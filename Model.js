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
// green triad). error and waiting both mean "needs you" and share the one
// "urgent" token; the glyph is what tells them apart.
function colorKeyForStatus(status) {
  switch (status) {
    case "error": return "urgent"
    case "waiting": return "urgent"
    case "running": return "accent"
    case "starting": return "accent"
    case "queued": return "accent"
    case "idle": return "muted"
    case "stopped": return "muted"
    default: return "muted"
  }
}

function glyphForStatus(status) {
  switch (status) {
    case "error": return "✕"    // ✕
    case "waiting": return "◆"  // ◆
    case "running": return "▶"  // ▶
    case "starting": return "▶"
    case "queued": return "▶"
    case "idle": return "○"     // ○
    case "stopped": return "○"
    default: return "?"
  }
}

function statusLabel(status) {
  if (!status) return "Unknown"
  return status.charAt(0).toUpperCase() + status.slice(1)
}

// Compact bar text, e.g. "✕1 ◆2 ▶3". Zero-count statuses are omitted so an
// all-idle fleet reads as "○4", not "✕0 ◆0 ▶0 ○4".
function summaryText(counts) {
  if (!counts) return ""
  var parts = []
  if (counts.error > 0) parts.push(glyphForStatus("error") + counts.error)
  if (counts.waiting > 0) parts.push(glyphForStatus("waiting") + counts.waiting)
  if (counts.running > 0) parts.push(glyphForStatus("running") + counts.running)
  if (counts.idle > 0) parts.push(glyphForStatus("idle") + counts.idle)
  if (counts.other > 0) parts.push("?" + counts.other)
  return parts.length > 0 ? parts.join(" ") : (glyphForStatus("idle") + "0")
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
    glyphForStatus: glyphForStatus,
    statusLabel: statusLabel,
    summaryText: summaryText,
    sortedSessions: sortedSessions
  }
}
