const fs = require('node:fs/promises')
const path = require('node:path')

function permissionState(value) {
  if (value?.authorization === 0) return 'not-determined'
  if (value?.authorization === 1) return 'denied'
  if (value?.authorization === 3) return 'quiet'
  if ([2, 4].includes(value?.authorization)) return value.alerts ? 'granted' : 'quiet'
  return 'unknown'
}

class NotificationPermissions {
  constructor({ directory, native, prompt, openSettings, onChange = () => {} }) {
    Object.assign(this, { native, prompt, openSettings, onChange })
    this.file = path.join(directory, 'notification-setup.json')
    this.state = 'unknown'
    this.requesting = null
  }
  snapshot() { return { status: this.state } }
  async call(method) {
    if (!this.native) return { authorization: -1 }
    return new Promise((resolve, reject) => {
      let timeout
      if (method !== 'request') timeout = setTimeout(() => reject(new Error('Notification check timed out')), 5000)
      try { this.native[method](value => { clearTimeout(timeout); resolve(value) }) }
      catch (error) { clearTimeout(timeout); reject(error) }
    })
  }
  async refresh() {
    try { this.state = permissionState(await this.call('get')) } catch { this.state = 'unknown' }
    this.onChange(this.snapshot())
    return this.snapshot()
  }
  async delivered() {
    try { const value = await this.call('delivered'); return Array.isArray(value) ? value : null } catch { return null }
  }
  enable() {
    if (this.requesting) return this.requesting
    this.requesting = this.enableOnce().finally(() => { this.requesting = null })
    return this.requesting
  }
  async enableOnce() {
    await this.refresh()
    if (this.state === 'not-determined') {
      // macOS may leave its consent banner pending. Keep the app usable while awaiting it.
      if (!this.nativeRequest) {
        const pending = this.call('request')
        this.nativeRequest = pending
        pending.then(() => this.refresh()).catch(() => this.refresh()).finally(() => {
          if (this.nativeRequest === pending) this.nativeRequest = null
        })
      }
      return this.refresh()
    }
    if (this.state !== 'granted') await this.openSettings()
    return this.snapshot()
  }
  async onboard() {
    await this.refresh()
    try { if (JSON.parse(await fs.readFile(this.file, 'utf8')).version === 1) return } catch {}
    const accepted = this.state === 'granted' || await this.prompt()
    // "Later" suppresses the startup prompt, while leaving a visible reminder in settings.
    await fs.mkdir(path.dirname(this.file), { recursive: true })
    await fs.writeFile(`${this.file}.tmp`, JSON.stringify({ version: 1 }), { mode: 0o600 })
    await fs.rename(`${this.file}.tmp`, this.file)
    if (accepted && this.state !== 'granted') await this.enable()
  }
}

function loadNativePermissions() {
  if (process.platform !== 'darwin') return null
  try { return require('./native/notification-permissions.node') } catch { return null }
}

module.exports = { NotificationPermissions, permissionState, loadNativePermissions }
