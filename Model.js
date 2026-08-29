// Model.js — pure parsing/formatting only, no Process/Timer/FileView code
// here. Those live in Panel.qml, matching how every first-party Omarchy
// plugin splits the two (see e.g. shell/plugins/panels/weather). Keeping
// agent-deck's JSON shape → widget-state mapping isolated in this one file
// is the single place to patch if a future agent-deck version renames or
// restructures the /api/menu response.
//
// Wire format this file understands (agent-deck internal/web, MenuSnapshot):
//   { items: [ { type: "session", session: { id, title, tool, status,
//     groupPath, projectPath, lastAccessedAt, latestPrompt, tmuxSession,
//     ... } }, { type: "group", group: {...} }, ... ] }
// Verified live against agent-deck @ 01c011b5 (2026-08-24).

var DEFAULT_HOST = "127.0.0.1"
var DEFAULT_PORT = 8420
var DEFAULT_POLL_SECONDS = 3
// Hard caps applied before anything from the network reaches JSON.parse,
// sorting, or the QML model — independent of curl's own --max-filesize
// (fetchMenuCommand below), which only helps when the server advertises
// Content-Length up front. 1 MiB/500 sessions/500 chars are all generous
// for what a session list actually is; a response this large is already a
// signal something's wrong, not a fleet to render.
var MAX_RESPONSE_BYTES = 1048576
var MAX_ITEMS = 500
var MAX_FIELD_CHARS = 500
// config.local.json is a handful of short fields; 64 KiB is generous.
var MAX_CONFIG_BYTES = 65536
// Visual feedback (a few opacity pulses on the bar glyph) is low-risk and
// on by default; a desktop notification is an external side effect (spawns
// notify-send, steals a moment of attention) so it defaults off, same
// opt-in posture as the token field above.
var DEFAULT_BLINK_ON_ATTENTION = true
var DEFAULT_NOTIFY_ON_ATTENTION = false

// Priority order for "what needs the user's eyes first" — used to sort the
// panel's session list.
var STATUS_PRIORITY = ["error", "waiting", "starting", "running", "queued", "idle", "stopped"]

function parseConfig(raw) {
  var cfg = {
    host: DEFAULT_HOST,
    port: DEFAULT_PORT,
    token: "",
    pollIntervalSeconds: DEFAULT_POLL_SECONDS,
    blinkOnAttention: DEFAULT_BLINK_ON_ATTENTION,
    notifyOnAttention: DEFAULT_NOTIFY_ON_ATTENTION
  }
  try {
    var data = raw ? JSON.parse(String(raw)) : null
    if (data && typeof data === "object") {
      if (typeof data.host === "string" && data.host.length > 0) cfg.host = data.host
      var port = parseInt(data.port, 10)
      if (isFinite(port) && port > 0 && port < 65536) cfg.port = port
      if (typeof data.token === "string") cfg.token = data.token
      var poll = parseFloat(data.pollIntervalSeconds)
      if (isFinite(poll) && poll >= 1) cfg.pollIntervalSeconds = poll
      if (typeof data.blinkOnAttention === "boolean") cfg.blinkOnAttention = data.blinkOnAttention
      if (typeof data.notifyOnAttention === "boolean") cfg.notifyOnAttention = data.notifyOnAttention
    }
  } catch (e) {
    // Malformed/missing config file: fall back to defaults rather than
    // going dark. Same behavior as no config file at all.
  }
  return cfg
}

function baseUrl(config) {
  return "http://" + config.host + ":" + config.port
}

function menuUrl(config) {
  return baseUrl(config) + "/api/menu"
}

// Deep link into agent-deck's own web UI, focused on one session (the
// server's handleIndex serves the SPA shell at /s/{id} unauthenticated).
// Deliberately does NOT append ?token=... even when one is configured:
// fetchMenuCommand's comment below explains agent-deck accepts the token via
// the Authorization header ONLY, specifically "to keep secrets out of logs"
// — putting it in a URL handed to xdg-open would undo that (it lands in
// xdg-open's argv, readable via /proc/*/cmdline by anything running as this
// user, and then in the browser's own history). If the browser doesn't
// already have a session with this server, the SPA's own login prompt
// handles it.
function sessionUrl(config, sessionId) {
  return baseUrl(config) + "/s/" + encodeURIComponent(sessionId)
}

