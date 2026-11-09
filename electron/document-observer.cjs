const { execFile } = require('node:child_process')
const fs = require('node:fs/promises')
const path = require('node:path')

// Fixed script; document paths are arguments, never interpolated into code.
const WORD_SCRIPT = `on run argv
set targetPath to item 1 of argv
set targetHfs to (POSIX file targetPath) as text
if application id "com.microsoft.Word" is not running then return "NOT_RUNNING"
tell application id "com.microsoft.Word"
repeat with d in documents
try
set diskPath to full name of d
if diskPath is targetHfs or diskPath is targetPath then return "OPEN"
on error
return "UNKNOWN"
end try
end repeat
end tell
return "CLOSED"
end run`

function probeWord(workingPath, { execFileImpl = execFile } = {}) {
  return new Promise(resolve => {
    execFileImpl('/usr/bin/osascript', ['-e', WORD_SCRIPT, workingPath], {
      timeout: 8000, maxBuffer: 4096, encoding: 'utf8', windowsHide: true,
    }, (error, stdout) => {
      if (error) return resolve('unknown')
      const result = String(stdout).trim()
      resolve(result === 'OPEN' ? 'open' : ['CLOSED', 'NOT_RUNNING'].includes(result) ? 'absent' : 'unknown')
    })
  })
}

class DocumentObserver {
  constructor({ probe = probeWord, onState = async () => {}, onClosed = async () => {}, intervalMs = 1000,
    openingTimeoutMs = 30000, now = Date.now, platform = process.platform } = {}) {
    Object.assign(this, { probe, onState, onClosed, intervalMs, openingTimeoutMs, now, platform })
    this.entries = new Map()
  }
  async watch(sessionId, workingPath) {
    this.unwatch(sessionId)
    const entry = { sessionId, workingPath: await fs.realpath(workingPath).catch(() => workingPath),
      state: 'opening', seen: false, absences: 0, started: this.now(), running: false, timer: null, stopped: false }
    this.entries.set(sessionId, entry)
    if (this.platform !== 'darwin' || !['.doc', '.docx', '.rtf', '.odt', '.txt'].includes(path.extname(workingPath).toLowerCase())) {
      await this.change(entry, 'unknown')
      return entry
    }
    entry.timer = setInterval(() => this.tick(entry).catch(() => {}), this.intervalMs)
    entry.timer.unref?.()
    this.tick(entry).catch(() => {})
    return entry
  }
  async change(entry, state) {
    if (entry.stopped || entry.state === state) return
    entry.state = state
    await this.onState({ sessionId: entry.sessionId, state })
  }
  async tick(entry) {
    if (entry.running || entry.stopped || entry.state === 'closed' || !this.entries.has(entry.sessionId)) return
    entry.running = true
    try {
      const observation = await this.probe(entry.workingPath)
      if (entry.stopped) return
      if (observation === 'open') {
        entry.seen = true
        entry.absences = 0
        await this.change(entry, 'open')
      } else if (observation === 'absent') {
        if (entry.seen && ++entry.absences >= 2) {
          await this.change(entry, 'closed')
          clearInterval(entry.timer)
          await this.onClosed({ sessionId: entry.sessionId })
        } else if (!entry.seen && this.now() - entry.started >= this.openingTimeoutMs) {
          await this.change(entry, 'unknown')
          clearInterval(entry.timer)
        }
      } else {
        entry.absences = 0
        await this.change(entry, 'unknown')
        clearInterval(entry.timer)
      }
    } finally { entry.running = false }
  }
  unwatch(sessionId) {
    const entry = this.entries.get(sessionId)
    if (!entry) return
    entry.stopped = true
    clearInterval(entry.timer)
    this.entries.delete(sessionId)
  }
  close() { for (const id of this.entries.keys()) this.unwatch(id) }
}
module.exports = { DocumentObserver, probeWord, WORD_SCRIPT }
