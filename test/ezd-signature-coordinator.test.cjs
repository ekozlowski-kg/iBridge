const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { EzdSignatureCoordinator } = require('../electron/ezd-signature-coordinator.cjs')
const { SessionStore } = require('../electron/session-store.cjs')

const signedPdf = Buffer.from('%PDF-1.7\nsigned exact coordinator bytes')
const signedHash = crypto.createHash('sha256').update(signedPdf).digest('hex')
const certificateSerial = '00A1B2'

function helperFailure(code, secret = '') {
  const error = new Error(`raw helper error ${secret}`)
  error.code = code
  return error
}

function clientFailure(kind, { ezdStatus = 0, httpStatus = 0, secret = '' } = {}) {
  const error = new Error(`raw SOAP error ${secret}`)
  error.kind = kind
  error.ezdStatus = ezdStatus
  error.httpStatus = httpStatus
  error.operation = 'AddInPodpisUpload'
  return error
}

async function makeFixture(t, {
  mode = 6,
  includeTimestamp = false,
  helper = null,
  upload = null,
  checkPatch = {},
  signaturePatch = {},
} = {}) {
  const baseDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ibridge-signature-coordinator-'))
  t.after(() => fsp.rm(baseDir, { recursive: true, force: true }))
  const store = new SessionStore({ baseDir })
  t.after(() => store.close())
  await store.init()
  const events = []
  const diagnostics = []
  const calls = {
    checkData: 0,
    downloadSignatureData: 0,
    uploadSignature: 0,
    finishSession: 0,
    status: 0,
    signPades: 0,
    uploads: [],
    signRequests: [],
    pins: [],
  }
  const client = {
    setDiagnosticContext: () => {},
    checkData: async () => {
      calls.checkData += 1
      return {
        documentId: 12,
        documentName: 'nazwa-z-check.pdf',
        documentMode: 0,
        pismoId: 1474132,
        pismoName: 'Pismo do sprawy',
        caseMark: 'KG-123/2026',
        shared: false,
        ...checkPatch,
      }
    },
    downloadSignatureData: async () => {
      calls.downloadSignatureData += 1
      return {
        data: Buffer.from('%PDF-1.7\noriginal coordinator input'),
        fileName: 'do-podpisu.pdf',
        fileLength: 35,
        mode,
        certificateSerial,
        signingTime: '2026-08-31T08:11:12.000Z',
        includeTimestamp,
        signatureRoleXml: '<Role>Director</Role>',
        fileHash: 'sha1',
        fileHash256: 'sha256',
        caseMark: 'ATTACKER-CASE',
        pismoName: 'ATTACKER-NAME',
        pismoId: 999,
        documentId: 999,
        ...signaturePatch,
      }
    },
    uploadSignature: async (bytes) => {
      calls.uploadSignature += 1
      calls.uploads.push(Buffer.from(bytes))
      return upload ? upload(bytes) : { documentId: 77, message: 'accepted' }
    },
    finishSession: async () => {
      calls.finishSession += 1
      throw new Error('signature flow must not finish session')
    },
  }
  const defaultHelper = {
    status: async () => {
      calls.status += 1
      return { ok: true, pkcs11Exists: true, tokenReady: true }
    },
    signPades: async (request, pin, { signal, onPhase }) => {
      calls.signPades += 1
      calls.signRequests.push({ ...request })
      calls.pins.push(pin)
      if (signal.aborted) throw helperFailure('CANCELLED')
      await onPhase('verifying')
      return {
        result: {
          ok: true,
          outputPath: request.outputPath,
          outputSha256: signedHash,
          outputBytes: signedPdf.length,
          outputDevice: '1',
          outputInode: '2',
          certificateSerial,
          subject: 'Jan Kowalski',
          profile: includeTimestamp ? 'PAdES-B-T' : 'PAdES-B-B',
          warnings: ['REVOCATION_NOT_CHECKED'],
        },
        signedBytes: Buffer.from(signedPdf),
      }
    },
  }
  const coordinator = new EzdSignatureCoordinator({
    store,
    helper: helper || defaultHelper,
    clientFactory: ({ authToken }) => {
      assert.equal(authToken, 'synthetic-auth-token')
      return client
    },
    onEvent: (channel, payload) => events.push({ channel, payload }),
    onDiagnostic: (event) => diagnostics.push(event),
  })
  return { store, coordinator, client, calls, events, diagnostics, defaultHelper, baseDir }
}

