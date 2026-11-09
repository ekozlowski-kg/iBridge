const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { EzdSessionCoordinator } = require('../electron/ezd-session-coordinator.cjs')

const hash = (data) => crypto.createHash('sha256').update(data).digest('hex')

async function coordinatorFixture(t, contents, options = {}) {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'ezd-ibridge-coordinator-'))
  t.after(() => fsp.rm(directory, { recursive: true, force: true }))
  const workingPath = path.join(directory, 'pismo.docx')
  await fsp.writeFile(workingPath, contents)
  const sessionId = 'session-1'
  const calls = []
  const session = {
    id: sessionId,
    workingPath,
    missing: false,
    remote: { status: 'editing', syncStatus: 'idle', lastError: null },
  }
  const store = {
    session,
    getSession(id) {
      assert.equal(id, sessionId)
      return session
    },
    async saveVersion() { calls.push('save-version'); return { created: true } },
    async markRemoteSyncPending() { session.remote.syncStatus = 'pending'; calls.push('pending') },
    async markRemoteSyncing() { session.remote.syncStatus = 'syncing'; calls.push('syncing') },
    async markRemoteSynced(_id, result) {
      session.remote.syncStatus = 'synced'
      session.remote.lastSyncedHash = result.hash
      if (result.documentId) session.remote.documentId = result.documentId
      calls.push('synced')
      return this.snapshot()
    },
    async markRemoteSyncError(_id, error) {
      session.remote.syncStatus = 'error'
      session.remote.lastError = { ...error }
      calls.push('sync-error')
      return this.snapshot()
    },
    async markRemoteUploaded(_id, result) {
      session.remote.status = 'sent'
      session.remote.documentId = result.documentId
      calls.push('sent')
      return this.snapshot()
    },
    snapshot() { return { sessions: [structuredClone(session)] } },
  }

  let releaseFirstUpload
  let notifyFirstUpload
  const firstUploadStarted = new Promise((resolve) => { notifyFirstUpload = resolve })
  const firstUploadGate = new Promise((resolve) => { releaseFirstUpload = resolve })
  const client = {
    operations: [],
    uploaded: [],
    finishError: options.finishError || null,
    uploadError: options.uploadError || null,
    async uploadFile(data) {
      this.operations.push('upload')
      this.uploaded.push(Buffer.from(data))
      if (this.uploaded.length === 1 && options.holdFirstUpload) {
        notifyFirstUpload()
        await firstUploadGate
      }
      if (this.uploadError) throw this.uploadError
      return { documentId: 99 }
    },
    async finishSession() {
      this.operations.push('finish')
      if (this.finishError) throw this.finishError
      return { ok: true }
    },
  }

  const coordinator = new EzdSessionCoordinator({ store })
  coordinator.liveSessions.set(sessionId, {
    client,
    documentId: 12,
    inFlight: null,
    pending: false,
    finishing: null,
    lastUploadedHash: hash(Buffer.from(options.downloadedContents || 'original')),
  })

  return {
    calls,
    client,
    coordinator,
    firstUploadStarted,
    releaseFirstUpload,
    sessionId,
    store,
    workingPath,
  }
}

test('sync uploads a changed file but does not finish the EZD session', async (t) => {
  const fixture = await coordinatorFixture(t, Buffer.from('changed'))
  await fixture.coordinator.sync(fixture.sessionId)
  assert.deepEqual(fixture.client.operations, ['upload'])
  assert.deepEqual(fixture.client.uploaded.map(String), ['changed'])
  assert.equal(fixture.store.session.remote.syncStatus, 'synced')
  assert.equal(fixture.store.session.remote.status, 'editing')
})

test('sync skips content that is already present in EZD', async (t) => {
  const fixture = await coordinatorFixture(t, Buffer.from('same'), { downloadedContents: 'same' })
  await fixture.coordinator.sync(fixture.sessionId)
  assert.deepEqual(fixture.client.operations, [])
  assert.equal(fixture.store.session.remote.syncStatus, 'synced')
})

