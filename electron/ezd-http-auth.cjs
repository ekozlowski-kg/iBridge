const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { randomUUID } = require('node:crypto')
const { EZD_ORIGIN } = require('./ezd-inbox-client.cjs')

function trustedAuth(details, info) {
  try {
    const url = new URL(details.url)
    return url.origin === EZD_ORIGIN && !url.username && !url.password && !info.isProxy
      && info.host === new URL(EZD_ORIGIN).hostname && Number(info.port) === 443
      && ['basic', 'digest', 'ntlm', 'negotiate'].includes(String(info.scheme).toLowerCase())
  } catch { return false }
}

function handleHttpAuth({ event, details, info, callback, parent, BrowserWindow, ipcMain }) {
  if (!trustedAuth(details, info)) return
  event.preventDefault()
  const channel = `ezd-auth:${randomUUID()}`
  const file = path.join(__dirname, '..', 'dist', 'ezd-auth.html')
  const expectedUrl = pathToFileURL(file).href
  const window = new BrowserWindow({ parent, modal: true, width: 450, height: 390,
    resizable: false, title: 'Logowanie domenowe EZD',
    webPreferences: { preload: path.join(__dirname, 'ezd-auth-preload.cjs'), additionalArguments: [`--ezd-auth-channel=${channel}`],
      contextIsolation: true, nodeIntegration: false, sandbox: true } })
  let completed = false
  const finish = (username, password) => {
    if (completed) return
    completed = true
    ipcMain.removeHandler(channel)
    callback(username, password)
    if (!window.isDestroyed()) window.destroy()
  }
  ipcMain.handle(channel, (incoming, value) => {
    if (incoming.sender !== window.webContents || incoming.senderFrame !== window.webContents.mainFrame
      || incoming.senderFrame.url !== expectedUrl) throw new Error('Niezaufane okno logowania.')
    if (value?.cancel === true) { finish(); return }
    if (typeof value?.username !== 'string' || !value.username.trim() || value.username.length > 256
      || typeof value?.password !== 'string' || !value.password || value.password.length > 1024) throw new Error('Uzupełnij login i hasło.')
    const username = value.username.trim()
    let password = value.password
    value.password = ''
    finish(username, password)
    password = null
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', navigation => navigation.preventDefault())
  window.on('closed', () => finish())
  window.loadFile(file).catch(() => finish())
}

module.exports = { trustedAuth, handleHttpAuth }