function requestedEvent(events) {
  return events.find((event) => event.channel === 'signature-requested')
}

function finishedEvent(events) {
  return events.findLast((event) => event.channel === 'signature-finished')
}

async function assertTerminalReleased(coordinator, requestId, record) {
  assert.equal(coordinator.activeRequestId, null)
  assert.equal(coordinator.requests.has(requestId), false)
  assert.equal(coordinator.requests.size, 0)
  assert.equal(record.client, null)
  assert.equal(record.policy, null)
  assert.equal(record.signedBytes, null)
  assert.equal(record.verifiedResult, null)
  assert.equal(record.abortController, null)
  assert.equal(record.operationPromise, null)
  await assert.rejects(
    coordinator.approve(requestId, 'repeated-pin'),
    (error) => error.code === 'REQUEST_NOT_FOUND',
  )
  await assert.rejects(
    coordinator.cancel(requestId),
    (error) => error.code === 'REQUEST_NOT_FOUND',
  )
}

test('runs the full state machine, stores version 1, and uploads the exact verified Buffer once', async (t) => {
  const fixture = await makeFixture(t)
  const stateOrder = []
  for (const methodName of ['markSignatureState', 'saveSignedSignatureVersion']) {
    const original = fixture.store[methodName].bind(fixture.store)
    fixture.store[methodName] = async (...args) => {
      const result = await original(...args)
      stateOrder.push(methodName === 'saveSignedSignatureVersion' ? 'signed-local' : args[1])
      return result
    }
  }

  const requested = await fixture.coordinator.receive({
    serviceUrl: 'https://ezd-proxy.kg.straz.gov.pl/EzdProxy.svc',
    authToken: 'synthetic-auth-token',
  })
  assert.equal(requested.status, 'awaiting-pin')
  assert.equal(fixture.calls.checkData, 1)
  assert.equal(fixture.calls.downloadSignatureData, 1)
  assert.equal(fixture.calls.status, 1)
  const requestId = requested.requestId
  const completed = await fixture.coordinator.approve(requestId, 'synthetic-pin')

  assert.equal(completed.status, 'completed')
  assert.deepEqual(stateOrder, [
    'awaiting-pin', 'signing', 'verifying', 'signed-local', 'uploading', 'completed',
  ])
  assert.equal(fixture.calls.signPades, 1)
  assert.equal(fixture.calls.uploadSignature, 1)
  assert.equal(fixture.calls.finishSession, 0)
  assert.deepEqual(fixture.calls.uploads[0], signedPdf)
  const session = fixture.store.getSession(requested.sessionId)
  assert.equal(session.versions.length, 2)
  assert.equal(session.remote.status, 'completed')
  assert.equal(session.remote.documentId, 12)
  assert.deepEqual(await fsp.readFile(session.versions[1].path), signedPdf)
  assert.deepEqual(finishedEvent(fixture.events).payload, {
    requestId,
    sessionId: requested.sessionId,
    status: 'completed',
    code: 'OK',
    documentId: 77,
    subject: 'Jan Kowalski',
    profile: 'PAdES-B-B',
  })
})

test('uses case data only from checkData and signing policy only from SignatureData', async (t) => {
  const fixture = await makeFixture(t, { mode: 9, includeTimestamp: true })
  const requested = await fixture.coordinator.receive({
    serviceUrl: 'https://ezd-proxy.kg.straz.gov.pl/EzdProxy.svc',
    authToken: 'synthetic-auth-token',
  })
  const event = requestedEvent(fixture.events).payload
  assert.deepEqual(event, {
    requestId: requested.requestId,
    sessionId: requested.sessionId,
    fileName: 'do-podpisu.pdf',
    caseMark: 'KG-123/2026',
    pismoName: 'Pismo do sprawy',
    expectedCertificateSerial: certificateSerial,
    mode: 9,
    includeTimestamp: true,
  })
  assert.equal(JSON.stringify(event).includes('ATTACKER'), false)
  await fixture.coordinator.approve(requested.requestId, 'synthetic-pin')
  assert.deepEqual(fixture.calls.signRequests[0], {
    inputPath: fixture.store.getSignaturePaths(requested.sessionId).inputPath,
    outputPath: fixture.store.getSignaturePaths(requested.sessionId).outputPath,
    certificateSerial,
    signingTime: '2026-08-31T08:11:12.000Z',
    includeTimestamp: true,
    visible: true,
    signatureRoleXml: '<Role>Director</Role>',
  })
  const session = fixture.store.getSession(requested.sessionId)
  assert.equal(session.remote.caseMark, 'KG-123/2026')
  assert.equal(session.remote.pismoName, 'Pismo do sprawy')
  assert.equal(session.remote.pismoId, 1474132)
  assert.equal(session.remote.documentId, 12)
})