test('three requests during one upload produce one current and one latest upload', async (t) => {
  const fixture = await coordinatorFixture(t, Buffer.from('v1'), { holdFirstUpload: true })
  const first = fixture.coordinator.sync(fixture.sessionId)
  await fixture.firstUploadStarted
  await fsp.writeFile(fixture.workingPath, 'v2')
  const second = fixture.coordinator.sync(fixture.sessionId)
  await fsp.writeFile(fixture.workingPath, 'v3')
  const third = fixture.coordinator.sync(fixture.sessionId)
  await new Promise((resolve) => setImmediate(resolve))
  fixture.releaseFirstUpload()
  await Promise.all([first, second, third])
  assert.deepEqual(fixture.client.uploaded.map(String), ['v1', 'v3'])
})

test('finish does not re-upload after sync and can retry finish separately', async (t) => {
  const finishError = new Error('status 1')
  const fixture = await coordinatorFixture(t, Buffer.from('final'), { finishError })
  await fixture.coordinator.sync(fixture.sessionId)
  await assert.rejects(fixture.coordinator.finish(fixture.sessionId), /status 1/)
  assert.equal(fixture.client.uploaded.length, 1)
  assert.deepEqual(fixture.client.operations, ['upload', 'finish'])
  assert.equal(fixture.store.session.remote.syncStatus, 'synced')
  assert.equal(fixture.coordinator.hasLiveSession(fixture.sessionId), true)

  fixture.client.finishError = null
  await fixture.coordinator.finish(fixture.sessionId)
  assert.equal(fixture.client.uploaded.length, 1)
  assert.deepEqual(fixture.client.operations, ['upload', 'finish', 'finish'])
  assert.equal(fixture.store.session.remote.status, 'sent')
  assert.equal(fixture.coordinator.hasLiveSession(fixture.sessionId), false)
})

test('persists an operation-aware upload error and allows the same content to retry', async (t) => {
  const uploadError = Object.assign(new Error('AddInUploadFile status 1'), {
    operation: 'AddInUploadFile', kind: 'ezd', ezdStatus: 1, httpStatus: 200, authToken: 'secret',
  })
  const fixture = await coordinatorFixture(t, Buffer.from('retry-me'), { uploadError })
  await assert.rejects(fixture.coordinator.sync(fixture.sessionId), /status 1/)
  assert.deepEqual(fixture.store.session.remote.lastError, {
    operation: 'AddInUploadFile', kind: 'ezd', ezdStatus: 1, httpStatus: 200, message: 'AddInUploadFile status 1',
  })
  fixture.client.uploadError = null
  await fixture.coordinator.sync(fixture.sessionId)
  assert.equal(fixture.client.uploaded.length, 2)
  assert.equal(fixture.store.session.remote.syncStatus, 'synced')
})

test('releaseAll waits for the latest queued content before finishing', async (t) => {
  const fixture = await coordinatorFixture(t, Buffer.from('v1'), { holdFirstUpload: true })
  const first = fixture.coordinator.sync(fixture.sessionId)
  await fixture.firstUploadStarted
  await fsp.writeFile(fixture.workingPath, 'v2')
  const release = fixture.coordinator.releaseAll()
  await new Promise((resolve) => setImmediate(resolve))
  fixture.releaseFirstUpload()
  await Promise.all([first, release])
  assert.deepEqual(fixture.client.uploaded.map(String), ['v1', 'v2'])
  assert.deepEqual(fixture.client.operations, ['upload', 'upload', 'finish'])
})

test('starts watching the downloaded file before opening the editor', async () => {
  const calls = []
  const store = {
    async importRemoteDocument() {
      calls.push('import')
      return { sessionId: 'received', workingPath: '/tmp/pismo.docx', sessions: [{ id: 'received', workingPath: '/tmp/pismo.docx' }] }
    },
    snapshot: () => ({ sessions: [{ id: 'received', workingPath: '/tmp/pismo.docx' }] }),
  }
  const client = {
    checkData: async () => ({ documentName: 'pismo.docx', documentId: 4 }),
    downloadFile: async () => ({ data: Buffer.from('document') }),
    setDiagnosticContext: () => {},
  }
  const coordinator = new EzdSessionCoordinator({
    store,
    clientFactory: () => client,
    onSessionReady: async ({ sessionId, workingPath }) => {
      assert.deepEqual({ sessionId, workingPath }, { sessionId: 'received', workingPath: '/tmp/pismo.docx' })
      calls.push('watch')
    },
    openEditor: async () => calls.push('editor'),
  })
  await coordinator.receive({ serviceUrl: 'https://example.test', authToken: 'secret' })
  assert.deepEqual(calls, ['import', 'watch', 'editor'])
})
