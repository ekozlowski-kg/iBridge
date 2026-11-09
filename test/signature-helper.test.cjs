const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { EventEmitter } = require('node:events')
const { Writable, PassThrough } = require('node:stream')
const test = require('node:test')

const {
  MAX_SIGNED_PDF_BYTES,
  SignatureHelper,
  readVerifiedPublishedPdf,
  validateSignSuccess,
} = require('../electron/signature-helper.cjs')

const serial = '00A1B2'

function frameParts(frame) {
  const headerLength = frame.readUInt32BE(0)
  const headerStart = 4
  const headerEnd = headerStart + headerLength
  const pinLength = frame.readUInt32BE(headerEnd)
  const pinStart = headerEnd + 4
  return {
    header: JSON.parse(frame.subarray(headerStart, headerEnd).toString('utf8')),
    pin: frame.subarray(pinStart, pinStart + pinLength),
    trailing: frame.subarray(pinStart + pinLength),
  }
}

function fakeSpawnFactory(onFrame) {
  const calls = []
  const spawnImpl = (executable, args, options) => {
    const child = new EventEmitter()
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.kills = []
    child.closed = false
    const chunks = []
    const references = []
    child.stdin = new Writable({
      write(chunk, _encoding, callback) {
        references.push(chunk)
        chunks.push(Buffer.from(chunk))
        callback()
      },
    })
    child.kill = (signal) => {
      child.kills.push(signal)
      if (!child.closed) {
        child.closed = true
        queueMicrotask(() => child.emit('close', null, signal))
      }
      return true
    }
    calls.push({ executable, args, options, child, chunks, references })
    child.stdin.once('finish', async () => {
      if (child.closed) return
      try {
        const outcome = await onFrame(Buffer.concat(chunks), calls.at(-1))
        if (outcome.stderr) child.stderr.end(outcome.stderr)
        else child.stderr.end()
        if (outcome.stdout) child.stdout.end(outcome.stdout)
        else child.stdout.end()
        child.closed = true
        queueMicrotask(() => child.emit('close', outcome.code ?? 0, outcome.signal ?? null))
      } catch (error) {
        child.emit('error', error)
        if (!child.closed) {
          child.closed = true
          queueMicrotask(() => child.emit('close', null, null))
        }
      }
    })
    return child
  }
  return { spawnImpl, calls }
}

function makeHelper(spawnImpl, options = {}) {
  return new SignatureHelper({
    spawnImpl,
    javaPath: '/Applications/EZD - iBridge.app/Contents/Resources/app/signer/runtime/bin/java',
    jarPath: '/Applications/EZD - iBridge.app/Contents/Resources/app/signer/ibridge-signer.jar',
    libraryWildcard: '/Applications/EZD - iBridge.app/Contents/Resources/app/signer/lib/*',
    statusTimeoutMs: 100,
    signTimeoutMs: 100,
    environment: {
      HOME: '/Users/tester',
      TMPDIR: '/private/tmp/tester/',
      PATH: '/attacker/bin',
      DYLD_INSERT_LIBRARIES: '/tmp/evil.dylib',
      JAVA_TOOL_OPTIONS: '-javaagent:/tmp/evil.jar',
      _JAVA_OPTIONS: '-XshowSettings',
      JDK_JAVA_OPTIONS: '-XX:StartFlightRecording',
      CLASSPATH: '/tmp/evil.jar',
      EZD_AUTH_TOKEN: 'auth-secret',
      PIN: 'pin-secret',
      LANG: 'pl_PL.UTF-8',
    },
    ...options,
  })
}

function signRequest(inputPath, outputPath, patch = {}) {
  return {
    inputPath,
    outputPath,
    certificateSerial: serial,
    signingTime: '2026-08-31T08:11:12.000Z',
    includeTimestamp: false,
    visible: false,
    signatureRoleXml: '<Role>Director</Role>',
    ...patch,
  }
}

async function makePdfFixture(t, bytes = Buffer.from('%PDF-1.7\nverified bytes')) {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'ibridge-node-helper-'))
  t.after(() => fsp.rm(directory, { recursive: true, force: true }))
  await fsp.chmod(directory, 0o700)
  const inputPath = path.join(directory, 'input.pdf')
  const outputPath = path.join(directory, 'output.pdf')
  await fsp.writeFile(inputPath, '%PDF-1.7\ninput', { mode: 0o600 })
  return { directory, inputPath, outputPath, bytes }
}