// Escapes a value for curl's config-file quoting rules (see `curl --manual`,
// "config file"): inside a double-quoted value, backslash and double-quote
// need escaping, and a raw newline/CR/tab would otherwise terminate the
// directive early or start an attacker-controlled one of its own.
function curlConfigEscape(value) {
  return String(value)
    .replace(/\\/g, "\\\\")
    .replace(/"/g, "\\\"")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t")
}

// curl argv for GET /api/menu, run through `sh -c` for one reason: piping
// curl into `head -c` is the simplest way to enforce MAX_RESPONSE_BYTES as
// a hard, consumer-side cap regardless of what the server claims or how it
// streams (curl's own --max-filesize is best-effort — it only aborts early
// when a Content-Length is sent up front). None of the interpolated values
// here come from the network, so this isn't a shell-injection concern; the
// one secret (the bearer token) deliberately does NOT appear anywhere in
// this argv — see fetchMenuStdin below.
function fetchMenuCommand(config) {
  return ["sh", "-c",
    'curl -fsS --max-time 5 --max-filesize "$2" -K - "$1" | head -c "$2"',
    "sh", menuUrl(config), String(MAX_RESPONSE_BYTES)]
}

// curl config-file text (curl's `-K -` above reads this from stdin)
// carrying the `Authorization: Bearer` header. agent-deck's REST endpoints
// accept the token via that header ONLY (query-string tokens are rejected
// on purpose, to keep secrets out of logs — see auth.go); routing it
// through curl's stdin instead of `-H` on the argv keeps it out of
// /proc/*/cmdline too, where it would otherwise be readable by any other
// process running as this user for as long as curl runs.
function fetchMenuStdin(config) {
  if (!config.token) return ""
  return "header = \"Authorization: Bearer " + curlConfigEscape(config.token) + "\"\n"
}

// argv for a bounded, symlink-safe read of config.local.json — it holds the
// bearer token, so it's read through this instead of handed straight to
// FileView (whose QML-exposed API has no symlink/type/owner/size controls).
// `dd ... iflag=nofollow` opens the path with O_NOFOLLOW: a symlink is
// refused at open() itself (GNU coreutils, atomic — not a stat()-then-open()
// race), and `bs=MAX_CONFIG_BYTES count=1` caps the read at one block. The
// preceding shell checks reject anything that isn't a regular file owned by
// the invoking user with no group/other write bit. Any check failing —
// including "no such file" — falls through to `exit 0` with empty output,
// which parseConfig() already treats the same as "no config file": defaults.
function configReadCommand(path) {
  var script = [
    'p=$1',
    'if [ -L "$p" ] || [ ! -e "$p" ] || [ ! -f "$p" ]; then exit 0; fi',
    'owner=$(stat -c %u "$p" 2>/dev/null) || exit 0',
    '[ "$owner" = "$(id -u)" ] || exit 0',
    'perm=$(stat -c %#a "$p" 2>/dev/null) || exit 0',
    '[ $(( perm & 022 )) -eq 0 ] || exit 0',
    'dd if="$p" bs=' + MAX_CONFIG_BYTES + ' count=1 iflag=nofollow status=none 2>/dev/null'
  ].join('\n')
  return ["sh", "-c", script, "sh", path]
}

// Coerces to string and truncates to MAX_FIELD_CHARS, falling back to
// `fallback` when value is empty/missing — same "never trust one server
// field's length" boundary applied to every session field parseMenuResponse
// pulls off the wire.
function boundedString(value, fallback) {
  var s = String(value || fallback || "")
  return s.length > MAX_FIELD_CHARS ? s.slice(0, MAX_FIELD_CHARS) : s
}

