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
  moduleName: "gianni.agent-deck"
  ipcTarget: root.moduleName
  // The base Panel's own IpcHandler (manageIpc: true) would call root.open()
  // for the "open"/"show"/"toggle" IPC methods — but open() below overrides
  // the base's version to also kick a refresh, and dispatch from a handler
  // declared in the base .qml file back into a derived override isn't
  // something to rely on. Every first-party plugin that overrides open()
  // (weather, clock) disables manageIpc and declares its own handler
  // instead, so this does the same.
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
  readonly property string configPath: Quickshell.env("HOME") + "/.config/omarchy/plugins/gianni.agent-deck/config.local.json"
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
  property bool connected: false
  property bool everFetched: false      // false until the first fetch resolves either way

  readonly property var counts: snapshot ? snapshot.counts : null
  readonly property string worstStatus: connected ? Model.worstStatus(counts) : ""
  readonly property string summaryText: connected ? Model.summaryText(counts) : "⚠"
  readonly property string summaryColorKey: connected ? Model.colorKeyForStatus(worstStatus) : "muted"
  readonly property string tooltipText: connected
    ? ("agent-deck: " + snapshot.totalSessions + " session" + (snapshot.totalSessions === 1 ? "" : "s") + " @ " + Model.baseUrl(config))
    : ("agent-deck: not reachable @ " + Model.baseUrl(config))

  function refresh() {
    if (fetchProc.running) return
    fetchProc.command = Model.fetchMenuCommand(root.config)
    fetchProc.running = true
  }

  Process {
    id: fetchProc
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        var parsed = Model.parseMenuResponse(text)
        root.snapshot = parsed
        root.connected = parsed !== null
        root.everFetched = true
      }
    }
  }

  Process {
    id: openProc
    // Fire-and-forget: opens the deep link in the user's default browser.
  }

  function openSession(sessionId) {
    openProc.command = ["xdg-open", Model.sessionUrl(root.config, sessionId)]
    openProc.running = true
  }

  // Maps a Model.colorKeyForStatus() result to an actual theme color.
  // Spelled out rather than indexed off Color dynamically (Color[key]) to
  // keep this file's QML/JS boundary unambiguous.
  function colorForKey(key) {
    switch (key) {
      case "urgent": return Color.urgent
      case "accent": return Color.accent
      case "muted": return Color.muted
      default: return Color.foreground
    }
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
    panelController.show()
    root.refresh()
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
    centerOnBar: true
    focusTarget: keyCatcher
    contentWidth: panel.fittedContentWidth(Style.space(320))
    contentHeight: panel.fittedContentHeight(contentColumn.implicitHeight)

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      onCloseRequested: root.close()
      onTabRequested: function(direction) { root.switchPanel(direction) }

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
            color: Color.muted
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
              color: Color.muted
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
            color: Color.muted
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
            color: Color.muted
            font.family: Style.font.family
            font.pixelSize: Style.font.body
          }

          // ---- Session rows.
          Repeater {
            model: root.connected && root.snapshot ? Model.sortedSessions(root.snapshot.sessions) : []

            delegate: Rectangle {
              id: row
              required property var modelData
              width: contentColumn.width
              height: rowColumn.implicitHeight + Style.space(12)
              color: rowArea.containsMouse ? Qt.rgba(root.barForeground.r, root.barForeground.g, root.barForeground.b, 0.08) : "transparent"

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
                    color: root.colorForKey(Model.colorKeyForStatus(row.modelData.status))
                    font.family: Style.font.family
                    font.pixelSize: Style.font.body
                  }

                  Text {
                    text: row.modelData.title
                    color: root.barForeground
                    font.family: Style.font.family
                    font.pixelSize: Style.font.body
                    elide: Text.ElideRight
                    width: Math.min(implicitWidth, contentColumn.width - Style.space(48))
                  }
                }

                Text {
                  text: [row.modelData.tool, row.modelData.groupPath, Model.statusLabel(row.modelData.status)]
                    .filter(function(part) { return part && part.length > 0 })
                    .join(" · ")
                  color: Color.muted
                  font.family: Style.font.family
                  font.pixelSize: Style.font.caption
                  elide: Text.ElideRight
                  width: contentColumn.width - Style.space(32)
                }
              }

              MouseArea {
                id: rowArea
                anchors.fill: parent
                hoverEnabled: true
                cursorShape: Qt.PointingHandCursor
                onClicked: root.openSession(row.modelData.id)
              }
            }
          }
        }
      }
    }
  }
}