test('keeps only active requests and releases every completed record over repeated cycles', async (t) => {
  const fixture = await makeFixture(t)
  const records = []
  const requestIds = []
  const cycles = 24

  for (let index = 0; index < cycles; index += 1) {
    const requested = await fixture.coordinator.receive({
      serviceUrl: 'https://ezd-proxy.kg.straz.gov.pl/EzdProxy.svc',
      authToken: 'synthetic-auth-token',
    })
    const record = fixture.coordinator.requests.get(requested.requestId)
    assert.ok(record)
    assert.equal(record.state, 'awaiting-pin')
    assert.equal(fixture.coordinator.requests.size, 1)
    records.push(record)
    requestIds.push(requested.requestId)

    const completed = await fixture.coordinator.approve(requested.requestId, 'synthetic-pin')
    assert.equal(completed.status, 'completed')
  }

  assert.equal(fixture.calls.signPades, cycles)
  assert.equal(fixture.calls.uploadSignature, cycles)
  assert.equal(fixture.coordinator.requests.size, 0)
  assert.equal(fixture.coordinator.activeRequestId, null)
  for (const record of records) {
    assert.equal(record.client, null)
    assert.equal(record.policy, null)
    assert.equal(record.signedBytes, null)
    assert.equal(record.verifiedResult, null)
    assert.equal(record.abortController, null)
    assert.equal(record.operationPromise, null)
  }
  await assert.rejects(
    fixture.coordinator.approve(requestIds.at(-1), 'repeated-pin'),
    (error) => error.code === 'REQUEST_NOT_FOUND',
  )
  await assert.rejects(
    fixture.coordinator.cancel(requestIds.at(-1)),
    (error) => error.code === 'REQUEST_NOT_FOUND',
  )
})

test('binds a gated signature import to its explicit session while a normal import persists', async (t) => {
  const fixture = await makeFixture(t)
  const localSource = path.join(fixture.baseDir, 'lokalny.txt')
  await fsp.writeFile(localSource, 'lokalny dokument')

  const originalPersist = fixture.store.persist.bind(fixture.store)
  let persistCalls = 0
  let releaseSignaturePersist
  let signalSignaturePersist
  let signalLocalPersist
  const signaturePersistGate = new Promise((resolve) => { releaseSignaturePersist = resolve })
  const signaturePersistReached = new Promise((resolve) => { signalSignaturePersist = resolve })
  const localPersistReached = new Promise((resolve) => { signalLocalPersist = resolve })
  fixture.store.persist = async () => {
    persistCalls += 1
    if (persistCalls === 1) {
      signalSignaturePersist()
      await signaturePersistGate
    } else if (persistCalls === 2) {
      signalLocalPersist()
    }
    return originalPersist()
  }

  const receiving = fixture.coordinator.receive({
    serviceUrl: 'https://ezd-proxy.kg.straz.gov.pl/EzdProxy.svc',
    authToken: 'synthetic-auth-token',
  })

  try {
    await signaturePersistReached
    const importingLocal = fixture.store.importDocument(localSource)
    await localPersistReached
    await importingLocal

    const beforeRelease = fixture.store.snapshot().sessions
    const signatureSession = beforeRelease.find(({ remote }) => remote?.operation === 'signature')
    const localSession = beforeRelease.find(({ remote }) => remote?.operation !== 'signature')
    assert.ok(signatureSession)
    assert.ok(localSession)
    assert.notEqual(signatureSession.id, localSession.id)
    assert.equal(beforeRelease[0].id, localSession.id)

    releaseSignaturePersist()
    const requested = await receiving
    assert.equal(requested.status, 'awaiting-pin')
    assert.equal(requested.sessionId, signatureSession.id)
    assert.equal(fixture.store.getSession(signatureSession.id).remote.status, 'awaiting-pin')
    assert.equal(fixture.store.getSession(localSession.id).remote, undefined)

    const completed = await fixture.coordinator.approve(requested.requestId, 'synthetic-pin')
    assert.equal(completed.status, 'completed')
    assert.equal(completed.sessionId, signatureSession.id)
    assert.equal(fixture.calls.signPades, 1)
    assert.equal(fixture.calls.uploadSignature, 1)
    assert.equal(fixture.store.getSession(signatureSession.id).remote.status, 'completed')
    assert.equal(fixture.store.getSession(localSession.id).versions.length, 1)
  } finally {
    releaseSignaturePersist()
    await Promise.allSettled([receiving])
  }
})

