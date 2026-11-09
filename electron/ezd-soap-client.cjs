const crypto = require('node:crypto')
const os = require('node:os')
const { DOMParser } = require('@xmldom/xmldom')

const DATA_NAMESPACE = 'http://ezd.gov.pl/data/'
const SOAP_NAMESPACE = 'http://schemas.xmlsoap.org/soap/envelope/'
const ACTION_BASE = 'http://ezd.gov.pl/IAddInProxy/'
const TRUSTED_EZD_HOST = 'ezd-proxy.kg.straz.gov.pl'
const DEFAULT_MAX_FILE_BYTES = 128 * 1024 * 1024
const XML_OVERHEAD_BYTES = 1024 * 1024

class EzdServiceError extends Error {
  constructor(message, {
    operation,
    kind,
    ezdStatus = 0,
    httpStatus = 0,
    retryable = false,
    cause,
  } = {}) {
    super(message, cause ? { cause } : undefined)
    this.name = 'EzdServiceError'
    this.operation = operation
    this.kind = kind
    this.ezdStatus = ezdStatus
    this.httpStatus = httpStatus
    this.retryable = retryable
  }
}

function normalizeServiceError(error, operation) {
  if (error instanceof EzdServiceError) return error
  return new EzdServiceError(
    `Operacja ${operation} nie powiodła się: ${error?.message || 'nieznany błąd odpowiedzi.'}`,
    { operation, kind: 'protocol', retryable: false, cause: error },
  )
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function validateServiceUrl(rawUrl) {
  let url
  try { url = new URL(rawUrl) } catch { throw new Error('Nieprawidłowy adres usługi EZD.') }
  if (
    url.protocol !== 'https:' ||
    url.hostname.toLowerCase() !== TRUSTED_EZD_HOST ||
    url.port || url.username || url.password || url.search || url.hash ||
    !/\/EzdProxy\.svc\/?$/i.test(url.pathname)
  ) throw new Error('Adres usługi SOAP EZD nie jest zaufany.')
  return url.toString()
}

function getLocalIPAddress() {
  const interfaces = os.networkInterfaces()
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries || []) {
      if (entry.family === 'IPv4' && !entry.internal) return entry.address
    }
  }
  return '127.0.0.1'
}

function soapXml(operation, authToken, ipAddress, fileContentId = null, requestWrapper = `${operation}Request`) {
  const body = fileContentId
    ? `<d:${requestWrapper}><d:FileByteStream><xop:Include href="cid:${escapeXml(fileContentId)}" /></d:FileByteStream></d:${requestWrapper}>`
    : `<d:${requestWrapper} />`
  return `<?xml version="1.0" encoding="utf-8"?><s:Envelope xmlns:s="${SOAP_NAMESPACE}" xmlns:d="${DATA_NAMESPACE}" xmlns:xop="http://www.w3.org/2004/08/xop/include"><s:Header><d:AuthToken>${escapeXml(authToken)}</d:AuthToken><d:IPAddress>${escapeXml(ipAddress)}</d:IPAddress></s:Header><s:Body>${body}</s:Body></s:Envelope>`
}

