const fsp = require('node:fs/promises')
const path = require('node:path')
const { itemKey } = require('./ezd-inbox-client.cjs')

const MESSAGES = {
  disabled: 'Powiadomienia wyłączone.', checking: 'Sprawdzanie nowych pism…',
  ready: 'Sprawdzanie w tle aktywne · co 60 sekund.',
  'login-required': 'Zaloguj się do EZD w oknie iBridge.',
  'account-changed': 'Konto lub stanowisko zmieniło się. Potwierdź wybór konta w ustawieniach.',
  schema: 'EZD zwróciło nierozpoznane dane. Sprawdzanie nie zostało potwierdzone.',
  incomplete: 'Lista zmieniła się podczas odczytu. iBridge ponowi sprawdzenie.',
  'connection-error': 'Brak połączenia z EZD. iBridge ponowi próbę w tle.',
  'storage-error': 'Nie można zapisać stanu powiadomień. Sprawdź dostęp do katalogu danych.',
  'notification-error': 'Nie potwierdzono wyświetlenia alertu. Sprawdź powiadomienia iBridge w ustawieniach macOS.',
}

class EzdInboxMonitor {
  constructor({ client, directory, notify, onChange = () => {}, intervalMs = 60_000 }) {
    Object.assign(this, { client, notify, onChange, intervalMs })
    this.file = path.join(directory, 'ezd-inbox.json')
    this.data = { enabled: false, context: null, keys: null, eventKeys: null, pending: 0, eventPending: 0 }
    this.status = 'disabled'
    this.lastCheckAt = null
    this.running = null
    this.generation = 0
    this.failures = 0
    this.closed = false
    this.controls = Promise.resolve()
    this.writes = Promise.resolve()
  }
  snapshot() {
    return { enabled: this.data.enabled, status: this.status, message: MESSAGES[this.status],
      account: this.data.context?.label || '', count: this.data.keys?.length ?? null, lastCheckAt: this.lastCheckAt }
  }
  emit(status) { this.status = status; this.onChange(this.snapshot()) }
  async init() {
    try {
      const data = JSON.parse(await fsp.readFile(this.file, 'utf8'))
      if (typeof data.enabled !== 'boolean' || !(data.keys === null || (Array.isArray(data.keys) && data.keys.length <= 50_000 && data.keys.every(k => typeof k === 'string' && k.length < 512)))
        || !(data.context === null || (typeof data.context?.key === 'string' && typeof data.context?.label === 'string'))
        || !Number.isSafeInteger(data.pending) || data.pending < 0) throw new Error('Invalid state')
      if (!(data.eventKeys === null || (Array.isArray(data.eventKeys) && data.eventKeys.length <= 10_000 && data.eventKeys.every(k => typeof k === 'string' && k.length < 512)))
        || !Number.isSafeInteger(data.eventPending) || data.eventPending < 0) throw new Error('Invalid event state')
      this.data = data
    } catch (error) { if (error.code !== 'ENOENT') { this.emit('storage-error'); return } }
    if (this.data.enabled) this.check()
  }
  persist() {
    const content = JSON.stringify(this.data)
    const saving = this.writes.catch(() => {}).then(async () => {
      await fsp.mkdir(path.dirname(this.file), { recursive: true })
      const temp = `${this.file}.tmp`
      await fsp.writeFile(temp, content, { mode: 0o600 })
      await fsp.rename(temp, this.file)
    })
    this.writes = saving
    return saving
  }
  setEnabled(enabled) {
    if (typeof enabled !== 'boolean') throw new Error('Nieprawidłowe ustawienie.')
    const generation = ++this.generation
    clearTimeout(this.timer)
    this.controller?.abort()
    const operation = this.controls.catch(() => {}).then(async () => {
      await this.running
      this.data.enabled = enabled
      await this.persist()
      if (enabled && generation === this.generation) return this.check()
      if (!enabled) this.emit('disabled')
      return this.snapshot()
    })
    this.controls = operation
    return operation
  }
  rebind() {
    const generation = ++this.generation
    clearTimeout(this.timer)
    this.controller?.abort()
    const operation = this.controls.catch(() => {}).then(async () => {
      await this.running
      // The next complete snapshot becomes the baseline, with no alerts for its existing items.
      this.data.context = null
      this.data.keys = null
      this.data.pending = 0
      this.data.eventKeys = null
      this.data.eventPending = 0
      await this.persist()
      return generation === this.generation ? this.check() : this.snapshot()
    })
    this.controls = operation
    return operation
  }
  check() {
    if (this.closed || !this.data.enabled) return Promise.resolve(this.snapshot())
    if (this.running) return this.running
    clearTimeout(this.timer)
    const generation = this.generation
    this.controller = new AbortController()
    const timeout = setTimeout(() => this.controller?.abort(), 45_000)
    const signal = this.controller.signal
    this.running = this.cycle(signal, generation).finally(() => {
      clearTimeout(timeout)
      this.running = null
      if (!this.closed && this.data.enabled && generation === this.generation && !['login-required', 'account-changed', 'storage-error'].includes(this.status)) {
        this.timer = setTimeout(() => this.check(), Math.min(this.intervalMs * 2 ** this.failures, 15 * 60_000))
        this.timer.unref?.()
      }
    })
    return this.running
  }
  async cycle(signal, generation) {
    this.emit('checking')
    try {
      const snapshot = await this.client.snapshot(signal, this.data.context?.key)
      if (this.closed || signal.aborted || generation !== this.generation) return this.snapshot()
      // Check here too: clients supplied by tests/integrations must not cross account boundaries.
      if (this.data.context && this.data.context.key !== snapshot.context.key) {
        this.emit('account-changed'); return this.snapshot()
      }
      const keys = snapshot.items.map(itemKey)
      const previous = new Set(this.data.keys || [])
      const added = this.data.keys === null ? [] : keys.filter(key => !previous.has(key))
      const addedKeys = new Set(added)
      const newItemIds = new Set(snapshot.items.filter(item => addedKeys.has(itemKey(item))).map(item => item.id))
      const events = snapshot.events || []
      const knownEvents = new Set(this.data.eventKeys || [])
      const newEvents = this.data.eventKeys === null ? [] : events.filter(event => !knownEvents.has(event.key) && !newItemIds.has(event.pismoId))
      const eventKeys = [...new Set([...knownEvents, ...events.map(event => event.key)])].slice(-10_000)
      const oldData = structuredClone(this.data)
      this.data = { ...this.data, context: snapshot.context, keys, eventKeys,
        pending: this.data.pending + added.length, eventPending: this.data.eventPending + newEvents.length }
      try { await this.persist() } catch { this.data = oldData; this.emit('storage-error'); return this.snapshot() }
      if (this.closed || signal.aborted || generation !== this.generation) return this.snapshot()
      if (this.data.pending || this.data.eventPending) {
        try { await this.notify({ count: this.data.pending, ...(this.data.eventPending ? { eventCount: this.data.eventPending } : {}) }) }
        catch { const error = new Error('Notification failed'); error.code = 'notification-error'; throw error }
        this.data.pending = 0
        this.data.eventPending = 0
        await this.persist()
      }
      this.lastCheckAt = new Date().toISOString()
      this.failures = 0
      this.emit('ready')
    } catch (error) {
      if (this.closed || generation !== this.generation) return this.snapshot()
      this.failures = Math.min(this.failures + 1, 4)
      this.emit(Object.hasOwn(MESSAGES, error.code) ? error.code : 'connection-error')
    }
    return this.snapshot()
  }
  async close() {
    this.closed = true
    this.generation++
    clearTimeout(this.timer)
    this.controller?.abort()
    await this.running
    await this.controls.catch(() => {})
    await this.writes.catch(() => {})
  }
}
module.exports = { EzdInboxMonitor }