test('synchronously consumes approval so parallel and sequential second approvals cannot sign twice', async (t) => {
  let releaseSign
  const gate = new Promise((resolve) => { releaseSign = resolve })
  const fixture = await makeFixture(t)
  const originalSign = fixture.defaultHelper.signPades
  fixture.defaultHelper.signPades = async (...args) => {
    await gate
    return originalSign(...args)
  }
  const requested = await fixture.coordinator.receive({
    serviceUrl: 'https://ezd-proxy.kg.straz.gov.pl/EzdProxy.svc',
    authToken: 'synthetic-auth-token',
  })
  const first = fixture.coordinator.approve(requested.requestId, 'synthetic-pin')
  const parallelSecond = fixture.coordinator.approve(requested.requestId, 'second-pin')
  await assert.rejects(parallelSecond, (error) => error.code === 'APPROVAL_ALREADY_USED')
  releaseSign()
  await first
  await assert.rejects(
    fixture.coordinator.approve(requested.requestId, 'third-pin'),
    (error) => error.code === 'REQUEST_NOT_FOUND',
  )
  assert.equal(fixture.calls.signPades, 1)
  assert.equal(fixture.calls.uploadSignature, 1)
  assert.deepEqual(fixture.calls.pins, ['synthetic-pin'])
})

test('rejects a second receive as BUSY before starting SOAP or helper work', async (t) => {
  const fixture = await makeFixture(t)
  const first = await fixture.coordinator.receive({
    serviceUrl: 'https://ezd-proxy.kg.straz.gov.pl/EzdProxy.svc',
    authToken: 'synthetic-auth-token',
  })
  await assert.rejects(
    fixture.coordinator.receive({
      serviceUrl: 'https://ezd-proxy.kg.straz.gov.pl/EzdProxy.svc',
      authToken: 'synthetic-auth-token',
    }),
    (error) => error.code === 'BUSY',
  )
  assert.equal(fixture.calls.checkData, 1)
  await fixture.coordinator.cancel(first.requestId)
})

test('cancels awaiting-pin with zero helper signing and zero upload', async (t) => {
  const fixture = await makeFixture(t)
  const requested = await fixture.coordinator.receive({
    serviceUrl: 'https://ezd-proxy.kg.straz.gov.pl/EzdProxy.svc',
    authToken: 'synthetic-auth-token',
  })
  const record = fixture.coordinator.requests.get(requested.requestId)
  const cancelled = await fixture.coordinator.cancel(requested.requestId)
  assert.equal(cancelled.status, 'cancelled')
  assert.equal(fixture.calls.signPades, 0)
  assert.equal(fixture.calls.uploadSignature, 0)
  assert.equal(fixture.store.getSession(requested.sessionId).remote.status, 'cancelled')
  await assert.rejects(
    fixture.coordinator.approve(requested.requestId, 'synthetic-pin'),
    (error) => error.code === 'REQUEST_NOT_FOUND',
  )
  await assertTerminalReleased(fixture.coordinator, requested.requestId, record)
})

for (const phase of ['signing', 'verifying']) {
  test(`cancels during ${phase}, aborts helper cleanup, and never uploads`, async (t) => {
    let phaseReached
    const reached = new Promise((resolve) => { phaseReached = resolve })
    const fixture = await makeFixture(t)
    fixture.defaultHelper.signPades = async (_request, _pin, { signal, onPhase }) => {
      if (phase === 'verifying') await onPhase('verifying')
      phaseReached()
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(helperFailure('CANCELLED')), { once: true })
      })
    }
    const requested = await fixture.coordinator.receive({
      serviceUrl: 'https://ezd-proxy.kg.straz.gov.pl/EzdProxy.svc',
      authToken: 'synthetic-auth-token',
    })
    const operation = fixture.coordinator.approve(requested.requestId, 'synthetic-pin')
    await reached
    const cancelled = await fixture.coordinator.cancel(requested.requestId)
    await assert.rejects(operation, (error) => error.code === 'CANCELLED')
    assert.equal(cancelled.status, 'cancelled')
    assert.equal(fixture.calls.uploadSignature, 0)
    assert.equal(fixture.store.getSession(requested.sessionId).remote.status, 'cancelled')
  })
}

