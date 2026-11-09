const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')
const { buildDocumentCatalog } = require('./document-catalog.cjs')

const SUPPORTED_EXTENSIONS = new Set([
  '.doc', '.docx', '.odt', '.rtf', '.txt', '.md', '.pdf',
  '.xls', '.xlsx', '.ods', '.csv', '.xml', '.html', '.htm',
  '.ppt', '.pptx',
])
const MAX_DOCUMENT_BYTES = 128 * 1024 * 1024
const MAX_SIGNED_DOCUMENT_BYTES = 130 * 1024 * 1024
const MAX_EDITABLE_BYTES = 4 * 1024 * 1024
const EDITABLE_EXTENSIONS = new Set(['.txt', '.md', '.csv', '.xml', '.html', '.htm'])
const REMOTE_SYNC_STATUSES = new Set(['idle', 'pending', 'syncing', 'synced', 'error'])
const REMOTE_ERROR_FIELDS = ['operation', 'kind', 'ezdStatus', 'httpStatus', 'message']
const SIGNATURE_STATES = new Set([
  'downloading',
  'awaiting-pin',
  'signing',
  'verifying',
  'signed-local',
  'uploading',
  'completed',
  'upload-rejected',
  'upload-unknown',
  'cancelled',
  'failed',
])
const SIGNATURE_WARNINGS = new Set(['REVOCATION_NOT_CHECKED'])

const DEFAULT_SETTINGS = {
  editorMode: 'automatic',
  editorPath: '',
  automaticVersions: true,
  acceptLegacyProtocol: true,
  serviceUrl: 'https://ezd-proxy.kg.straz.gov.pl/EzdProxy.svc',
  launchAtLogin: false,
  launchAtLoginPrompted: false,
  settingsRevision: 2,
}

function safeFileName(value) {
  const base = path.basename(String(value || 'dokument'))
  const cleaned = base.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim()
  return cleaned || 'dokument'
}

function sanitizeRemoteText(value) {
  return String(value)
    .replace(/\b(?:ezd|most-ezd):\/\/[^\s"']+/gi, '[USUNIĘTO_ADRES_PROTOKOŁU]')
    .replace(/([?&](?:auth(?:entication)?token|token)=)[^&\s]+/gi, '$1[USUNIĘTO]')
}

function safeRemoteText(value) {
  return typeof value === 'string' ? sanitizeRemoteText(value) : ''
}

function safeRemoteId(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? value : 0
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)$/.test(value)) return 0
  const id = Number(value)
  return Number.isSafeInteger(id) ? id : 0
}

function safeRemoteError(error) {
  if (!error || typeof error !== 'object') return null
  const safe = {}
  for (const key of REMOTE_ERROR_FIELDS) {
    if (error[key] === undefined) continue
    safe[key] = typeof error[key] === 'string' ? sanitizeRemoteText(error[key]) : error[key]
  }
  return Object.keys(safe).length ? safe : null
}

function safeIsoTimestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(value)) return null
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString()
}

function safeSignatureSerial(value) {
  return typeof value === 'string' && /^(?:[0-9A-Fa-f]{2})+$/.test(value)
    ? value.toUpperCase()
    : ''
}

function safeSignatureSubject(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 512
    && !/[\u0000-\u001f\u007f]/.test(value)
    ? value
    : ''
}

function safeSignatureWarnings(value) {
  if (!Array.isArray(value) || value.length > 8) return []
  const result = value.filter((warning) => SIGNATURE_WARNINGS.has(warning))
  return [...new Set(result)]
}

function migratedSignatureRemote(remote) {
  const status = SIGNATURE_STATES.has(remote.status) ? remote.status : 'failed'
  const migrated = {
    operation: 'signature',
    serviceUrl: safeRemoteText(remote.serviceUrl),
    documentId: safeRemoteId(remote.documentId),
    pismoId: safeRemoteId(remote.pismoId),
    pismoName: safeRemoteText(remote.pismoName),
    caseMark: safeRemoteText(remote.caseMark),
    shared: Boolean(remote.shared),
    status: status === 'uploading' ? 'upload-unknown' : status,
    expectedCertificateSerial: safeSignatureSerial(remote.expectedCertificateSerial),
    signingTime: safeIsoTimestamp(remote.signingTime),
    signatureMode: [6, 9].includes(remote.signatureMode) ? remote.signatureMode : 0,
    includeTimestamp: Boolean(remote.includeTimestamp),
    downloadedAt: safeIsoTimestamp(remote.downloadedAt),
  }
  if (typeof remote.phase === 'string'
      && (SIGNATURE_STATES.has(remote.phase) || remote.phase === 'cancelling')) migrated.phase = remote.phase
  if (typeof remote.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(remote.code)) {
    migrated.code = remote.code
  }
  for (const key of ['size', 'httpStatus', 'ezdStatus', 'signatureSize']) {
    if (Number.isSafeInteger(remote[key]) && remote[key] >= 0) migrated[key] = remote[key]
  }
  for (const key of ['uploadAttemptedAt', 'uploadedAt', 'completedAt']) {
    const timestamp = safeIsoTimestamp(remote[key])
    if (timestamp) migrated[key] = timestamp
  }
  if (typeof remote.signatureHash === 'string' && /^[0-9a-f]{64}$/.test(remote.signatureHash)) {
    migrated.signatureHash = remote.signatureHash
  }
  if (['PAdES-B-B', 'PAdES-B-T'].includes(remote.signatureProfile)) {
    migrated.signatureProfile = remote.signatureProfile
  }
  const subject = safeSignatureSubject(remote.signatureSubject)
  if (subject) migrated.signatureSubject = subject
  const warnings = safeSignatureWarnings(remote.signatureWarnings)
  if (warnings.length) migrated.signatureWarnings = warnings
  return migrated
}