// Returns null on any failure (empty body, unreachable server, unexpected
// shape) so callers have one clean "treat as disconnected" signal.
function parseMenuResponse(raw) {
  var text = String(raw || "").trim()
  if (!text) return null

  var data
  try {
    data = JSON.parse(text)
  } catch (e) {
    return null
  }
  if (!data || !Array.isArray(data.items)) return null

  var sessions = []
  var counts = { running: 0, waiting: 0, idle: 0, error: 0, other: 0 }
  // Cap how many items get parsed at all — not just how many render — so a
  // pathological/compromised server can't turn this into an unbounded sort
  // or an unbounded QML Repeater model.
  var itemCount = Math.min(data.items.length, MAX_ITEMS)

  for (var i = 0; i < itemCount; i++) {
    var item = data.items[i]
    if (!item || item.type !== "session" || !item.session) continue

    var s = item.session
    var status = boundedString(s.status, "").toLowerCase()
    sessions.push({
      id: boundedString(s.id, ""),
      title: boundedString(s.title, s.id || "(untitled)"),
      tool: boundedString(s.tool, ""),
      status: status,
      groupPath: boundedString(s.groupPath, ""),
      projectPath: boundedString(s.projectPath, ""),
      lastAccessedAt: boundedString(s.lastAccessedAt, ""),
      latestPrompt: boundedString(s.latestPrompt, ""),
      tmuxSession: boundedString(s.tmuxSession, "")
    })

    if (counts.hasOwnProperty(status)) {
      counts[status]++
    } else if (status === "starting" || status === "queued") {
      // Transitional states read as "running" for the bar's compact count.
      counts.running++
    } else if (status === "stopped") {
      counts.idle++
    } else {
      counts.other++
    }
  }

  return {
    generatedAt: boundedString(data.generatedAt, ""),
    totalSessions: sessions.length,
    sessions: sessions,
    counts: counts
  }
}

// Status color, ported from agent-deck's own StatusIndicator() styles
// (internal/ui/styles.go: RunningStyle/WaitingStyle/IdleStyle/
// ErrorIndicatorStyle — dark-theme values, matching the tool colors below)
// rather than Omarchy's theme tokens, so a session's status color reads the
// same here as it does in agent-deck's own TUI. "starting" uses
// WaitingStyle in agent-deck (yellow, not green — it's "not running yet"),
// and "queued" isn't in agent-deck's switch at all; grouped with "starting"
// here for the same reason glyphForStatus groups them (see its comment).
var STATUS_COLORS = {
  error: "#f7768e",
  waiting: "#e0af68",
  starting: "#e0af68",
  queued: "#e0af68",
  running: "#9ece6a",
  idle: "#787fa0",
  stopped: "#787fa0"
}
var DEFAULT_STATUS_COLOR = "#787fa0" // agent-deck's default case (IdleStyle)

function statusColorHex(status) {
  return STATUS_COLORS.hasOwnProperty(status) ? STATUS_COLORS[status] : DEFAULT_STATUS_COLOR
}

// Matches agent-deck's own StatusIndicator() (internal/ui/styles.go) glyph
// for glyph: ✕ error, ◐ waiting, ● running, ○ idle, ⟳ starting (agent-deck's
// TUI has no distinct "queued" case; grouped with "starting" here as the
// other transitional/in-flux state rather than defaulting to plain idle).
function glyphForStatus(status) {
  switch (status) {
    case "error": return "✕"
    case "waiting": return "◐"
    case "running": return "●"
    case "starting": return "⟳"
    case "queued": return "⟳"
    case "idle": return "○"
    case "stopped": return "○"
    default: return "?"
  }
}

function statusLabel(status) {
  if (!status) return "Unknown"
  return status.charAt(0).toUpperCase() + status.slice(1)
}

