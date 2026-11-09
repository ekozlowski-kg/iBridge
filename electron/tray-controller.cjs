function trayStatusFromState(state) {
  const remoteSessions = (state?.sessions || []).filter((session) => session.remote && session.remote.operation !== 'signature' && session.remote.status !== 'sent')
  if (remoteSessions.some(s => s.remote.finishStatus === 'error')) return 'Nie potwierdzono zakończenia sesji EZD'
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
  onQuit,
  onFinish = () => {},
}) {
  const image = nativeImage.createFromPath(iconPath)
  image.setTemplateImage(true)
  const tray = new Tray(image)
  let status = 'Praca w tle aktywna'
  let sessions = []

  function rebuildMenu() {
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: `Otwórz ${applicationName}`, click: onOpen },
      { type: 'separator' },
      { label: status, enabled: false },
      ...sessions.map(session => ({
        label: `Zakończ edycję: ${String(session.name).slice(0, 80)}`,
        click: () => onFinish(session.id),
      })),
      { type: 'separator' },
      { label: `Zakończ ${applicationName}`, click: onQuit },
    ]))
  }

  tray.setToolTip(applicationName)
  tray.on('click', onOpen)
  rebuildMenu()

  return {
    tray,
    updateStatus(nextStatus) {
      status = String(nextStatus || 'Praca w tle aktywna')
      rebuildMenu()
    },
    updateState(state) {
      sessions = (state?.sessions || []).filter(s => s.remote?.operation !== 'signature'
        && s.remote?.connectionStatus === 'active' && s.remote?.status !== 'sent')
      status = trayStatusFromState(state)
      rebuildMenu()
    },
    dispose() {
      tray.destroy()
    },
  }
}

module.exports = { createTrayController, trayStatusFromState }
