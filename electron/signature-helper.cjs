const crypto = require('node:crypto')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const { delimiter } = require('node:path')
const { spawn } = require('node:child_process')
const { TextDecoder } = require('node:util')

const MAX_HEADER_BYTES = 64 * 1024
const MAX_PIN_BYTES = 1024
const MAX_STDOUT_BYTES = 8 * 1024
const MAX_STDERR_BYTES = 4 * 1024
const MAX_SIGNED_PDF_BYTES = 130 * 1024 * 1024
const DEFAULT_STATUS_TIMEOUT_MS = 10_000
const DEFAULT_SIGN_TIMEOUT_MS = 180_000
const DEFAULT_READ_CHUNK_BYTES = 64 * 1024
const UINT64_MAX = (1n << 64n) - 1n
const PRODUCTION_PKCS11_PATH = '/usr/local/lib/libSimplySignPKCS.dylib'
const MAIN_CLASS = 'pl.kckr.ibridge.signing.Main'

const SIGN_REQUEST_KEYS = new Set([
  'inputPath',
  'outputPath',
  'certificateSerial',
  'signingTime',
  'includeTimestamp',
  'visible',
  'signatureRoleXml',
])
const SIGN_SUCCESS_KEYS = new Set([
  'ok',
  'outputPath',
  'outputSha256',
  'outputBytes',
  'outputDevice',
  'outputInode',
  'certificateSerial',
  'subject',
  'profile',
  'warnings',
])
const STATUS_SUCCESS_KEYS = new Set(['ok', 'pkcs11Exists', 'pkcs11Path', 'tokenReady'])
const STATUS_FAILURE_KEYS = new Set([
  'ok', 'pkcs11Exists', 'pkcs11Path', 'tokenReady', 'code', 'message',
])
const SIGN_FAILURE_KEYS = new Set(['ok', 'code', 'message'])
const SAFE_WARNINGS = new Set(['REVOCATION_NOT_CHECKED'])
const HELPER_FAILURE_CODES = new Set([
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
  'INTERNAL_ERROR',
  'PROTOCOL_INVALID',
])

const SAFE_MESSAGES = Object.freeze({
  REQUEST_INVALID: 'Nieprawidłowe żądanie podpisu.',
  HELPER_UNAVAILABLE: 'Nie można uruchomić modułu podpisu.',
  HELPER_PROTOCOL: 'Moduł podpisu zwrócił nieprawidłową odpowiedź.',
  HELPER_OUTPUT_LIMIT: 'Moduł podpisu przekroczył bezpieczny limit odpowiedzi.',
  CANCELLED: 'Operacja podpisu została anulowana.',
  TIMEOUT: 'Operacja podpisu przekroczyła limit czasu.',
  OUTPUT_IDENTITY_MISMATCH: 'Nie można potwierdzić tożsamości podpisanego dokumentu.',
  OUTPUT_HASH_MISMATCH: 'Nie można potwierdzić integralności podpisanego dokumentu.',
  OUTPUT_TRAILING_DATA: 'Podpisany dokument zmienił rozmiar podczas weryfikacji.',
  OUTPUT_READ_FAILED: 'Nie można bezpiecznie odczytać podpisanego dokumentu.',
  OUTPUT_INVALID: 'Wynik podpisu nie jest prawidłowym dokumentem PDF.',
})

class SignatureHelperError extends Error {
  constructor(code, message = SAFE_MESSAGES[code] || 'Operacja podpisu nie powiodła się.') {
    super(message)
    this.name = 'SignatureHelperError'
    this.code = code
  }
}

function fail(code) {
  throw new SignatureHelperError(code)
}

function exactKeys(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const keys = Object.keys(value)
  return keys.length === expected.size && keys.every((key) => expected.has(key))
}