async function helperResultFor(outputPath, bytes, patch = {}) {
  const info = await fsp.stat(outputPath, { bigint: true })
  return {
    ok: true,
    outputPath,
    outputSha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    outputBytes: bytes.length,
    outputDevice: info.dev.toString(),
    outputInode: info.ino.toString(),
    certificateSerial: serial,
    subject: 'Jan Kowalski',
    profile: 'PAdES-B-B',
    warnings: ['REVOCATION_NOT_CHECKED'],
    ...patch,
  }
}

test('writes exact BE frames and keeps PIN out of JSON, argv, environment, and errors', async (t) => {
  const fixture = await makePdfFixture(t)
  const fake = fakeSpawnFactory(async (frame) => {
    const parsed = frameParts(frame)
    if (parsed.header.command === 'status') {
      assert.equal(parsed.pin.length, 0)
      return { stdout: '{"ok":true,"pkcs11Exists":true,"pkcs11Path":"/usr/local/lib/libSimplySignPKCS.dylib","tokenReady":true}\n' }
    }
    await fsp.writeFile(fixture.outputPath, fixture.bytes, { mode: 0o600, flag: 'wx' })
    const result = await helperResultFor(fixture.outputPath, fixture.bytes)
    return { stdout: `${JSON.stringify(result)}\n` }
  })
  const helper = makeHelper(fake.spawnImpl)
  assert.equal((await helper.status()).tokenReady, true)

  const secret = 'synthetic-pin-123'
  const signed = await helper.signPades(signRequest(fixture.inputPath, fixture.outputPath), secret)
  assert.deepEqual(signed.signedBytes, fixture.bytes)
  assert.equal(fake.calls.length, 2)

  const call = fake.calls[1]
  const transmitted = frameParts(Buffer.concat(call.chunks))
  assert.deepEqual(transmitted.header, {
    command: 'sign-pades',
    inputPath: fixture.inputPath,
    outputPath: fixture.outputPath,
    certificateSerial: serial,
    signingTime: '2026-08-31T08:11:12.000Z',
    includeTimestamp: false,
    visible: false,
    signatureRoleXml: '<Role>Director</Role>',
  })
  assert.equal(transmitted.pin.toString('utf8'), secret)
  assert.equal(transmitted.trailing.length, 0)
  assert.equal(JSON.stringify(transmitted.header).includes(secret), false)
  assert.equal(`${call.executable}\0${call.args.join('\0')}`.includes(secret), false)
  assert.equal(JSON.stringify(call.options.env).includes(secret), false)
  assert.deepEqual(call.options.stdio, ['pipe', 'pipe', 'pipe'])
  assert.equal(call.options.shell, false)
  assert.equal(call.options.detached, false)
  for (const forbidden of [
    'DYLD_INSERT_LIBRARIES', 'JAVA_TOOL_OPTIONS', '_JAVA_OPTIONS',
    'JDK_JAVA_OPTIONS', 'CLASSPATH', 'EZD_AUTH_TOKEN', 'PIN',
  ]) assert.equal(Object.hasOwn(call.options.env, forbidden), false)
  assert.equal(call.options.env.PATH, '/usr/bin:/bin:/usr/sbin:/sbin')
  assert.equal(call.references.at(-1).every((byte) => byte === 0), true)
})

test('zeros its PIN Buffer immediately after stdin accepts it, before helper completion', async (t) => {
  const fixture = await makePdfFixture(t)
  let observedZeroBeforeResult = false
  const fake = fakeSpawnFactory(async (_frame, call) => {
    observedZeroBeforeResult = call.references.at(-1).every((byte) => byte === 0)
    await fsp.writeFile(fixture.outputPath, fixture.bytes, { mode: 0o600, flag: 'wx' })
    return { stdout: `${JSON.stringify(await helperResultFor(fixture.outputPath, fixture.bytes))}\n` }
  })
  const helper = makeHelper(fake.spawnImpl)
  await helper.signPades(signRequest(fixture.inputPath, fixture.outputPath), 'short-lived-pin')
  assert.equal(observedZeroBeforeResult, true)
})

test('rejects unknown signing fields before spawning the helper', async (t) => {
  const fixture = await makePdfFixture(t)
  const fake = fakeSpawnFactory(async () => assert.fail('must not spawn'))
  const helper = makeHelper(fake.spawnImpl)
  await assert.rejects(
    helper.signPades({ ...signRequest(fixture.inputPath, fixture.outputPath), authToken: 'secret' }, '1234'),
    (error) => error.code === 'REQUEST_INVALID',
  )
  assert.equal(fake.calls.length, 0)
})