function migrateRemoteState(remote) {
  const before = JSON.stringify(remote)
  remote.documentId = safeRemoteId(remote.documentId)
  remote.pismoId = safeRemoteId(remote.pismoId)
  remote.pismoName = safeRemoteText(remote.pismoName)
  remote.caseMark = safeRemoteText(remote.caseMark)
  if (remote.sourceDocumentId !== undefined) remote.sourceDocumentId = safeRemoteId(remote.sourceDocumentId)
  if (remote.documentIds !== undefined) remote.documentIds = Array.isArray(remote.documentIds)
    ? [...new Set(remote.documentIds.map(safeRemoteId).filter(Boolean))] : []
  if (!REMOTE_SYNC_STATUSES.has(remote.syncStatus)) remote.syncStatus = 'idle'
  if (typeof remote.lastSyncedAt !== 'string') remote.lastSyncedAt = null
  if (typeof remote.lastSyncedHash !== 'string') remote.lastSyncedHash = ''
  remote.lastError = remote.syncStatus === 'error' ? safeRemoteError(remote.lastError) : null
  return JSON.stringify(remote) !== before
}

async function sha256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256')
    const input = fs.createReadStream(filePath)
    input.on('error', reject)
    input.on('data', (chunk) => hash.update(chunk))
    input.on('end', () => resolve(hash.digest('hex')))
  })
}

class SessionStore {
  constructor({ baseDir, onChange = () => {} }) {
    this.baseDir = baseDir
    this.workspaceDir = path.join(baseDir, 'dokumenty')
    this.statePath = path.join(baseDir, 'stan.json')
    this.state = { sessions: [], settings: { ...DEFAULT_SETTINGS } }
    this.watchers = new Map()
    this.debounceTimers = new Map()
    this.autoVersionTimers = new Map()
    this.onChange = onChange
    this.persistTail = Promise.resolve()
    this.versionTails = new Map()
  }

  async init() {
    await fsp.mkdir(this.workspaceDir, { recursive: true })
    let migratedSettings = false
    let migratedRemoteSessions = false
    try {
      const parsed = JSON.parse(await fsp.readFile(this.statePath, 'utf8'))
      this.state.sessions = Array.isArray(parsed.sessions) ? parsed.sessions : []
      this.state.settings = { ...DEFAULT_SETTINGS, ...(parsed.settings || {}) }
      if (Number(parsed.settings?.settingsRevision || 0) < DEFAULT_SETTINGS.settingsRevision) {
        this.state.settings.acceptLegacyProtocol = true
        this.state.settings.automaticVersions = true
        this.state.settings.settingsRevision = DEFAULT_SETTINGS.settingsRevision
        migratedSettings = true
      }
      for (const session of this.state.sessions) {
        if (!session.remote) continue
        if (typeof session.remote !== 'object' || Array.isArray(session.remote)) {
          session.remote = {}
          migratedRemoteSessions = true
        }
        if (session.remote.operation === 'signature') {
          const before = JSON.stringify(session.remote)
          session.remote = migratedSignatureRemote(session.remote)
          if (JSON.stringify(session.remote) !== before) migratedRemoteSessions = true
        } else {
          if (migrateRemoteState(session.remote)) migratedRemoteSessions = true
          const remote = session.remote
          remote.connectionStatus = remote.status === 'sent' ? 'closed' : 'needs-reopen'
          remote.editorState = 'unknown'
          if (['pending', 'syncing'].includes(remote.syncStatus)) remote.syncStatus = 'pending'
          if (remote.finishStatus === 'finishing') remote.finishStatus = 'unconfirmed'
          migratedRemoteSessions = true
        }
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        const backup = `${this.statePath}.uszkodzony-${Date.now()}`
        await fsp.copyFile(this.statePath, backup).catch(() => {})
      }
      await this.persist()
    }

    if (migratedSettings || migratedRemoteSessions) await this.persist()

    for (const session of this.state.sessions) {
      if (session.remote?.operation !== 'signature' && await this.fileExists(session.workingPath)) {
        if (session.remote) {
          const baseline = session.remote.lastSyncedHash || session.versions?.[0]?.hash
          session.remote.recoveryRequired = Boolean(baseline && await sha256(session.workingPath) !== baseline)
        }
        this.watch(session.id)
      }
    }
    if (this.state.sessions.some(s => s.remote && s.remote.operation !== 'signature')) await this.persist()
    return this.snapshot()
  }