function canonicalUint64(value, { positive = false } = {}) {
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]*)$/.test(value)) fail('HELPER_PROTOCOL')
  let parsed
  try { parsed = BigInt(value) } catch { fail('HELPER_PROTOCOL') }
  if (parsed > UINT64_MAX || (positive && parsed === 0n)) fail('HELPER_PROTOCOL')
  return parsed
}

function isSafeText(value, maximum, { empty = true } = {}) {
  return typeof value === 'string'
    && value.length <= maximum
    && (empty || value.length > 0)
    && !/[\u0000-\u001f\u007f]/.test(value)
}

function validateSignSuccess(value, { expectedPath, expectedSerial, includeTimestamp }) {
  if (!exactKeys(value, SIGN_SUCCESS_KEYS) || value.ok !== true) fail('HELPER_PROTOCOL')
  if (typeof expectedPath !== 'string'
      || !path.isAbsolute(expectedPath)
      || path.normalize(expectedPath) !== expectedPath
      || value.outputPath !== expectedPath
      || !path.isAbsolute(value.outputPath)
      || path.normalize(value.outputPath) !== value.outputPath) fail('HELPER_PROTOCOL')
  if (typeof value.outputSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(value.outputSha256)) {
    fail('HELPER_PROTOCOL')
  }
  if (!Number.isSafeInteger(value.outputBytes)
      || value.outputBytes < 1
      || value.outputBytes > MAX_SIGNED_PDF_BYTES) fail('HELPER_PROTOCOL')
  canonicalUint64(value.outputDevice)
  canonicalUint64(value.outputInode, { positive: true })
  if (typeof expectedSerial !== 'string'
      || typeof value.certificateSerial !== 'string'
      || !/^(?:[0-9A-Fa-f]{2})+$/.test(value.certificateSerial)
      || value.certificateSerial.toUpperCase() !== expectedSerial.toUpperCase()) fail('HELPER_PROTOCOL')
  if (!isSafeText(value.subject, 512, { empty: false })) fail('HELPER_PROTOCOL')
  const expectedProfile = includeTimestamp ? 'PAdES-B-T' : 'PAdES-B-B'
  if (value.profile !== expectedProfile) fail('HELPER_PROTOCOL')
  if (!Array.isArray(value.warnings)
      || value.warnings.length > 8
      || new Set(value.warnings).size !== value.warnings.length
      || value.warnings.some((warning) => !SAFE_WARNINGS.has(warning))) fail('HELPER_PROTOCOL')
  return value
}

function assertNotAborted(signal) {
  if (signal?.aborted) fail('CANCELLED')
}

function identityMatches(info, { device, inode, size, uid }) {
  try {
    return typeof info?.isFile === 'function'
      && info.isFile()
      && BigInt(info.uid) === uid
      && (BigInt(info.mode) & 0o777n) === 0o600n
      && BigInt(info.dev) === device
      && BigInt(info.ino) === inode
      && BigInt(info.size) === size
  } catch {
    return false
  }
}