test('rejects empty/oversized PIN and a JSON header over 64 KiB by UTF-8 byte length', async (t) => {
  const fixture = await makePdfFixture(t)
  const fake = fakeSpawnFactory(async () => assert.fail('must not spawn'))
  const helper = makeHelper(fake.spawnImpl)
  for (const [request, pin] of [
    [signRequest(fixture.inputPath, fixture.outputPath), ''],
    [signRequest(fixture.inputPath, fixture.outputPath), '1'.repeat(1025)],
    [signRequest(fixture.inputPath, fixture.outputPath, { signatureRoleXml: 'ą'.repeat(33_000) }), '1234'],
  ]) {
    await assert.rejects(
      helper.signPades(request, pin),
      (error) => error.code === 'REQUEST_INVALID',
    )
  }
  assert.equal(fake.calls.length, 0)
})

test('accepts fragmented one-line stdout and maps declared helper failures without raw messages', async () => {
  const fake = fakeSpawnFactory(async (_frame, call) => {
    call.child.stdout.write('{"ok":false,"pkcs11Exists":true,')
    call.child.stdout.write('"pkcs11Path":"/usr/local/lib/libSimplySignPKCS.dylib",')
    return {
      stdout: '"tokenReady":false,"code":"TOKEN_NOT_READY","message":"echo synthetic-pin auth-secret"}\n',
      stderr: '{"event":"signature_helper_failure","code":"TOKEN_NOT_READY","secret":"synthetic-pin"}\n',
      code: 2,
    }
  })
  const helper = makeHelper(fake.spawnImpl)
  await assert.rejects(helper.status(), (error) => {
    assert.equal(error.code, 'TOKEN_NOT_READY')
    assert.doesNotMatch(error.message, /synthetic-pin|auth-secret|echo/)
    return true
  })
})

for (const [name, outcome] of [
  ['stdout over 8 KiB', { stdout: `${'x'.repeat(8192)}\n`, code: 2 }],
  ['more than one stdout line', { stdout: '{}\n{}\n', code: 0 }],
  ['stdout without LF', { stdout: '{"ok":true}', code: 0 }],
  ['invalid UTF-8 stdout', { stdout: Buffer.from([0xc3, 0x28, 0x0a]), code: 0 }],
  ['invalid JSON stdout', { stdout: '{broken}\n', code: 0 }],
  ['stderr over its limit', { stdout: '{"ok":true,"pkcs11Exists":true,"pkcs11Path":"/usr/local/lib/libSimplySignPKCS.dylib","tokenReady":true}\n', stderr: 'x'.repeat(4097), code: 0 }],
  ['success body with exit 2', { stdout: '{"ok":true,"pkcs11Exists":true,"pkcs11Path":"/usr/local/lib/libSimplySignPKCS.dylib","tokenReady":true}\n', code: 2 }],
  ['failure body with exit 0', { stdout: '{"ok":false,"pkcs11Exists":false,"pkcs11Path":"/usr/local/lib/libSimplySignPKCS.dylib","tokenReady":false,"code":"PKCS11_MISSING","message":"missing"}\n', code: 0 }],
]) {
  test(`fails closed for ${name} and never exposes raw child output`, async () => {
    const fake = fakeSpawnFactory(async () => outcome)
    const helper = makeHelper(fake.spawnImpl)
    await assert.rejects(helper.status(), (error) => {
      assert.match(error.code, /^(?:HELPER_PROTOCOL|HELPER_OUTPUT_LIMIT)$/)
      assert.doesNotMatch(error.message, /broken|synthetic|x{20}/)
      return true
    })
  })
}

test('timeout and AbortSignal kill with SIGKILL and reject only after child close', async () => {
  const makeHangingSpawn = () => {
    const calls = []
    return {
      calls,
      spawnImpl: (_executable, _args, _options) => {
        const child = new EventEmitter()
        child.stdout = new PassThrough()
        child.stderr = new PassThrough()
        child.stdin = new Writable({ write(_chunk, _encoding, callback) { callback() } })
        child.kills = []
        child.kill = (signal) => {
          child.kills.push(signal)
          setTimeout(() => child.emit('close', null, signal), 8)
          return true
        }
        calls.push(child)
        return child
      },
    }
  }

  const timeoutFake = makeHangingSpawn()
  const timed = makeHelper(timeoutFake.spawnImpl, { statusTimeoutMs: 5 })
  await assert.rejects(timed.status(), (error) => error.code === 'TIMEOUT')
  assert.deepEqual(timeoutFake.calls[0].kills, ['SIGKILL'])

  const abortFake = makeHangingSpawn()
  const controller = new AbortController()
  const aborted = makeHelper(abortFake.spawnImpl, { statusTimeoutMs: 1000 })
  const pending = aborted.status({ signal: controller.signal })
  controller.abort()
  await assert.rejects(pending, (error) => error.code === 'CANCELLED')
  assert.deepEqual(abortFake.calls[0].kills, ['SIGKILL'])
})

