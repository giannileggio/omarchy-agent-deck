import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui
import "Model.js" as Model

// Owns all agent-deck state: config, polling, and the session-list popup.
// BarWidget.qml is a thin shell that just reads properties off this file's
// root through the Loader — see BarWidget.qml's injectPanel(). Polling runs
// continuously (the Loader that hosts this file is always active, panel
// open or not) so the bar glyph stays live without the popup ever opening.
Panel {
  id: root
  moduleName: "io.github.giannileggio.agent-deck"
  ipcTarget: root.moduleName
  // manageIpc: false — the base Panel's own IpcHandler has no refresh()
  // method, and every first-party plugin that adds IPC methods beyond the
  // base four (open/close/show/hide/toggle) owns its handler rather than
  // extending the base's, so this does the same. Note the base's toggle()
  // and IpcHandler *do* correctly dispatch to this file's open()/close()
  // overrides via normal QML method resolution (derived overrides win) —
  // manageIpc:false isn't compensating for a dispatch problem, refresh()
  // just needs its own IpcHandler method regardless.
  manageIpc: false

  property var anchorItem: null

  // The bar tracks the widget mounted in its slot — BarWidget.qml — not this
  // nested panel. Everything the bar identifies a panel by has to be that
  // widget (popout coordinator, switchPanelFrom lookups), matching the
  // pattern every first-party panel plugin uses.
  property var hostWidget: null
  readonly property var barIdentity: hostWidget || root

  // ---- Config. host/port/pollIntervalSeconds are plain settings; token is
  // a secret and deliberately does NOT live in shell.json (which is not
  // gitignored in a user's dotfiles) — it lives in this plugin-local file,
  // which ships .gitignore'd. See README.md and config.example.json.
  readonly property string configPath: Quickshell.env("HOME") + "/.config/omarchy/plugins/io.github.giannileggio.agent-deck/config.local.json"
  property var config: Model.parseConfig("")

  FileView {
    id: configFile
    path: root.configPath
    watchChanges: true
    printErrors: false
    onLoaded: root.applyConfig(text())
    onLoadFailed: root.applyConfig("")
    onFileChanged: reload()
  }

  function applyConfig(raw) {
    root.config = Model.parseConfig(raw)
    root.refresh()
  }

  // ---- Live session data.
  property var snapshot: null           // Model.parseMenuResponse() result, or null
  // Derived from snapshot rather than set alongside it: the fetch handler
  // used to assign root.snapshot and root.connected as two separate
  // statements, which left a one-tick window where a dependent binding
  // (summaryMarkup) could see them out of sync — e.g. still connected===true
  // right after snapshot was reset to null on a failed fetch, crashing on
  // snapshot.totalSessions. Deriving connected from snapshot makes that
  // pairing atomic.
  readonly property bool connected: snapshot !== null
  property bool everFetched: false      // false until the first fetch resolves either way

  readonly property var counts: snapshot ? snapshot.counts : null
  readonly property string summaryMarkup: connected
    ? Model.summarySegments(counts).map(function(seg) {
        return "<font color='" + Model.statusColorHex(seg.status) + "'>" + seg.glyph + seg.count + "</font>"
      }).join(" ")
    : "⚠"
  // Bar-glyph color for BarWidget's pre-summaryMarkup fallback. Only ever
  // actually paints while disconnected — summaryMarkup is plain "⚠" text
  // there, so a plain Text.color applies for real. While connected,
  // summaryMarkup is rich text with each segment wrapped in its own
  // <font color> (above), which overrides whatever this holds — so
  // Color.foreground here is a value that's computed but never rendered,
  // rather than a real per-status color threaded through for nothing.
  readonly property color summaryColor: connected ? Color.foreground : root.mutedReadable

  function refresh() {
    if (fetchProc.running) return
    fetchProc.command = Model.fetchMenuCommand(root.config)
    fetchProc.running = true
  }

  Process {
    id: fetchProc
    // A process that fails to start (e.g. curl missing from PATH) flips
    // `running` back to false without ever emitting streamFinished, which
    // would otherwise leave everFetched stuck at false forever — a
    // permanent "Loading…" that masks the one message ("not reachable —
    // check host/port/token") the user actually needs. Latching it here too
    // covers that path; the ordinary curl-ran-but-server-unreachable case
    // still goes through onStreamFinished below (curl exits non-zero but
    // still closes stdout, so streamFinished fires with empty text).
    onExited: root.everFetched = true
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        root.snapshot = Model.parseMenuResponse(text)
        root.everFetched = true
      }
    }
  }

  function openSession(sessionId) {
    if (!sessionId) return
    // Util.execArgv (qs.Commons) runs this detached via a login shell,
    // matching how every first-party plugin launches xdg-open/mpv/etc. — a
    // plain Process here would get its command overwritten (and the
    // in-flight child killed) by a second click on a different session
    // before the first xdg-open finishes resolving a handler.
    Util.execArgv(["xdg-open", Model.sessionUrl(root.config, sessionId)])
  }

  // Copies `tmux attach -t <session>` to the clipboard via wl-copy — see the
  // hover-revealed row action in the Repeater delegate below. Read-only from
  // agent-deck's own point of view (no HTTP call at all), so there's no
  // failure state or confirm step to design for, unlike a real session
  // mutation would need.
  function copyAttachCommand(tmuxSession) {
    var command = Model.tmuxAttachCommand(tmuxSession)
    if (!command) return
    Util.execArgv(["wl-copy", command])
  }

  // Color.muted measures ~1.7:1 contrast against this bar/popup background in
  // the Nord theme (sampled live: muted #4c566a on background #2e3440) — well
  // under WCAG's 3:1 floor for even large text, and visibly hard to read next
  // to anything else on the bar. Rather than trust a token some themes may
  // tune for a different context, mutedReadable is translucent foreground —
  // alpha-blending toward whatever the background actually is, so it stays
  // legibly secondary (dimmer than foreground) without inheriting muted's
  // low-contrast risk on any given theme.
  readonly property color mutedReadable: Qt.rgba(Color.foreground.r, Color.foreground.g, Color.foreground.b, 0.62)

  // Ticks periodically so the session list's relative "3m ago" timestamps
  // stay fresh between polls — pollTimer below only refetches session
  // state, it doesn't by itself invalidate a relativeTime() string once the
  // underlying counts haven't changed.
  property real nowMs: Date.now()

  Timer {
    interval: 30000
    running: true
    repeat: true
    onTriggered: root.nowMs = Date.now()
  }

  Timer {
    id: pollTimer
    interval: Math.max(1, root.config.pollIntervalSeconds) * 1000
    running: true
    repeat: true
    triggeredOnStart: true
    onTriggered: root.refresh()
  }

  // ---- Popup lifecycle. Overrides the Panel base's open() to also kick a
  // refresh, so the list is current the moment it's opened rather than
  // waiting for the next poll tick.
  function open() {
    root.controller.show()
    root.refresh()
  }

  function close() {
    // Closing unmaps KeyboardPanel's full-screen dismiss overlay, which
    // hands the pointer back to the bar surface and re-fires iconHovered's
    // rising edge even though the pointer never moved off the icon —
    // without this suppression window, hoverOpenTimer below would
    // immediately reopen what was just closed. See iconHovered's comment.
    root.hoverOpenSuppressedUntil = Date.now() + 600
    root.controller.hide()
  }

  function toggle() {
    if (root.opened) root.close()
    else root.open()
  }

  // The bar tracks panels by barIdentity (see above), so Tab/Shift-Tab
  // cycling has to route through it too, not through the base Panel's own
  // switchPanel() (which would look this panel itself up in the bar's slot
  // table, where it was never registered — see barIdentity's comment).
  function switchPanel(direction) {
    if (root.bar && typeof root.bar.switchPanelFrom === "function")
      return root.bar.switchPanelFrom(root.barIdentity, direction)
    return false
  }

  // ---- Hover-to-open. iconHovered is set live from BarWidget.qml's
  // WidgetButton via a Binding (this file is loaded by a Loader, so
  // BarWidget can't reach a plain property assignment on it — see
  // BarWidget.qml). Edge-triggered (onIconHoveredChanged, not a level check)
  // so a manual click-to-close while still hovering doesn't immediately
  // reopen the panel on its own — but the edge alone isn't sufficient: see
  // hoverOpenSuppressedUntil below and close()'s comment above.
  //
  // Deliberately open-only: closing is left to the panel's existing
  // mechanisms (click the icon again, click elsewhere — KeyboardPanel's own
  // full-screen dismiss overlay — or IPC hide), not mirrored on hover-exit.
  // Once hover opens the panel, that dismiss overlay maps on top of the bar
  // and stops routing pointer motion to this widget's own MouseArea, so
  // "is the pointer still over the icon" can't be trusted anymore right
  // after opening — confirmed live: a hover-close mirror of this closed the
  // panel ~1s after opening even with the pointer held stationary over the
  // icon the whole time. See KeyboardPanel.qml's own comment: hover
  // triggerMode is "missing on purpose (for now)".
  property bool iconHovered: false

  // The same dismiss-overlay lifecycle that made hover-exit untrustworthy
  // (comment above) works in reverse on close: unmapping it hands pointer
  // events back to the bar, so iconHovered re-fires its rising edge purely
  // because the overlay went away — not because the pointer actually moved.
  // Without suppressing hoverOpenTimer for a beat after close(), that
  // spurious edge would reopen the panel the click was meant to dismiss.
  property real hoverOpenSuppressedUntil: 0

  onIconHoveredChanged: {
    if (root.iconHovered) hoverOpenTimer.restart()
    else hoverOpenTimer.stop()
  }

  // Delay before opening: long enough that passing over the icon on the way
  // to something else doesn't flash the panel, short enough to feel responsive
  // to someone actually pausing on it.
  Timer {
    id: hoverOpenTimer
    interval: 250
    onTriggered: if (root.iconHovered && !root.opened && Date.now() >= root.hoverOpenSuppressedUntil) root.open()
  }

  IpcHandler {
    target: root.ipcTarget

    function open(): void { root.open() }
    function close(): void { root.close() }
    function show(): void { root.open() }
    function hide(): void { root.close() }
    function toggle(): void { root.toggle() }
    function refresh(): void { root.refresh() }
  }

  KeyboardPanel {
    id: panel
    anchorItem: root.anchorItem
    owner: root.barIdentity
    bar: root.bar
    open: root.opened
    // No centerOnBar: that's for center-section widgets (clock, weather)
    // that want the popup centered on the whole bar regardless of their own
    // position. This widget lives in the right section by convention (see
    // README), same as bluetooth/network/audio/monitor/tailscale, none of
    // which set it either — the default (false) anchors the popup under the
    // icon itself, which is what a right-section widget wants.
    focusTarget: keyCatcher
    contentWidth: panel.fittedContentWidth(Style.space(320))
    contentHeight: panel.fittedContentHeight(contentColumn.implicitHeight)

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      onCloseRequested: root.close()
      onTabRequested: function(direction) { root.switchPanel(direction) }
      // PanelKeyCatcher accepts (and otherwise silently discards) arrow
      // keys/jk/hl regardless of whether a panel wires them up — without
      // this, a hotkey-summoned session list longer than the card is
      // mouse-scroll-only, since the keys never reach the Flickable below.
      onMoveRequested: function(dx, dy) {
        scroll.contentY = Math.max(0, Math.min(scroll.contentHeight - scroll.height, scroll.contentY + dy * Style.space(40)))
      }

      Flickable {
        id: scroll
        anchors.fill: parent
        contentWidth: width
        contentHeight: contentColumn.implicitHeight
        clip: true
        boundsBehavior: Flickable.StopAtBounds
        interactive: contentHeight > height

        Column {
          id: contentColumn
          width: scroll.width
          spacing: Style.space(2)
          topPadding: Style.space(10)
          bottomPadding: Style.space(10)

          Text {
            width: parent.width
            leftPadding: Style.space(16)
            rightPadding: Style.space(16)
            text: "Agent Deck"
            color: root.barForeground
            font.family: Style.font.family
            font.pixelSize: Style.font.heading
            font.bold: true
          }

          Text {
            width: parent.width
            leftPadding: Style.space(16)
            rightPadding: Style.space(16)
            bottomPadding: Style.space(6)
            text: root.connected ? Model.baseUrl(root.config) : "not reachable — " + Model.baseUrl(root.config)
            color: root.mutedReadable
            font.family: Style.font.family
            font.pixelSize: Style.font.bodySmall
            elide: Text.ElideRight
          }

          PanelSeparator {}

          // ---- Disconnected state.
          Column {
            visible: root.everFetched && !root.connected
            width: parent.width
            topPadding: Style.space(16)
            bottomPadding: Style.space(16)
            spacing: Style.space(4)

            Text {
              width: parent.width
              leftPadding: Style.space(16)
              rightPadding: Style.space(16)
              horizontalAlignment: Text.AlignHCenter
              wrapMode: Text.WordWrap
              text: "agent-deck web isn't reachable"
              color: Color.foreground
              font.family: Style.font.family
              font.pixelSize: Style.font.body
            }

            Text {
              width: parent.width
              leftPadding: Style.space(16)
              rightPadding: Style.space(16)
              horizontalAlignment: Text.AlignHCenter
              wrapMode: Text.WordWrap
              text: "Run \"agent-deck web\", or check host/port/token in config.local.json"
              color: root.mutedReadable
              font.family: Style.font.family
              font.pixelSize: Style.font.bodySmall
            }
          }

          // ---- Loading state (first fetch still in flight).
          Text {
            visible: !root.everFetched
            width: parent.width
            leftPadding: Style.space(16)
            rightPadding: Style.space(16)
            topPadding: Style.space(16)
            text: "Loading…"
            color: root.mutedReadable
            font.family: Style.font.family
            font.pixelSize: Style.font.body
          }

          // ---- Empty state (connected, zero sessions).
          Text {
            visible: root.connected && root.snapshot && root.snapshot.totalSessions === 0
            width: parent.width
            leftPadding: Style.space(16)
            rightPadding: Style.space(16)
            topPadding: Style.space(16)
            text: "No sessions"
            color: root.mutedReadable
            font.family: Style.font.family
            font.pixelSize: Style.font.body
          }

          // ---- Session rows.
          Repeater {
            model: root.connected && root.snapshot ? Model.sortedSessions(root.snapshot.sessions) : []

            delegate: Rectangle {
              id: row
              required property var modelData
              property bool justCopied: false
              width: contentColumn.width
              height: rowColumn.implicitHeight + Style.space(12)
              color: rowHover.hovered ? Qt.rgba(root.barForeground.r, root.barForeground.g, root.barForeground.b, 0.08) : "transparent"

              // Hover state for the row as a whole, independent of the two
              // MouseAreas below (rowArea for open-session, copyIconArea for
              // the copy action) — a HoverHandler doesn't take an exclusive
              // grab the way MouseArea does, so it keeps reporting hover
              // correctly even while the pointer sits inside copyIconArea's
              // bounds. Same idiom as weather/Panel.qml's location-edit row.
              HoverHandler {
                id: rowHover
              }

              Column {
                id: rowColumn
                anchors.left: parent.left
                anchors.right: parent.right
                anchors.verticalCenter: parent.verticalCenter
                anchors.leftMargin: Style.space(16)
                anchors.rightMargin: Style.space(16)
                spacing: Style.space(1)

                Row {
                  spacing: Style.space(6)

                  Text {
                    text: Model.glyphForStatus(row.modelData.status)
                    color: Model.statusColorHex(row.modelData.status)
                    font.family: Style.font.family
                    font.pixelSize: Style.font.body
                  }

                  // Tool icon + brand color, ported from agent-deck's own
                  // ToolIcon()/ToolColor() (internal/ui/styles.go) — see
                  // Model.toolIcon/toolColorHex. Most of these render as
                  // color emoji, whose own embedded color wins over `color`
                  // on most systems; the property is still set for the
                  // non-emoji case ("π", pi) and as the correct intent
                  // either way.
                  Text {
                    text: Model.toolIcon(row.modelData.tool)
                    color: Model.toolColorHex(row.modelData.tool)
                    font.family: Style.font.family
                    font.pixelSize: Style.font.body
                  }

                  Text {
                    text: row.modelData.title
                    color: root.barForeground
                    font.family: Style.font.family
                    font.pixelSize: Style.font.body
                    elide: Text.ElideRight
                    // Style.space(72) reserves room for the hover-revealed
                    // copy-attach icon at the row's right edge so it never
                    // sits on top of the title; Math.max(0, …) keeps this
                    // from going negative on a very narrow card.
                    width: Math.max(0, Math.min(implicitWidth, contentColumn.width - Style.space(72)))
                  }
                }

                Text {
                  text: [row.modelData.tool, row.modelData.groupPath, Model.statusLabel(row.modelData.status)]
                    .filter(function(part) { return part && part.length > 0 })
                    .join(" · ")
                  color: root.mutedReadable
                  font.family: Style.font.family
                  font.pixelSize: Style.font.caption
                  elide: Text.ElideRight
                  width: contentColumn.width - Style.space(32)
                }

                // Project name + last-active time: disambiguates two
                // same-titled sessions in different repos, and flags one
                // that's been sitting untouched. Both come straight off the
                // /api/menu response already being polled — no extra
                // request. Hidden entirely when both are empty (e.g. a
                // "shell" session with no lastAccessedAt yet).
                Text {
                  text: [Model.projectName(row.modelData.projectPath), Model.relativeTime(row.modelData.lastAccessedAt, root.nowMs)]
                    .filter(function(part) { return part && part.length > 0 })
                    .join(" · ")
                  visible: text.length > 0
                  color: root.mutedReadable
                  font.family: Style.font.family
                  font.pixelSize: Style.font.caption
                  elide: Text.ElideRight
                  width: contentColumn.width - Style.space(32)
                }

                // The agent's own latest prompt/output, shown only while
                // waiting — that's the one status where "what is it actually
                // stuck on" is worth a line, and it's the status agent-deck
                // seems to populate latestPrompt for.
                Text {
                  visible: row.modelData.status === "waiting" && row.modelData.latestPrompt.length > 0
                  text: "↳ " + row.modelData.latestPrompt
                  color: root.mutedReadable
                  font.family: Style.font.family
                  font.italic: true
                  font.pixelSize: Style.font.caption
                  elide: Text.ElideRight
                  width: contentColumn.width - Style.space(32)
                }
              }

              MouseArea {
                id: rowArea
                // Leaves the same Style.space(72) strip on the right free
                // for copyIconArea below, rather than overlapping it — two
                // adjacent non-overlapping MouseAreas avoid any ambiguity
                // over which one gets a click in the shared region.
                anchors.left: parent.left
                anchors.top: parent.top
                anchors.bottom: parent.bottom
                anchors.right: parent.right
                anchors.rightMargin: Style.space(72)
                cursorShape: Qt.PointingHandCursor
                onClicked: root.openSession(row.modelData.id)
              }

              MouseArea {
                id: copyIconArea
                anchors.right: parent.right
                anchors.top: parent.top
                anchors.bottom: parent.bottom
                width: Style.space(72)
                // Invisible (and, since invisible items aren't hit-tested,
                // inert) outside of a row hover — clicking this strip
                // without hovering first falls through to nothing, which
                // matches there being no icon shown to click.
                visible: rowHover.hovered && row.modelData.tmuxSession.length > 0
                cursorShape: Qt.PointingHandCursor
                onClicked: {
                  root.copyAttachCommand(row.modelData.tmuxSession)
                  row.justCopied = true
                  copiedResetTimer.restart()
                }

                Text {
                  anchors.centerIn: parent
                  text: row.justCopied ? "✓" : "⎘"
                  color: root.mutedReadable
                  font.family: Style.font.family
                  font.pixelSize: Style.font.body
                }
              }

              Timer {
                id: copiedResetTimer
                interval: 1200
                onTriggered: row.justCopied = false
              }
            }
          }
        }
      }
    }
  }
}
