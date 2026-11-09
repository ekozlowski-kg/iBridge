const assert = require('node:assert/strict')
const test = require('node:test')

const {
  EzdServiceError,
  EzdSoapClient,
  parseMtomMessage,
} = require('../electron/ezd-soap-client.cjs')

const xml = (status, message = '') => Buffer.from(
  `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><r><Status>${status}</Status><Message>${message}</Message></r></s:Body></s:Envelope>`,
)

function makeClient(options = {}) {
  return new EzdSoapClient({
    serviceUrl: 'https://ezd-proxy.kg.straz.gov.pl/EzdProxy.svc',
    authToken: 'test-token',
    ipAddress: '127.0.0.1',
    retryDelaysMs: [0, 0],
    sleep: async () => {},
    ...options,
  })
}

function signatureMtomResponse({
  certificateSerial = '01A2B3',
  signingTime = '2026-08-31T10:11:12+02:00',
  fileLength = null,
  fileName = Buffer.from('do-podpisu.pdf', 'utf8').toString('base64'),
  includeTimestamp = 'true',
  mode = 6,
  fileData = Buffer.from('%PDF-1.7\nbody'),
  includeAttachment = true,
} = {}) {
  const boundary = 'signature-response-boundary'
  const fileId = 'signature-file@example.test'
  const declaredFileLength = fileLength === null ? fileData.length : fileLength
  const envelope = `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" xmlns:d="http://ezd.gov.pl/data/" xmlns:xop="http://www.w3.org/2004/08/xop/include"><s:Header><d:Status>0</d:Status><d:CertyfikatUzytkownika>${certificateSerial}</d:CertyfikatUzytkownika><d:DataPodpisu>${signingTime}</d:DataPodpisu><d:FileHash>sha1</d:FileHash><d:FileHash256>sha256</d:FileHash256><d:FileLength>${declaredFileLength}</d:FileLength><d:FileName>${fileName}</d:FileName><d:IncludeTimestampFromTSA>${includeTimestamp}</d:IncludeTimestampFromTSA><d:SR>&lt;Role&gt;Director&lt;/Role&gt;</d:SR><d:Tryb>${mode}</d:Tryb></s:Header><s:Body><d:AddInPodpisDaneResponse><d:FileByteStream><xop:Include href="cid:${fileId}" /></d:FileByteStream></d:AddInPodpisDaneResponse></s:Body></s:Envelope>`
  return {
    body: Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Type: application/xop+xml; charset=UTF-8; type="text/xml"\r\nContent-ID: <root@example.test>\r\n\r\n${envelope}\r\n`),
      ...(includeAttachment ? [
        Buffer.from(`--${boundary}\r\nContent-Type: application/octet-stream\r\nContent-ID: <${fileId}>\r\n\r\n`),
        fileData,
      ] : []),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
    contentType: `multipart/related; type="application/xop+xml"; start="<root@example.test>"; boundary="${boundary}"`,
  }
}

test('downloads and validates PAdES signature data from an MTOM response', async () => {
  const response = signatureMtomResponse()
  const client = makeClient({
    fetchImpl: async () => new Response(response.body, {
      status: 200,
      headers: { 'content-type': response.contentType },
    }),
  })

  const signature = await client.downloadSignatureData()
  assert.deepEqual(signature, {
    data: Buffer.from('%PDF-1.7\nbody'),
    fileName: 'do-podpisu.pdf',
    fileLength: 13,
    mode: 6,
    certificateSerial: '01A2B3',
    signingTime: '2026-08-31T08:11:12.000Z',
    includeTimestamp: true,
    signatureRoleXml: '<Role>Director</Role>',
    fileHash: 'sha1',
    fileHash256: 'sha256',
  })
  assert.notEqual(signature.data, response.body)
})

test('copies signature attachment bytes before returning them to the caller', async () => {
  const response = signatureMtomResponse()
  const sharedResponseBytes = Buffer.allocUnsafeSlow(response.body.length)
  response.body.copy(sharedResponseBytes)
  const attachmentOffset = sharedResponseBytes.indexOf(Buffer.from('%PDF-1.7\nbody'))
  const client = makeClient({
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': response.contentType }),
      arrayBuffer: async () => sharedResponseBytes.buffer,
    }),
  })

  const signature = await client.downloadSignatureData()
  signature.data[0] = 0
  assert.equal(sharedResponseBytes[attachmentOffset], '%'.charCodeAt(0))
})

test('requests signature data with the exact action, empty wrapper, and SOAP headers', async () => {
  const response = signatureMtomResponse()
  const sent = []
  const client = makeClient({
    fetchImpl: async (_url, request) => {
      sent.push(request)
      return new Response(response.body, { status: 200, headers: { 'content-type': response.contentType } })
    },
  })

  await client.downloadSignatureData()
  assert.equal(sent.length, 1)
  assert.equal(sent[0].headers.SOAPAction, '"http://ezd.gov.pl/IAddInProxy/AddInPodpisDane"')
  const requestXml = parseMtomMessage(sent[0].body, sent[0].headers['Content-Type']).xmlBuffer.toString('utf8')
  assert.match(requestXml, /<s:Header><d:AuthToken>test-token<\/d:AuthToken><d:IPAddress>127\.0\.0\.1<\/d:IPAddress><\/s:Header>/)
  assert.match(requestXml, /<s:Body><d:AddInPodpisDaneRequest \/><\/s:Body>/)
  assert.doesNotMatch(requestXml, /<s:Body>[\s\S]*<d:(?:AuthToken|IPAddress)>/)
})

test('aborts a read-only signature receive through the caller signal without retry', async () => {
  const controller = new AbortController()
  let attempts = 0
  const client = makeClient({
    timeoutMs: 5000,
    fetchImpl: async () => {
      attempts += 1
      return new Promise((_resolve, reject) => {
        const abort = () => {
          const error = new Error('synthetic caller abort')
          error.name = 'AbortError'
          reject(error)
        }
        if (controller.signal.aborted) abort()
        else controller.signal.addEventListener('abort', abort, { once: true })
      })
    },
  })
  const operation = client.downloadSignatureData({ signal: controller.signal })
  controller.abort()

  await assert.rejects(
    operation,
    (error) => error instanceof EzdServiceError && error.kind === 'cancelled' && error.retryable === false,
  )
  assert.equal(attempts, 1)
})

for (const [name, fileName, expected] of [
  ['plain-text filename', 'signed.pdf', 'signed.pdf'],
  ['non-canonical Base64 filename', 'ZE==', 'ZE=='],
  ['embedded-whitespace Base64 filename', 'Z A==', 'Z A=='],
]) {
  test(`keeps the original ${name} when Base64 decoding is unsafe`, async () => {
    const response = signatureMtomResponse({ fileName })
    const client = makeClient({
      fetchImpl: async () => new Response(response.body, { status: 200, headers: { 'content-type': response.contentType } }),
    })
    assert.equal((await client.downloadSignatureData()).fileName, expected)
  })
}

test('accepts PAdES graph mode and DateTimeOffset boundary values within .NET range', async () => {
  for (const [signingTime, expected] of [
    ['0001-01-01T00:00:00Z', '0001-01-01T00:00:00.000Z'],
    ['9999-12-31T23:59:59Z', '9999-12-31T23:59:59.000Z'],
  ]) {
    const response = signatureMtomResponse({ mode: 9, signingTime })
    const client = makeClient({
      fetchImpl: async () => new Response(response.body, { status: 200, headers: { 'content-type': response.contentType } }),
    })
    const signature = await client.downloadSignatureData()
    assert.equal(signature.mode, 9)
    assert.equal(signature.signingTime, expected)
  }
})

for (const signingTime of [
  '0000-01-01T00:00:00Z',
  '0001-01-01T00:00:00+00:01',
  '9999-12-31T23:59:59-00:01',
  '10000-01-01T00:00:00Z',
]) {
  test(`rejects DateTimeOffset outside the .NET range: ${signingTime}`, async () => {
    const response = signatureMtomResponse({ signingTime })
    const client = makeClient({
      fetchImpl: async () => new Response(response.body, { status: 200, headers: { 'content-type': response.contentType } }),
    })
    await assert.rejects(client.downloadSignatureData())
  })
}

for (const [name, response] of [
  ['missing certificate serial', signatureMtomResponse({ certificateSerial: '' })],
  ['invalid signing time', signatureMtomResponse({ signingTime: 'not-a-date' })],
  ['unsupported signature mode', signatureMtomResponse({ mode: 5 })],
  ['missing MTOM attachment', signatureMtomResponse({ includeAttachment: false })],
  ['mismatched declared file length', signatureMtomResponse({ fileLength: 14 })],
  ['invalid timestamp flag', signatureMtomResponse({ includeTimestamp: 'yes' })],
  ['invalid declared file length', signatureMtomResponse({ fileLength: '13.5' })],
  ['non-PDF signature payload', signatureMtomResponse({ fileData: Buffer.from('not a PDF file') })],
]) {
  test(`rejects ${name} before an upload can be attempted`, async () => {
    const client = makeClient({
      fetchImpl: async () => new Response(response.body, {
        status: 200,
        headers: { 'content-type': response.contentType },
      }),
    })
    await assert.rejects(client.downloadSignatureData())
  })
}

test('uploads a PAdES signature with the signature action and shared WCF wrapper', async () => {
  const sent = []
  const client = makeClient({
    fetchImpl: async (_url, request) => {
      sent.push(request)
      return new Response(Buffer.from(`<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Header><Status>0</Status><Message>accepted</Message></s:Header><s:Body><AddInUploadFileResponse><IdDokumentu>987</IdDokumentu></AddInUploadFileResponse></s:Body></s:Envelope>`), {
        status: 200,
        headers: { 'content-type': 'text/xml' },
      })
    },
  })
  const signedPdf = Buffer.from('%PDF-1.7\nSigned bytes\x00\xff', 'latin1')

  const uploaded = await client.uploadSignature(signedPdf)
  assert.deepEqual(uploaded, { documentId: 987, message: 'accepted' })
  assert.equal(sent.length, 1)
  assert.equal(sent[0].headers.SOAPAction, '"http://ezd.gov.pl/IAddInProxy/AddInPodpisUpload"')
  const request = parseMtomMessage(sent[0].body, sent[0].headers['Content-Type'])
  const include = request.document.getElementsByTagName('xop:Include')[0]
  const href = include.getAttribute('href').replace(/^cid:/, '')
  assert.match(request.xmlBuffer.toString('utf8'), /<d:AddInUploadFileRequest>/)
  assert.equal(request.attachments.has(href), true)
  assert.deepEqual(request.attachments.get(href), signedPdf)
})

for (const [name, fetchImpl] of [
  ['HTTP 502', async () => new Response(xml(1, 'temporary'), { status: 502, headers: { 'content-type': 'text/xml' } })],
  ['transport failure', async () => { throw new TypeError('fetch failed') }],
]) {
  test(`does not retry a signature upload after a retryable ${name}`, async () => {
    let attempts = 0
    const client = makeClient({
      fetchImpl: async (...args) => {
        attempts += 1
        return fetchImpl(...args)
      },
    })
    await assert.rejects(client.uploadSignature(Buffer.from('%PDF-1.7')), (error) => {
      assert.equal(error.retryable, false)
      return true
    })
    assert.equal(attempts, 1)
  })
}

test('diagnostics exclude SOAP failure text and thrown errors redact an echoed session token', async () => {
  const events = []
  const client = makeClient({
    fetchImpl: async () => new Response(xml(1, 'echoed test-token from SOAP body'), {
      status: 200,
      headers: { 'content-type': 'text/xml' },
    }),
    onDiagnostic: async (event) => events.push(event),
  })

  await assert.rejects(client.finishSession(), error => {
    assert.match(error.message, /echoed \[USUNIĘTO\] from SOAP body/)
    assert.doesNotMatch(error.message, /test-token/)
    return true
  })
  assert.equal(events.length, 1)
  assert.deepEqual(Object.keys(events[0]).sort(), [
    'attempt', 'durationMs', 'ezdStatus', 'httpStatus', 'kind', 'operation', 'size',
  ])
  assert.doesNotMatch(JSON.stringify(events[0]), /test-token|SOAP body/)
})

test('rejects a non-PDF signature before sending it', async () => {
  let attempts = 0
  const client = makeClient({ fetchImpl: async () => { attempts += 1 } })
  await assert.rejects(client.uploadSignature(Buffer.from('not pdf')))
  assert.equal(attempts, 0)
})

test('names AddInUploadFile when EZD returns status 1', async () => {
  const client = makeClient({
    fetchImpl: async () => new Response(xml(1), {
      status: 200,
      headers: { 'content-type': 'text/xml' },
    }),
  })

  await assert.rejects(client.uploadFile(Buffer.from('x')), (error) => {
    assert.equal(error instanceof EzdServiceError, true)
    assert.equal(error.operation, 'AddInUploadFile')
    assert.equal(error.kind, 'ezd')
    assert.equal(error.ezdStatus, 1)
    assert.equal(error.retryable, false)
    assert.match(error.message, /AddInUploadFile.*status 1/i)
    assert.doesNotMatch(error.message, /test-token/)
    return true
  })
})

test('retains retry behavior for ordinary document uploads', async () => {
  let attempts = 0
  const client = makeClient({
    fetchImpl: async () => {
      attempts += 1
      if (attempts < 3) throw new TypeError('fetch failed')
      return new Response(Buffer.from(`<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><r><Status>0</Status><IdDokumentu>321</IdDokumentu></r></s:Body></s:Envelope>`), {
        status: 200,
        headers: { 'content-type': 'text/xml' },
      })
    },
  })

  assert.deepEqual(await client.uploadFile(Buffer.from('ordinary upload')), { documentId: 321, message: '' })
  assert.equal(attempts, 3)
})

for (const status of [502, 503, 504]) {
  test(`retries HTTP ${status} twice and returns the third successful response`, async () => {
    let attempts = 0
    const client = makeClient({
      fetchImpl: async () => {
        attempts += 1
        return attempts < 3
          ? new Response(xml(1, 'temporary'), { status, headers: { 'content-type': 'text/xml' } })
          : new Response(xml(0), { status: 200, headers: { 'content-type': 'text/xml' } })
      },
    })
    await client.finishSession()
    assert.equal(attempts, 3)
  })
}

test('retries a transport failure and then succeeds', async () => {
  let attempts = 0
  const client = makeClient({
    fetchImpl: async () => {
      attempts += 1
      if (attempts < 3) throw new TypeError('fetch failed')
      return new Response(xml(0), { status: 200, headers: { 'content-type': 'text/xml' } })
    },
  })
  await client.finishSession()
  assert.equal(attempts, 3)
})

test('does not retry HTTP 500', async () => {
  let attempts = 0
  const client = makeClient({
    fetchImpl: async () => {
      attempts += 1
      return new Response(xml(1, 'server error'), { status: 500, headers: { 'content-type': 'text/xml' } })
    },
  })
  await assert.rejects(client.finishSession(), (error) => {
    assert.equal(error.httpStatus, 500)
    assert.equal(error.retryable, false)
    return true
  })
  assert.equal(attempts, 1)
})

test('does not retry a domain status returned over HTTP 200', async () => {
  let attempts = 0
  const client = makeClient({
    fetchImpl: async () => {
      attempts += 1
      return new Response(xml(1), { status: 200, headers: { 'content-type': 'text/xml' } })
    },
  })
  await assert.rejects(client.finishSession(), EzdServiceError)
  assert.equal(attempts, 1)
})

test('reports operation, attempt, duration, and statuses without secrets', async () => {
  const events = []
  const client = makeClient({
    fetchImpl: async () => new Response(xml(0), {
      status: 200,
      headers: { 'content-type': 'text/xml' },
    }),
    onDiagnostic: async (event) => events.push(event),
  })
  client.setDiagnosticContext({ sessionId: 'local-session' })
  await client.finishSession()
  assert.equal(events.length, 1)
  assert.equal(events[0].operation, 'AddInZakonczSesje')
  assert.equal(events[0].attempt, 1)
  assert.equal(events[0].sessionId, 'local-session')
  assert.equal(events[0].httpStatus, 200)
  assert.equal(events[0].ezdStatus, 0)
  assert.equal(typeof events[0].durationMs, 'number')
  assert.equal(Object.hasOwn(events[0], 'authToken'), false)
})

test('reports each retry attempt separately', async () => {
  const events = []
  let attempts = 0
  const client = makeClient({
    fetchImpl: async () => {
      attempts += 1
      return new Response(xml(attempts < 3 ? 1 : 0), {
        status: attempts < 3 ? 503 : 200,
        headers: { 'content-type': 'text/xml' },
      })
    },
    onDiagnostic: async (event) => events.push(event),
  })
  await client.finishSession()
  assert.deepEqual(events.map((event) => event.attempt), [1, 2, 3])
  assert.deepEqual(events.map((event) => event.httpStatus), [503, 503, 200])
})