test('a spawn error is reported safely only after the child close event', async () => {
  let closed = false
  const child = new EventEmitter()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.stdin = new Writable({ write(_chunk, _encoding, callback) { callback() } })
  child.kill = () => true
  const helper = makeHelper(() => {
    queueMicrotask(() => {
      child.emit('error', new Error('spawn leaked-secret'))
      setTimeout(() => {
        closed = true
        child.emit('close', null, null)
      }, 8)
    })
    return child
  })
  await assert.rejects(helper.status(), (error) => {
    assert.equal(closed, true)
    assert.equal(error.code, 'HELPER_UNAVAILABLE')
    assert.doesNotMatch(error.message, /leaked-secret/)
    return true
  })
})

test('handles a child stdin error safely and reaps the process', async () => {
  let closed = false
  const child = new EventEmitter()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.stdin = new Writable({
    write(_chunk, _encoding, callback) {
      callback(new Error('stdin leaked-secret'))
    },
  })
  child.kill = (signal) => {
    assert.equal(signal, 'SIGKILL')
    if (!closed) {
      setTimeout(() => {
        closed = true
        child.emit('close', null, signal)
      }, 8)
    }
    return true
  }
  const helper = makeHelper(() => child)

  await assert.rejects(helper.status(), (error) => {
    assert.equal(closed, true)
    assert.equal(error.code, 'HELPER_UNAVAILABLE')
    assert.doesNotMatch(error.message, /leaked-secret/)
    return true
  })
})

test('strictly validates signing success identity, path, serial, profile, and exact keys', () => {
  const expectedPath = '/private/tmp/session/output.pdf'
  const valid = {
    ok: true,
    outputPath: expectedPath,
    outputSha256: 'a'.repeat(64),
    outputBytes: 42,
    outputDevice: '16777234',
    outputInode: '1152921504606846976',
    certificateSerial: serial,
    subject: 'Jan Kowalski',
    profile: 'PAdES-B-B',
    warnings: ['REVOCATION_NOT_CHECKED'],
  }
  assert.deepEqual(validateSignSuccess(valid, {
    expectedPath,
    expectedSerial: serial,
    includeTimestamp: false,
  }), valid)

  for (const [name, patch] of [
    ['unknown key', { unexpected: true }],
    ['different path', { outputPath: '/private/tmp/session/other.pdf' }],
    ['non-normal path', { outputPath: '/private/tmp/session/../session/output.pdf' }],
    ['wrong hash case', { outputSha256: 'A'.repeat(64) }],
    ['zero bytes', { outputBytes: 0 }],
    ['oversized bytes', { outputBytes: MAX_SIGNED_PDF_BYTES + 1 }],
    ['unsafe integer bytes', { outputBytes: Number.MAX_SAFE_INTEGER + 1 }],
    ['numeric device', { outputDevice: 12 }],
    ['non-canonical device', { outputDevice: '01' }],
    ['uint64 overflow', { outputDevice: '18446744073709551616' }],
    ['zero inode', { outputInode: '0' }],
    ['wrong serial', { certificateSerial: '00A1B3' }],
    ['wrong profile', { profile: 'PAdES-B-T' }],
    ['unsafe warning', { warnings: ['RAW_PROVIDER_MESSAGE'] }],
    ['overlong subject', { subject: 'x'.repeat(513) }],
  ]) {
    assert.throws(() => validateSignSuccess({ ...valid, ...patch }, {
      expectedPath,
      expectedSerial: serial,
      includeTimestamp: false,
    }), { code: 'HELPER_PROTOCOL' }, name)
  }
})

