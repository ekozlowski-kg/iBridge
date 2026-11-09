const assert = require('node:assert/strict')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { SessionStore, safeRemoteId } = require('../electron/session-store.cjs')

async function makeTemporaryDirectory(t) {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'ezd-ibridge-store-'))
  t.after(() => fsp.rm(directory, { recursive: true, force: true }))
  return directory
}

async function makeRemoteStore(t, options = {}) {
  const baseDir = await makeTemporaryDirectory(t)
  const events = []
  const store = new SessionStore({ baseDir, onChange: (event) => events.push(event.type) })
  t.after(() => store.close())
  await store.init()
  await store.importRemoteDocument({
    fileName: 'pismo.docx',
    data: Buffer.from('x'),
    metadata: { documentId: 12, serviceUrl: 'https://ezd-proxy.kg.straz.gov.pl/EzdProxy.svc' },
  })
  return { store, events, baseDir, ...options }
}

test('initializes synchronization fields for a new remote document', async (t) => {
  const { store } = await makeRemoteStore(t)
  assert.deepEqual(
    {
      syncStatus: store.snapshot().sessions[0].remote.syncStatus,
      lastSyncedAt: store.snapshot().sessions[0].remote.lastSyncedAt,
      lastSyncedHash: store.snapshot().sessions[0].remote.lastSyncedHash,
      lastError: store.snapshot().sessions[0].remote.lastError,
    },
    { syncStatus: 'idle', lastSyncedAt: null, lastSyncedHash: '', lastError: null },
  )
})

test('normalizes remote IDs to numeric values or canonical unsigned decimal strings', () => {
  for (const [value, expected] of [
    [0, 0],
    [42, 42],
    ['0', 0],
    ['42', 42],
    ['', 0],
    [' ', 0],
    ['0x10', 0],
    ['1e3', 0],
    ['1.0', 0],
    ['+1', 0],
    ['-1', 0],
    ['01', 0],
    ['9007199254740992', 0],
  ]) {
    assert.equal(safeRemoteId(value), expected)
  }
})

