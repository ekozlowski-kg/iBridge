const fs = require('node:fs/promises')
const path = require('node:path')
const RELEASES_URL = 'https://api.github.com/repos/ekozlowski-kg/iBridge/releases/latest'
const REPOSITORY_URL = 'https://github.com/ekozlowski-kg/iBridge'
const DAY = 24 * 60 * 60 * 1000
function versionParts(value) {
  const m = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(String(value))
  return m ? m.slice(1).map(BigInt) : null
}
function newer(a, b) {
  const aa = versionParts(a), bb = versionParts(b)
  if (!aa || !bb) return false
  for (let i=0;i<3;i++) { if (aa[i] !== bb[i]) return aa[i] > bb[i] }
  return false
}
function releaseUrl(tag) { return `${REPOSITORY_URL}/releases/tag/${encodeURIComponent(tag)}` }
class UpdateChecker {
  constructor({ currentVersion, directory, fetchImpl = globalThis.fetch, now = Date.now, onChange = () => {} }) {
    Object.assign(this, { currentVersion, fetchImpl, now, onChange })
    this.cachePath = path.join(directory, 'aktualizacje.json')
    this.state = { status: 'not-checked', currentVersion }
    this.inFlight = null
    this.timer = null
  }
  snapshot() { return { ...this.state, currentVersion: this.currentVersion } }
  async start() {
    try {
      const cached = JSON.parse(await fs.readFile(this.cachePath, 'utf8'))
      if (['available','current','no-releases'].includes(cached.status)
          && Number.isFinite(cached.checkedAt) && cached.checkedAt <= this.now()
          && this.now()-cached.checkedAt < DAY) {
        this.state = { status: cached.status, currentVersion: this.currentVersion, checkedAt: cached.checkedAt }
        if (versionParts(cached.latestVersion)) {
          this.state.latestVersion = cached.latestVersion
          this.state.status = newer(cached.latestVersion, this.currentVersion) ? 'available' : 'current'
          this.state.url = releaseUrl(cached.latestVersion)
        }
        this.onChange(this.snapshot())
      }
    } catch {}
    this.check(false).catch(() => {})
    this.timer = setInterval(() => this.check(false).catch(() => {}), 60 * 60 * 1000)
    this.timer.unref?.()
  }
  check(force = false) {
    if (this.inFlight) return this.inFlight
    if (!force && this.state.checkedAt && this.now()-this.state.checkedAt < DAY) return Promise.resolve(this.snapshot())
    this.inFlight = this.run().finally(() => { this.inFlight = null })
    return this.inFlight
  }
  async run() {
    this.state = { ...this.state, status: 'checking' }; this.onChange(this.snapshot())
    try {
      const response = await this.fetchImpl(RELEASES_URL, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'EZD-iBridge' }, redirect: 'error', signal: AbortSignal.timeout(8000) })
      if (response.status === 404) this.state = { status: 'no-releases', checkedAt: this.now() }
      else {
        if (!response.ok) throw new Error('GitHub nie udostępnił informacji o wydaniu.')
        if (Number(response.headers.get('content-length')) > 256 * 1024) throw new Error('Odpowiedź jest zbyt duża.')
        const reader = response.body?.getReader?.()
        let text = ''
        if (reader) {
          let count = 0; const parts = []
          for (;;) { const {done,value} = await reader.read(); if (done) break; count += value.byteLength; if (count > 256*1024) { await reader.cancel(); throw new Error('Odpowiedź jest zbyt duża.') }; parts.push(Buffer.from(value)) }
          text = Buffer.concat(parts).toString('utf8')
        } else { text = await response.text(); if (Buffer.byteLength(text) > 256*1024) throw new Error('Odpowiedź jest zbyt duża.') }
        const release = JSON.parse(text)
        if (release.draft || release.prerelease || !versionParts(release.tag_name)) throw new Error('Brak prawidłowego wydania stabilnego.')
        this.state = { status: newer(release.tag_name, this.currentVersion) ? 'available' : 'current', latestVersion: release.tag_name, checkedAt: this.now(), url: releaseUrl(release.tag_name) }
      }
      await fs.mkdir(path.dirname(this.cachePath), { recursive: true })
      const tmp = `${this.cachePath}.${process.pid}.tmp`
      try { await fs.writeFile(tmp, JSON.stringify(this.state), { mode: 0o600 }); await fs.rename(tmp, this.cachePath) }
      finally { await fs.rm(tmp, { force: true }).catch(() => {}) }
    } catch { this.state = { status: 'unavailable', checkedAt: this.now() } }
    this.onChange(this.snapshot())
    return this.snapshot()
  }
  close() { clearInterval(this.timer) }
}
module.exports = { UpdateChecker, newer, RELEASES_URL, REPOSITORY_URL, releaseUrl }