test('cancels after signed-local persistence but before uploading persistence', async (t) => {
  const fixture = await makeFixture(t)
  let signedLocalReached
  let releaseSave
  const reached = new Promise((resolve) => { signedLocalReached = resolve })
  const saveGate = new Promise((resolve) => { releaseSave = resolve })
  const originalSave = fixture.store.saveSignedSignatureVersion.bind(fixture.store)
  fixture.store.saveSignedSignatureVersion = async (...args) => {
    const state = await originalSave(...args)
    signedLocalReached()
    await saveGate
    return state
  }
  const requested = await fixture.coordinator.receive({
    serviceUrl: 'https://ezd-proxy.kg.straz.gov.pl/EzdProxy.svc',
    authToken: 'synthetic-auth-token',
  })
  const operation = fixture.coordinator.approve(requested.requestId, 'synthetic-pin')
  await reached
  assert.equal(fixture.store.getSession(requested.sessionId).remote.status, 'signed-local')
  const cancelling = fixture.coordinator.cancel(requested.requestId)
  releaseSave()
  assert.equal((await cancelling).status, 'cancelled')
  await assert.rejects(operation, (error) => error.code === 'CANCELLED')
  assert.equal(fixture.calls.uploadSignature, 0)
  assert.equal(fixture.store.getSession(requested.sessionId).remote.status, 'cancelled')
})

test('rejects cancellation after uploading begins and waits for the unchanged upload result', async (t) => {
  let releaseUpload
  let uploadStarted
  const started = new Promise((resolve) => { uploadStarted = resolve })
  const uploadGate = new Promise((resolve) => { releaseUpload = resolve })
  const fixture = await makeFixture(t, {
    upload: async () => {
      uploadStarted()
      await uploadGate
      return { documentId: 77, message: 'accepted' }
    },
  })
  const requested = await fixture.coordinator.receive({
    serviceUrl: 'https://ezd-proxy.kg.straz.gov.pl/EzdProxy.svc',
    authToken: 'synthetic-auth-token',
  })
  const operation = fixture.coordinator.approve(requested.requestId, 'synthetic-pin')
  await started
  await assert.rejects(
    fixture.coordinator.cancel(requested.requestId),
    (error) => error.code === 'CANCEL_NOT_ALLOWED',
  )
  releaseUpload()
  assert.equal((await operation).status, 'completed')
  assert.equal(fixture.calls.uploadSignature, 1)
})

for (const code of [
  'PKCS11_MISSING', 'TOKEN_NOT_READY', 'PIN_INVALID', 'CERTIFICATE_NOT_FOUND',
  'TSA_INVALID', 'OUTPUT_IDENTITY_MISMATCH', 'TIMEOUT',
]) {
  test(`maps ${code} to a safe failed state with zero upload`, async (t) => {
    const fixture = await makeFixture(t)
    if (['PKCS11_MISSING', 'TOKEN_NOT_READY'].includes(code)) {
      fixture.defaultHelper.status = async () => { throw helperFailure(code, 'synthetic-pin') }
      await assert.rejects(
        fixture.coordinator.receive({
          serviceUrl: 'https://ezd-proxy.kg.straz.gov.pl/EzdProxy.svc',
          authToken: 'synthetic-auth-token',
        }),
        (error) => error.code === code,
      )
    } else {
      fixture.defaultHelper.signPades = async () => { throw helperFailure(code, 'synthetic-pin') }
      const requested = await fixture.coordinator.receive({
        serviceUrl: 'https://ezd-proxy.kg.straz.gov.pl/EzdProxy.svc',
        authToken: 'synthetic-auth-token',
      })
      await assert.rejects(
        fixture.coordinator.approve(requested.requestId, 'synthetic-pin'),
        (error) => error.code === code,
      )
      assert.equal(fixture.store.getSession(requested.sessionId).remote.status, 'failed')
    }
    assert.equal(fixture.calls.uploadSignature, 0)
    assert.doesNotMatch(JSON.stringify(fixture.events), /raw helper error|synthetic-pin/)
    assert.doesNotMatch(JSON.stringify(fixture.diagnostics), /raw helper error|synthetic-pin/)
  })
}

