const { EZD_ORIGIN, INBOX_URL } = require('./ezd-inbox-client.cjs')
const { handleHttpAuth } = require('./ezd-http-auth.cjs')

function trustedUrl(raw) {
  try {
    const url = new URL(raw)
    return url.origin === EZD_ORIGIN && !url.username && !url.password
  } catch { return false }
}

function createInboxWindowController({ BrowserWindow, session, ipcMain, onLoaded = () => {} }) {
  const inboxSession = session.fromPartition('persist:ezd-inbox')
  inboxSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  inboxSession.setPermissionCheckHandler(() => false)
  // Only this dedicated EZD session is restricted; document-editing sessions are separate.
  inboxSession.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !trustedUrl(details.url) })
  })
  inboxSession.on('will-download', event => event.preventDefault())
  let window = null
  return {
    session: inboxSession,
    open() {
      if (window && !window.isDestroyed()) { window.show(); window.focus(); window.reload(); return }
      window = new BrowserWindow({ width: 1100, height: 760, title: 'EZD — konto iBridge',
        webPreferences: { session: inboxSession, nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true } })
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      window.webContents.on('login', (event, details, info, callback) => {
        handleHttpAuth({ event, details, info, callback, parent: window, BrowserWindow, ipcMain })
      })
      for (const event of ['will-navigate', 'will-redirect']) {
        window.webContents.on(event, (navigation, url) => { if (!trustedUrl(url)) navigation.preventDefault() })
      }
      window.webContents.on('did-finish-load', () => { if (trustedUrl(window?.webContents.getURL())) onLoaded() })
      window.on('closed', () => { window = null })
      window.loadURL(INBOX_URL).catch(() => {})
    },
    close() { window?.destroy(); window = null },
  }
}
module.exports = { createInboxWindowController, trustedUrl }