function createMtomRequest(operation, authToken, ipAddress, fileData = null, { requestWrapper = `${operation}Request` } = {}) {
  const boundary = `most-ezd-${crypto.randomUUID()}`
  const rootId = `root.${crypto.randomUUID()}@most-ezd`
  const fileId = fileData ? `file.${crypto.randomUUID()}@most-ezd` : null
  const xml = soapXml(operation, authToken, ipAddress, fileId, requestWrapper)
  const chunks = [Buffer.from(
    `--${boundary}\r\nContent-Type: application/xop+xml; charset=UTF-8; type="text/xml"\r\nContent-Transfer-Encoding: 8bit\r\nContent-ID: <${rootId}>\r\n\r\n${xml}\r\n`,
  )]
  if (fileData) {
    chunks.push(Buffer.from(
      `--${boundary}\r\nContent-Type: application/octet-stream\r\nContent-Transfer-Encoding: binary\r\nContent-ID: <${fileId}>\r\n\r\n`,
    ))
    chunks.push(fileData)
    chunks.push(Buffer.from('\r\n'))
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`))
  return {
    body: Buffer.concat(chunks),
    contentType: `multipart/related; type="application/xop+xml"; start="<${rootId}>"; boundary="${boundary}"; start-info="text/xml"`,
  }
}

function parseHeaderBlock(buffer) {
  const value = buffer.toString('latin1')
  const headers = new Map()
  for (const line of value.split('\r\n')) {
    const separator = line.indexOf(':')
    if (separator > 0) headers.set(line.slice(0, separator).trim().toLowerCase(), line.slice(separator + 1).trim())
  }
  return headers
}

function parseMultipart(buffer, contentType) {
  const match = /boundary\s*=\s*(?:"([^"]+)"|([^;\s]+))/i.exec(contentType)
  if (!match) throw new Error('Odpowiedź MTOM nie zawiera granicy MIME.')
  const boundary = match[1] || match[2]
  if (!boundary || boundary.length > 200) throw new Error('Nieprawidłowa granica MIME.')
  const marker = Buffer.from(`--${boundary}`)
  const nextMarker = Buffer.from(`\r\n--${boundary}`)
  const parts = []
  let position = buffer.indexOf(marker)
  if (position < 0) throw new Error('Nieprawidłowa odpowiedź MTOM.')

  while (position >= 0) {
    position += marker.length
    if (buffer.subarray(position, position + 2).equals(Buffer.from('--'))) break
    if (buffer.subarray(position, position + 2).equals(Buffer.from('\r\n'))) position += 2
    const headerEnd = buffer.indexOf(Buffer.from('\r\n\r\n'), position)
    if (headerEnd < 0 || headerEnd - position > 64 * 1024) throw new Error('Nieprawidłowe nagłówki MIME.')
    const headers = parseHeaderBlock(buffer.subarray(position, headerEnd))
    const contentStart = headerEnd + 4
    const contentEnd = buffer.indexOf(nextMarker, contentStart)
    if (contentEnd < 0) throw new Error('Niekompletna odpowiedź MTOM.')
    parts.push({ headers, data: buffer.subarray(contentStart, contentEnd) })
    position = contentEnd + 2
  }
  if (!parts.length) throw new Error('Pusta odpowiedź MTOM.')
  return parts
}

function findElement(node, localName) {
  if (!node) return null
  if (node.nodeType === 1 && (node.localName || node.nodeName.split(':').at(-1)) === localName) return node
  for (let child = node.firstChild; child; child = child.nextSibling) {
    const found = findElement(child, localName)
    if (found) return found
  }
  return null
}

function elementText(document, name) {
  const element = findElement(document.documentElement, name)
  return element ? String(element.textContent || '').trim() : ''
}

function parseXml(xmlBuffer) {
  if (/<!DOCTYPE|<!ENTITY/i.test(xmlBuffer.toString('utf8'))) {
    throw new Error('Odpowiedź SOAP zawiera niedozwoloną deklarację DTD.')
  }
  const errors = []
  const document = new DOMParser({
    errorHandler: {
      warning: () => {},
      error: (message) => errors.push(message),
      fatalError: (message) => errors.push(message),
    },
  }).parseFromString(xmlBuffer.toString('utf8'), 'text/xml')
  if (!document?.documentElement || errors.length) throw new Error('Nieprawidłowa odpowiedź XML usługi EZD.')
  return document
}

function parseMtomMessage(buffer, contentType = 'text/xml', maxBytes = DEFAULT_MAX_FILE_BYTES + XML_OVERHEAD_BYTES) {
  if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer)
  if (buffer.length > maxBytes) throw new Error('Odpowiedź usługi EZD jest zbyt duża.')

  let xmlBuffer = buffer
  let parts = []
  if (/multipart\/related/i.test(contentType)) {
    parts = parseMultipart(buffer, contentType)
    const root = parts.find((part) => /(?:application\/xop\+xml|text\/xml|application\/soap\+xml)/i.test(part.headers.get('content-type') || '')) || parts[0]
    xmlBuffer = root.data
  }
  const document = parseXml(xmlBuffer)
  const attachments = new Map()
  for (const part of parts) {
    const contentId = (part.headers.get('content-id') || '').replace(/^<|>$/g, '')
    if (contentId) attachments.set(contentId, part.data)
  }
  return { document, attachments, xmlBuffer }
}

function parseInteger(document, name, { required = false } = {}) {
  const value = elementText(document, name)
  if (!value && !required) return 0
  if (!/^-?\d+$/.test(value)) throw new Error(`Nieprawidłowe pole ${name} w odpowiedzi EZD.`)
  const number = Number(value)
  if (!Number.isSafeInteger(number)) throw new Error(`Pole ${name} przekracza obsługiwany zakres.`)
  return number
}

function parseBoolean(document, name, { required = false } = {}) {
  const value = elementText(document, name)
  if (!value && !required) return false
  if (!/^(?:true|false)$/i.test(value)) throw new Error(`Nieprawidłowe pole ${name} w odpowiedzi EZD.`)
  return value.toLowerCase() === 'true'
}

function parseSigningTime(document, name) {
  const value = elementText(document, name)
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,7})?(Z|[+-](\d{2}):(\d{2}))$/.exec(value)
  if (!match) throw new Error(`Nieprawidłowe pole ${name} w odpowiedzi EZD.`)
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, zone, zoneHourText = '0', zoneMinuteText = '0'] = match
  const year = Number(yearText)
  const month = Number(monthText)
  const day = Number(dayText)
  const hour = Number(hourText)
  const minute = Number(minuteText)
  const second = Number(secondText)
  const zoneHour = Number(zoneHourText)
  const zoneMinute = Number(zoneMinuteText)
  const daysInMonth = [31, year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]
  if (
    year < 1 || year > 9999 || month < 1 || month > 12 || day < 1 || day > daysInMonth ||
    hour > 23 || minute > 59 || second > 59 || zoneHour > 14 || zoneMinute > 59 ||
    (zoneHour === 14 && zoneMinute !== 0)
  ) throw new Error(`Nieprawidłowe pole ${name} w odpowiedzi EZD.`)
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime()) || parsed.getUTCFullYear() < 1 || parsed.getUTCFullYear() > 9999) {
    throw new Error(`Nieprawidłowe pole ${name} w odpowiedzi EZD.`)
  }
  return parsed.toISOString()
}

function decodeBase64Utf8OrOriginal(value) {
  const original = String(value || '').trim()
  const encoded = original
  if (!encoded || encoded.length % 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) return original
  const decoded = Buffer.from(encoded, 'base64')
  if (decoded.toString('base64') !== encoded) return original
  const text = decoded.toString('utf8')
  return Buffer.from(text, 'utf8').equals(decoded) ? text : original
}

function readFileByteStream(result, maxFileBytes, missingMessage) {
  const stream = findElement(result.document.documentElement, 'FileByteStream')
  const include = stream && findElement(stream, 'Include')
  let data
  if (include) {
    const href = include.getAttribute('href') || ''
    data = result.attachments.get(href.replace(/^cid:/i, ''))
  } else if (stream) {
    try { data = Buffer.from(String(stream.textContent || '').replace(/\s/g, ''), 'base64') } catch {}
  }
  if (!data) throw new Error(missingMessage)
  if (data.length > maxFileBytes) throw new Error('Dokument EZD jest zbyt duży.')
  return Buffer.from(data)
}

async function readResponseBuffer(response, maximum) {
  const declared = Number(response.headers.get('content-length') || 0)
  if (declared > maximum) throw new Error('Odpowiedź usługi EZD jest zbyt duża.')
  if (!response.body?.getReader) {
    const buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.length > maximum) throw new Error('Odpowiedź usługi EZD jest zbyt duża.')
    return buffer
  }
  const reader = response.body.getReader()
  const chunks = []
  let size = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > maximum) {
      await reader.cancel().catch(() => {})
      throw new Error('Odpowiedź usługi EZD jest zbyt duża.')
    }
    chunks.push(Buffer.from(value))
  }
  return Buffer.concat(chunks, size)
}

class EzdSoapClient {
  constructor({
    serviceUrl,
    authToken,
    ipAddress = getLocalIPAddress(),
    fetchImpl = globalThis.fetch,
    timeoutMs = 30_000,
    maxFileBytes = DEFAULT_MAX_FILE_BYTES,
    retryDelaysMs = [250, 750],
    sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    onDiagnostic = async () => {},
  }) {
    this.serviceUrl = validateServiceUrl(serviceUrl)
    if (typeof authToken !== 'string' || !authToken || authToken.length > 512) throw new Error('Brak prawidłowego tokenu sesji EZD.')
    if (typeof ipAddress !== 'string' || !ipAddress || ipAddress.length > 64) throw new Error('Brak lokalnego adresu IP.')
    if (typeof fetchImpl !== 'function') throw new Error('Brak obsługi połączeń sieciowych.')
    this.authToken = authToken
    this.ipAddress = ipAddress
    this.fetchImpl = fetchImpl
    this.timeoutMs = timeoutMs
    this.maxFileBytes = maxFileBytes
    this.retryDelaysMs = [...retryDelaysMs]
    this.sleep = sleep
    this.onDiagnostic = onDiagnostic
    this.diagnosticContext = {}
  }

  setDiagnosticContext(patch = {}) {
    if (typeof patch.sessionId === 'string' && patch.sessionId) {
      this.diagnosticContext.sessionId = patch.sessionId
    }
  }

  async emitDiagnostic(event) {
    try {
      await this.onDiagnostic({ ...this.diagnosticContext, ...event })
    } catch {
      // Diagnostyka nie może przerwać komunikacji z EZD.
    }
  }

  async postOnce(operation, fileData = null, { requestWrapper, signal } = {}) {
    const request = createMtomRequest(operation, this.authToken, this.ipAddress, fileData, { requestWrapper })
    let response
    try {
      const timeoutSignal = AbortSignal.timeout(this.timeoutMs)
      const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal
      response = await this.fetchImpl(this.serviceUrl, {
        method: 'POST',
        redirect: 'error',
        headers: {
          'Content-Type': request.contentType,
          SOAPAction: `"${ACTION_BASE}${operation}"`,
          Accept: 'multipart/related, application/xop+xml, text/xml',
        },
        body: request.body,
        signal: requestSignal,
      })
    } catch (cause) {
      const cancelled = signal?.aborted === true
      const timedOut = !cancelled && (cause?.name === 'TimeoutError' || cause?.name === 'AbortError')
      throw new EzdServiceError(
        cancelled
          ? `Operacja ${operation} została przerwana.`
          : timedOut
          ? `Operacja ${operation} przekroczyła limit czasu.`
          : `Operacja ${operation} nie połączyła się z usługą EZD.`,
        {
          operation,
          kind: cancelled ? 'cancelled' : timedOut ? 'timeout' : 'transport',
          retryable: !cancelled,
          cause,
        },
      )
    }

    try {
      const buffer = await readResponseBuffer(response, this.maxFileBytes + XML_OVERHEAD_BYTES)
      const contentType = response.headers.get('content-type') || 'text/xml'

      if (!response.ok) {
        let serverMessage = ''
        try {
          const errorResponse = parseMtomMessage(buffer, contentType, this.maxFileBytes + XML_OVERHEAD_BYTES)
          serverMessage = elementText(errorResponse.document, 'faultstring') || elementText(errorResponse.document, 'Message')
        } catch {}
        throw new EzdServiceError(
          `Operacja ${operation} zwróciła HTTP ${response.status}${serverMessage ? `: ${serverMessage}` : '.'}`,
          {
            operation,
            kind: 'http',
            httpStatus: response.status,
            retryable: [502, 503, 504].includes(response.status),
          },
        )
      }

      const parsed = parseMtomMessage(buffer, contentType, this.maxFileBytes + XML_OVERHEAD_BYTES)
      const fault = elementText(parsed.document, 'faultstring') || elementText(parsed.document, 'Text')
      if (findElement(parsed.document.documentElement, 'Fault')) {
        throw new EzdServiceError(
          `Operacja ${operation} zwróciła błąd SOAP${fault ? `: ${fault}` : '.'}`,
          { operation, kind: 'soap', httpStatus: response.status, retryable: false },
        )
      }
      const status = parseInteger(parsed.document, 'Status', { required: true })
      const message = elementText(parsed.document, 'Message')
      if (status !== 0) {
        throw new EzdServiceError(
          `Operacja ${operation} zwróciła status ${status}${message ? `: ${message}` : '.'}`,
          {
            operation,
            kind: 'ezd',
            ezdStatus: status,
            httpStatus: response.status,
            retryable: false,
          },
        )
      }
      return { ...parsed, status, message, httpStatus: response.status }
    } catch (error) {
      if (error instanceof EzdServiceError) throw error
      if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
        throw new EzdServiceError(`Operacja ${operation} została przerwana podczas odczytu odpowiedzi.`, {
          operation, kind: signal?.aborted ? 'cancelled' : 'timeout', httpStatus: response.status,
          retryable: !signal?.aborted, cause: error,
        })
      }
      throw new EzdServiceError(
        `Operacja ${operation} zwróciła nieprawidłową odpowiedź: ${error?.message || 'nieznany błąd.'}`,
        {
          operation,
          kind: 'protocol',
          httpStatus: response.status,
          retryable: false,
          cause: error,
        },
      )
    }
  }

  async post(operation, fileData = null, { requestWrapper, retry = true, signal } = {}) {
    if (fileData && fileData.length > this.maxFileBytes) throw new Error('Dokument jest zbyt duży do wysłania do EZD.')
    const attempts = retry ? this.retryDelaysMs.length + 1 : 1
    for (let attemptIndex = 0; attemptIndex < attempts; attemptIndex += 1) {
      if (signal?.aborted) {
        throw new EzdServiceError(`Operacja ${operation} została przerwana.`, {
          operation,
          kind: 'cancelled',
          retryable: false,
        })
      }
      const started = performance.now()
      let result = null
      let failure = null
      try {
        result = await this.postOnce(operation, fileData, { requestWrapper, signal })
      } catch (error) {
        failure = normalizeServiceError(error, operation)
        failure.message = failure.message.split(this.authToken).join('[USUNIĘTO]')
      }
      if (failure && (!retry || signal?.aborted)) failure.retryable = false

      await this.emitDiagnostic({
        operation,
        attempt: attemptIndex + 1,
        durationMs: Math.max(0, Math.round((performance.now() - started) * 100) / 100),
        size: fileData?.length || 0,
        httpStatus: failure?.httpStatus ?? result?.httpStatus ?? 0,
        ezdStatus: failure?.ezdStatus ?? result?.status ?? 0,
        kind: failure?.kind || 'success',
      })

      if (!failure) return result
      if (!failure.retryable || attemptIndex === attempts - 1) throw failure
      await this.sleep(this.retryDelaysMs[attemptIndex])
    }
    throw new EzdServiceError(`Operacja ${operation} nie powiodła się.`, {
      operation,
      kind: 'protocol',
      retryable: false,
    })
  }

  async checkData({ signal } = {}) {
    const { document } = await this.post('AddInSprawdzDane', null, { signal })
    const metadata = {
      documentId: parseInteger(document, 'DokumentId'),
      documentName: elementText(document, 'DokumentNazwa'),
      documentMode: parseInteger(document, 'DokumentTryb'),
      pismoId: parseInteger(document, 'PismoId'),
      pismoName: elementText(document, 'PismoNazwa'),
      caseMark: elementText(document, 'SprawaZnak'),
      shared: elementText(document, 'Udostepniony').toLowerCase() === 'true',
    }
    await this.emitDiagnostic({
      operation: 'AddInSprawdzDaneMetadata',
      kind: 'metadata',
      caseMarkPresent: Boolean(metadata.caseMark),
      pismoIdPresent: metadata.pismoId > 0,
      documentIdPresent: metadata.documentId > 0,
    })
    return metadata
  }

  async downloadFile() {
    const result = await this.post('AddInDownloadFile')
    const data = readFileByteStream(result, this.maxFileBytes, 'Odpowiedź EZD nie zawiera pliku dokumentu.')
    const declaredFileLength = parseInteger(result.document, 'FileLength')
    return {
      data: Buffer.from(data),
      fileLength: data.length,
      declaredFileLength,
      lengthMismatch: Boolean(declaredFileLength && declaredFileLength !== data.length),
      message: result.message,
    }
  }

  async uploadFile(data) {
    const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data || [])
    if (!bytes.length) throw new Error('Nie można wysłać pustego dokumentu.')
    const { document, message } = await this.post('AddInUploadFile', bytes)
    return { documentId: parseInteger(document, 'IdDokumentu'), message }
  }

  async downloadSignatureData({ signal } = {}) {
    const result = await this.post('AddInPodpisDane', null, { signal })
    const certificateSerial = elementText(result.document, 'CertyfikatUzytkownika')
    if (!certificateSerial) throw new Error('Odpowiedź EZD nie zawiera numeru seryjnego certyfikatu.')
    const signingTime = parseSigningTime(result.document, 'DataPodpisu')
    const fileLength = parseInteger(result.document, 'FileLength', { required: true })
    if (fileLength < 0) throw new Error('Nieprawidłowe pole FileLength w odpowiedzi EZD.')
    const mode = parseInteger(result.document, 'Tryb', { required: true })
    if (mode !== 6 && mode !== 9) throw new Error('EZD zwrócił nieobsługiwany tryb podpisu.')
    const includeTimestamp = parseBoolean(result.document, 'IncludeTimestampFromTSA', { required: true })
    const data = readFileByteStream(result, this.maxFileBytes, 'Odpowiedź EZD nie zawiera pliku do podpisu.')
    if (!data.length) throw new Error('Odpowiedź EZD nie zawiera pliku do podpisu.')
    if (fileLength !== data.length) throw new Error('Długość pliku do podpisu nie zgadza się z odpowiedzią EZD.')
    if (!data.subarray(0, 5).equals(Buffer.from('%PDF-'))) throw new Error('EZD zwrócił dane do podpisu, które nie są plikiem PDF.')
    return {
      data,
      fileName: decodeBase64Utf8OrOriginal(elementText(result.document, 'FileName')),
      fileLength,
      mode,
      certificateSerial,
      signingTime,
      includeTimestamp,
      signatureRoleXml: elementText(result.document, 'SR'),
      fileHash: elementText(result.document, 'FileHash'),
      fileHash256: elementText(result.document, 'FileHash256'),
    }
  }

  async uploadSignature(data) {
    const bytes = Buffer.from(Buffer.isBuffer(data) ? data : data || [])
    if (!bytes.length) throw new Error('Nie można wysłać pustego podpisu.')
    if (!bytes.subarray(0, 5).equals(Buffer.from('%PDF-'))) throw new Error('Nie można wysłać podpisu, który nie jest plikiem PDF.')
    const { document, message } = await this.post('AddInPodpisUpload', bytes, {
      requestWrapper: 'AddInUploadFileRequest',
      retry: false,
    })
    return { documentId: parseInteger(document, 'IdDokumentu', { required: true }), message }
  }

  async finishSession() {
    const { message } = await this.post('AddInZakonczSesje')
    return { ok: true, message }
  }
}

module.exports = {
  DEFAULT_MAX_FILE_BYTES,
  EzdServiceError,
  EzdSoapClient,
  createMtomRequest,
  getLocalIPAddress,
  parseMtomMessage,
  validateServiceUrl,
}