test('does not upload when persisting uploading fails', async (t) => {
  const fixture = await makeFixture(t)
  const original = fixture.store.markSignatureState.bind(fixture.store)
  fixture.store.markSignatureState = async (sessionId, state, details) => {
    if (state === 'uploading') throw new Error('store write failed secret')
    return original(sessionId, state, details)
  }
  const requested = await fixture.coordinator.receive({
    serviceUrl: 'https://ezd-proxy.kg.straz.gov.pl/EzdProxy.svc',
    authToken: 'synthetic-auth-token',
  })
  await assert.rejects(
    fixture.coordinator.approve(requested.requestId, 'synthetic-pin'),
    (error) => error.code === 'STORE_FAILED',
  )
  assert.equal(fixture.calls.uploadSignature, 0)
})

test('keeps a confirmed upload ACK completed when the local completed audit write fails', async (t) => {
  const fixture = await makeFixture(t)
  const original = fixture.store.markSignatureState.bind(fixture.store)
  fixture.store.markSignatureState = async (sessionId, state, details) => {
    if (state === 'completed') throw new Error('local audit failed synthetic-pin synthetic-auth-token')
    return original(sessionId, state, details)
  }
  const requested = await fixture.coordinator.receive({
    serviceUrl: 'https://ezd-proxy.kg.straz.gov.pl/EzdProxy.svc',
    authToken: 'synthetic-auth-token',
  })

  const result = await fixture.coordinator.approve(requested.requestId, 'synthetic-pin')

  assert.equal(result.status, 'completed')
  assert.equal(result.code, 'OK')
  assert.equal(fixture.calls.uploadSignature, 1)
  assert.equal(fixture.store.getSession(requested.sessionId).remote.status, 'uploading')
  assert.equal(finishedEvent(fixture.events).payload.status, 'completed')
  assert.equal(fixture.events.some(({ payload }) => payload.status === 'failed'), false)
  assert.deepEqual(fixture.diagnostics.at(-1), {
    operation: 'signature',
    kind: 'local-audit',
    code: 'LOCAL_AUDIT_FAILED',
    phase: 'completed',
  })
  const serialized = JSON.stringify({ events: fixture.events, diagnostics: fixture.diagnostics })
  assert.equal(serialized.includes('synthetic-pin'), false)
  assert.equal(serialized.includes('synthetic-auth-token'), false)
})

test('maps EZD status 1 to upload-rejected after exactly one upload and preserves signed-local', async (t) => {
  const fixture = await makeFixture(t, {
    upload: async () => { throw clientFailure('ezd', { ezdStatus: 1, secret: 'synthetic-pin' }) },
  })
  const requested = await fixture.coordinator.receive({
    serviceUrl: 'https://ezd-proxy.kg.straz.gov.pl/EzdProxy.svc',
    authToken: 'synthetic-auth-token',
  })
  const record = fixture.coordinator.requests.get(requested.requestId)
  const result = await fixture.coordinator.approve(requested.requestId, 'synthetic-pin')
  assert.equal(result.status, 'upload-rejected')
  assert.equal(fixture.calls.uploadSignature, 1)
  assert.equal(fixture.calls.finishSession, 0)
  const session = fixture.store.getSession(requested.sessionId)
  assert.equal(session.remote.status, 'upload-rejected')
  assert.equal(session.remote.ezdStatus, 1)
  assert.equal(session.versions.length, 2)
  assert.doesNotMatch(JSON.stringify(fixture.events), /synthetic-pin|raw SOAP/)
  await assertTerminalReleased(fixture.coordinator, requested.requestId, record)
})

for (const [kind, details] of [
  ['transport', {}],
  ['timeout', {}],
  ['http', { httpStatus: 503 }],
  ['soap', { httpStatus: 200 }],
]) {
  test(`maps ${kind} ambiguity to upload-unknown with no retry`, async (t) => {
    const fixture = await makeFixture(t, {
      upload: async () => { throw clientFailure(kind, { ...details, secret: 'synthetic-auth-token' }) },
    })
    const requested = await fixture.coordinator.receive({
      serviceUrl: 'https://ezd-proxy.kg.straz.gov.pl/EzdProxy.svc',
      authToken: 'synthetic-auth-token',
    })
    const record = fixture.coordinator.requests.get(requested.requestId)
    const result = await fixture.coordinator.approve(requested.requestId, 'synthetic-pin')
    assert.equal(result.status, 'upload-unknown')
    assert.equal(fixture.calls.uploadSignature, 1)
    assert.equal(fixture.calls.finishSession, 0)
    assert.equal(fixture.store.getSession(requested.sessionId).remote.status, 'upload-unknown')
    assert.doesNotMatch(JSON.stringify(fixture.events), /synthetic-auth-token|raw SOAP/)
    await assertTerminalReleased(fixture.coordinator, requested.requestId, record)
  })
}

