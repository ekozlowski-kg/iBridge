const fs = require('node:fs')
const path = require('node:path')
const { waitForStableFile } = require('./file-stability.cjs')

function isTransient(error) {
  if ([401, 403].includes(Number(error?.httpStatus))) return false
  if (['ezd', 'soap', 'protocol', 'cancelled'].includes(error?.kind)) return false
  return error?.retryable === true || ['transport', 'timeout', 'file-changing'].includes(error?.kind)
    || (error?.kind === 'http' && [502, 503, 504].includes(Number(error.httpStatus)))
}

class EzdAutosync {
  constructor({ coordinator, onError = () => {}, onFinished = () => {}, onRetry = () => {},
    debounceMs = 150, pollMs = 5000, retryDelaysMs = [5000, 15000, 30000, 60000],
    stabilityOptions = {}, watchFactory = fs.watch }) {
    if (!coordinator || typeof coordinator.sync !== 'function') throw new Error('Brak koordynatora synchronizacji EZD.')
    Object.assign(this, { coordinator, onError, onFinished, onRetry, debounceMs, pollMs, retryDelaysMs, stabilityOptions, watchFactory })
    this.entries = new Map()
  }

  watch(sessionId, workingPath) {
    this.unwatch(sessionId)
    const entry = { sessionId, workingPath, watchedName: path.basename(workingPath), watcher: null,
      timer: null, poll: null, processing: null, rerun: false, closed: false, lastStableKey: '',
      finishing: false, blocked: false, retryIndex: 0, retryTimer: null, lastErrorKey: '' }
    try { const s = fs.statSync(workingPath); entry.lastStableKey = `${s.size}:${s.mtimeMs}` } catch {}
    this.entries.set(sessionId, entry)
    try {
      entry.watcher = this.watchFactory(path.dirname(workingPath), (_type, name) => {
        if (name && String(name) !== entry.watchedName) return
        if (!entry.blocked && !entry.retryTimer) this.schedule(entry)
      })
      entry.watcher.on?.('error', error => this.reportError(entry, error))
    } catch (error) { this.reportError(entry, error) }
    if (this.pollMs > 0) {
      entry.poll = setInterval(() => {
        if (!entry.blocked && !entry.retryTimer) this.schedule(entry)
      }, this.pollMs)
      entry.poll.unref?.()
    }
    this.schedule(entry)
    return entry
  }

  schedule(entry, delay = this.debounceMs) {
    if (entry.closed) return
    clearTimeout(entry.timer)
    entry.timer = setTimeout(() => {
      entry.timer = null
      this.run(entry).catch(() => {})
    }, delay)
    entry.timer.unref?.()
  }

  run(entry) {
    if (entry.closed) return Promise.resolve()
    if (entry.processing) { entry.rerun = true; return entry.processing }
    entry.processing = this.process(entry).catch(error => {
      const transient = isTransient(error)
      entry.blocked = !transient
      this.reportError(entry, error)
      if (transient && !entry.closed) {
        const delay = this.retryDelaysMs[Math.min(entry.retryIndex++, this.retryDelaysMs.length - 1)] ?? 60000
        clearTimeout(entry.retryTimer)
        entry.retryTimer = setTimeout(() => {
          entry.retryTimer = null
          this.run(entry).catch(() => {})
        }, delay)
        entry.retryTimer.unref?.()
        Promise.resolve(this.onRetry({ sessionId: entry.sessionId, retryAt: new Date(Date.now() + delay).toISOString() })).catch(() => {})
      }
      throw error
    }).finally(() => { entry.processing = null })
    return entry.processing
  }

  async process(entry) {
    do {
      entry.rerun = false
      const stable = await waitForStableFile(entry.workingPath, this.stabilityOptions)
      if (entry.closed || this.entries.get(entry.sessionId) !== entry) return
      const key = `${stable.size}:${stable.mtimeMs}`
      if (entry.finishing) {
        const state = await this.coordinator.finish(entry.sessionId)
        this.unwatch(entry.sessionId)
        await this.onFinished({ sessionId: entry.sessionId, state })
        return state
      }
      if (key !== entry.lastStableKey) {
        await this.coordinator.sync(entry.sessionId)
        // A failure must not consume this change. New saves during upload are
        // detected by fs.watch or the periodic check, even if events are lost.
        entry.lastStableKey = key
        entry.retryIndex = 0
        entry.lastErrorKey = ''
        await this.onRetry({ sessionId: entry.sessionId, retryAt: null })
      }
    } while (entry.rerun && !entry.closed)
  }

  finish(sessionId) {
    const entry = this.entries.get(sessionId)
    if (!entry) return Promise.reject(new Error('Brak aktywnej sesji. Otwórz dokument ponownie z EZD.'))
    entry.finishing = true
    entry.blocked = false
    clearTimeout(entry.retryTimer)
    entry.retryTimer = null
    clearTimeout(entry.timer)
    // If sync is in progress, its rerun observes finishing before upload ends.
    return this.run(entry).then(result => {
      if (!entry.closed && entry.finishing) return this.run(entry)
      return result
    })
  }

  retry(sessionId) {
    const entry = this.entries.get(sessionId)
    if (!entry) return Promise.reject(new Error('Otwórz dokument ponownie z EZD.'))
    entry.blocked = false
    entry.lastStableKey = ''
    clearTimeout(entry.retryTimer)
    entry.retryTimer = null
    return this.run(entry)
  }

  reportError(entry, error) {
    const key = `${entry.finishing ? 'finish' : 'sync'}:${error?.kind || 'local'}:${error?.ezdStatus || 0}:${error?.httpStatus || 0}`
    const firstOccurrence = key !== entry.lastErrorKey
    entry.lastErrorKey = key
    try {
      Promise.resolve(this.onError({ sessionId: entry.sessionId,
        operation: error?.operation || (entry.finishing ? 'finish' : 'watch'),
        kind: error?.kind || 'local', message: String(error?.message || 'Błąd synchronizacji.'),
        firstOccurrence, retryable: isTransient(error), error })).catch(() => {})
    } catch {}
  }

  unwatch(sessionId) {
    const entry = this.entries.get(sessionId)
    if (!entry) return null
    entry.closed = true
    clearTimeout(entry.timer)
    clearTimeout(entry.retryTimer)
    clearInterval(entry.poll)
    entry.watcher?.close()
    this.entries.delete(sessionId)
    return entry.processing
  }

  async close() {
    const pending = [...this.entries.keys()].map(id => this.unwatch(id)).filter(Boolean)
    await Promise.allSettled(pending)
  }
}
module.exports = { EzdAutosync, isTransient }
