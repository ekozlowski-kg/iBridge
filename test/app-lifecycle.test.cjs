const assert = require('node:assert/strict')
const test = require('node:test')

const {
  drainBeforeQuit,
  shouldKeepRunningInBackground,
} = require('../electron/app-lifecycle.cjs')

test('drains autosync and edit sessions before signature sessions', async () => {
  const calls = []
  const autosync = { close: async () => { calls.push('close-watchers') } }
  const sessions = { releaseAll: async () => { calls.push('finish-sessions') } }
  const signatureSessions = { releaseAll: async () => { calls.push('finish-signatures') } }
  const result = await drainBeforeQuit({ sessions, signatureSessions, autosync, timeoutMs: 100 })
  assert.deepEqual(calls, ['close-watchers', 'finish-sessions', 'finish-signatures'])
  assert.equal(result.timedOut, false)
})

test('times out only edit draining and still releases signature sessions', async () => {
  const started = Date.now()
  const calls = []
  const result = await drainBeforeQuit({
    autosync: { close: async () => { calls.push('close-watchers') } },
    sessions: { releaseAll: () => new Promise(() => {}) },
    signatureSessions: { releaseAll: async () => { calls.push('finish-signatures') } },
    timeoutMs: 20,
  })
  assert.ok(Date.now() - started < 200)
  assert.equal(result.timedOut, true)
  assert.deepEqual(calls, ['close-watchers', 'finish-signatures'])
})

test('never forces a timeout over an in-flight signature upload', async () => {
  let releaseSignature
  const signatureGate = new Promise((resolve) => { releaseSignature = resolve })
  let finished = false
  const draining = drainBeforeQuit({
    autosync: { close: async () => {} },
    sessions: { releaseAll: async () => {} },
    signatureSessions: { releaseAll: () => signatureGate },
    timeoutMs: 10,
  }).then((result) => {
    finished = true
    return result
  })
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(finished, false)
  releaseSignature()
  assert.deepEqual(await draining, { timedOut: false })
})

test('keeps the process in the menu bar when the window is closed', () => {
  assert.equal(shouldKeepRunningInBackground({ isQuitting: false }), true)
  assert.equal(shouldKeepRunningInBackground({ isQuitting: true }), false)
})
