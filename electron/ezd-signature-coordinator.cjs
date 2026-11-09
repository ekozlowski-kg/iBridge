const crypto = require('node:crypto')
const { EzdSoapClient } = require('./ezd-soap-client.cjs')
const { EZD_SESSION_MODES } = require('./protocol.cjs')

const SAFE_HELPER_CODES = new Set([
  'PKCS11_MISSING',
  'TOKEN_NOT_READY',
  'PIN_INVALID',
  'CERTIFICATE_NOT_FOUND',
  'CERTIFICATE_AMBIGUOUS',
  'PRIVATE_KEY_MISSING',
  'PATH_REJECTED',
  'PDF_INVALID',
  'PDF_ENCRYPTED',
  'EXISTING_SIGNATURE_INVALID',
  'DOCUMENT_PERMISSIONS_DENIED',
  'TSA_UNAVAILABLE',
  'TSA_INVALID',
  'CMS_TOO_LARGE',
  'SIGNATURE_INVALID',
  'TIMEOUT',
  'CANCELLED',
  'OUTPUT_IDENTITY_MISMATCH',
  'OUTPUT_HASH_MISMATCH',
  'OUTPUT_TRAILING_DATA',
  'OUTPUT_READ_FAILED',
  'OUTPUT_INVALID',
  'HELPER_UNAVAILABLE',
  'HELPER_PROTOCOL',
  'HELPER_OUTPUT_LIMIT',
])
const TERMINAL_REQUEST_STATES = new Set([
  'completed',
  'upload-rejected',
  'upload-unknown',
  'cancelled',
  'failed',
])

const SAFE_MESSAGES = Object.freeze({
  BUSY: 'Inna operacja podpisu jest już aktywna.',
  REQUEST_NOT_FOUND: 'Nie znaleziono żądania podpisu.',
  APPROVAL_ALREADY_USED: 'To żądanie podpisu zostało już rozstrzygnięte.',
  CANCEL_NOT_ALLOWED: 'Nie można anulować podpisu po rozpoczęciu wysyłania.',
  CANCELLED: 'Operacja podpisu została anulowana.',
  STORE_FAILED: 'Nie można bezpiecznie zapisać stanu podpisu.',
  DOWNLOAD_FAILED: 'Nie można pobrać dokumentu do podpisu.',
  SIGNATURE_FAILED: 'Nie udało się złożyć podpisu.',
  UPLOAD_REJECTED: 'EZD odrzuciło podpisany dokument.',
  UPLOAD_UNKNOWN: 'Nie można potwierdzić, czy EZD odebrało podpisany dokument.',
  INVALID_REQUEST: 'Nieprawidłowe żądanie podpisu.',
  UNSUPPORTED_MODE: 'Ten tryb podpisu EZD nie jest obsługiwany.',
})

class EzdSignatureError extends Error {
  constructor(code, message = SAFE_MESSAGES[code] || 'Operacja podpisu nie powiodła się.') {
    super(message)
    this.name = 'EzdSignatureError'
    this.code = code
  }
}

function coordinatorError(code) {
  return new EzdSignatureError(code)
}

function safeHelperCode(error, fallback) {
  return SAFE_HELPER_CODES.has(error?.code) ? error.code : fallback
}

function positiveDocumentId(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : 0
}