test('releases receive and helper failures without retaining their request records', async (t) => {
  const receiveFailure = await makeFixture(t)
  let receiveRecord
  receiveFailure.client.checkData = async () => {
    receiveRecord = receiveFailure.coordinator.requests.values().next().value
    throw clientFailure('transport', { secret: 'synthetic-auth-token' })
  }
  await assert.rejects(
    receiveFailure.coordinator.receive({
      serviceUrl: 'https://ezd-proxy.kg.straz.gov.pl/EzdProxy.svc',
      authToken: 'synthetic-auth-token',
    }),
    (error) => error.code === 'DOWNLOAD_FAILED',
  )
  const receiveRequestId = finishedEvent(receiveFailure.events).payload.requestId
  await assertTerminalReleased(receiveFailure.coordinator, receiveRequestId, receiveRecord)

  const helperFailureFixture = await makeFixture(t)
  helperFailureFixture.defaultHelper.signPades = async () => {
    throw helperFailure('PIN_INVALID', 'synthetic-pin')
  }
  const requested = await helperFailureFixture.coordinator.receive({
    serviceUrl: 'https://ezd-proxy.kg.straz.gov.pl/EzdProxy.svc',
    authToken: 'synthetic-auth-token',
  })
  const helperRecord = helperFailureFixture.coordinator.requests.get(requested.requestId)
  await assert.rejects(
    helperFailureFixture.coordinator.approve(requested.requestId, 'synthetic-pin'),
    (error) => error.code === 'PIN_INVALID',
  )
  await assertTerminalReleased(helperFailureFixture.coordinator, requested.requestId, helperRecord)
  assert.equal(helperFailureFixture.calls.uploadSignature, 0)
})

test('never persists or emits PIN, auth token, PDF, SR, helper output, or raw errors', async (t) => {
  const secret = 'synthetic-super-secret'
  const fixture = await makeFixture(t, {
    upload: async () => { throw clientFailure('transport', { secret }) },
    signaturePatch: { signatureRoleXml: `<SR>${secret}</SR>` },
  })
  const requested = await fixture.coordinator.receive({
    serviceUrl: 'https://ezd-proxy.kg.straz.gov.pl/EzdProxy.svc',
    authToken: 'synthetic-auth-token',
  })
  await fixture.coordinator.approve(requested.requestId, secret)
  const persisted = await fsp.readFile(fixture.store.statePath, 'utf8')
  for (const material of [secret, 'synthetic-auth-token', '<SR>', signedPdf.toString('utf8')]) {
    assert.equal(persisted.includes(material), false)
    assert.equal(JSON.stringify(fixture.events).includes(material), false)
    assert.equal(JSON.stringify(fixture.diagnostics).includes(material), false)
  }
})

test('releaseAll cancels pre-upload work and waits for an in-flight upload without aborting it', async (t) => {
  const awaiting = await makeFixture(t)
  const request = await awaiting.coordinator.receive({
    serviceUrl: 'https://ezd-proxy.kg.straz.gov.pl/EzdProxy.svc',
    authToken: 'synthetic-auth-token',
  })
  await awaiting.coordinator.releaseAll()
  assert.equal(awaiting.store.getSession(request.sessionId).remote.status, 'cancelled')
  assert.equal(awaiting.calls.uploadSignature, 0)

  let releaseUpload
  let uploadStarted
  const started = new Promise((resolve) => { uploadStarted = resolve })
  const gate = new Promise((resolve) => { releaseUpload = resolve })
  const uploading = await makeFixture(t, {
    upload: async () => {
      uploadStarted()
      await gate
      return { documentId: 77, message: 'accepted' }
    },
  })
  const uploadingRequest = await uploading.coordinator.receive({
    serviceUrl: 'https://ezd-proxy.kg.straz.gov.pl/EzdProxy.svc',
    authToken: 'synthetic-auth-token',
  })
  const operation = uploading.coordinator.approve(uploadingRequest.requestId, 'synthetic-pin')
  await started
  let released = false
  const draining = uploading.coordinator.releaseAll().then(() => { released = true })
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(released, false)
  releaseUpload()
  await draining
  assert.equal((await operation).status, 'completed')
})

