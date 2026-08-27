// Model.js — pure parsing/formatting only, no Process/Timer/FileView code
// here. Those live in Panel.qml, matching how every first-party Omarchy
// plugin splits the two (see e.g. shell/plugins/panels/weather). Keeping
// agent-deck's JSON shape → widget-state mapping isolated in this one file
// is the single place to patch if a future agent-deck version renames or
// restructures the /api/menu response.
//
// Wire format this file understands (agent-deck internal/web, MenuSnapshot):
//   { items: [ { type: "session", session: { id, title, tool, status,
//     groupPath, ... } }, { type: "group", group: {...} }, ... ] }
// Verified live against agent-deck @ 01c011b5 (2026-08-24).

var DEFAULT_HOST = "127.0.0.1"
var DEFAULT_PORT = 8420
var DEFAULT_POLL_SECONDS = 3

// Priority order for "what needs the user's eyes first" — used both to pick
// the bar's overall status and to sort the panel's session list.
var STATUS_PRIORITY = ["error", "waiting", "starting", "running", "queued", "idle", "stopped"]

function parseConfig(raw) {
  var cfg = {
    host: DEFAULT_HOST,
    port: DEFAULT_PORT,
    token: "",
    pollIntervalSeconds: DEFAULT_POLL_SECONDS
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
// server's handleIndex serves the SPA shell at /s/{id} unauthenticated; the
// SPA's own JS makes the authenticated API calls and strips the token from
// the URL after reading it — see agent-deck internal/web/static_files.go).
function sessionUrl(config, sessionId) {
  var url = baseUrl(config) + "/s/" + encodeURIComponent(sessionId)
  return config.token ? (url + "?token=" + encodeURIComponent(config.token)) : url
}

// curl argv for GET /api/menu. agent-deck's REST endpoints accept the token
// via the `Authorization: Bearer` header ONLY (query-string tokens are
// rejected on purpose, to keep secrets out of logs — see auth.go); building
// the header here, in one place, means that constraint only has to be known
// once.
function fetchMenuCommand(config) {
  var args = ["curl", "-fsS", "--max-time", "5", menuUrl(config)]
  if (config.token) {
    args.splice(1, 0, "-H", "Authorization: Bearer " + config.token)
  }
  return args
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

  for (var i = 0; i < data.items.length; i++) {
    var item = data.items[i]
    if (!item || item.type !== "session" || !item.session) continue

    var s = item.session
    var status = String(s.status || "").toLowerCase()
    sessions.push({
      id: String(s.id || ""),
      title: String(s.title || s.id || "(untitled)"),
      tool: String(s.tool || ""),
      status: status,
      groupPath: String(s.groupPath || "")
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
    generatedAt: String(data.generatedAt || ""),
    totalSessions: sessions.length,
    sessions: sessions,
    counts: counts
  }
}

// Highest-priority non-zero status across the fleet — drives the bar's
// overall glyph color when collapsed to a single dot.
function worstStatus(counts) {
  if (!counts) return ""
  if (counts.error > 0) return "error"
  if (counts.waiting > 0) return "waiting"
  if (counts.running > 0) return "running"
  if (counts.idle > 0) return "idle"
  if (counts.other > 0) return "other"
  return ""
}

// One Color.qml token per status (see shell/Commons/Color.qml: foreground,
// background, accent, urgent, muted — there is no theme-provided red/yellow/
// green triad). error and waiting are both "needs you", but reading the same
// red for a session that's dead (error) and one that's just paused on a
// prompt (waiting) is worse than the glyph alone disambiguates, so "waiting"
// maps to "warning" — not a real Color.qml token, but a yellow-ish tint
// derived from the theme's own urgent color at render time. See
// warningTintFromRgb() and Panel.qml's colorForKey().
// Only feeds the bar glyph's disconnected-state fallback color now (see
// Panel.qml's summaryColorKey) — every actually-visible status color (bar
// glyph when connected, panel row glyphs) uses statusColorHex() below
// instead, which matches agent-deck's own fixed palette rather than
// Omarchy's theme tokens.
function colorKeyForStatus(status) {
  switch (status) {
    case "error": return "urgent"
    case "waiting": return "warning"
    case "running": return "accent"
    case "starting": return "accent"
    case "queued": return "accent"
    case "idle": return "muted"
    case "stopped": return "muted"
    default: return "muted"
  }
}

// Status color, ported from agent-deck's own StatusIndicator() styles
// (internal/ui/styles.go: RunningStyle/WaitingStyle/IdleStyle/
// ErrorIndicatorStyle — dark-theme values, matching the tool colors above)
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

// ---- Minimal RGB<->HSL, used only to derive the synthetic "warning" tint
// below from whatever red a given theme's urgent color actually is.
function rgbToHsl(r, g, b) {
  var max = Math.max(r, g, b), min = Math.min(r, g, b)
  var h = 0, s = 0, l = (max + min) / 2
  if (max !== min) {
    var d = max - min
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
    switch (max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break
      case g: h = (b - r) / d + 2; break
      default: h = (r - g) / d + 4; break
    }
    h /= 6
  }
  return [h, s, l]
}

function hslToRgb(h, s, l) {
  function hue2rgb(p, q, t) {
    if (t < 0) t += 1
    if (t > 1) t -= 1
    if (t < 1 / 6) return p + (q - p) * 6 * t
    if (t < 1 / 2) return q
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6
    return p
  }
  if (s === 0) return [l, l, l]
  var q = l < 0.5 ? l * (1 + s) : l + s - l * s
  var p = 2 * l - q
  return [hue2rgb(p, q, h + 1 / 3), hue2rgb(p, q, h), hue2rgb(p, q, h - 1 / 3)]
}

// Rotates a color's hue most of the way toward yellow (60°) along the
// shorter arc, while boosting saturation/lightness enough to read as a
// distinct "warning" tone against whatever red the theme's urgent color
// happens to be — rather than hardcoding a fixed hex that would clash with
// some themes and match others by coincidence.
function warningTintFromRgb(r, g, b) {
  var hsl = rgbToHsl(r, g, b)
  var yellowHue = 60 / 360
  var diff = yellowHue - hsl[0]
  diff -= Math.round(diff) // shortest path around the hue wheel
  var h = (hsl[0] + diff * 0.85 + 1) % 1
  var s = Math.max(hsl[1], 0.5)
  var l = Math.min(Math.max(hsl[2], 0.55), 0.7)
  return hslToRgb(h, s, l)
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
// fleet reads as "○4", not "✕0 ◐0 ●0 ○4". Kept separate from each segment's
// *text* so a caller that can resolve theme colors (Panel.qml) can render
// each glyph in its own status color instead of the whole string collapsing
// to one color picked for the fleet's single worst status — see summaryText's
// callers in BarWidget.qml/Panel.qml.
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

// Compact bar text, e.g. "✕1 ◐2 ●3", as one plain (uncolored) string.
function summaryText(counts) {
  return summarySegments(counts).map(function(seg) { return seg.glyph + seg.count }).join(" ")
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
    parseMenuResponse: parseMenuResponse,
    worstStatus: worstStatus,
    colorKeyForStatus: colorKeyForStatus,
    statusColorHex: statusColorHex,
    warningTintFromRgb: warningTintFromRgb,
    toolIcon: toolIcon,
    toolColorHex: toolColorHex,
    glyphForStatus: glyphForStatus,
    statusLabel: statusLabel,
    summarySegments: summarySegments,
    summaryText: summaryText,
    sortedSessions: sortedSessions
  }
}