  snapshot() {
    return JSON.parse(JSON.stringify({
      sessions: this.state.sessions,
      settings: this.state.settings,
      storagePath: this.baseDir,
      documents: buildDocumentCatalog(this.state.sessions),
      accountCatalog: {
        status: 'not-configured',
        message: 'Pełna lista konta wymaga API EZD i uprawnień administratora. Poniżej są wyłącznie dokumenty otwierane z EZD w iBridge.',
      },
    }))
  }

  persist() {
    const contents = JSON.stringify(this.state, null, 2)
    const operation = this.persistTail.then(() => this.writeState(contents))
    this.persistTail = operation.catch(() => {})
    return operation
  }

  async writeState(contents) {
    await fsp.mkdir(this.baseDir, { recursive: true })
    const tmpPath = `${this.statePath}.${crypto.randomUUID()}.tmp`
    try {
      await fsp.writeFile(tmpPath, contents, { flag: 'wx', mode: 0o600 })
      await fsp.chmod(tmpPath, 0o600)
      await fsp.rename(tmpPath, this.statePath)
    } finally {
      await fsp.rm(tmpPath, { force: true }).catch(() => {})
    }
  }

  async fileExists(filePath) {
    try {
      return (await fsp.stat(filePath)).isFile()
    } catch {
      return false
    }
  }

  getSession(sessionId) {
    const session = this.state.sessions.find((item) => item.id === sessionId)
    if (!session) throw new Error('Nie znaleziono sesji dokumentu.')
    return session
  }

  async importDocument(sourcePath) {
    const source = path.resolve(sourcePath)
    const info = await fsp.stat(source)
    if (!info.isFile()) throw new Error('Wybrana ścieżka nie jest plikiem.')

    const extension = path.extname(source).toLowerCase()
    if (!SUPPORTED_EXTENSIONS.has(extension)) {
      throw new Error(`Nieobsługiwany typ pliku: ${extension || 'bez rozszerzenia'}.`)
    }

    const id = crypto.randomUUID()
    const sessionDir = path.join(this.workspaceDir, id)
    const versionsDir = path.join(sessionDir, 'wersje')
    const name = safeFileName(source)
    const workingPath = path.join(sessionDir, name)
    const originalVersionPath = path.join(versionsDir, `000-oryginal${extension}`)

    await fsp.mkdir(versionsDir, { recursive: true })
    await fsp.copyFile(source, workingPath, fs.constants.COPYFILE_EXCL)
    await fsp.copyFile(source, originalVersionPath, fs.constants.COPYFILE_EXCL)

    const now = new Date().toISOString()
    const hash = await sha256(workingPath)
    const session = {
      id,
      name,
      extension: extension.slice(1).toUpperCase() || 'PLIK',
      originalPath: source,
      workingPath,
      createdAt: now,
      updatedAt: now,
      size: info.size,
      dirty: false,
      missing: false,
      lastSavedHash: hash,
      lastChangeAt: null,
      versions: [{
        id: crypto.randomUUID(),
        label: 'Oryginał',
        path: originalVersionPath,
        createdAt: now,
        size: info.size,
        hash,
        automatic: false,
      }],
    }

    this.state.sessions.unshift(session)
    await this.persist()
    this.watch(id)
    this.emit('session-imported', session)
    return this.snapshot()
  }

  async importRemoteDocument({ fileName, data, metadata = {} }) {
    const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data || [])
    if (!bytes.length) throw new Error('EZD zwrócił pusty dokument.')
    if (bytes.length > MAX_DOCUMENT_BYTES) throw new Error('Dokument EZD jest zbyt duży.')

    const name = safeFileName(fileName)
    const extension = path.extname(name).toLowerCase()
    if (!SUPPORTED_EXTENSIONS.has(extension)) {
      throw new Error(`Nieobsługiwany typ dokumentu EZD: ${extension || 'bez rozszerzenia'}.`)
    }