async function readVerifiedPublishedPdf(expectedPath, helperResult, {
  signal,
  fsImpl = fsp,
  expectedUid = typeof process.geteuid === 'function' ? process.geteuid() : null,
  chunkBytes = DEFAULT_READ_CHUNK_BYTES,
} = {}) {
  if (typeof expectedPath !== 'string'
      || !path.isAbsolute(expectedPath)
      || path.normalize(expectedPath) !== expectedPath
      || !helperResult
      || !Number.isSafeInteger(helperResult.outputBytes)
      || helperResult.outputBytes < 1
      || helperResult.outputBytes > MAX_SIGNED_PDF_BYTES
      || typeof helperResult.outputSha256 !== 'string'
      || !/^[0-9a-f]{64}$/.test(helperResult.outputSha256)
      || !Number.isSafeInteger(chunkBytes)
      || chunkBytes < 1
      || expectedUid === null
      || !Number.isSafeInteger(expectedUid)
      || expectedUid < 0) fail('OUTPUT_IDENTITY_MISMATCH')

  let expectedDevice
  let expectedInode
  try {
    expectedDevice = canonicalUint64(helperResult.outputDevice)
    expectedInode = canonicalUint64(helperResult.outputInode, { positive: true })
  } catch {
    fail('OUTPUT_IDENTITY_MISMATCH')
  }
  const expectedSize = BigInt(helperResult.outputBytes)
  const identity = {
    device: expectedDevice,
    inode: expectedInode,
    size: expectedSize,
    uid: BigInt(expectedUid),
  }
  assertNotAborted(signal)

  let handle
  try {
    handle = await fsImpl.open(expectedPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
  } catch {
    fail('OUTPUT_IDENTITY_MISMATCH')
  }

  try {
    assertNotAborted(signal)
    let before
    try { before = await handle.stat({ bigint: true }) } catch { fail('OUTPUT_IDENTITY_MISMATCH') }
    if (!identityMatches(before, identity)) fail('OUTPUT_IDENTITY_MISMATCH')

    const bytes = Buffer.allocUnsafe(helperResult.outputBytes)
    const digest = crypto.createHash('sha256')
    let offset = 0
    while (offset < bytes.length) {
      assertNotAborted(signal)
      const requested = Math.min(chunkBytes, bytes.length - offset)
      let read
      try { read = await handle.read(bytes, offset, requested, offset) } catch { fail('OUTPUT_READ_FAILED') }
      if (!read || !Number.isInteger(read.bytesRead) || read.bytesRead <= 0 || read.bytesRead > requested) {
        fail('OUTPUT_READ_FAILED')
      }
      digest.update(bytes.subarray(offset, offset + read.bytesRead))
      offset += read.bytesRead
    }

    assertNotAborted(signal)
    const probe = Buffer.allocUnsafe(1)
    let trailing
    try { trailing = await handle.read(probe, 0, 1, helperResult.outputBytes) } catch { fail('OUTPUT_READ_FAILED') }
    if (!trailing || trailing.bytesRead !== 0) fail('OUTPUT_TRAILING_DATA')

    let after
    try { after = await handle.stat({ bigint: true }) } catch { fail('OUTPUT_IDENTITY_MISMATCH') }
    if (!identityMatches(after, identity)) fail('OUTPUT_IDENTITY_MISMATCH')

    const actualDigest = digest.digest()
    const expectedDigest = Buffer.from(helperResult.outputSha256, 'hex')
    const equal = actualDigest.length === expectedDigest.length
      && crypto.timingSafeEqual(actualDigest, expectedDigest)
    actualDigest.fill(0)
    expectedDigest.fill(0)
    if (!equal) fail('OUTPUT_HASH_MISMATCH')
    if (bytes.length < 5 || !bytes.subarray(0, 5).equals(Buffer.from('%PDF-'))) fail('OUTPUT_INVALID')
    assertNotAborted(signal)
    return bytes
  } finally {
    try { await handle.close() } catch { fail('OUTPUT_READ_FAILED') }
  }
}

function safeEnvironment(environment) {
  const result = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' }
  for (const key of ['HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'USER', 'LOGNAME', '__CF_USER_TEXT_ENCODING']) {
    const value = environment?.[key]
    if (typeof value === 'string' && value && !value.includes('\u0000')) result[key] = value
  }
  return result
}

function validateSigningRequest(request) {
  if (!exactKeys(request, SIGN_REQUEST_KEYS)) fail('REQUEST_INVALID')
  for (const key of ['inputPath', 'outputPath']) {
    const value = request[key]
    if (typeof value !== 'string'
        || !path.isAbsolute(value)
        || path.normalize(value) !== value
        || value.includes('\u0000')) fail('REQUEST_INVALID')
  }
  if (request.inputPath === request.outputPath
      || path.dirname(request.inputPath) !== path.dirname(request.outputPath)) fail('REQUEST_INVALID')
  if (typeof request.certificateSerial !== 'string'
      || !/^(?:[0-9A-Fa-f]{2})+$/.test(request.certificateSerial)) fail('REQUEST_INVALID')
  if (typeof request.signingTime !== 'string'
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(request.signingTime)
      || Number.isNaN(Date.parse(request.signingTime))) fail('REQUEST_INVALID')
  if (typeof request.includeTimestamp !== 'boolean' || typeof request.visible !== 'boolean') {
    fail('REQUEST_INVALID')
  }
  if (typeof request.signatureRoleXml !== 'string'
      || Buffer.from(request.signatureRoleXml, 'utf8').toString('utf8') !== request.signatureRoleXml) {
    fail('REQUEST_INVALID')
  }
  const header = {
    command: 'sign-pades',
    inputPath: request.inputPath,
    outputPath: request.outputPath,
    certificateSerial: request.certificateSerial,
    signingTime: request.signingTime,
    includeTimestamp: request.includeTimestamp,
    visible: request.visible,
    signatureRoleXml: request.signatureRoleXml,
  }
  const headerBytes = Buffer.from(JSON.stringify(header), 'utf8')
  if (!headerBytes.length || headerBytes.length > MAX_HEADER_BYTES) fail('REQUEST_INVALID')
  return { header, headerBytes }
}

function validatePin(pin) {
  if (typeof pin !== 'string' || !pin) fail('REQUEST_INVALID')
  const bytes = Buffer.from(pin, 'utf8')
  if (!bytes.length || bytes.length > MAX_PIN_BYTES || bytes.toString('utf8') !== pin) {
    bytes.fill(0)
    fail('REQUEST_INVALID')
  }
  return bytes
}

function writeChunk(stream, bytes) {
  return new Promise((resolve, reject) => {
    let callbackFinished = false
    let drained = true
    let completed = false
    let drainListener = null
    const onError = (error) => finish(error)
    const cleanup = () => {
      stream.removeListener('error', onError)
      if (drainListener) stream.removeListener('drain', drainListener)
    }
    const finish = (error) => {
      if (completed) return
      if (error) {
        completed = true
        cleanup()
        reject(error)
        return
      }
      if (callbackFinished && drained) {
        completed = true
        cleanup()
        resolve()
      }
    }
    stream.once('error', onError)
    let accepted
    try {
      accepted = stream.write(bytes, (error) => {
        callbackFinished = true
        finish(error || null)
      })
    } catch (error) {
      finish(error)
      return
    }
    if (!accepted) {
      drained = false
      drainListener = () => {
        drained = true
        finish()
      }
      stream.once('drain', drainListener)
    }
  })
}

function uint32(value) {
  const bytes = Buffer.allocUnsafe(4)
  bytes.writeUInt32BE(value)
  return bytes
}

function strictJsonLine(chunks, byteLength) {
  const bytes = Buffer.concat(chunks, byteLength)
  try {
    let text
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { fail('HELPER_PROTOCOL') }
    if (!text.endsWith('\n') || text.includes('\r') || text.slice(0, -1).includes('\n')) fail('HELPER_PROTOCOL')
    try { return JSON.parse(text.slice(0, -1)) } catch { fail('HELPER_PROTOCOL') }
  } finally {
    bytes.fill(0)
    for (const chunk of chunks) chunk.fill(0)
  }
}

function validateDeclaredFailure(value, expectedKeys) {
  if (!exactKeys(value, expectedKeys)
      || value.ok !== false
      || typeof value.code !== 'string'
      || !HELPER_FAILURE_CODES.has(value.code)
      || typeof value.message !== 'string'
      || !value.message
      || value.message.length > 256) fail('HELPER_PROTOCOL')
  return value.code
}

class SignatureHelper {
  constructor({
    appRoot = path.join(__dirname, '..'),
    javaPath = path.join(appRoot, 'signer', 'runtime', 'bin', 'java'),
    jarPath = path.join(appRoot, 'signer', 'ibridge-signer.jar'),
    libraryWildcard = path.join(appRoot, 'signer', 'lib', '*'),
    mainClass = MAIN_CLASS,
    spawnImpl = spawn,
    fsImpl = fsp,
    environment = process.env,
    statusTimeoutMs = DEFAULT_STATUS_TIMEOUT_MS,
    signTimeoutMs = DEFAULT_SIGN_TIMEOUT_MS,
  } = {}) {
    for (const candidate of [javaPath, jarPath, libraryWildcard]) {
      if (typeof candidate !== 'string' || !path.isAbsolute(candidate) || path.normalize(candidate) !== candidate) {
        throw new SignatureHelperError('REQUEST_INVALID')
      }
    }
    if (typeof mainClass !== 'string' || !/^[A-Za-z_$][A-Za-z0-9_$.]*$/.test(mainClass)) {
      throw new SignatureHelperError('REQUEST_INVALID')
    }
    if (typeof spawnImpl !== 'function' || !fsImpl?.open
        || !Number.isSafeInteger(statusTimeoutMs) || statusTimeoutMs < 1
        || !Number.isSafeInteger(signTimeoutMs) || signTimeoutMs < 1) {
      throw new SignatureHelperError('REQUEST_INVALID')
    }
    this.javaPath = javaPath
    this.jarPath = jarPath
    this.libraryWildcard = libraryWildcard
    this.mainClass = mainClass
    this.spawnImpl = spawnImpl
    this.fsImpl = fsImpl
    this.environment = safeEnvironment(environment)
    this.statusTimeoutMs = statusTimeoutMs
    this.signTimeoutMs = signTimeoutMs
  }

  async status({ signal } = {}) {
    const value = await this.execute({ command: 'status' }, Buffer.alloc(0), {
      signal,
      timeoutMs: this.statusTimeoutMs,
    })
    if (value.ok === true) {
      if (!exactKeys(value, STATUS_SUCCESS_KEYS)
          || value.pkcs11Exists !== true
          || value.pkcs11Path !== PRODUCTION_PKCS11_PATH
          || value.tokenReady !== true) fail('HELPER_PROTOCOL')
      return { ok: true, pkcs11Exists: true, pkcs11Path: value.pkcs11Path, tokenReady: true }
    }
    if (!exactKeys(value, STATUS_FAILURE_KEYS)
        || typeof value.pkcs11Exists !== 'boolean'
        || value.pkcs11Path !== PRODUCTION_PKCS11_PATH
        || value.tokenReady !== false) fail('HELPER_PROTOCOL')
    const code = validateDeclaredFailure(value, STATUS_FAILURE_KEYS)
    throw new SignatureHelperError(code)
  }

  async signPades(request, pin, { signal, onPhase } = {}) {
    assertNotAborted(signal)
    const { header, headerBytes } = validateSigningRequest(request)
    const pinBytes = validatePin(pin)
    let value
    try {
      value = await this.execute(header, pinBytes, {
        signal,
        timeoutMs: this.signTimeoutMs,
        headerBytes,
      })
    } finally {
      pinBytes.fill(0)
    }
    if (value.ok !== true) {
      const code = validateDeclaredFailure(value, SIGN_FAILURE_KEYS)
      throw new SignatureHelperError(code)
    }
    const result = validateSignSuccess(value, {
      expectedPath: request.outputPath,
      expectedSerial: request.certificateSerial,
      includeTimestamp: request.includeTimestamp,
    })
    if (onPhase !== undefined) {
      if (typeof onPhase !== 'function') fail('REQUEST_INVALID')
      await onPhase('verifying')
    }
    const signedBytes = await readVerifiedPublishedPdf(request.outputPath, result, {
      signal,
      fsImpl: this.fsImpl,
    })
    return { result, signedBytes }
  }

  async execute(header, pinBytes, { signal, timeoutMs, headerBytes = null }) {
    assertNotAborted(signal)
    const encodedHeader = headerBytes || Buffer.from(JSON.stringify(header), 'utf8')
    if (!encodedHeader.length || encodedHeader.length > MAX_HEADER_BYTES
        || !Buffer.isBuffer(pinBytes) || pinBytes.length > MAX_PIN_BYTES) fail('REQUEST_INVALID')

    let child
    try {
      child = this.spawnImpl(this.javaPath, [
        '-cp',
        `${this.jarPath}${delimiter}${this.libraryWildcard}`,
        this.mainClass,
      ], {
        shell: false,
        detached: false,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...this.environment },
      })
    } catch {
      fail('HELPER_UNAVAILABLE')
    }

    const stdoutChunks = []
    const stderrChunks = []
    let stdoutBytes = 0
    let stderrBytes = 0
    let terminalCode = null
    let spawnFailed = false
    let reaped = false
    let killed = false

    const killAndMark = (code) => {
      if (!terminalCode) terminalCode = code
      if (!killed && !reaped) {
        killed = true
        try { child.kill('SIGKILL') } catch {}
      }
    }
    const onStdinError = () => killAndMark('HELPER_UNAVAILABLE')
    child.stdin.on('error', onStdinError)
    const collect = (kind, chunk) => {
      const bytes = Buffer.from(chunk)
      if (kind === 'stdout') {
        stdoutBytes += bytes.length
        if (stdoutBytes > MAX_STDOUT_BYTES) {
          bytes.fill(0)
          killAndMark('HELPER_OUTPUT_LIMIT')
          return
        }
        stdoutChunks.push(bytes)
      } else {
        stderrBytes += bytes.length
        if (stderrBytes > MAX_STDERR_BYTES) {
          bytes.fill(0)
          killAndMark('HELPER_OUTPUT_LIMIT')
          return
        }
        stderrChunks.push(bytes)
      }
    }
    child.stdout.on('data', (chunk) => collect('stdout', chunk))
    child.stderr.on('data', (chunk) => collect('stderr', chunk))

    const closed = new Promise((resolve) => {
      child.once('error', () => { spawnFailed = true })
      child.once('close', (code, closeSignal) => {
        reaped = true
        resolve({ code, signal: closeSignal })
      })
    })
    const onAbort = () => killAndMark('CANCELLED')
    signal?.addEventListener('abort', onAbort, { once: true })
    const timeout = setTimeout(() => killAndMark('TIMEOUT'), timeoutMs)

    try {
      try {
        await writeChunk(child.stdin, uint32(encodedHeader.length))
        await writeChunk(child.stdin, encodedHeader)
        await writeChunk(child.stdin, uint32(pinBytes.length))
        try {
          await writeChunk(child.stdin, pinBytes)
        } finally {
          pinBytes.fill(0)
        }
        child.stdin.end()
      } catch {
        killAndMark('HELPER_UNAVAILABLE')
      }

      const result = await closed
      if (terminalCode) throw new SignatureHelperError(terminalCode)
      if (spawnFailed) fail('HELPER_UNAVAILABLE')
      if (result.signal !== null) fail('HELPER_PROTOCOL')
      const value = strictJsonLine(stdoutChunks, stdoutBytes)
      const helperFailure = value?.ok === false
      if ((result.code === 0 && helperFailure) || (result.code === 2 && !helperFailure)
          || (result.code !== 0 && result.code !== 2)) fail('HELPER_PROTOCOL')
      return value
    } finally {
      clearTimeout(timeout)
      signal?.removeEventListener('abort', onAbort)
      for (const chunk of stdoutChunks) chunk.fill(0)
      for (const chunk of stderrChunks) chunk.fill(0)
      if (!reaped) {
        try { child.kill('SIGKILL') } catch {}
        await closed.catch(() => {})
      }
      child.stdin.removeListener('error', onStdinError)
    }
  }
}

module.exports = {
  MAX_HEADER_BYTES,
  MAX_PIN_BYTES,
  MAX_SIGNED_PDF_BYTES,
  SignatureHelper,
  SignatureHelperError,
  readVerifiedPublishedPdf,
  validateSignSuccess,
}