test('opens the published path exactly once with O_NOFOLLOW and returns its verified bytes', async (t) => {
  const fixture = await makePdfFixture(t)
  await fsp.writeFile(fixture.outputPath, fixture.bytes, { mode: 0o600, flag: 'wx' })
  const result = await helperResultFor(fixture.outputPath, fixture.bytes)
  let opens = 0
  let flags = 0
  const bytes = await readVerifiedPublishedPdf(fixture.outputPath, result, {
    fsImpl: {
      open: async (target, openFlags) => {
        opens += 1
        flags = openFlags
        return fsp.open(target, openFlags)
      },
    },
  })
  assert.deepEqual(bytes, fixture.bytes)
  assert.equal(opens, 1)
  assert.equal((flags & fs.constants.O_RDONLY), fs.constants.O_RDONLY)
  assert.equal((flags & fs.constants.O_NOFOLLOW), fs.constants.O_NOFOLLOW)
})

test('rejects a path swap before open by matching helper device and inode', async (t) => {
  const fixture = await makePdfFixture(t)
  await fsp.writeFile(fixture.outputPath, fixture.bytes, { mode: 0o600, flag: 'wx' })
  const result = await helperResultFor(fixture.outputPath, fixture.bytes)
  await fsp.rename(fixture.outputPath, path.join(fixture.directory, 'parked.pdf'))
  await fsp.writeFile(fixture.outputPath, fixture.bytes, { mode: 0o600, flag: 'wx' })
  await assert.rejects(
    readVerifiedPublishedPdf(fixture.outputPath, result),
    (error) => error.code === 'OUTPUT_IDENTITY_MISMATCH',
  )
})

test('a path swap after open still returns bytes from the retained descriptor', async (t) => {
  const fixture = await makePdfFixture(t)
  const foreign = Buffer.from('%PDF-1.7\nforeign bytes!')
  assert.equal(foreign.length, fixture.bytes.length)
  await fsp.writeFile(fixture.outputPath, fixture.bytes, { mode: 0o600, flag: 'wx' })
  const result = await helperResultFor(fixture.outputPath, fixture.bytes)
  const retained = path.join(fixture.directory, 'retained.pdf')
  let opens = 0
  const bytes = await readVerifiedPublishedPdf(fixture.outputPath, result, {
    fsImpl: {
      open: async (target, flags) => {
        opens += 1
        const handle = await fsp.open(target, flags)
        await fsp.rename(target, retained)
        await fsp.writeFile(target, foreign, { mode: 0o600, flag: 'wx' })
        return handle
      },
    },
  })
  assert.equal(opens, 1)
  assert.deepEqual(bytes, fixture.bytes)
  assert.deepEqual(await fsp.readFile(fixture.outputPath), foreign)
})

test('detects same-inode same-size mutation by hashing the exact retained descriptor', async (t) => {
  const fixture = await makePdfFixture(t)
  const foreign = Buffer.from('%PDF-1.7\nforeign bytes!')
  assert.equal(foreign.length, fixture.bytes.length)
  await fsp.writeFile(fixture.outputPath, fixture.bytes, { mode: 0o600, flag: 'wx' })
  const result = await helperResultFor(fixture.outputPath, fixture.bytes)
  await fsp.writeFile(fixture.outputPath, foreign)
  const after = await fsp.stat(fixture.outputPath, { bigint: true })
  assert.equal(after.ino.toString(), result.outputInode)
  assert.equal(after.size, BigInt(result.outputBytes))
  await assert.rejects(
    readVerifiedPublishedPdf(fixture.outputPath, result),
    (error) => error.code === 'OUTPUT_HASH_MISMATCH',
  )
})

test('rejects symlink, wrong mode, directory, oversized metadata, and trailing data', async (t) => {
  const fixture = await makePdfFixture(t)
  const real = path.join(fixture.directory, 'real.pdf')
  await fsp.writeFile(real, fixture.bytes, { mode: 0o600 })
  await fsp.symlink(real, fixture.outputPath)
  const symlinkResult = await helperResultFor(real, fixture.bytes, { outputPath: fixture.outputPath })
  await assert.rejects(readVerifiedPublishedPdf(fixture.outputPath, symlinkResult))

  await fsp.rm(fixture.outputPath)
  await fsp.writeFile(fixture.outputPath, fixture.bytes, { mode: 0o644 })
  const wrongMode = await helperResultFor(fixture.outputPath, fixture.bytes)
  await assert.rejects(readVerifiedPublishedPdf(fixture.outputPath, wrongMode), (error) => error.code === 'OUTPUT_IDENTITY_MISMATCH')

  assert.throws(() => validateSignSuccess({
    ...wrongMode,
    outputBytes: MAX_SIGNED_PDF_BYTES + 1,
  }, {
    expectedPath: fixture.outputPath,
    expectedSerial: serial,
    includeTimestamp: false,
  }), { code: 'HELPER_PROTOCOL' })

  await fsp.chmod(fixture.outputPath, 0o600)
  const original = await helperResultFor(fixture.outputPath, fixture.bytes)
  await fsp.appendFile(fixture.outputPath, Buffer.from('x'))
  await assert.rejects(readVerifiedPublishedPdf(fixture.outputPath, original), (error) => (
    ['OUTPUT_IDENTITY_MISMATCH', 'OUTPUT_TRAILING_DATA'].includes(error.code)
  ))

  const directoryResult = { ...original, outputPath: fixture.directory }
  await assert.rejects(readVerifiedPublishedPdf(fixture.directory, directoryResult))
})

