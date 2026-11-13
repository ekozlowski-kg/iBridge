const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { NotificationPermissions, permissionState } = require('../electron/notification-permissions.cjs')

test('permission distinguishes system denial, quiet delivery and enabled banners', () => {
  assert.equal(permissionState({ authorization: 0 }), 'not-determined')
  assert.equal(permissionState({ authorization: 1 }), 'denied')
  assert.equal(permissionState({ authorization: 2, alerts: true }), 'granted')
  assert.equal(permissionState({ authorization: 2, alerts: false }), 'quiet')
  assert.equal(permissionState({ authorization: 3, alerts: true }), 'quiet')
  assert.equal(permissionState(null), 'unknown')
})

async function fixture(t, { authorization = 0, accepted = true } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ibridge-permissions-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const calls = []
  const state = { authorization, alerts: authorization === 2 }
  const options = { directory, native: {
    get: callback => callback(state),
    request: callback => { calls.push('request'); state.authorization = 2; state.alerts = true; callback(state) },
  }, prompt: async () => { calls.push('explain'); return accepted }, openSettings: async () => { calls.push('settings') } }
  return { permissions: new NotificationPermissions(options), calls, options }
}

test('fresh installation explains first, then requests native macOS authorization once', async t => {
  const f = await fixture(t)
  await f.permissions.onboard()
  assert.deepEqual(f.calls, ['explain', 'request'])
  assert.equal(f.permissions.snapshot().status, 'granted')
  await new NotificationPermissions(f.options).onboard()
  assert.deepEqual(f.calls, ['explain', 'request'])
})

test('Later does not request authorization or repeat the startup prompt after restart', async t => {
  const f = await fixture(t, { accepted: false })
  await f.permissions.onboard()
  await new NotificationPermissions(f.options).onboard()
  assert.deepEqual(f.calls, ['explain'])
  assert.equal(f.permissions.snapshot().status, 'not-determined')
})

test('a prior macOS denial opens settings after consent; it does not repeat a rejected OS prompt', async t => {
  const f = await fixture(t, { authorization: 1 })
  await f.permissions.onboard()
  assert.deepEqual(f.calls, ['explain', 'settings'])
  assert.equal(f.permissions.snapshot().status, 'denied')
})

test('already authorized installations preserve consent without another prompt', async t => {
  const f = await fixture(t, { authorization: 2 })
  await f.permissions.onboard()
  assert.deepEqual(f.calls, [])
  assert.equal(f.permissions.snapshot().status, 'granted')
})

test('missing native bridge never claims permission; explicit enable offers system settings', async t => {
  const f = await fixture(t)
  const permissions = new NotificationPermissions({ ...f.options, native: null })
  await permissions.enable()
  assert.equal(permissions.snapshot().status, 'unknown')
  assert.deepEqual(f.calls, ['settings'])
})

test('delivery confirmation reads only opaque IDs from this application notification center', async t => {
  const f = await fixture(t)
  const permissions = new NotificationPermissions({ ...f.options, native: { ...f.options.native,
    delivered: callback => callback(['synthetic-notification-id']) } })
  assert.deepEqual(await permissions.delivered(), ['synthetic-notification-id'])
  assert.equal(await new NotificationPermissions({ ...f.options, native: null }).delivered(), null)
})

test('an unanswered macOS consent banner does not block the app or trigger duplicate requests', async t => {
  const f = await fixture(t)
  let complete
  let requests = 0
  const permissions = new NotificationPermissions({ ...f.options, native: { ...f.options.native,
    request: callback => { requests++; complete = callback } } })
  await permissions.enable()
  await permissions.enable()
  assert.equal(requests, 1)
  assert.equal(permissions.snapshot().status, 'not-determined')
  complete({ authorization: 1 })
  await permissions.nativeRequest
})
