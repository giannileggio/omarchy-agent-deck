# gianni.agent-deck

Omarchy Quattro bar widget for [agent-deck](https://github.com/asheshgoplani/agent-deck)'s
`agent-deck web` server. Shows live running/waiting/idle/error session counts in the
bar, with a click-through panel listing every session and a link to open it in
agent-deck's own web UI.

## Requirements

- Omarchy Quattro shell.
- `agent-deck web` running and reachable (defaults to `http://127.0.0.1:8420`,
  agent-deck's own default). The widget polls this server directly — it does
  not read tmux or agent-deck's on-disk state, so `agent-deck web` must be
  running for it to show anything but the disconnected state.
- `curl` and `xdg-open` on `PATH` (both are standard on an Omarchy install).

Start agent-deck's web server with:

```sh
agent-deck web --no-tui          # headless, no separate TUI window
# or just
agent-deck web                   # TUI + web server together
```

## Install

```sh
mkdir -p ~/.config/omarchy/plugins
git clone https://github.com/giannileggio/omarchy-agent-deck.git ~/.config/omarchy/plugins/gianni.agent-deck
```

Then reload plugins (`omarchy plugin list --json` should show `gianni.agent-deck`,
or run `omarchy-shell shell rescanPlugins` / restart the shell) and add it to a
bar slot via Omarchy's plugin settings.

## Configuration

Copy the example config and edit it:

```sh
cp ~/.config/omarchy/plugins/gianni.agent-deck/config.example.json \
   ~/.config/omarchy/plugins/gianni.agent-deck/config.local.json
```

`config.local.json`:

```json
{
  "host": "127.0.0.1",
  "port": 8420,
  "token": "",
  "pollIntervalSeconds": 3
}
```

| Key | Default | Notes |
|---|---|---|
| `host` | `127.0.0.1` | agent-deck web server host. |
| `port` | `8420` | agent-deck web server port. |
| `token` | `""` (none) | Only needed if you started `agent-deck web --token ...` (e.g. binding non-loopback). Leave empty for the default local/no-auth setup. |
| `pollIntervalSeconds` | `3` | How often the widget polls `GET /api/menu`. |

`config.local.json` is **gitignored on purpose** — it's where the bearer
token lives, and it should never end up committed alongside this plugin's
code. `config.example.json` (committed) is just a template; the widget falls
back to the defaults above if `config.local.json` is missing entirely, so a
default local `agent-deck web` (no `--token`) needs no config file at all.

The file is watched, so editing it takes effect live without restarting the
shell.

## What it shows

The bar glyph is a compact per-status count, e.g. `✕1 ◆2 ▶3`:

| Glyph | Status | Color |
|---|---|---|
| `✕` | error | urgent (theme's attention color) |
| `◆` | waiting | urgent (theme's attention color) |
| `▶` | running (incl. starting/queued) | accent |
| `○` | idle (incl. stopped) | muted |

Zero-count statuses are omitted, so an all-idle fleet reads as `○4`, not
`✕0 ◆0 ▶0 ○4`. `error` and `waiting` share the theme's one "needs attention"
color token (Omarchy's theme palette doesn't have a separate red/yellow) —
the glyph is what tells them apart.

Clicking the bar glyph opens a panel listing every session (status, title,
tool, group), sorted so whatever needs attention is at the top. Clicking a
session opens it in agent-deck's own web UI (`/s/{id}`) in your default
browser.

If `agent-deck web` isn't reachable, the glyph shows `⚠` and the panel
explains what to check, rather than erroring or crashing the shell.

## Known limitations

- **Poll-based, not push.** agent-deck's web server does expose a live SSE
  stream (`GET /events/menu`), but every first-party Omarchy bar-widget plugin
  that fetches external data (weather, network, etc.) uses a short-lived
  `curl` `Process` on a `Timer` rather than a long-running streaming child
  process — this plugin follows that same convention rather than the SSE
  endpoint, for consistency and because a persistent streaming subprocess is
  an unusual shape in this framework. Default interval is 3s; lower
  `pollIntervalSeconds` for snappier updates at the cost of more `curl` calls.
- **`agent-deck web`'s HTTP API is not a documented/versioned contract.** It's
  agent-deck's own web UI's backend, well-tested but with no stability
  promise across versions. All fetch/parse logic is isolated in `Model.js` —
  if a future agent-deck release changes the `/api/menu` response shape,
  that's the one file to patch.
- Only the four core statuses (`running`/`waiting`/`idle`/`error`) get their
  own glyph; agent-deck's transitional states (`starting`, `queued`) fold into
  "running" and `stopped` folds into "idle" for the bar count (the panel still
  shows each session's exact status).
- No settings UI (host/port/token/interval are edited by hand in
  `config.local.json`, not through Omarchy's plugin settings form).

## Development

```sh
omarchy plugin validate ~/.config/omarchy/plugins/gianni.agent-deck
qmllint -I "$OMARCHY_PATH/shell" BarWidget.qml Panel.qml
```

## License

MIT — see [LICENSE](LICENSE). Matches agent-deck's own license.