function validRequestId(value) {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

async function routeEzdSessionMode({
  mode,
  connection,
  editReceive,
  signatureReceive,
  showSignatureWindow,
} = {}) {
  if (typeof editReceive !== 'function'
      || typeof signatureReceive !== 'function'
      || typeof showSignatureWindow !== 'function') {
    throw coordinatorError('INVALID_REQUEST')
  }
  const selectedMode = mode === undefined || mode === null ? EZD_SESSION_MODES.EDIT : mode
  if (selectedMode === EZD_SESSION_MODES.EDIT) return editReceive(connection)
  if (selectedMode === EZD_SESSION_MODES.SIGN) {
    await showSignatureWindow()
    return signatureReceive(connection)
  }
  throw coordinatorError('UNSUPPORTED_MODE')
}

function registerSignatureIpc({ ipcMain, coordinator, assertTrustedSender } = {}) {
  if (typeof ipcMain?.handle !== 'function'
      || typeof coordinator?.approve !== 'function'
      || typeof coordinator?.cancel !== 'function'
      || typeof assertTrustedSender !== 'function') {
    throw coordinatorError('INVALID_REQUEST')
  }
  ipcMain.handle('signature:approve', (event, ...args) => {
    assertTrustedSender(event)
    if (args.length !== 2) throw coordinatorError('INVALID_REQUEST')
    const [requestId, pin] = args
    if (!validRequestId(requestId)
        || typeof pin !== 'string'
        || Buffer.byteLength(pin, 'utf8') < 1
        || Buffer.byteLength(pin, 'utf8') > 1024) {
      throw coordinatorError('INVALID_REQUEST')
    }
    return coordinator.approve(requestId, pin)
  })
  ipcMain.handle('signature:cancel', (event, ...args) => {
    assertTrustedSender(event)
    if (args.length !== 1 || !validRequestId(args[0])) throw coordinatorError('INVALID_REQUEST')
    return coordinator.cancel(args[0])
  })
}

class EzdSignatureCoordinator {
  constructor({
    store,
    helper,
    clientFactory = (options) => new EzdSoapClient(options),
    onEvent = () => {},
    onDiagnostic = () => {},
    randomUUID = () => crypto.randomUUID(),
  } = {}) {
    if (!store || !helper
        || typeof clientFactory !== 'function'
        || typeof onEvent !== 'function'
        || typeof onDiagnostic !== 'function'
        || typeof randomUUID !== 'function') {
      throw coordinatorError('SIGNATURE_FAILED')
    }
    this.store = store
    this.helper = helper
    this.clientFactory = clientFactory
    this.onEvent = onEvent
    this.onDiagnostic = onDiagnostic
    this.randomUUID = randomUUID
    this.requests = new Map()
    this.activeRequestId = null
  }

  emit(channel, payload) {
    try { this.onEvent(channel, Object.freeze({ ...payload })) } catch {}
  }

  diagnostic(event) {
    const safe = {
      operation: 'signature',
      kind: event.kind,
      code: event.code,
      phase: event.phase,
    }
    if (Number.isFinite(event.durationMs)) safe.durationMs = event.durationMs
    if (Number.isSafeInteger(event.size) && event.size >= 0) safe.size = event.size
    if (Number.isSafeInteger(event.httpStatus) && event.httpStatus >= 0) safe.httpStatus = event.httpStatus
    if (Number.isSafeInteger(event.ezdStatus) && event.ezdStatus >= 0) safe.ezdStatus = event.ezdStatus
    try { Promise.resolve(this.onDiagnostic(safe)).catch(() => {}) } catch {}
  }

  receive({ serviceUrl, authToken } = {}) {
    if (this.activeRequestId !== null) return Promise.reject(coordinatorError('BUSY'))
    const requestId = this.randomUUID()
    const record = {
      requestId,
      sessionId: null,
      state: 'downloading',
      client: null,
      policy: null,
      abortController: new AbortController(),
      operationPromise: null,
      approvalConsumed: false,
      uploadAttempted: false,
      signedBytes: null,
      verifiedResult: null,
    }
    this.requests.set(requestId, record)
    this.activeRequestId = requestId
    const operation = this.runReceive(record, { serviceUrl, authToken })
    record.operationPromise = operation
    return operation
  }

  async runReceive(record, { serviceUrl, authToken }) {
    let downloadedBytes = null
    try {
      record.client = this.clientFactory({ serviceUrl, authToken })
      const caseMetadata = await record.client.checkData({ signal: record.abortController.signal })
      this.throwIfCancelled(record)
      const downloaded = await record.client.downloadSignatureData({ signal: record.abortController.signal })
      this.throwIfCancelled(record)
      downloadedBytes = downloaded.data
      const imported = await this.store.importSignatureDocument({
        fileName: downloaded.fileName || caseMetadata.documentName || 'dokument-do-podpisu.pdf',
        data: downloadedBytes,
        metadata: {
          serviceUrl,
          documentId: caseMetadata.documentId,
          pismoId: caseMetadata.pismoId,
          pismoName: caseMetadata.pismoName,
          caseMark: caseMetadata.caseMark,
          shared: caseMetadata.shared,
          certificateSerial: downloaded.certificateSerial,
          signingTime: downloaded.signingTime,
          signatureMode: downloaded.mode,
          includeTimestamp: downloaded.includeTimestamp,
        },
      })
      record.sessionId = imported.sessionId
      if (typeof record.client.setDiagnosticContext === 'function') {
        record.client.setDiagnosticContext({ sessionId: record.sessionId })
      }
      record.policy = {
        certificateSerial: downloaded.certificateSerial,
        signingTime: downloaded.signingTime,
        includeTimestamp: downloaded.includeTimestamp,
        visible: downloaded.mode === 9,
        mode: downloaded.mode,
        signatureRoleXml: downloaded.signatureRoleXml,
      }
      downloadedBytes = null
      if (Buffer.isBuffer(downloaded.data)) downloaded.data.fill(0)
      this.throwIfCancelled(record)

      await this.helper.status({ signal: record.abortController.signal })
      this.throwIfCancelled(record)
      record.state = 'awaiting-pin'
      await this.markState(record, 'awaiting-pin', { phase: 'awaiting-pin' })
      this.throwIfCancelled(record)

      const session = this.store.getSession(record.sessionId)
      const requested = {
        requestId: record.requestId,
        sessionId: record.sessionId,
        fileName: session.name,
        caseMark: session.remote.caseMark,
        pismoName: session.remote.pismoName,
        expectedCertificateSerial: record.policy.certificateSerial,
        mode: record.policy.mode,
        includeTimestamp: record.policy.includeTimestamp,
      }
      this.emit('signature-requested', requested)
      this.emit('signature-progress', {
        requestId: record.requestId,
        sessionId: record.sessionId,
        status: 'awaiting-pin',
      })
      record.operationPromise = null
      return { ...requested, status: 'awaiting-pin' }
    } catch (error) {
      if (record.state === 'cancelling' || error?.code === 'CANCELLED') {
        await this.finalizeCancelled(record)
        throw coordinatorError('CANCELLED')
      }
      const code = error instanceof EzdSignatureError
        ? error.code
        : safeHelperCode(error, record.sessionId ? 'DOWNLOAD_FAILED' : 'DOWNLOAD_FAILED')
      await this.finalizeFailed(record, code, 'downloading')
      throw coordinatorError(code)
    } finally {
      if (Buffer.isBuffer(downloadedBytes)) downloadedBytes.fill(0)
    }
  }

  approve(requestId, pin) {
    const record = this.requests.get(requestId)
    if (!record) return Promise.reject(coordinatorError('REQUEST_NOT_FOUND'))
    if (record.approvalConsumed || record.state !== 'awaiting-pin') {
      return Promise.reject(coordinatorError('APPROVAL_ALREADY_USED'))
    }
    record.approvalConsumed = true
    record.state = 'signing'
    const operation = this.runApproval(record, pin)
    record.operationPromise = operation
    pin = null
    return operation
  }

  async runApproval(record, pin) {
    try {
      await this.markState(record, 'signing', { phase: 'signing' })
      this.throwIfCancelled(record)
      this.emit('signature-progress', {
        requestId: record.requestId,
        sessionId: record.sessionId,
        status: 'signing',
      })
      const paths = this.store.getSignaturePaths(record.sessionId)
      const outcome = await this.helper.signPades({
        inputPath: paths.inputPath,
        outputPath: paths.outputPath,
        certificateSerial: record.policy.certificateSerial,
        signingTime: record.policy.signingTime,
        includeTimestamp: record.policy.includeTimestamp,
        visible: record.policy.visible,
        signatureRoleXml: record.policy.signatureRoleXml,
      }, pin, {
        signal: record.abortController.signal,
        onPhase: async (phase) => {
          if (phase !== 'verifying') throw coordinatorError('SIGNATURE_FAILED')
          this.throwIfCancelled(record)
          record.state = 'verifying'
          await this.markState(record, 'verifying', { phase: 'verifying' })
          this.throwIfCancelled(record)
          this.emit('signature-progress', {
            requestId: record.requestId,
            sessionId: record.sessionId,
            status: 'verifying',
          })
        },
      })
      pin = null
      this.throwIfCancelled(record)
      if (!Buffer.isBuffer(outcome?.signedBytes) || !outcome?.result) {
        throw coordinatorError('SIGNATURE_FAILED')
      }
      record.signedBytes = outcome.signedBytes
      record.verifiedResult = {
        outputSha256: outcome.result.outputSha256,
        outputBytes: outcome.result.outputBytes,
        subject: outcome.result.subject,
        profile: outcome.result.profile,
        warnings: Array.isArray(outcome.result.warnings) ? [...outcome.result.warnings] : [],
      }
      await this.saveSignedVersion(record)
      this.throwIfCancelled(record)
      record.state = 'signed-local'
      this.emit('signature-progress', {
        requestId: record.requestId,
        sessionId: record.sessionId,
        status: 'signed-local',
      })
      this.throwIfCancelled(record)

      // This synchronous state claim is the cancellation boundary.  Persistence
      // must succeed before uploadAttempted is set or any network call begins.
      record.state = 'uploading'
      await this.markState(record, 'uploading', {
        phase: 'uploading',
        size: record.signedBytes.length,
      })
      this.emit('signature-progress', {
        requestId: record.requestId,
        sessionId: record.sessionId,
        status: 'uploading',
      })
      record.uploadAttempted = true

      let uploaded
      try {
        uploaded = await record.client.uploadSignature(record.signedBytes)
      } catch (error) {
        return await this.finishUploadFailure(record, error)
      }
      const documentId = positiveDocumentId(uploaded?.documentId)
      record.state = 'completed'
      try {
        await this.markState(record, 'completed', {
          phase: 'completed',
          size: record.signedBytes.length,
        })
      } catch {
        // The server ACK is authoritative. A local audit failure after that
        // point must not relabel success or invite a duplicate upload.
        // Persisted `uploading` is reconciled conservatively after restart.
        this.diagnostic({
          kind: 'local-audit',
          code: 'LOCAL_AUDIT_FAILED',
          phase: 'completed',
        })
      }
      const result = {
        requestId: record.requestId,
        sessionId: record.sessionId,
        status: 'completed',
        code: 'OK',
        documentId,
        subject: record.verifiedResult.subject,
        profile: record.verifiedResult.profile,
      }
      this.emit('signature-finished', result)
      return result
    } catch (error) {
      if (record.state === 'cancelling' || error?.code === 'CANCELLED') {
        await this.finalizeCancelled(record)
        throw coordinatorError('CANCELLED')
      }
      const code = error instanceof EzdSignatureError
        ? error.code
        : safeHelperCode(error, 'SIGNATURE_FAILED')
      await this.finalizeFailed(record, code, record.state)
      throw coordinatorError(code)
    } finally {
      pin = null
      this.releaseTerminal(record)
    }
  }

  async saveSignedVersion(record) {
    try {
      await this.store.saveSignedSignatureVersion(record.sessionId, {
        signedBytes: record.signedBytes,
        hash: record.verifiedResult.outputSha256,
        size: record.verifiedResult.outputBytes,
        profile: record.verifiedResult.profile,
        subject: record.verifiedResult.subject,
        warnings: record.verifiedResult.warnings,
      })
    } catch {
      throw coordinatorError('STORE_FAILED')
    }
  }

  async markState(record, state, details) {
    if (!record.sessionId) return
    try {
      await this.store.markSignatureState(record.sessionId, state, details)
    } catch {
      throw coordinatorError('STORE_FAILED')
    }
  }

  async finishUploadFailure(record, error) {
    const domainRejected = error?.kind === 'ezd' && Number.isSafeInteger(error?.ezdStatus)
      && error.ezdStatus !== 0
    const status = domainRejected ? 'upload-rejected' : 'upload-unknown'
    const code = domainRejected ? 'UPLOAD_REJECTED' : 'UPLOAD_UNKNOWN'
    record.state = status
    try {
      await this.markState(record, status, {
        phase: status,
        code,
        size: record.signedBytes.length,
        ezdStatus: Number.isSafeInteger(error?.ezdStatus) ? error.ezdStatus : 0,
        httpStatus: Number.isSafeInteger(error?.httpStatus) ? error.httpStatus : 0,
      })
    } catch {
      // An upload was already attempted.  Never retry it merely because the
      // local audit write failed; restart reconciliation remains conservative.
    }
    this.diagnostic({
      kind: domainRejected ? 'ezd' : 'upload-ambiguous',
      code,
      phase: status,
      size: record.signedBytes.length,
      ezdStatus: Number.isSafeInteger(error?.ezdStatus) ? error.ezdStatus : 0,
      httpStatus: Number.isSafeInteger(error?.httpStatus) ? error.httpStatus : 0,
    })
    const result = {
      requestId: record.requestId,
      sessionId: record.sessionId,
      status,
      code,
      subject: record.verifiedResult.subject,
      profile: record.verifiedResult.profile,
    }
    this.emit('signature-finished', result)
    return result
  }

  cancel(requestId) {
    const record = this.requests.get(requestId)
    if (!record) return Promise.reject(coordinatorError('REQUEST_NOT_FOUND'))
    if (record.state === 'uploading') return Promise.reject(coordinatorError('CANCEL_NOT_ALLOWED'))
    if (!['awaiting-pin', 'signing', 'verifying', 'signed-local'].includes(record.state)) {
      return Promise.reject(coordinatorError('CANCEL_NOT_ALLOWED'))
    }
    record.approvalConsumed = true
    record.state = 'cancelling'
    record.abortController.abort()
    if (!record.operationPromise) return this.finalizeCancelled(record)
    const operation = record.operationPromise
    return (async () => {
      try { await operation } catch (error) {
        if (error?.code !== 'CANCELLED') throw error
      }
      return {
        requestId: record.requestId,
        sessionId: record.sessionId,
        status: 'cancelled',
        code: 'CANCELLED',
      }
    })()
  }

  throwIfCancelled(record) {
    if (record.state === 'cancelling' || record.abortController.signal.aborted) {
      throw coordinatorError('CANCELLED')
    }
  }

  async finalizeCancelled(record) {
    record.state = 'cancelled'
    if (record.sessionId) {
      try {
        await this.store.markSignatureState(record.sessionId, 'cancelled', {
          phase: 'cancelled',
          code: 'CANCELLED',
        })
      } catch {}
    }
    const result = {
      requestId: record.requestId,
      sessionId: record.sessionId,
      status: 'cancelled',
      code: 'CANCELLED',
    }
    this.emit('signature-finished', result)
    this.releaseTerminal(record)
    return result
  }

  async finalizeFailed(record, code, phase) {
    record.state = 'failed'
    if (record.sessionId) {
      try {
        await this.store.markSignatureState(record.sessionId, 'failed', {
          phase: 'failed',
          code,
        })
      } catch {}
    }
    this.diagnostic({ kind: 'failure', code, phase })
    this.emit('signature-finished', {
      requestId: record.requestId,
      sessionId: record.sessionId,
      status: 'failed',
      code,
    })
    this.releaseTerminal(record)
  }

  releaseTerminal(record) {
    if (!TERMINAL_REQUEST_STATES.has(record.state)) return false
    if (Buffer.isBuffer(record.signedBytes)) record.signedBytes.fill(0)
    record.signedBytes = null
    record.verifiedResult = null
    record.client = null
    record.policy = null
    record.abortController = null
    record.operationPromise = null
    this.releaseActive(record)
    if (this.requests.get(record.requestId) === record) this.requests.delete(record.requestId)
    return true
  }

  releaseActive(record) {
    if (this.activeRequestId === record.requestId) this.activeRequestId = null
  }

  async releaseAll() {
    const requestId = this.activeRequestId
    if (!requestId) return []
    const record = this.requests.get(requestId)
    if (!record) {
      this.activeRequestId = null
      return []
    }
    if (record.state === 'uploading') {
      return Promise.allSettled(record.operationPromise ? [record.operationPromise] : [])
    }
    if (['awaiting-pin', 'signing', 'verifying', 'signed-local'].includes(record.state)) {
      return Promise.allSettled([this.cancel(record.requestId)])
    }
    if (record.state === 'downloading') {
      record.state = 'cancelling'
      record.approvalConsumed = true
      record.abortController.abort()
      return Promise.allSettled(record.operationPromise ? [record.operationPromise] : [])
    }
    return []
  }
}

module.exports = {
  EzdSignatureCoordinator,
  EzdSignatureError,
  registerSignatureIpc,
  routeEzdSessionMode,
}