// Per-tool icon + brand color, next to each session's title. Ported straight
// from agent-deck's own internal/ui/styles.go (IconClaude/IconGemini/.../
// ToolIcon()/ToolColor()) — plain Unicode emoji and the exact hex values
// agent-deck's own TUI renders, not bundled vendor logo files, so this is
// just replicating agent-deck's own established visual language rather than
// this plugin inventing (or appropriating) tool branding on its own. Colors
// are fixed (not derived from the Omarchy theme like the status colors
// elsewhere in this file) on purpose: they're a tool's identity, the same
// regardless of which theme happens to be active, matching how agent-deck
// itself treats them.
var TOOL_ICONS = {
  claude: "🤖",
  gemini: "✨",
  opencode: "🌐",
  codex: "💻",
  copilot: "🐙",
  crush: "💘",
  cursor: "📝",
  hermes: "☤",
  deepseek: "🐋",
  pi: "π",
  shell: "🐚"
}
var DEFAULT_TOOL_ICON = "🐚" // agent-deck's ToolIcon() default case

var TOOL_COLORS = {
  claude: "#ff9e64",   // Anthropic orange
  gemini: "#bb9af7",   // Google AI purple
  codex: "#7dcfff",    // light blue for OpenAI
  copilot: "#7aa2f7",  // GitHub Copilot blue
  crush: "#bb9af7",    // Charm Crush purple/magenta
  cursor: "#7aa2f7",   // Cursor blue
  hermes: "#e0af68",   // Hermes gold
  deepseek: "#7dcfff",
  pi: "#7aa2f7",
  aider: "#f7768e",    // Aider red
  shell: "#c0caf5",    // agent-deck's plain text color — not a "brand", just readable
  opencode: "#c0caf5"
}
var DEFAULT_TOOL_COLOR = "#787fa0" // agent-deck's ToolColor() default case (gray)

function toolIcon(tool) {
  var key = String(tool || "").toLowerCase()
  return TOOL_ICONS.hasOwnProperty(key) ? TOOL_ICONS[key] : DEFAULT_TOOL_ICON
}

function toolColorHex(tool) {
  var key = String(tool || "").toLowerCase()
  return TOOL_COLORS.hasOwnProperty(key) ? TOOL_COLORS[key] : DEFAULT_TOOL_COLOR
}

// Per-glyph breakdown of the compact bar text, e.g. [{status:"error",
// glyph:"✕",count:1}, ...]. Zero-count statuses are omitted so an all-idle
// fleet reads as "○4", not "✕0 ◐0 ●0 ○4" — except when every status is
// zero (no sessions at all yet, or all filtered out), where a bare "○0" is
// substituted below so the bar glyph never collapses to an empty string.
// Kept separate from each segment's *text* so a caller that can resolve
// theme colors (Panel.qml) can render each glyph in its own status color
// instead of the whole string collapsing to one color.
function summarySegments(counts) {
  if (!counts) return []
  var order = ["error", "waiting", "running", "idle"]
  var segments = []
  for (var i = 0; i < order.length; i++) {
    var status = order[i]
    var n = counts[status] || 0
    if (n > 0) segments.push({ status: status, glyph: glyphForStatus(status), count: n })
  }
  if (counts.other > 0) segments.push({ status: "other", glyph: "?", count: counts.other })
  if (segments.length === 0) segments.push({ status: "idle", glyph: glyphForStatus("idle"), count: 0 })
  return segments
}

// Statuses worth interrupting the user for — the same two STATUS_PRIORITY
// puts first, since those are exactly the ones where a session is stuck on
// the user rather than making progress on its own.
var ATTENTION_STATUSES = ["waiting", "error"]

function isAttentionStatus(status) {
  return ATTENTION_STATUSES.indexOf(status) !== -1
}

// Sessions in `currSessions` that just started needing attention — i.e. are
// waiting/error now but weren't in that same status a moment ago, matched by
// id against `prevSessions` (the previous poll's session list, or null/[]
// before the first poll ever resolves). A session already sitting in
// "waiting" across two consecutive polls produces no event (nothing new
// happened); one that flips running -> waiting, or error -> waiting (e.g. a
// retry), does. `prevSessions` being null/empty treats every currently
// waiting/error session as new — so the very first fetch that ever
// succeeds (prevSessions hasn't been set yet) still flags a fleet that was
// already stuck, instead of silently adopting it as "normal". A later
// fetch after a transient disconnect is unaffected: the caller (Panel.qml's
// applySnapshot) only overwrites its stored previous-sessions list on a
// successful fetch, so a still-waiting session reconnecting doesn't
// re-count as new.
function newAttentionSessions(prevSessions, currSessions) {
  var prevStatusById = {}
  ;(prevSessions || []).forEach(function(s) { prevStatusById[s.id] = s.status })
  return (currSessions || []).filter(function(s) {
    return isAttentionStatus(s.status) && prevStatusById[s.id] !== s.status
  })
}

