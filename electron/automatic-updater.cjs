const fs = require('node:fs/promises')
const path = require('node:path')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const execute = promisify(execFile)
const DAY = 24 * 60 * 60 * 1000
const RETRY = 15 * 60 * 1000
const REPOSITORY_URL = 'https://github.com/ekozlowski-kg/iBridge'

function feedUrl(arch) {
  if (!['arm64', 'x64'].includes(arch)) throw new Error('Nieobsługiwana architektura aktualizacji.')
  return `${REPOSITORY_URL}/releases/latest/download/RELEASES-darwin-${arch}.json`
}

async function updateSupport({ isPackaged, platform = process.platform, arch = process.arch,
  execPath = process.execPath, configPath, run = execute }) {
  if (platform !== 'darwin' || !isPackaged) return { enabled: false, reason: 'development' }
  try {
    feedUrl(arch)
    const config = JSON.parse(await fs.readFile(configPath, 'utf8'))
    if (config.enabled !== true || !/^[A-Z0-9]{10}$/.test(config.teamId)) throw new Error('configuration')
    const bundle = path.resolve(execPath, '../../..')
    if (!bundle.endsWith('.app')) throw new Error('bundle')
    await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle], { timeout: 30000 })
    const { stderr = '' } = await run('/usr/bin/codesign', ['-dv', '--verbose=4', bundle], { timeout: 10000 })
    if (!stderr.includes('Authority=Developer ID Application:')
        || !stderr.split(/\r?\n/).includes(`TeamIdentifier=${config.teamId}`)
        || stderr.includes('Signature=adhoc')) throw new Error('signature')
    return { enabled: true, url: feedUrl(arch) }
  } catch { return { enabled: false, reason: 'signing-required' } }
}

// Squirrel downloads and verifies signed updates, then installs on normal quit.
// Downloading never interrupts document editing or starts a browser.
class AutomaticUpdater {
  constructor({ nativeUpdater, currentVersion, support, onChange = () => {},
    canRestart = async () => false, requestQuit = () => {}, now = Date.now,
    setTimer = setInterval, clearTimer = clearInterval }) {
    Object.assign(this, { nativeUpdater, currentVersion, support, onChange, canRestart,
      requestQuit, now, setTimer, clearTimer })
    this.state = { status: support.enabled ? 'not-checked' : 'setup-required',
      currentVersion, automatic: support.enabled, reason: support.reason }
    this.listeners = []
    this.timer = null
    this.started = false
    this.closed = false
    this.ready = false
    this.restartRequested = false
    this.restartInFlight = null
  }
  snapshot() { return { ...this.state } }
  publish(patch) {
    this.state = { ...this.state, ...patch }
    this.onChange(this.snapshot())
    return this.snapshot()
  }
  async start() {
    if (this.started || this.closed) return this.snapshot()
    this.started = true
    if (!this.support.enabled) return this.publish({ status: 'setup-required' })
    const on = (event, callback) => {
      this.listeners.push([event, callback])
      this.nativeUpdater.on(event, callback)
    }
    on('error', () => {
      if (this.closed) return
      // Never expose arbitrary native errors/paths in the renderer.
      this.ready = false
      this.publish({ status: 'unavailable', checkedAt: this.now() })
    })
    on('checking-for-update', () => this.publish({ status: 'checking' }))
    on('update-available', () => this.publish({ status: 'downloading' }))
    on('update-not-available', () => this.publish({ status: 'current', checkedAt: this.now() }))
    on('update-downloaded', (_event, _notes, releaseName) => {
      this.ready = true
      this.publish({ status: 'ready', checkedAt: this.now(),
        latestVersion: typeof releaseName === 'string' ? releaseName.slice(0, 80) : undefined })
    })
    try {
      this.nativeUpdater.setFeedURL({ url: this.support.url, serverType: 'json' })
      this.timer = this.setTimer(() => this.check(false), 60 * 60 * 1000)
      this.timer?.unref?.()
      return this.check(true)
    } catch { return this.publish({ status: 'unavailable', checkedAt: this.now() }) }
  }
  check(force = false) {
    if (this.closed || !this.support.enabled || !this.started) return this.snapshot()
    // A second native check would start another download. Never do that.
    if (this.ready || ['checking', 'downloading'].includes(this.state.status)) return this.snapshot()
    const interval = this.state.status === 'unavailable' ? RETRY : DAY
    if (!force && Number.isFinite(this.state.checkedAt)
        && this.now() - this.state.checkedAt < interval) return this.snapshot()
    this.publish({ status: 'checking' })
    try { this.nativeUpdater.checkForUpdates() }
    catch { this.publish({ status: 'unavailable', checkedAt: this.now() }) }
    return this.snapshot()
  }
  requestRestart() {
    if (this.restartInFlight) return this.restartInFlight
    this.restartInFlight = this.tryRestart().finally(() => { this.restartInFlight = null })
    return this.restartInFlight
  }
  async tryRestart() {
    if (this.closed || !this.ready || this.restartRequested) return this.snapshot()
    try {
      if (!await this.canRestart()) return this.publish({ status: 'waiting-for-documents' })
      if (this.closed || !this.ready) return this.snapshot()
      this.restartRequested = true
      this.publish({ status: 'restarting' })
      this.requestQuit()
    } catch {
      this.restartRequested = false
      this.publish({ status: 'ready' })
    }
    return this.snapshot()
  }
  // Called only AFTER the existing quit handler has persisted data and drained
  // document/signature work. Native quitAndInstall closes windows immediately.
  installAfterCleanup() {
    if (!this.restartRequested || !this.ready) return false
    this.restartRequested = false
    try {
      this.nativeUpdater.quitAndInstall()
      return true
    } catch { return false }
  }
  cancelRestart() {
    this.restartRequested = false
    if (this.ready && !this.closed) this.publish({ status: 'waiting-for-documents' })
  }
  close() {
    this.closed = true
    this.clearTimer(this.timer)
    // Keep the error listener through process shutdown: a late native error
    // must not become an unhandled EventEmitter error during document cleanup.
    for (const [event, listener] of this.listeners) {
      if (event !== 'error') this.nativeUpdater.removeListener(event, listener)
    }
    this.listeners = []
  }
}
module.exports = { AutomaticUpdater, updateSupport, feedUrl, DAY, RETRY }