test('serializes concurrent persists with private unique siblings and keeps the latest invocation', async (t) => {
  const baseDir = await makeTemporaryDirectory(t)
  const store = new SessionStore({ baseDir })
  t.after(() => store.close())
  await store.init()

  const originalMkdir = fsp.mkdir
  const originalWriteFile = fsp.writeFile
  let releaseFirstWrite
  let signalFirstWrite
  const firstWriteGate = new Promise((resolve) => { releaseFirstWrite = resolve })
  const firstWriteReached = new Promise((resolve) => { signalFirstWrite = resolve })
  const temporaryPaths = []
  const operations = []

  fsp.mkdir = async (directory, options) => {
    if (path.resolve(directory) === path.resolve(baseDir)) return undefined
    return originalMkdir(directory, options)
  }
  fsp.writeFile = async (filePath, data, options) => {
    const candidate = String(filePath)
    if (candidate.startsWith(`${store.statePath}.`) && candidate.endsWith('.tmp')) {
      temporaryPaths.push(candidate)
      if (temporaryPaths.length === 1) {
        signalFirstWrite()
        await firstWriteGate
      }
    }
    return originalWriteFile(filePath, data, options)
  }

  try {
    operations.push(store.updateSettings({ editorPath: 'persist-value-0' }))
    await firstWriteReached
    for (let index = 1; index < 32; index += 1) {
      operations.push(store.updateSettings({ editorPath: `persist-value-${index}` }))
    }

    // Every unqueued implementation has now crossed its already-resolved mkdir await.
    await Promise.resolve()
    const writesWhileFirstBlocked = temporaryPaths.length
    releaseFirstWrite()
    const results = await Promise.allSettled(operations)

    assert.equal(writesWhileFirstBlocked, 1, 'later persists must wait behind the first write')
    assert.equal(results.every(({ status }) => status === 'fulfilled'), true)
    assert.equal(temporaryPaths.length, operations.length)
    assert.equal(new Set(temporaryPaths).size, operations.length)
    for (const temporaryPath of temporaryPaths) {
      assert.equal(path.dirname(temporaryPath), path.dirname(store.statePath))
      assert.match(
        path.basename(temporaryPath),
        /^stan\.json\.[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/i,
      )
    }

    const persisted = JSON.parse(await fsp.readFile(store.statePath, 'utf8'))
    assert.equal(persisted.settings.editorPath, 'persist-value-31')
    assert.equal((await fsp.stat(store.statePath)).mode & 0o777, 0o600)
    const siblings = await fsp.readdir(baseDir)
    assert.deepEqual(siblings.filter((name) => /^stan\.json\..+\.tmp$/.test(name)), [])
  } finally {
    releaseFirstWrite()
    await Promise.allSettled(operations)
    fsp.mkdir = originalMkdir
    fsp.writeFile = originalWriteFile
  }
})

test('keeps the persist queue usable after one private temporary write fails', async (t) => {
  const baseDir = await makeTemporaryDirectory(t)
  const store = new SessionStore({ baseDir })
  t.after(() => store.close())
  await store.init()

  const originalWriteFile = fsp.writeFile
  let failNextStateWrite = true
  fsp.writeFile = async (filePath, ...args) => {
    const candidate = String(filePath)
    if (failNextStateWrite
        && candidate.startsWith(`${store.statePath}.`)
        && candidate.endsWith('.tmp')) {
      failNextStateWrite = false
      const error = new Error('injected persist failure')
      error.code = 'EIO'
      throw error
    }
    return originalWriteFile(filePath, ...args)
  }

  try {
    await assert.rejects(
      store.updateSettings({ editorPath: 'must-not-win' }),
      /injected persist failure/,
    )
    await store.updateSettings({ editorPath: 'recovered-latest' })
    const persisted = JSON.parse(await fsp.readFile(store.statePath, 'utf8'))
    assert.equal(persisted.settings.editorPath, 'recovered-latest')
    const siblings = await fsp.readdir(baseDir)
    assert.deepEqual(siblings.filter((name) => /^stan\.json\..+\.tmp$/.test(name)), [])
  } finally {
    fsp.writeFile = originalWriteFile
  }
})

test('preserves case-link metadata with stable types after import and restart', async (t) => {
  const baseDir = await makeTemporaryDirectory(t)
  const store = new SessionStore({ baseDir })
  await store.init()
  await store.importRemoteDocument({
    fileName: 'pismo.docx',
    data: Buffer.from('x'),
    metadata: {
      serviceUrl: 'https://ezd-proxy.kg.straz.gov.pl/EzdProxy.svc',
      documentId: '12',
      pismoId: '1474132',
      pismoName: 'Pismo do sprawy',
      caseMark: 'KG-123/2026',
    },
  })
  const sessionId = store.snapshot().sessions[0].id
  store.close()

  const restarted = new SessionStore({ baseDir })
  t.after(() => restarted.close())
  await restarted.init()

  const { downloadedAt, connectionStatus, editorState, finishStatus, sourceDocumentId, documentIds, recoveryRequired, ...remote } = restarted.getSession(sessionId).remote
  assert.equal(connectionStatus, 'needs-reopen')
  assert.equal(editorState, 'unknown')
  assert.equal(recoveryRequired, false)
  assert.deepEqual(documentIds, [12])
  assert.equal(sourceDocumentId, 12)
  assert.equal(finishStatus, 'idle')
  assert.match(downloadedAt, /^\d{4}-\d{2}-\d{2}T/)
  assert.deepEqual(remote, {
    serviceUrl: 'https://ezd-proxy.kg.straz.gov.pl/EzdProxy.svc',
    documentId: 12,
    documentMode: 0,
    pismoId: 1474132,
    pismoName: 'Pismo do sprawy',
    caseMark: 'KG-123/2026',
    shared: false,
    status: 'editing',
    syncStatus: 'idle',
    lastSyncedAt: null,
    lastSyncedHash: '',
    lastError: null,
  })
})

test('persists pending, syncing, synced, and error states without secrets', async (t) => {
  const { store, events } = await makeRemoteStore(t)
  const sessionId = store.snapshot().sessions[0].id
  await store.markRemoteSyncPending(sessionId)
  assert.equal(store.getSession(sessionId).remote.syncStatus, 'pending')
  await store.markRemoteSyncing(sessionId)
  assert.equal(store.getSession(sessionId).remote.syncStatus, 'syncing')
  await store.markRemoteSynced(sessionId, { hash: 'a'.repeat(64), documentId: 77 })
  assert.equal(store.getSession(sessionId).remote.syncStatus, 'synced')
  assert.equal(store.getSession(sessionId).remote.lastSyncedHash, 'a'.repeat(64))
  assert.equal(store.getSession(sessionId).remote.documentId, 77)
  assert.match(store.getSession(sessionId).remote.lastSyncedAt, /^\d{4}-\d{2}-\d{2}T/)
  await store.markRemoteSyncError(sessionId, {
    operation: 'AddInUploadFile',
    kind: 'ezd',
    ezdStatus: 1,
    message: 'status 1',
    authToken: 'top-secret',
    protocolUrl: 'ezd://top-secret/path',
  })
  assert.equal(store.getSession(sessionId).remote.syncStatus, 'error')
  assert.deepEqual(events.slice(-4), [
    'remote-sync-pending',
    'remote-syncing',
    'remote-synced',
    'remote-sync-error',
  ])

  const persisted = await fsp.readFile(store.statePath, 'utf8')
  assert.match(persisted, /AddInUploadFile/)
  assert.doesNotMatch(persisted, /authToken|protocolUrl|top-secret|ezd:\/\//)
})

test('keeps remote document IDs numeric when synchronization updates provide malformed values', async (t) => {
  const { store } = await makeRemoteStore(t)
  const sessionId = store.snapshot().sessions[0].id

  await store.markRemoteSynced(sessionId, { hash: 'a'.repeat(64), documentId: '42' })
  assert.equal(store.getSession(sessionId).remote.documentId, 42)
  await store.markRemoteSynced(sessionId, { hash: 'b'.repeat(64), documentId: '0x10' })
  assert.equal(store.getSession(sessionId).remote.documentId, 42)
  await store.markRemoteUploaded(sessionId, { documentId: '1e3' })
  assert.equal(store.getSession(sessionId).remote.documentId, 42)
})

test('migrates missing or malformed case-link metadata to safe empty values', async (t) => {
  const baseDir = await makeTemporaryDirectory(t)
  const workingPath = path.join(baseDir, 'legacy.docx')
  await fsp.writeFile(workingPath, 'legacy')
  await fsp.writeFile(path.join(baseDir, 'stan.json'), JSON.stringify({
    settings: { settingsRevision: 2 },
    sessions: [{
      id: 'legacy-session',
      workingPath,
      remote: {
        status: 'editing',
        documentId: 'not-an-id',
        pismoId: Number.MAX_SAFE_INTEGER + 1,
        pismoName: { unexpected: 'value' },
        caseMark: ['unexpected'],
        lastError: { authToken: 'secret' },
      },
      versions: [],
    }],
  }))

  const store = new SessionStore({ baseDir })
  t.after(() => store.close())
  await store.init()
  assert.deepEqual(store.getSession('legacy-session').remote, {
    status: 'editing',
    connectionStatus: 'needs-reopen',
    editorState: 'unknown',
    recoveryRequired: false,
    documentId: 0,
    pismoId: 0,
    pismoName: '',
    caseMark: '',
    syncStatus: 'idle',
    lastSyncedAt: null,
    lastSyncedHash: '',
    lastError: null,
  })
  const persisted = await fsp.readFile(store.statePath, 'utf8')
  assert.match(persisted, /"syncStatus": "idle"/)
  assert.doesNotMatch(persisted, /secret|authToken/)
})

test('imports a signature PDF into owner-only storage without an edit watcher', async (t) => {
  const baseDir = await makeTemporaryDirectory(t)
  const store = new SessionStore({ baseDir })
  t.after(() => store.close())
  await store.init()
  const original = Buffer.from('%PDF-1.7\noriginal signature input')

  const imported = await store.importSignatureDocument({
    fileName: 'do podpisu.pdf',
    data: original,
    metadata: {
      serviceUrl: 'https://ezd-proxy.kg.straz.gov.pl/EzdProxy.svc',
      documentId: 12,
      pismoId: 1474132,
      pismoName: 'Pismo do sprawy',
      caseMark: 'KG-123/2026',
      certificateSerial: '00A1B2',
      signingTime: '2026-08-31T08:11:12.000Z',
      signatureMode: 9,
      includeTimestamp: true,
    },
  })

  assert.deepEqual(Object.keys(imported).sort(), ['sessionId', 'state'])
  const session = imported.state.sessions.find(({ id }) => id === imported.sessionId)
  assert.ok(session)
  const paths = store.getSignaturePaths(session.id)
  assert.equal(session.remote.operation, 'signature')
  assert.equal(session.remote.status, 'downloading')
  assert.equal(session.remote.caseMark, 'KG-123/2026')
  assert.equal(session.remote.pismoName, 'Pismo do sprawy')
  assert.equal(session.remote.pismoId, 1474132)
  assert.equal(session.remote.documentId, 12)
  assert.equal(session.remote.expectedCertificateSerial, '00A1B2')
  assert.equal(session.remote.signatureMode, 9)
  assert.equal(session.remote.includeTimestamp, true)
  assert.equal(store.watchers.has(session.id), false)
  assert.equal((await fsp.stat(path.dirname(paths.inputPath))).mode & 0o777, 0o700)
  assert.equal((await fsp.stat(path.dirname(path.dirname(paths.inputPath)))).mode & 0o777, 0o700)
  assert.equal((await fsp.stat(paths.inputPath)).mode & 0o777, 0o600)
  assert.deepEqual(await fsp.readFile(paths.inputPath), original)
  await assert.rejects(fsp.stat(paths.outputPath), { code: 'ENOENT' })
  assert.equal(path.dirname(paths.inputPath), path.dirname(paths.outputPath))
})

test('saves the exact verified Buffer as version 1 before upload state', async (t) => {
  const baseDir = await makeTemporaryDirectory(t)
  const store = new SessionStore({ baseDir })
  t.after(() => store.close())
  await store.init()
  const imported = await store.importSignatureDocument({
    fileName: 'input.pdf',
    data: Buffer.from('%PDF-1.7\noriginal'),
    metadata: {},
  })
  const { sessionId } = imported
  const signedBytes = Buffer.from('%PDF-1.7\nsigned exact bytes')
  const hash = require('node:crypto').createHash('sha256').update(signedBytes).digest('hex')

  await store.saveSignedSignatureVersion(sessionId, {
    signedBytes,
    hash,
    size: signedBytes.length,
    profile: 'PAdES-B-B',
    subject: 'Jan Kowalski',
    warnings: ['REVOCATION_NOT_CHECKED'],
  })

  const session = store.getSession(sessionId)
  assert.equal(session.versions.length, 2)
  assert.equal(session.remote.status, 'signed-local')
  assert.equal(session.remote.signatureHash, hash)
  assert.equal(session.remote.signatureProfile, 'PAdES-B-B')
  assert.equal(session.remote.signatureSubject, 'Jan Kowalski')
  assert.deepEqual(session.remote.signatureWarnings, ['REVOCATION_NOT_CHECKED'])
  assert.equal(session.workingPath, session.versions[1].path)
  assert.deepEqual(await fsp.readFile(session.versions[1].path), signedBytes)
  assert.equal((await fsp.stat(session.versions[1].path)).mode & 0o777, 0o600)
  assert.equal(store.watchers.has(sessionId), false)
})

test('persists only allowlisted signature states/details and migrates uploading to unknown', async (t) => {
  const baseDir = await makeTemporaryDirectory(t)
  const store = new SessionStore({ baseDir })
  await store.init()
  const imported = await store.importSignatureDocument({
    fileName: 'input.pdf',
    data: Buffer.from('%PDF-1.7\noriginal'),
    metadata: {},
  })
  const { sessionId } = imported
  const secret = 'synthetic-pin-and-auth-token'
  await store.markSignatureState(sessionId, 'awaiting-pin', {
    phase: 'awaiting-pin',
    message: secret,
    pin: secret,
    authToken: secret,
    signatureRoleXml: secret,
    outputPath: `/tmp/${secret}`,
  })
  await store.markSignatureState(sessionId, 'uploading', {
    phase: 'uploading',
    size: 123,
  })
  assert.equal(store.getSession(sessionId).remote.status, 'uploading')
  assert.match(store.getSession(sessionId).remote.uploadAttemptedAt, /^\d{4}-\d{2}-\d{2}T/)
  const persistedBefore = await fsp.readFile(store.statePath, 'utf8')
  assert.doesNotMatch(persistedBefore, new RegExp(secret))
  assert.doesNotMatch(persistedBefore, /signatureRoleXml|outputPath|authToken|"pin"/)
  store.close()

  const restarted = new SessionStore({ baseDir })
  t.after(() => restarted.close())
  await restarted.init()
  const remote = restarted.getSession(sessionId).remote
  assert.equal(remote.operation, 'signature')
  assert.equal(remote.status, 'upload-unknown')
  assert.equal(remote.phase, 'uploading')
  assert.equal(remote.size, 123)
  assert.equal(restarted.watchers.has(sessionId), false)
  assert.doesNotMatch(await fsp.readFile(restarted.statePath, 'utf8'), new RegExp(secret))
})

test('accepts every durable signature terminal state without adding secret error text', async (t) => {
  for (const durableState of [
    'downloading', 'awaiting-pin', 'signing', 'verifying', 'signed-local',
    'uploading', 'completed', 'upload-rejected', 'upload-unknown', 'cancelled', 'failed',
  ]) {
    const baseDir = await makeTemporaryDirectory(t)
    const store = new SessionStore({ baseDir })
    await store.init()
    const imported = await store.importSignatureDocument({
      fileName: 'input.pdf',
      data: Buffer.from('%PDF-1.7\noriginal'),
      metadata: { documentId: 12 },
    })
    const { sessionId } = imported
    await store.markSignatureState(sessionId, durableState, {
      code: 'SAFE_CODE',
      message: 'must-not-persist',
      documentId: 77,
      ezdStatus: 1,
      httpStatus: 503,
    })
    assert.equal(store.getSession(sessionId).remote.status, durableState)
    assert.equal(store.getSession(sessionId).remote.code, 'SAFE_CODE')
    assert.equal(store.getSession(sessionId).remote.documentId, 12)
    assert.doesNotMatch(await fsp.readFile(store.statePath, 'utf8'), /must-not-persist/)
    store.close()
  }
})
