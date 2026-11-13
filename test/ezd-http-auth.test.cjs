const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { pathToFileURL } = require('node:url')
const { trustedAuth, handleHttpAuth } = require('../electron/ezd-http-auth.cjs')

const details = { url: 'https://ezd.kg.straz.gov.pl/adlogin.aspx' }
const info = { host: 'ezd.kg.straz.gov.pl', port: 443, scheme: 'ntlm', isProxy: false }

test('HTTP credentials are limited to the exact HTTPS EZD challenge', () => {
  assert.equal(trustedAuth(details, info), true)
  for (const url of ['http://ezd.kg.straz.gov.pl/', 'https://ezd.kg.straz.gov.pl.evil.test/', 'https://user@ezd.kg.straz.gov.pl/', 'file:///tmp/test']) {
    assert.equal(trustedAuth({ url }, info), false)
  }
  for (const change of [{ host: 'evil.test' }, { port: 80 }, { isProxy: true }, { scheme: 'unknown' }]) {
    assert.equal(trustedAuth(details, { ...info, ...change }), false)
  }
})

function fixture() {
  const handlers = new Map()
  const callbacks = []
  let window
  let prevented = 0
  class BrowserWindow extends EventEmitter {
    constructor(options) {
      super(); window = this; this.options = options
      this.webContents = Object.assign(new EventEmitter(), { mainFrame: {}, setWindowOpenHandler: fn => { this.openHandler = fn } })
    }
    isDestroyed() { return !!this.destroyed }
    destroy() { this.destroyed = true; this.emit('closed') }
    loadFile(file) { this.webContents.mainFrame.url = pathToFileURL(file).href; return Promise.resolve() }
  }
  handleHttpAuth({ event: { preventDefault() { prevented++ } }, details, info,
    callback: (...args) => callbacks.push(args), BrowserWindow, parent: {},
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler), removeHandler: channel => handlers.delete(channel) } })
  return { window, handlers, callbacks, prevented }
}

test('only its own local main frame can submit a one-time HTTP login', () => {
  const f = fixture()
  const handler = [...f.handlers.values()][0]
  assert.equal(f.prevented, 1)
  assert.equal(f.window.options.webPreferences.sandbox, true)
  assert.deepEqual(f.window.openHandler(), { action: 'deny' })
  const incoming = { sender: f.window.webContents, senderFrame: f.window.webContents.mainFrame }
  const secret = { username: ' DOMENA\\test ', password: 'synthetic-password' }
  assert.throws(() => handler({ ...incoming, sender: {} }, secret), /Niezaufane/)
  assert.throws(() => handler({ ...incoming, senderFrame: { url: incoming.senderFrame.url } }, secret), /Niezaufane/)
  const originalUrl = incoming.senderFrame.url
  incoming.senderFrame.url = details.url
  assert.throws(() => handler(incoming, secret), /Niezaufane/)
  incoming.senderFrame.url = originalUrl
  handler(incoming, secret)
  assert.deepEqual(f.callbacks, [['DOMENA\\test', 'synthetic-password']])
  assert.equal(secret.password, '')
  assert.equal(f.handlers.size, 0)
  assert.equal(f.window.isDestroyed(), true)
  f.window.emit('closed')
  assert.equal(f.callbacks.length, 1)
})

test('closing the login window cancels its challenge and removes the credential channel', () => {
  const f = fixture()
  f.window.destroy()
  assert.deepEqual(f.callbacks, [[undefined, undefined]])
  assert.equal(f.handlers.size, 0)
})
