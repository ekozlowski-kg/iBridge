function trayStatusFromState(state) {
  const remoteSessions = (state?.sessions || []).filter((session) => session.remote && session.remote.operation !== 'signature' && session.remote.status !== 'sent')
  if (remoteSessions.some(s => s.remote.recoveryRequired)) return 'Zmiany czekają na wysłanie — otwórz aplikację'
  if (remoteSessions.some((session) => session.remote?.syncStatus === 'error')) {
    return 'Błąd synchronizacji — otwórz aplikację'
  }
  if (remoteSessions.some((session) => ['pending', 'syncing'].includes(session.remote?.syncStatus))) {
    return 'Synchronizacja z EZD…'
  }
  if (remoteSessions.some((session) => session.remote?.syncStatus === 'synced')) {
    return 'Dokumenty zsynchronizowane'
  }
  return 'Praca w tle aktywna'
}

function createTrayController({
  Tray,
  Menu,
  nativeImage,
  iconPath,
  applicationName,
  onOpen,
  onOpenInbox = () => {},
  onQuit,
}) {
  const image = nativeImage.createFromPath(iconPath)
  image.setTemplateImage(true)
  const tray = new Tray(image)
  let status = 'Praca w tle aktywna'
  let inbox = null

  function rebuildMenu() {
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: `Otwórz ${applicationName}`, click: onOpen },
      { type: 'separator' },
      { label: status, enabled: false },
      { label: inbox?.message || 'Powiadomienia EZD: wyłączone', enabled: false },
      { label: 'Otwórz EZD w iBridge', click: onOpenInbox },
      { type: 'separator' },
      { label: `Zakończ ${applicationName}`, click: onQuit },
    ]))
  }

  tray.setToolTip(applicationName)
  tray.on('click', onOpen)
  rebuildMenu()

  return {
    tray,
    updateInbox(state) { inbox = state; rebuildMenu() },
    updateStatus(nextStatus) {
      status = String(nextStatus || 'Praca w tle aktywna')
      rebuildMenu()
    },
    updateState(state) {
      status = trayStatusFromState(state)
      rebuildMenu()
    },
    dispose() {
      tray.destroy()
    },
  }
}

module.exports = { createTrayController, trayStatusFromState }
