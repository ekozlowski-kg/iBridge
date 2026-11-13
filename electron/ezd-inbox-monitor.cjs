const fsp = require('node:fs/promises')
const path = require('node:path')
const { itemKey } = require('./ezd-inbox-client.cjs')

const MESSAGES = {
  disabled: 'Powiadomienia wyłączone.', checking: 'Sprawdzanie nowych pism…',
  ready: 'Sygnał „Nowe pisma” aktywny · sprawdzanie co 30 sekund.',
  'login-required': 'Zaloguj się do EZD w oknie iBridge.',
  'account-changed': 'Konto lub stanowisko zmieniło się. Potwierdź wybór konta w ustawieniach.',
  schema: 'EZD zwróciło nierozpoznane dane. Sprawdzanie nie zostało potwierdzone.',
  incomplete: 'Lista zmieniła się podczas odczytu. iBridge ponowi sprawdzenie.',
  'connection-error': 'Brak połączenia z EZD. iBridge ponowi próbę w tle.',
  'storage-error': 'Nie można zapisać stanu powiadomień. Sprawdź dostęp do katalogu danych.',
  'notification-error': 'Nie potwierdzono wyświetlenia alertu. Sprawdź powiadomienia iBridge w ustawieniach macOS.',
}

class EzdInboxMonitor {
  constructor({ client, directory, notify, onChange = () => {}, intervalMs = 30_000 }) {
    Object.assign(this, { client, notify, onChange, intervalMs })
    this.file = path.join(directory, 'ezd-inbox.json')
    this.data = { enabled: true, context: null, keys: null, eventKeys: null, signalKeys: [], primaryRecent: {}, pending: 0, eventPending: 0 }
    this.status = 'disabled'
    this.lastCheckAt = null
    this.running = null
    this.generation = 0
    this.failures = 0
    this.closed = false
    this.controls = Promise.resolve()
    this.writes = Promise.resolve()
    this.supplementError = false
  }
  snapshot() {
    return { enabled: this.data.enabled, status: this.status, message: MESSAGES[this.status],
      account: this.data.context?.label || '', count: this.data.keys?.length ?? null, lastCheckAt: this.lastCheckAt,
      supplementError: this.supplementError }
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
      data.signalKeys ??= []
      data.primaryRecent ??= {}
      if (!Array.isArray(data.signalKeys) || data.signalKeys.length > 50_000 || !data.signalKeys.every(id => typeof id === 'string' && /^[1-9]\d{0,15}$/.test(id))
        || !data.primaryRecent || Array.isArray(data.primaryRecent) || typeof data.primaryRecent !== 'object'
        || Object.keys(data.primaryRecent).length > 50_000 || !Object.entries(data.primaryRecent).every(([id, time]) => /^[1-9]\d{0,15}$/.test(id) && Number.isFinite(time))) throw new Error('Invalid signal state')
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
      // Supplementary lists get a silent baseline; a nonempty primary signal can alert immediately.
      this.data.context = null
      this.data.keys = null
      this.data.pending = 0
      this.data.eventKeys = null
      this.data.eventPending = 0
      this.data.signalKeys = []
      this.data.primaryRecent = {}
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
    const started = Date.now()
    this.controller = new AbortController()
    const timeout = setTimeout(() => this.controller?.abort(), 25_000)
    const signal = this.controller.signal
    this.running = this.cycle(signal, generation).finally(() => {
      clearTimeout(timeout)
      this.running = null
      if (!this.closed && this.data.enabled && generation === this.generation && !['login-required', 'account-changed', 'storage-error'].includes(this.status)) {
        const cadence = this.intervalMs
        this.timer = setTimeout(() => this.check(), Math.max(1, cadence - (Date.now() - started)))
        this.timer.unref?.()
      }
    })
    return this.running
  }
  async cycle(signal, generation) {
    this.emit('checking')
    try {
      const snapshot = await this.client.snapshot(signal, this.data.context?.key)
      await this.acceptSnapshot(snapshot, signal, generation)
      if (this.closed || signal.aborted || generation !== this.generation) return this.snapshot()
      this.lastCheckAt = new Date().toISOString()
      this.failures = 0
      this.emit('ready')
      // Deliver and durably record the primary signal BEFORE any supplementary request.
      if (typeof this.client.supplement === 'function') {
        let extra
        try {
          const extraSignal = AbortSignal.any([signal, AbortSignal.timeout(8_000)])
          extra = await this.client.supplement(extraSignal, snapshot.context.key)
          this.supplementError = false
        } catch { this.supplementError = true }
        if (extra) await this.acceptSnapshot(extra, signal, generation)
        if (!this.closed && !signal.aborted && generation === this.generation) this.emit('ready')
      }
    } catch (error) {
      if (this.closed || generation !== this.generation) return this.snapshot()
      this.failures = Math.min(this.failures + 1, 4)
      this.emit(Object.hasOwn(MESSAGES, error.code) ? error.code : 'connection-error')
    }
    return this.snapshot()
  }
  async acceptSnapshot(snapshot, signal, generation) {
      if (this.closed || signal.aborted || generation !== this.generation) return this.snapshot()
      // Check here too: clients supplied by tests/integrations must not cross account boundaries.
      if (this.data.context && this.data.context.key !== snapshot.context.key) {
        const error = new Error('Context changed'); error.code = 'account-changed'; throw error
      }
      const keys = snapshot.items ? snapshot.items.map(itemKey) : this.data.keys
      const previous = new Set(this.data.keys || [])
      const added = this.data.keys === null || !snapshot.items ? [] : keys.filter(key => !previous.has(key))
      const addedKeys = new Set(added)
      const now = Date.now()
      const primaryRecent = Object.fromEntries(Object.entries(this.data.primaryRecent).filter(([, time]) => now - time < 5 * 60_000 && time <= now))
      const signalKeys = snapshot.primaryItems ? snapshot.primaryItems.map(item => item.id) : this.data.signalKeys
      const previousSignal = new Set(this.data.signalKeys)
      const newPrimaryIds = snapshot.primaryItems ? signalKeys.filter(id => !previousSignal.has(id)) : []
      const newItemIds = new Set((snapshot.items || []).filter(item => addedKeys.has(itemKey(item)) && !Object.hasOwn(primaryRecent, item.id)).map(item => item.id))
      for (const id of newPrimaryIds) { newItemIds.add(id); primaryRecent[id] = now }
      const events = snapshot.events || []
      const knownEvents = new Set(this.data.eventKeys || [])
      const newEvents = this.data.eventKeys === null ? [] : events.filter(event => {
        if (knownEvents.has(event.key)) return false
        const incomingTransfer = /^Przekaz(?:anie|ano|ał)/i.test(event.description || '')
        // A new version/signature on that same pismo is a distinct event, not a duplicate arrival.
        return !(incomingTransfer && (newItemIds.has(event.pismoId) || Object.hasOwn(primaryRecent, event.pismoId)))
      })
      const eventKeys = snapshot.events ? [...new Set([...knownEvents, ...events.map(event => event.key)])].slice(-10_000) : this.data.eventKeys
      const oldData = structuredClone(this.data)
      this.data = { ...this.data, context: snapshot.context, keys, eventKeys, signalKeys, primaryRecent: Object.fromEntries(Object.entries(primaryRecent).slice(-50_000)),
        pending: this.data.pending + newItemIds.size, eventPending: this.data.eventPending + newEvents.length }
      try { await this.persist() } catch { this.data = oldData; const error = new Error('Storage failed'); error.code = 'storage-error'; throw error }
      if (this.closed || signal.aborted || generation !== this.generation) return this.snapshot()
      if (this.data.pending || this.data.eventPending) {
        try { await this.notify({ count: this.data.pending, ...(this.data.eventPending ? { eventCount: this.data.eventPending } : {}) }) }
        catch { const error = new Error('Notification failed'); error.code = 'notification-error'; throw error }
        this.data.pending = 0
        this.data.eventPending = 0
        await this.persist()
      }
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