    const id = crypto.randomUUID()
    const sessionDir = path.join(this.workspaceDir, id)
    const versionsDir = path.join(sessionDir, 'wersje')
    const workingPath = path.join(sessionDir, name)
    const originalVersionPath = path.join(versionsDir, `000-oryginal${extension}`)

    await fsp.mkdir(versionsDir, { recursive: true })
    await fsp.writeFile(workingPath, bytes, { flag: 'wx', mode: 0o600 })
    await fsp.writeFile(originalVersionPath, bytes, { flag: 'wx', mode: 0o600 })

    const now = new Date().toISOString()
    const hash = crypto.createHash('sha256').update(bytes).digest('hex')
    const remote = {
      serviceUrl: safeRemoteText(metadata.serviceUrl),
      documentId: safeRemoteId(metadata.documentId),
      documentMode: safeRemoteId(metadata.documentMode),
      pismoId: safeRemoteId(metadata.pismoId),
      pismoName: safeRemoteText(metadata.pismoName),
      caseMark: safeRemoteText(metadata.caseMark),
      shared: Boolean(metadata.shared),
      status: 'editing',
      connectionStatus: 'active',
      editorState: 'opening',
      finishStatus: 'idle',
      sourceDocumentId: safeRemoteId(metadata.documentId),
      documentIds: [safeRemoteId(metadata.documentId)].filter(Boolean),
      syncStatus: 'idle',
      lastSyncedAt: null,
      lastSyncedHash: '',
      lastError: null,
      downloadedAt: now,
    }
    const session = {
      id,
      name,
      extension: extension.slice(1).toUpperCase(),
      originalPath: null,
      workingPath,
      createdAt: now,
      updatedAt: now,
      size: bytes.length,
      dirty: false,
      missing: false,
      lastSavedHash: hash,
      lastChangeAt: null,
      remote,
      versions: [{
        id: crypto.randomUUID(),
        label: 'Oryginał z EZD',
        path: originalVersionPath,
        createdAt: now,
        size: bytes.length,
        hash,
        automatic: false,
      }],
    }

