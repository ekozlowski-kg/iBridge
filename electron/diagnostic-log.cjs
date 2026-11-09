const fsp = require('node:fs/promises')
const path = require('node:path')

const ALLOWED_FIELDS = [
  'timestamp',
  'sessionId',
  'operation',
  'attempt',
  'durationMs',
  'size',
  'httpStatus',
  'ezdStatus',
  'kind',
  'code',
  'phase',
  'message',
  'caseMarkPresent',
  'pismoIdPresent',
  'documentIdPresent',
]

const SIGNATURE_ALLOWED_FIELDS = [
  'operation',
  'kind',
  'code',
  'phase',
  'durationMs',
  'size',
  'httpStatus',
  'ezdStatus',
]

const BOOLEAN_FIELDS = new Set([
  'caseMarkPresent',
  'pismoIdPresent',
  'documentIdPresent',
])

function sanitizeText(value) {
  return String(value)
    .replace(/\b(?:ezd|most-ezd):\/\/[^\s"']+/gi, '[USUNIĘTO_ADRES_PROTOKOŁU]')
    .replace(/([?&](?:auth(?:entication)?token|token)=)[^&\s]+/gi, '$1[USUNIĘTO]')
}

function safeEvent(event) {
  const safe = {}
  const fields = event.operation === 'signature' ? SIGNATURE_ALLOWED_FIELDS : ALLOWED_FIELDS
  for (const key of fields) {
    if (event[key] === undefined) continue
    if (BOOLEAN_FIELDS.has(key) && typeof event[key] !== 'boolean') continue
    safe[key] = typeof event[key] === 'string' ? sanitizeText(event[key]) : event[key]
  }
  safe.timestamp = new Date().toISOString()
  return safe
}

class DiagnosticLog {
  constructor({ directory, maximumBytes = 1024 * 1024, fsImpl = fsp }) {
    if (typeof directory !== 'string' || !directory) throw new Error('Brak katalogu dziennika diagnostycznego.')
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) throw new Error('Nieprawidłowy limit dziennika diagnostycznego.')
    this.directory = directory
    this.maximumBytes = maximumBytes
    this.fs = fsImpl
    this.activePath = path.join(directory, 'ezd-ibridge.log')
    this.rotatedPath = path.join(directory, 'ezd-ibridge.log.1')
    this.pending = Promise.resolve()
  }

  write(event = {}) {
    const operation = this.pending.then(() => this.writeNow(event))
    this.pending = operation.catch(() => {})
    return operation
  }

  async writeNow(event) {
    const line = `${JSON.stringify(safeEvent(event))}\n`
    await this.fs.mkdir(this.directory, { recursive: true, mode: 0o700 })
    const currentSize = await this.fs.stat(this.activePath).then((info) => info.size, () => 0)
    if (currentSize > 0 && currentSize + Buffer.byteLength(line) > this.maximumBytes) {
      await this.fs.rm(this.rotatedPath, { force: true })
      await this.fs.rename(this.activePath, this.rotatedPath)
    }
    await this.fs.appendFile(this.activePath, line, { mode: 0o600 })
    await this.fs.chmod(this.activePath, 0o600)
  }
}

module.exports = { DiagnosticLog }
