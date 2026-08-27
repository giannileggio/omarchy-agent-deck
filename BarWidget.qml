import QtQuick
import qs.Commons
import qs.Ui

// Compact bar glyph. All state (config, polling, connectivity) lives in
// Panel.qml, loaded here via panelLoader and always active — this file only
// reads panelLoader.item's exposed properties and forwards bar chrome down
// to it, matching the first-party bar-widget+panel plugins (clock, weather).
BarWidget {
  id: root
  moduleName: "gianni.agent-deck"

  function injectPanel() {
    var target = panelLoader.item
    if (!target) return
    if ("bar" in target) target.bar = root.bar
    if ("settings" in target) target.settings = root.settings
    if ("anchorItem" in target) target.anchorItem = button
    if ("hostWidget" in target) target.hostWidget = root
  }

  function refresh() {
    if (panelLoader.item && panelLoader.item.refresh) panelLoader.item.refresh()
  }

  function togglePanel() {
    if (panelLoader.item && panelLoader.item.toggle) panelLoader.item.toggle()
  }

  // Shape contract for shell.summon/hide/toggle routing (Bar.findPanelWidget
  // requires open/close/opened on the bar-widget root).
  readonly property bool opened: panelLoader.item ? panelLoader.item.opened === true : false

  function open() {
    if (panelLoader.item && panelLoader.item.open) panelLoader.item.open()
  }

  function close() {
    if (panelLoader.item && panelLoader.item.close) panelLoader.item.close()
  }

  readonly property bool popoutSwitchClosing: panelLoader.item ? panelLoader.item.popoutSwitchClosing === true : false

  function closeForPopoutSwitch() {
    if (panelLoader.item) panelLoader.item.closeForPopoutSwitch()
  }

  readonly property bool connected: panelLoader.item ? panelLoader.item.connected === true : false
  readonly property string summaryText: panelLoader.item ? panelLoader.item.summaryText : "…"
  readonly property color summaryColor: panelLoader.item
    ? panelLoader.item.colorForKey(panelLoader.item.summaryColorKey)
    : Color.muted

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  onBarChanged: injectPanel()
  onSettingsChanged: injectPanel()

  Loader {
    id: panelLoader
    active: true
    source: Qt.resolvedUrl("Panel.qml")
    visible: false
    onLoaded: {
      root.injectPanel()
      Qt.callLater(root.injectPanel)
    }
  }

  WidgetButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    text: root.summaryText
    foreground: root.summaryColor
    useActiveColor: false
    tooltipText: panelLoader.item ? panelLoader.item.tooltipText : "agent-deck"

    onPressed: function(b) {
      if (b === Qt.MiddleButton) root.refresh()
      else root.togglePanel()
    }
  }
}