    this.state.sessions.unshift(session)
    await this.persist()
    this.watch(id)
    this.emit('session-imported', session)
    return { ...this.snapshot(), sessionId: id, workingPath }
  }

  async ensurePrivateDirectory(directory) {
    await fsp.mkdir(directory, { recursive: true, mode: 0o700 })
    await fsp.chmod(directory, 0o700)
    const info = await fsp.lstat(directory)
    const expectedUid = typeof process.geteuid === 'function' ? process.geteuid() : info.uid
    if (!info.isDirectory() || info.isSymbolicLink()
        || info.uid !== expectedUid || (info.mode & 0o777) !== 0o700) {
      throw new Error('Nie można utworzyć prywatnego katalogu podpisu.')
    }
  }

  async ensurePrivateRegularFile(filePath) {
    const info = await fsp.lstat(filePath)
    const expectedUid = typeof process.geteuid === 'function' ? process.geteuid() : info.uid
    if (!info.isFile() || info.isSymbolicLink()
        || info.uid !== expectedUid || (info.mode & 0o777) !== 0o600) {
      throw new Error('Nie można utworzyć prywatnego pliku podpisu.')
    }
    return info
  }

  async importSignatureDocument({ fileName, data, metadata = {} }) {
    const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data || [])
    if (!bytes.length) throw new Error('EZD zwrócił pusty dokument do podpisu.')
    if (bytes.length > MAX_DOCUMENT_BYTES) throw new Error('Dokument do podpisu jest zbyt duży.')
    if (bytes.length < 5 || !bytes.subarray(0, 5).equals(Buffer.from('%PDF-'))) {
      throw new Error('Dokument do podpisu nie jest plikiem PDF.')
    }
    const name = safeFileName(fileName || 'dokument-do-podpisu.pdf')
    if (path.extname(name).toLowerCase() !== '.pdf') {
      throw new Error('Podpis kwalifikowany wymaga dokumentu PDF.')
    }

    const id = crypto.randomUUID()
    const sessionDir = path.join(this.workspaceDir, id)
    const versionsDir = path.join(sessionDir, 'wersje')
    const inputPath = path.join(versionsDir, '000-oryginal.pdf')
    await this.ensurePrivateDirectory(sessionDir)
    await this.ensurePrivateDirectory(versionsDir)
    await fsp.writeFile(inputPath, bytes, { flag: 'wx', mode: 0o600 })
    await fsp.chmod(inputPath, 0o600)
    await this.ensurePrivateRegularFile(inputPath)

    const now = new Date().toISOString()
    const hash = crypto.createHash('sha256').update(bytes).digest('hex')
    const remote = {
      operation: 'signature',
      serviceUrl: safeRemoteText(metadata.serviceUrl),
      documentId: safeRemoteId(metadata.documentId),
      pismoId: safeRemoteId(metadata.pismoId),
      pismoName: safeRemoteText(metadata.pismoName),
      caseMark: safeRemoteText(metadata.caseMark),
      shared: Boolean(metadata.shared),
      status: 'downloading',
      expectedCertificateSerial: safeSignatureSerial(metadata.certificateSerial),
      signingTime: safeIsoTimestamp(metadata.signingTime),
      signatureMode: [6, 9].includes(metadata.signatureMode) ? metadata.signatureMode : 0,
      includeTimestamp: Boolean(metadata.includeTimestamp),
      downloadedAt: now,
    }
    const session = {
      id,
      name,
      extension: 'PDF',
      originalPath: null,
      workingPath: inputPath,
      createdAt: now,
      updatedAt: now,
      size: bytes.length,
      dirty: false,
      missing: false,
      lastSavedHash: hash,
      lastChangeAt: null,
      remote,
      versions: [{
        id: crypto.randomUUID(),
        label: 'Oryginał z EZD',
        path: inputPath,
        createdAt: now,
        size: bytes.length,
        hash,
        automatic: false,
      }],
    }
    this.state.sessions.unshift(session)
    await this.persist()
    this.emit('signature-session-imported', session)
    return Object.freeze({ sessionId: id, state: this.snapshot() })
  }

  getSignaturePaths(sessionId) {
    const session = this.getSession(sessionId)
    if (session.remote?.operation !== 'signature' || !session.versions?.[0]?.path) {
      throw new Error('To nie jest sesja podpisu EZD.')
    }
    const versionsDir = path.dirname(session.versions[0].path)
    return {
      inputPath: session.versions[0].path,
      outputPath: path.join(versionsDir, '.ibridge-helper-output.pdf'),
      signedVersionPath: path.join(versionsDir, '001-podpisany.pdf'),
    }
  }

  async saveSignedSignatureVersion(sessionId, {
    signedBytes,
    hash,
    size,
    profile,
    subject,
    warnings,
  } = {}) {
    const session = this.getSession(sessionId)
    if (session.remote?.operation !== 'signature') throw new Error('To nie jest sesja podpisu EZD.')
    if (!Buffer.isBuffer(signedBytes)
        || signedBytes.length < 5
        || signedBytes.length > MAX_SIGNED_DOCUMENT_BYTES
        || !signedBytes.subarray(0, 5).equals(Buffer.from('%PDF-'))
        || size !== signedBytes.length
        || typeof hash !== 'string'
        || !/^[0-9a-f]{64}$/.test(hash)
        || !['PAdES-B-B', 'PAdES-B-T'].includes(profile)
        || !safeSignatureSubject(subject)
        || !Array.isArray(warnings)
        || warnings.length !== safeSignatureWarnings(warnings).length) {
      throw new Error('Nieprawidłowa lokalna wersja podpisanego dokumentu.')
    }
    const calculated = crypto.createHash('sha256').update(signedBytes).digest()
    const expected = Buffer.from(hash, 'hex')
    const hashMatches = calculated.length === expected.length && crypto.timingSafeEqual(calculated, expected)
    calculated.fill(0)
    expected.fill(0)
    if (!hashMatches) throw new Error('Skrót podpisanego dokumentu jest nieprawidłowy.')
    if (session.versions.length !== 1) throw new Error('Podpisana wersja dokumentu już istnieje.')

    const { signedVersionPath } = this.getSignaturePaths(sessionId)
    await fsp.writeFile(signedVersionPath, signedBytes, { flag: 'wx', mode: 0o600 })
    await fsp.chmod(signedVersionPath, 0o600)
    await this.ensurePrivateRegularFile(signedVersionPath)
    const now = new Date().toISOString()
    session.versions.push({
      id: crypto.randomUUID(),
      label: 'Podpis kwalifikowany',
      path: signedVersionPath,
      createdAt: now,
      size,
      hash,
      automatic: false,
      profile,
      subject,
      warnings: [...warnings],
    })
    session.workingPath = signedVersionPath
    session.updatedAt = now
    session.size = size
    session.lastSavedHash = hash
    session.remote.status = 'signed-local'
    session.remote.signatureHash = hash
    session.remote.signatureSize = size
    session.remote.signatureProfile = profile
    session.remote.signatureSubject = subject
    session.remote.signatureWarnings = [...warnings]
    await this.persist()
    this.emit('signature-version-saved', session)
    return this.snapshot()
  }

  async markSignatureState(sessionId, state, details = {}) {
    const session = this.getSession(sessionId)
    if (session.remote?.operation !== 'signature') throw new Error('To nie jest sesja podpisu EZD.')
    if (!SIGNATURE_STATES.has(state)) throw new Error('Nieprawidłowy stan podpisu EZD.')
    const safe = details && typeof details === 'object' && !Array.isArray(details) ? details : {}
    const now = new Date().toISOString()
    session.remote.status = state
    if (typeof safe.phase === 'string'
        && (SIGNATURE_STATES.has(safe.phase) || safe.phase === 'cancelling')) session.remote.phase = safe.phase
    if (typeof safe.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(safe.code)) {
      session.remote.code = safe.code
    }
    if (Number.isSafeInteger(safe.size) && safe.size >= 0 && safe.size <= MAX_SIGNED_DOCUMENT_BYTES) {
      session.remote.size = safe.size
    }
    if (Number.isSafeInteger(safe.httpStatus) && safe.httpStatus >= 0 && safe.httpStatus <= 999) {
      session.remote.httpStatus = safe.httpStatus
    }
    if (Number.isSafeInteger(safe.ezdStatus) && safe.ezdStatus >= 0) {
      session.remote.ezdStatus = safe.ezdStatus
    }
    if (state === 'uploading') session.remote.uploadAttemptedAt = now
    if (state === 'completed') {
      session.remote.uploadedAt = now
      session.remote.completedAt = now
    }
    session.updatedAt = now
    await this.persist()
    this.emit('signature-state-changed', session)
    return this.snapshot()
  }

  async markRemoteUploaded(sessionId, { documentId = 0 } = {}) {
    const session = this.getSession(sessionId)
    if (!session.remote) throw new Error('To nie jest dokument pobrany z EZD.')
    session.remote.status = 'sent'
    session.remote.connectionStatus = 'closed'
    session.remote.finishStatus = 'completed'
    session.remote.finishError = null
    session.remote.uploadedAt = new Date().toISOString()
    const safeDocumentId = safeRemoteId(documentId)
    if (safeDocumentId > 0) session.remote.documentId = safeDocumentId
    else session.remote.documentId = safeRemoteId(session.remote.documentId)
    session.updatedAt = session.remote.uploadedAt
    await this.persist()
    this.emit('session-uploaded', session)
    return this.snapshot()
  }

  async markRemoteSyncPending(sessionId) {
    const session = this.getSession(sessionId)
    if (!session.remote) throw new Error('To nie jest dokument pobrany z EZD.')
    session.remote.syncStatus = 'pending'
    session.remote.lastError = null
    session.updatedAt = new Date().toISOString()
    await this.persist()
    this.emit('remote-sync-pending', session)
    return this.snapshot()
  }

  async markRemoteSyncing(sessionId) {
    const session = this.getSession(sessionId)
    if (!session.remote) throw new Error('To nie jest dokument pobrany z EZD.')
    session.remote.syncStatus = 'syncing'
    session.remote.lastError = null
    session.updatedAt = new Date().toISOString()
    await this.persist()
    this.emit('remote-syncing', session)
    return this.snapshot()
  }

  async markRemoteSynced(sessionId, { hash, documentId = 0 } = {}) {
    const session = this.getSession(sessionId)
    if (!session.remote) throw new Error('To nie jest dokument pobrany z EZD.')
    const now = new Date().toISOString()
    session.remote.syncStatus = 'synced'
    session.remote.lastSyncedAt = now
    session.remote.lastSyncedHash = String(hash || '')
    session.remote.lastError = null
    session.remote.recoveryRequired = false
    const safeDocumentId = safeRemoteId(documentId)
    if (safeDocumentId > 0) {
      session.remote.documentIds = [...new Set([...(session.remote.documentIds || []), session.remote.documentId, safeDocumentId])].filter((id) => Number.isSafeInteger(id) && id > 0)
      session.remote.documentId = safeDocumentId
    }
    else session.remote.documentId = safeRemoteId(session.remote.documentId)
    session.updatedAt = now
    await this.persist()
    this.emit('remote-synced', session)
    return this.snapshot()
  }

  async markRemoteSyncError(sessionId, errorSummary = {}) {
    const session = this.getSession(sessionId)
    if (!session.remote) throw new Error('To nie jest dokument pobrany z EZD.')
    session.remote.syncStatus = 'error'
    session.remote.lastError = safeRemoteError(errorSummary)
    session.updatedAt = new Date().toISOString()
    await this.persist()
    this.emit('remote-sync-error', session)
    return this.snapshot()
  }

  async patchRemote(sessionId, patch) {
    const session = this.getSession(sessionId)
    if (!session.remote || session.remote.operation === 'signature') throw new Error('To nie jest sesja edycji EZD.')
    const allowed = ['connectionStatus', 'editorState', 'finishStatus', 'finishError', 'retryAt', 'lastUploadAt', 'lastUploadHash', 'recoveryRequired']
    for (const key of allowed) if (Object.hasOwn(patch, key)) {
      session.remote[key] = key === 'finishError' ? safeRemoteError(patch[key]) : patch[key]
    }
    await this.persist()
    this.emit('remote-lifecycle', session)
    return this.snapshot()
  }

  watch(sessionId) {
    if (this.watchers.has(sessionId)) return
    const session = this.getSession(sessionId)
    if (session.remote?.operation === 'signature') return
    const directory = path.dirname(session.workingPath)
    const watchedName = path.basename(session.workingPath)

    try {
      const watcher = fs.watch(directory, (_eventType, fileName) => {
        if (fileName && String(fileName) !== watchedName) return
        clearTimeout(this.debounceTimers.get(sessionId))
        this.debounceTimers.set(sessionId, setTimeout(() => {
          this.inspectChange(sessionId).catch((error) => {
            this.emit('session-error', { sessionId, message: error.message })
          })
        }, 650))
      })
      watcher.on('error', (error) => this.emit('session-error', { sessionId, message: error.message }))
      this.watchers.set(sessionId, watcher)
    } catch (error) {
      this.emit('session-error', { sessionId, message: error.message })
    }
  }

  async inspectChange(sessionId) {
    const session = this.getSession(sessionId)
    let info
    try {
      info = await fsp.stat(session.workingPath)
    } catch {
      session.missing = true
      session.dirty = false
      await this.persist()
      this.emit('session-changed', session)
      return
    }

    const currentHash = await sha256(session.workingPath)
    session.missing = false
    session.size = info.size
    session.updatedAt = new Date().toISOString()
    session.lastChangeAt = session.updatedAt
    session.dirty = currentHash !== session.lastSavedHash
    if (session.remote && session.remote.operation !== 'signature' && session.remote.connectionStatus !== 'active') {
      const baseline = session.remote.lastSyncedHash || session.versions?.[0]?.hash
      session.remote.recoveryRequired = Boolean(baseline && currentHash !== baseline)
    }
    await this.persist()
    this.emit('session-changed', session)

    clearTimeout(this.autoVersionTimers.get(sessionId))
    if (session.dirty && this.state.settings.automaticVersions) {
      this.autoVersionTimers.set(sessionId, setTimeout(() => {
        this.saveVersion(sessionId, { automatic: true }).catch((error) => {
          this.emit('session-error', { sessionId, message: error.message })
        })
      }, 1800))
    }
  }

  saveVersion(sessionId, options = {}) {
    const supplied = options.data ? Buffer.from(options.data) : null
    const previous = this.versionTails.get(sessionId) || Promise.resolve()
    const operation = previous.catch(() => {}).then(() => this.saveVersionNow(sessionId, { ...options, data: supplied }))
    this.versionTails.set(sessionId, operation)
    operation.finally(() => {
      if (this.versionTails.get(sessionId) === operation) this.versionTails.delete(sessionId)
    }).catch(() => {})
    return operation
  }

  async saveVersionNow(sessionId, { automatic = false, data = null } = {}) {
    const session = this.getSession(sessionId)
    const bytes = data || await fsp.readFile(session.workingPath)
    const info = { size: bytes.length }
    if (bytes.length > MAX_DOCUMENT_BYTES) throw new Error('Dokument jest zbyt duży do zapisania wersji.')
    const hash = crypto.createHash('sha256').update(bytes).digest('hex')
    const latest = session.versions.at(-1)
    if (latest?.hash === hash) {
      session.dirty = false
      session.lastSavedHash = hash
      await this.persist()
      this.emit('session-changed', session)
      return { created: false, state: this.snapshot() }
    }

    const number = session.versions.length
    const extension = path.extname(session.workingPath)
    const versionPath = path.join(
      path.dirname(session.versions[0].path),
      `${String(number).padStart(3, '0')}-wersja${extension}`,
    )
    await fsp.writeFile(versionPath, bytes, { flag: 'wx', mode: 0o600 })

    const now = new Date().toISOString()
    session.versions.push({
      id: crypto.randomUUID(),
      label: `Wersja ${number}`,
      path: versionPath,
      createdAt: now,
      size: info.size,
      hash,
      automatic,
    })
    session.size = info.size
    session.updatedAt = now
    session.lastSavedHash = hash
    session.dirty = false
    await this.persist()
    this.emit('version-saved', session)
    return { created: true, state: this.snapshot() }
  }

  async readEditableDocument(sessionId) {
    const session = this.getSession(sessionId)
    const extension = path.extname(session.workingPath).toLowerCase()
    if (!EDITABLE_EXTENSIONS.has(extension)) {
      throw new Error('Edycja w aplikacji obsługuje TXT, Markdown, CSV, XML i HTML. Ten format otwórz w przypisanym edytorze.')
    }

    const info = await fsp.stat(session.workingPath)
    if (!info.isFile()) throw new Error('Nie znaleziono pliku dokumentu.')
    if (info.size > MAX_EDITABLE_BYTES) {
      throw new Error('Plik jest zbyt duży do bezpiecznej edycji w aplikacji.')
    }

    const contents = await fsp.readFile(session.workingPath)
    if (contents.includes(0)) throw new Error('Plik zawiera dane binarne i nie może być edytowany jako tekst.')

    let text
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(contents)
    } catch {
      throw new Error('Plik nie jest zapisany w UTF-8. Otwórz go w przypisanym edytorze.')
    }

    return {
      sessionId,
      name: session.name,
      extension: session.extension,
      text,
      maximumBytes: MAX_EDITABLE_BYTES,
    }
  }

  async writeWorkingFile(session, writeTemporaryFile) {
    const temporaryPath = `${session.workingPath}.${process.pid}.${crypto.randomUUID()}.tmp`
    try {
      await writeTemporaryFile(temporaryPath)
      await fsp.rename(temporaryPath, session.workingPath)
    } finally {
      await fsp.rm(temporaryPath, { force: true }).catch(() => {})
    }
  }

  async saveEditableDocument(sessionId, text) {
    if (typeof text !== 'string') throw new Error('Nieprawidłowa treść dokumentu.')
    const session = this.getSession(sessionId)
    const extension = path.extname(session.workingPath).toLowerCase()
    if (!EDITABLE_EXTENSIONS.has(extension)) {
      throw new Error('Tego formatu nie można edytować bezpośrednio w aplikacji.')
    }

    const contents = Buffer.from(text, 'utf8')
    if (contents.length > MAX_EDITABLE_BYTES) {
      throw new Error('Treść jest zbyt duża do bezpiecznego zapisu w aplikacji.')
    }

    clearTimeout(this.autoVersionTimers.get(sessionId))
    await this.writeWorkingFile(session, (temporaryPath) => (
      fsp.writeFile(temporaryPath, contents, { flag: 'wx', mode: 0o600 })
    ))
    await this.inspectChange(sessionId)
    clearTimeout(this.autoVersionTimers.get(sessionId))
    return this.saveVersion(sessionId)
  }

  async replaceWorkingDocument(sessionId, sourcePath) {
    const session = this.getSession(sessionId)
    const source = path.resolve(sourcePath)
    if (source === path.resolve(session.workingPath)) return { created: false, state: this.snapshot() }

    const info = await fsp.stat(source)
    if (!info.isFile()) throw new Error('Wybrana ścieżka nie jest plikiem.')
    if (!info.size) throw new Error('Nie można użyć pustego pliku.')
    if (info.size > MAX_DOCUMENT_BYTES) throw new Error('Wybrany plik jest zbyt duży.')

    const currentExtension = path.extname(session.workingPath).toLowerCase()
    const replacementExtension = path.extname(source).toLowerCase()
    if (replacementExtension !== currentExtension) {
      throw new Error(`Wybierz plik w tym samym formacie (${currentExtension || 'bez rozszerzenia'}).`)
    }

    await this.saveVersion(sessionId)
    clearTimeout(this.autoVersionTimers.get(sessionId))
    await this.writeWorkingFile(session, (temporaryPath) => (
      fsp.copyFile(source, temporaryPath, fs.constants.COPYFILE_EXCL)
    ))
    await this.inspectChange(sessionId)
    clearTimeout(this.autoVersionTimers.get(sessionId))
    return this.saveVersion(sessionId)
  }

  async updateSettings(settings) {
    const allowed = [
      'editorMode',
      'editorPath',
      'automaticVersions',
      'acceptLegacyProtocol',
      'serviceUrl',
      'launchAtLogin',
      'launchAtLoginPrompted',
    ]
    for (const key of allowed) {
      if (Object.hasOwn(settings, key)) this.state.settings[key] = settings[key]
    }
    await this.persist()
    this.emit('settings-changed', this.state.settings)
    return this.snapshot()
  }

  emit(type, payload) {
    this.onChange({ type, payload, state: this.snapshot() })
  }

  close() {
    for (const timer of this.debounceTimers.values()) clearTimeout(timer)
    for (const timer of this.autoVersionTimers.values()) clearTimeout(timer)
    for (const watcher of this.watchers.values()) watcher.close()
    this.watchers.clear()
  }
}

module.exports = {
  DEFAULT_SETTINGS,
  EDITABLE_EXTENSIONS,
  MAX_EDITABLE_BYTES,
  MAX_DOCUMENT_BYTES,
  MAX_SIGNED_DOCUMENT_BYTES,
  SIGNATURE_STATES,
  SUPPORTED_EXTENSIONS,
  SessionStore,
  safeFileName,
  safeRemoteId,
  sha256,
}
