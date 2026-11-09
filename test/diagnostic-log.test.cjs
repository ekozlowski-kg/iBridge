const assert = require('node:assert/strict')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { DiagnosticLog } = require('../electron/diagnostic-log.cjs')

async function makeTemporaryDirectory(t) {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'ezd-ibridge-log-'))
  t.after(() => fsp.rm(directory, { recursive: true, force: true }))
  return directory
}

test('redacts token-like and protocol secret fields before writing', async (t) => {
  const directory = await makeTemporaryDirectory(t)
  const log = new DiagnosticLog({ directory, maximumBytes: 4096 })
  await log.write({
    operation: 'AddInUploadFile',
    authToken: 'secret',
    protocolUrl: 'ezd://secret/path',
    requestBody: Buffer.from('document'),
    size: 12,
  })
  const content = await fsp.readFile(path.join(directory, 'ezd-ibridge.log'), 'utf8')
  const line = JSON.parse(content.trim())
  assert.equal(line.operation, 'AddInUploadFile')
  assert.equal(line.size, 12)
  assert.equal(Object.hasOwn(line, 'authToken'), false)
  assert.equal(Object.hasOwn(line, 'protocolUrl'), false)
  assert.equal(Object.hasOwn(line, 'requestBody'), false)
  assert.equal(content.includes('secret'), false)
  assert.equal(content.includes('document'), false)
})

test('uses the signature diagnostic allowlist and drops raw secret-bearing messages', async (t) => {
  const directory = await makeTemporaryDirectory(t)
  const log = new DiagnosticLog({ directory, maximumBytes: 4096 })
  await log.write({
    operation: 'signature',
    kind: 'failure',
    code: 'PIN_INVALID',
    phase: 'signing',
    durationMs: 12,
    size: 34,
    httpStatus: 500,
    ezdStatus: 1,
    message: 'raw helper synthetic-pin synthetic-auth-token',
    pin: 'synthetic-pin',
    authToken: 'synthetic-auth-token',
    stdout: 'raw stdout synthetic-pin',
    responseBody: 'synthetic-auth-token',
  })
  const content = await fsp.readFile(path.join(directory, 'ezd-ibridge.log'), 'utf8')
  const line = JSON.parse(content.trim())
  assert.deepEqual(Object.keys(line).sort(), [
    'code', 'durationMs', 'ezdStatus', 'httpStatus', 'kind', 'operation', 'phase', 'size', 'timestamp',
  ])
  assert.equal(line.code, 'PIN_INVALID')
  assert.equal(line.phase, 'signing')
  assert.equal(content.includes('synthetic-pin'), false)
  assert.equal(content.includes('synthetic-auth-token'), false)
  assert.equal(Object.hasOwn(line, 'message'), false)
})

test('rotates once when the active log would exceed the limit', async (t) => {
  const directory = await makeTemporaryDirectory(t)
  const log = new DiagnosticLog({ directory, maximumBytes: 180 })
  await log.write({ operation: 'first', message: 'x'.repeat(120) })
  await log.write({ operation: 'second', message: 'y'.repeat(120) })
  assert.match(await fsp.readFile(path.join(directory, 'ezd-ibridge.log.1'), 'utf8'), /first/)
  assert.match(await fsp.readFile(path.join(directory, 'ezd-ibridge.log'), 'utf8'), /second/)
})

test('serializes parallel writes and creates a private log file', async (t) => {
  const directory = await makeTemporaryDirectory(t)
  const log = new DiagnosticLog({ directory, maximumBytes: 8192 })
  await Promise.all(Array.from({ length: 20 }, (_, index) => log.write({ operation: `event-${index}` })))
  const activePath = path.join(directory, 'ezd-ibridge.log')
  const lines = (await fsp.readFile(activePath, 'utf8')).trim().split('\n').map(JSON.parse)
  assert.equal(lines.length, 20)
  assert.deepEqual(lines.map((line) => line.operation), Array.from({ length: 20 }, (_, index) => `event-${index}`))
  assert.equal((await fsp.stat(activePath)).mode & 0o777, 0o600)
})