test('rejects wrong owner/type, short read, trailing byte, mutation during read, and always closes', async () => {
  const pdf = Buffer.from('%PDF-1.7\n1234567890')
  const digest = crypto.createHash('sha256').update(pdf).digest('hex')
  const baseResult = {
    outputBytes: pdf.length,
    outputDevice: '12',
    outputInode: '34',
    outputSha256: digest,
  }
  const makeStats = (patch = {}) => ({
    isFile: () => true,
    uid: BigInt(typeof process.geteuid === 'function' ? process.geteuid() : 0),
    mode: 0o100600n,
    dev: 12n,
    ino: 34n,
    size: BigInt(pdf.length),
    ...patch,
  })

  const cases = [
    ['wrong owner', { stats: makeStats({ uid: 999999n }) }],
    ['wrong type', { stats: makeStats({ isFile: () => false }) }],
    ['short read', { short: true }],
    ['trailing byte', { trailing: true }],
    ['mutation during read', { secondStats: makeStats({ ino: 35n }) }],
  ]
  for (const [name, behavior] of cases) {
    let closed = 0
    let statsCalls = 0
    let reads = 0
    const handle = {
      stat: async () => {
        statsCalls += 1
        return statsCalls === 1
          ? (behavior.stats || makeStats())
          : (behavior.secondStats || behavior.stats || makeStats())
      },
      read: async (buffer, offset, length, position) => {
        reads += 1
        if (position === pdf.length) {
          if (behavior.trailing) {
            buffer[offset] = 0x78
            return { bytesRead: 1, buffer }
          }
          return { bytesRead: 0, buffer }
        }
        if (behavior.short && reads > 1) return { bytesRead: 0, buffer }
        const maximum = behavior.short ? Math.min(length, 2) : length
        const source = pdf.subarray(position, position + maximum)
        source.copy(buffer, offset)
        return { bytesRead: source.length, buffer }
      },
      close: async () => { closed += 1 },
    }
    await assert.rejects(
      readVerifiedPublishedPdf('/private/tmp/session/output.pdf', baseResult, {
        fsImpl: { open: async () => handle },
      }),
      undefined,
      name,
    )
    assert.equal(closed, 1, `${name} must close exactly once`)
  }
})

test('abort during chunked read returns no Buffer and closes the retained handle', async () => {
  const pdf = Buffer.alloc(96 * 1024, 0x31)
  pdf.write('%PDF-', 0, 'ascii')
  const result = {
    outputBytes: pdf.length,
    outputDevice: '12',
    outputInode: '34',
    outputSha256: crypto.createHash('sha256').update(pdf).digest('hex'),
  }
  const stats = {
    isFile: () => true,
    uid: BigInt(typeof process.geteuid === 'function' ? process.geteuid() : 0),
    mode: 0o100600n,
    dev: 12n,
    ino: 34n,
    size: BigInt(pdf.length),
  }
  const controller = new AbortController()
  let closed = 0
  let reads = 0
  const handle = {
    stat: async () => stats,
    read: async (buffer, offset, length, position) => {
      const bytes = pdf.subarray(position, position + Math.min(length, 4096))
      bytes.copy(buffer, offset)
      reads += 1
      if (reads === 2) controller.abort()
      return { bytesRead: bytes.length, buffer }
    },
    close: async () => { closed += 1 },
  }
  await assert.rejects(
    readVerifiedPublishedPdf('/private/tmp/session/output.pdf', result, {
      fsImpl: { open: async () => handle },
      signal: controller.signal,
      chunkBytes: 4096,
    }),
    (error) => error.code === 'CANCELLED',
  )
  assert.equal(closed, 1)
})