// Sessions ordered worst-status-first, then by title, so the panel surfaces
// what needs attention without the user having to scroll for it.
function sortedSessions(sessions) {
  var ranked = (sessions || []).slice()
  ranked.sort(function(a, b) {
    var ra = STATUS_PRIORITY.indexOf(a.status)
    var rb = STATUS_PRIORITY.indexOf(b.status)
    if (ra === -1) ra = STATUS_PRIORITY.length
    if (rb === -1) rb = STATUS_PRIORITY.length
    if (ra !== rb) return ra - rb
    return a.title < b.title ? -1 : (a.title > b.title ? 1 : 0)
  })
  return ranked
}

// Last path segment of a session's projectPath, e.g.
// "/home/g/Projects/foo" -> "foo". The repo name is what actually
// disambiguates two same-titled sessions living in different projects; the
// full path is mostly noise in a ~320px popup.
function projectName(path) {
  var s = String(path || "").replace(/\/+$/, "")
  if (!s) return ""
  var parts = s.split("/")
  return parts[parts.length - 1] || s
}

// Compact "how long ago" for a session's lastAccessedAt, e.g. "3m ago".
// Takes `nowMs` as a parameter rather than reading Date.now() itself, so
// this stays a pure function of its inputs (see this file's header) — the
// caller (Panel.qml) supplies a periodically-updated "now".
function relativeTime(iso, nowMs) {
  if (!iso) return ""
  var then = Date.parse(iso)
  if (!isFinite(then)) return ""
  var deltaSeconds = Math.max(0, Math.floor((nowMs - then) / 1000))
  if (deltaSeconds < 45) return "just now"
  var minutes = Math.floor(deltaSeconds / 60)
  if (minutes < 60) return minutes + "m ago"
  var hours = Math.floor(minutes / 60)
  if (hours < 24) return hours + "h ago"
  var days = Math.floor(hours / 24)
  return days + "d ago"
}

// Text for the row-hover "copy attach command" action — read-only from
// agent-deck's own point of view (no HTTP call, just a tmux command the user
// runs themselves in a real terminal).
function tmuxAttachCommand(tmuxSession) {
  if (!tmuxSession) return ""
  return "tmux attach -t " + tmuxSession
}

// Exported for both Panel.qml's `import "Model.js" as Model` (QML resolves
// this via the engine's own module loader, module.exports is irrelevant
// there) and, incidentally, for a plain Node `require("./Model.js")` — this
// file has no Quickshell/Process dependency, so it can be unit-tested
// outside the shell entirely; no such tests exist yet, but the export is
// here for whoever writes them.
if (typeof module !== "undefined") {
  module.exports = {
    DEFAULT_HOST: DEFAULT_HOST,
    DEFAULT_PORT: DEFAULT_PORT,
    DEFAULT_POLL_SECONDS: DEFAULT_POLL_SECONDS,
    parseConfig: parseConfig,
    baseUrl: baseUrl,
    menuUrl: menuUrl,
    sessionUrl: sessionUrl,
    fetchMenuCommand: fetchMenuCommand,
    fetchMenuStdin: fetchMenuStdin,
    configReadCommand: configReadCommand,
    parseMenuResponse: parseMenuResponse,
    statusColorHex: statusColorHex,
    glyphForStatus: glyphForStatus,
    statusLabel: statusLabel,
    toolIcon: toolIcon,
    toolColorHex: toolColorHex,
    summarySegments: summarySegments,
    isAttentionStatus: isAttentionStatus,
    newAttentionSessions: newAttentionSessions,
    sortedSessions: sortedSessions,
    projectName: projectName,
    relativeTime: relativeTime,
    tmuxAttachCommand: tmuxAttachCommand
  }
}