test('releaseAll aborts an in-flight read-only SOAP receive before helper or upload', async (t) => {
  const fixture = await makeFixture(t)
  let checkStarted
  const started = new Promise((resolve) => { checkStarted = resolve })
  fixture.client.checkData = async ({ signal } = {}) => {
    fixture.calls.checkData += 1
    checkStarted()
    if (!signal) throw new Error('coordinator did not pass the abort signal')
    return new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(helperFailure('CANCELLED')), { once: true })
    })
  }
  const operation = fixture.coordinator.receive({
    serviceUrl: 'https://ezd-proxy.kg.straz.gov.pl/EzdProxy.svc',
    authToken: 'synthetic-auth-token',
  })
  await started

  const draining = fixture.coordinator.releaseAll()

  await assert.rejects(operation, (error) => error.code === 'CANCELLED')
  await draining
  assert.equal(fixture.calls.downloadSignatureData, 0)
  assert.equal(fixture.calls.status, 0)
  assert.equal(fixture.calls.signPades, 0)
  assert.equal(fixture.calls.uploadSignature, 0)
})

test('releases global BUSY after completed, cancelled, failed, and receive/status failure', async (t) => {
  const completed = await makeFixture(t)
  const firstCompleted = await completed.coordinator.receive({
    serviceUrl: 'https://ezd-proxy.kg.straz.gov.pl/EzdProxy.svc',
    authToken: 'synthetic-auth-token',
  })
  await completed.coordinator.approve(firstCompleted.requestId, 'synthetic-pin')
  const afterCompleted = await completed.coordinator.receive({
    serviceUrl: 'https://ezd-proxy.kg.straz.gov.pl/EzdProxy.svc',
    authToken: 'synthetic-auth-token',
  })
  await completed.coordinator.cancel(afterCompleted.requestId)

  const cancelled = await makeFixture(t)
  const firstCancelled = await cancelled.coordinator.receive({
    serviceUrl: 'https://ezd-proxy.kg.straz.gov.pl/EzdProxy.svc',
    authToken: 'synthetic-auth-token',
  })
  await cancelled.coordinator.cancel(firstCancelled.requestId)
  const afterCancelled = await cancelled.coordinator.receive({
    serviceUrl: 'https://ezd-proxy.kg.straz.gov.pl/EzdProxy.svc',
    authToken: 'synthetic-auth-token',
  })
  await cancelled.coordinator.cancel(afterCancelled.requestId)

  const failed = await makeFixture(t)
  let failSignOnce = true
  const normalSign = failed.defaultHelper.signPades
  failed.defaultHelper.signPades = async (...args) => {
    if (failSignOnce) {
      failSignOnce = false
      throw helperFailure('PIN_INVALID')
    }
    return normalSign(...args)
  }
  const firstFailed = await failed.coordinator.receive({
    serviceUrl: 'https://ezd-proxy.kg.straz.gov.pl/EzdProxy.svc',
    authToken: 'synthetic-auth-token',
  })
  await assert.rejects(
    failed.coordinator.approve(firstFailed.requestId, 'synthetic-pin'),
    (error) => error.code === 'PIN_INVALID',
  )
  const afterFailed = await failed.coordinator.receive({
    serviceUrl: 'https://ezd-proxy.kg.straz.gov.pl/EzdProxy.svc',
    authToken: 'synthetic-auth-token',
  })
  await failed.coordinator.cancel(afterFailed.requestId)

  const statusFailure = await makeFixture(t)
  let failStatusOnce = true
  statusFailure.defaultHelper.status = async () => {
    if (failStatusOnce) {
      failStatusOnce = false
      throw helperFailure('TOKEN_NOT_READY')
    }
    return { ok: true, pkcs11Exists: true, tokenReady: true }
  }
  await assert.rejects(
    statusFailure.coordinator.receive({
      serviceUrl: 'https://ezd-proxy.kg.straz.gov.pl/EzdProxy.svc',
      authToken: 'synthetic-auth-token',
    }),
    (error) => error.code === 'TOKEN_NOT_READY',
  )
  const afterStatusFailure = await statusFailure.coordinator.receive({
    serviceUrl: 'https://ezd-proxy.kg.straz.gov.pl/EzdProxy.svc',
    authToken: 'synthetic-auth-token',
  })
  await statusFailure.coordinator.cancel(afterStatusFailure.requestId)
})
