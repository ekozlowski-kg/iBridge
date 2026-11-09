const assert = require('node:assert/strict')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { EzdAutosync } = require('../electron/ezd-autosync.cjs')

async function waitFor(predicate, description, maximumMs = 1500) {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > maximumMs) throw new Error(`Przekroczono czas oczekiwania: ${description}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

function createDeterministicWatch() {
  let callback = null
  return {
    watchFactory(_directory, next) {
      callback = next
      return { close() {}, on() {} }
    },
    emit(changedName) {
      callback?.('rename', changedName)
    },
  }
}

test('syncs a replacement made before the watcher emits an event', async (t) => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'ezd-ibridge-autosync-ready-'))
  t.after(() => fsp.rm(directory, { recursive: true, force: true }))
  const workingPath = path.join(directory, 'pismo.docx')
  await fsp.writeFile(workingPath, 'v1')
  const sessionIds = []
  const autosync = new EzdAutosync({
    coordinator: { sync: async (sessionId) => sessionIds.push(sessionId) },
    debounceMs: 20,
    stabilityOptions: { sampleMs: 10, maximumMs: 500 },
    watchFactory: () => ({ close() {} }),
  })
  t.after(() => autosync.close())

  autosync.watch('session-1', workingPath)
  await fsp.writeFile(`${workingPath}.tmp`, 'v2')
  await fsp.rename(`${workingPath}.tmp`, workingPath)

  await waitFor(() => sessionIds.length === 1, 'synchronizacja przed gotowością obserwatora')
  assert.deepEqual(sessionIds, ['session-1'])
  await new Promise((resolve) => setTimeout(resolve, 80))
  assert.deepEqual(sessionIds, ['session-1'])
})

test('does not sync an unchanged file during the watcher readiness check', async (t) => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'ezd-ibridge-autosync-baseline-'))
  t.after(() => fsp.rm(directory, { recursive: true, force: true }))
  const workingPath = path.join(directory, 'pismo.docx')
  await fsp.writeFile(workingPath, 'v1')
  const sessionIds = []
  const autosync = new EzdAutosync({
    coordinator: { sync: async (sessionId) => sessionIds.push(sessionId) },
    debounceMs: 20,
    stabilityOptions: { sampleMs: 10, maximumMs: 500 },
    watchFactory: () => ({ close() {} }),
  })
  t.after(() => autosync.close())

  autosync.watch('session-1', workingPath)

  await new Promise((resolve) => setTimeout(resolve, 80))
  assert.deepEqual(sessionIds, [])
})

test('syncs each stable save, supports atomic replacement, and stops after unwatch', async (t) => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'ezd-ibridge-autosync-'))
  t.after(() => fsp.rm(directory, { recursive: true, force: true }))
  const workingPath = path.join(directory, 'pismo.docx')
  await fsp.writeFile(workingPath, 'v1')
  const contents = []
  const errors = []
  const watcher = createDeterministicWatch()
  const autosync = new EzdAutosync({
    coordinator: {
      async sync(sessionId) {
        assert.equal(sessionId, 'session-1')
        contents.push(await fsp.readFile(workingPath, 'utf8'))
      },
    },
    onError: (event) => errors.push(event),
    debounceMs: 20,
    stabilityOptions: { sampleMs: 10, maximumMs: 500 },
    watchFactory: watcher.watchFactory,
  })
  t.after(() => autosync.close())
  autosync.watch('session-1', workingPath)

  await fsp.writeFile(workingPath, 'v2')
  watcher.emit('pismo.docx')
  await waitFor(() => contents.length === 1, 'pierwsza synchronizacja')
  assert.deepEqual(contents, ['v2'])

  await fsp.writeFile(`${workingPath}.tmp`, 'v3')
  await fsp.rename(`${workingPath}.tmp`, workingPath)
  watcher.emit('pismo.docx')
  await waitFor(() => contents.length === 2, 'synchronizacja po podmianie')
  assert.deepEqual(contents, ['v2', 'v3'])
  assert.deepEqual(errors, [])

  autosync.unwatch('session-1')
  await fsp.writeFile(workingPath, 'v4')
  watcher.emit('pismo.docx')
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal(contents.length, 2)
})

test('coalesces a burst of directory events into the latest stable save', async (t) => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'ezd-ibridge-autosync-burst-'))
  t.after(() => fsp.rm(directory, { recursive: true, force: true }))
  const workingPath = path.join(directory, 'pismo.docx')
  await fsp.writeFile(workingPath, 'initial')
  const contents = []
  const watcher = createDeterministicWatch()
  const autosync = new EzdAutosync({
    coordinator: { sync: async () => contents.push(await fsp.readFile(workingPath, 'utf8')) },
    debounceMs: 30,
    stabilityOptions: { sampleMs: 10, maximumMs: 500 },
    watchFactory: watcher.watchFactory,
  })
  t.after(() => autosync.close())
  autosync.watch('session-1', workingPath)

  await fsp.writeFile(workingPath, 'one')
  watcher.emit('pismo.docx')
  await fsp.writeFile(workingPath, 'two')
  watcher.emit('pismo.docx')
  await fsp.writeFile(workingPath, 'latest')
  watcher.emit('pismo.docx')
  await waitFor(() => contents.length === 1, 'scalona synchronizacja')
  await new Promise((resolve) => setTimeout(resolve, 80))
  assert.deepEqual(contents, ['latest'])
})

test('absorbs a rejected asynchronous diagnostics callback', async () => {
  const autosync = new EzdAutosync({
    coordinator: { sync: async () => {} },
    onError: async () => { throw new Error('diagnostics unavailable') },
  })
  autosync.reportError({ sessionId: 'session-1' }, new Error('watch failed'))
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(true, true)
})
