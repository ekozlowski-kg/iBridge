const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { EzdInboxClient, parseContext, normalizeItem, normalizeEvents, parseNewLetters, InboxError, EZD_ORIGIN } = require('../electron/ezd-inbox-client.cjs')
const { EzdInboxMonitor } = require('../electron/ezd-inbox-monitor.cjs')
const { trustedUrl } = require('../electron/ezd-inbox-window.cjs')

const html = (effective = '20') => `<html><span id="lblUzytkownik" title="10">Użytkownik Test</span><a id="lblUzytkownikZastepstwo" title="${effective}">Konto Test</a><span id="lblDzial" title="30">Dział</span><span id="lblStanowisko">Specjalista</span></html>`
const context = { key: 'test-account', label: 'Konto testowe' }
const item = (id, dd = '13.11.2026') => normalizeItem({ id, nz: `Pismo ${id}`, dd })
const response = (value, type = 'application/json') => new Response(type.includes('json') ? JSON.stringify(value) : value, { headers: { 'content-type': type } })

test('separates operator, effective account and unit; rejects login HTML', () => {
  assert.notEqual(parseContext(html('20')).key, parseContext(html('21')).key)
  assert.match(parseContext(html()).label, /w zastępstwie/)
  assert.throws(() => parseContext('<html>Logowanie</html>'), { code: 'login-required' })
})

test('native account window permits only the exact HTTPS origin', () => {
  assert.equal(trustedUrl(`${EZD_ORIGIN}/FolderPism.aspx?Status=1`), true)
  for (const url of ['http://ezd.kg.straz.gov.pl/', 'https://ezd.kg.straz.gov.pl.evil.test/', 'https://user@ezd.kg.straz.gov.pl/', 'file:///tmp/x', 'ezd://secret/']) assert.equal(trustedUrl(url), false)
})

test('fetches all groups, without opening or acknowledging any pismo', async () => {
  const calls = []
  const client = new EzdInboxClient({ fetchImpl: async (url, options) => {
    calls.push({ url, options })
    if (url.includes('FolderPism')) return response(html(), 'text/html')
    if (url.endsWith('/grupyfolderu')) return response([{ Rok: 2026, Miesiac: 11, Dzien: 0, Ilosc: 1 }, { Rok: 2026, Miesiac: 10, Dzien: 0, Ilosc: 1 }])
    if (url.endsWith('/pooluser')) return response([])
    return response([{ id: calls.length, nz: 'Pismo testowe', dd: '13.11.2026' }])
  } })
  const snapshot = await client.supplement(AbortSignal.timeout(1000), parseContext(html()).key)
  assert.equal(snapshot.items.length, 2)
  assert.equal(calls.length, 6)
  assert.equal(calls.every(c => c.options.credentials === 'include'), true)
  assert.equal(calls.some(c => c.url.includes('Pismo3')), false)
  assert.deepEqual(JSON.parse(calls[1].options.body), { IdStatus: '1' })
  assert.deepEqual(JSON.parse(calls[2].options.body), { Id: '2026_11_0', Status: '1' })
})

test('does not use a partial group as a complete snapshot', async () => {
  const client = new EzdInboxClient({ fetchImpl: async url => {
    if (url.includes('FolderPism')) return response(html(), 'text/html')
    if (url.endsWith('/grupyfolderu')) return response([{ Rok: 2026, Miesiac: 11, Dzien: 0, Ilosc: 2 }])
    return response([{ id: 1, nz: 'Jedna z dwóch' }])
  } })
  await assert.rejects(client.supplement(AbortSignal.timeout(1000), parseContext(html()).key), { code: 'incomplete' })
})

test('detects account changes during the same read', async () => {
  let n = 0
  const client = new EzdInboxClient({ fetchImpl: async url => url.includes('FolderPism') ? response(html(++n === 1 ? '20' : '21'), 'text/html') : response({ value: '' }) })
  await assert.rejects(client.snapshot(AbortSignal.timeout(1000)), { code: 'account-changed' })
})

test('redirects and HTML responses to JSON endpoints require login', async () => {
  const client = new EzdInboxClient({ fetchImpl: async () => new Response('', { status: 302, headers: { location: '/login' } }) })
  await assert.rejects(client.snapshot(AbortSignal.timeout(1000)), { code: 'login-required' })
})

async function fixture(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ibridge-inbox-test-'))
  let current = { context, items: [item(1)] }
  let failure = null
  const notices = []
  const monitor = new EzdInboxMonitor({ client: { snapshot: async () => { if (failure) throw failure; return current } }, directory,
    notify: async n => notices.push(n), ...options })
  t.after(async () => { await monitor.close(); await fs.rm(directory, { recursive: true, force: true }) })
  // Existing explicit opt-out lets each scenario control when polling begins.
  await fs.writeFile(monitor.file, JSON.stringify({ ...monitor.data, enabled: false }))
  await monitor.init()
  return { monitor, directory, notices, set: value => { current = value }, fail: value => { failure = value } }
}

test('fresh installation monitors automatically; an explicit opt-out survives restart', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ibridge-default-inbox-'))
  const notices = []
  let reads = 0
  const options = { directory, client: { snapshot: async () => { reads++; return { context, primaryItems: [{ id: '123' }] } } },
    notify: async n => notices.push(n) }
  const monitor = new EzdInboxMonitor(options)
  t.after(async () => { await monitor.close(); await fs.rm(directory, { recursive: true, force: true }) })
  await monitor.init(); await monitor.running
  assert.equal(monitor.snapshot().enabled, true)
  assert.equal(reads, 1)
  assert.deepEqual(notices, [{ count: 1 }])
  await monitor.setEnabled(false)
  await monitor.close()
  const restarted = new EzdInboxMonitor(options)
  t.after(() => restarted.close())
  await restarted.init()
  assert.equal(restarted.snapshot().enabled, false)
  assert.equal(reads, 1)
})

test('first baseline is silent; a different ID alerts even at the same count', async t => {
  const f = await fixture(t)
  await f.monitor.setEnabled(true)
  assert.equal(f.notices.length, 0)
  f.set({ context, items: [item(2)] })
  await f.monitor.check()
  await f.monitor.check()
  assert.deepEqual(f.notices, [{ count: 1 }])
})

test('a returned assignment or new transfer date can alert again', async t => {
  const f = await fixture(t)
  await f.monitor.setEnabled(true)
  f.set({ context, items: [] }); await f.monitor.check()
  f.set({ context, items: [item(1)] }); await f.monitor.check()
  f.set({ context, items: [item(1, '14.11.2026')] }); await f.monitor.check()
  assert.equal(f.notices.length, 2)
})

test('failed reads retain baseline, and recovery reports new items', async t => {
  const f = await fixture(t)
  await f.monitor.setEnabled(true)
  f.fail(new InboxError('login-required')); await f.monitor.check()
  assert.equal(f.monitor.snapshot().status, 'login-required')
  assert.equal(f.monitor.snapshot().count, 1)
  f.fail(null); f.set({ context, items: [item(1), item(2)] }); await f.monitor.check()
  assert.deepEqual(f.notices, [{ count: 1 }])
})

test('new account requires explicit rebind, which creates a silent baseline', async t => {
  const f = await fixture(t)
  await f.monitor.setEnabled(true)
  f.set({ context: { key: 'other', label: 'Inne konto' }, items: [item(3)] })
  await f.monitor.check()
  assert.equal(f.monitor.snapshot().status, 'account-changed')
  assert.equal(f.monitor.snapshot().account, context.label)
  await f.monitor.rebind()
  assert.equal(f.monitor.snapshot().account, 'Inne konto')
  assert.equal(f.notices.length, 0)
})

test('deduplication survives application restart', async t => {
  const f = await fixture(t)
  await f.monitor.setEnabled(true)
  f.set({ context, items: [item(1), item(2)] }); await f.monitor.check()
  await f.monitor.close()
  const restarted = new EzdInboxMonitor({ client: { snapshot: async () => ({ context, items: [item(1), item(2)] }) }, directory: f.directory, notify: async n => f.notices.push(n) })
  t.after(() => restarted.close())
  await restarted.init(); await restarted.running
  assert.deepEqual(f.notices, [{ count: 1 }])
})

test('notification delivery failure is retained for retry', async t => {
  let reject = true
  const notices = []
  const f = await fixture(t, { notify: async n => { if (reject) throw new Error('unavailable'); notices.push(n) } })
  await f.monitor.setEnabled(true)
  f.set({ context, items: [item(1), item(2)] }); await f.monitor.check()
  assert.equal(f.monitor.data.pending, 1)
  reject = false
  await f.monitor.check()
  assert.deepEqual(notices, [{ count: 1 }])
  assert.equal(f.monitor.data.pending, 0)
})

test('timer polls automatically without a renderer or browser', async t => {
  const f = await fixture(t, { intervalMs: 20 })
  await f.monitor.setEnabled(true)
  f.set({ context, items: [item(1), item(2)] })
  await new Promise(resolve => setTimeout(resolve, 90))
  assert.deepEqual(f.notices, [{ count: 1 }])
  await f.monitor.setEnabled(false)
  f.set({ context, items: [item(3)] })
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal(f.notices.length, 1)
})

test('stopping an in-flight read does not update baseline or emit an alert', async t => {
  let release
  const gate = new Promise(resolve => { release = resolve })
  const f = await fixture(t, { client: { snapshot: () => gate } })
  const starting = f.monitor.setEnabled(true)
  while (!f.monitor.running) await new Promise(resolve => setTimeout(resolve, 1))
  const stopping = f.monitor.setEnabled(false)
  release({ context, items: [item(1)] })
  await Promise.all([starting, stopping])
  assert.equal(f.monitor.snapshot().enabled, false)
  assert.equal(f.monitor.data.keys, null)
  assert.equal(f.notices.length, 0)
})

test('event feed preserves IDs and times without dismissing events', () => {
  const raw = [{ Powiadomienia: [{ Id: 1, IdKoszulki: 4, DataZdarzeniaShort: '13.11.2026 08:00', IdZdarzenia: 63, Zdarzenie: 'Nowa wersja', Uzytkownik: 'Test', NazwaKoszulki: 'Test' }] }]
  assert.equal(normalizeEvents(raw)[0].code, 63)
  assert.equal(normalizeEvents(raw)[0].pismoId, '4')
  assert.deepEqual(normalizeEvents(null), [])
  assert.throws(() => normalizeEvents({ error: true }), { code: 'schema' })
})

test('existing event feed is silent, new events alert once and overlap with new inbox is deduplicated', async t => {
  const f = await fixture(t)
  f.set({ context, items: [item(1)], events: [{ key: 'old', pismoId: '1' }] })
  await f.monitor.setEnabled(true)
  f.set({ context, items: [item(1), item(2)], events: [{ key: 'old', pismoId: '1' }, { key: 'new', pismoId: '2', description: 'Przekazanie koszulki' }, { key: 'version', pismoId: '1' }] })
  await f.monitor.check(); await f.monitor.check()
  assert.deepEqual(f.notices, [{ count: 1, eventCount: 1 }])
})

const popup = '<table><tr><td>Nazwa pisma:</td><td>Nadawca:</td></tr><tr><td title="Od: Test"><a href="Pismo3.aspx?idpisma=123">Pismo &amp; test</a></td><td>Test</td></tr></table>'

test('reads the actual AjaxPro method as the primary signal, using its verified transport contract', async () => {
  const calls = []
  const client = new EzdInboxClient({ fetchImpl: async (url, options) => {
    calls.push({ url, options })
    if (url.includes('FolderPism')) return response(html(), 'text/html')
    return new Response(JSON.stringify({ value: popup }), { headers: { 'content-type': 'text/plain; charset=utf-8' } })
  } })
  const snapshot = await client.snapshot(AbortSignal.timeout(1000))
  assert.deepEqual(snapshot.primaryItems, [{ id: '123', title: 'Pismo & test' }])
  assert.equal(calls.length, 3)
  assert.equal(calls[1].url, `${EZD_ORIGIN}/ajaxpro/ezd.Web.Outlook,ezd.Web.ashx`)
  assert.equal(calls[1].options.headers['X-AjaxPro-Method'], 'SprawdzNowePisma')
  assert.equal(calls[1].options.headers['Content-Type'], 'text/plain; charset=utf-8')
  assert.equal(calls[1].options.body, '{}')
  assert.equal(calls.some(c => c.url.includes('/api/')), false)
})

test('dialog HTML remains inert; IDs are deduplicated and foreign links or malformed replies are rejected', () => {
  assert.deepEqual(parseNewLetters({ value: '' }), [])
  assert.deepEqual(parseNewLetters({ value: null }), [])
  assert.equal(parseNewLetters({ value: popup + popup + '<script>globalThis.BAD = true</script>' }).length, 1)
  assert.equal(globalThis.BAD, undefined)
  for (const value of [[], { error: { Message: 'error' } }, { value: 1 }, { value: '<a href="https://evil.test/Pismo3.aspx?idpisma=123">Test</a>' }, { value: '<p>Logowanie</p>' }]) {
    assert.throws(() => parseNewLetters(value), { code: 'schema' })
  }
})

test('primary signal alerts immediately before supplementary work, despite broken optional endpoints', async t => {
  const order = []
  const f = await fixture(t, { client: {
    snapshot: async () => ({ context, primaryItems: [{ id: '123' }] }),
    supplement: async () => { order.push('supplement'); throw new InboxError('schema') },
  }, notify: async () => order.push('notify') })
  assert.equal(f.monitor.intervalMs, 30_000)
  await f.monitor.setEnabled(true)
  assert.deepEqual(order, ['notify', 'supplement'])
  assert.equal(f.monitor.snapshot().status, 'ready')
  assert.equal(f.monitor.snapshot().supplementError, true)
  await f.monitor.check()
  assert.deepEqual(order, ['notify', 'supplement', 'supplement'])
})

test('primary dialog deduplication survives restart; an empty signal allows a later new episode', async t => {
  let primaryItems = [{ id: '123' }]
  const f = await fixture(t, { client: { snapshot: async () => ({ context, primaryItems }) } })
  await f.monitor.setEnabled(true)
  await f.monitor.check()
  assert.deepEqual(f.notices, [{ count: 1 }])
  await f.monitor.close()
  const restarted = new EzdInboxMonitor({ client: { snapshot: async () => ({ context, primaryItems }) }, directory: f.directory, notify: async n => f.notices.push(n) })
  t.after(() => restarted.close())
  await restarted.init(); await restarted.running
  assert.equal(f.notices.length, 1)
  primaryItems = []; await restarted.check()
  primaryItems = [{ id: '123' }]; await restarted.check()
  assert.equal(f.notices.length, 2)
})

test('supplementary folder/event duplicates do not produce a second notification for the primary signal', async t => {
  let items = []
  let events = []
  let primaryItems = []
  const f = await fixture(t, { client: {
    snapshot: async () => ({ context, primaryItems }),
    supplement: async () => ({ context, items, events }),
  } })
  await f.monitor.setEnabled(true)
  primaryItems = [{ id: '123' }]; items = [item(123)]; events = [{ key: 'transfer123', pismoId: '123', description: 'Przekazanie koszulki' }]
  await f.monitor.check()
  assert.deepEqual(f.notices, [{ count: 1 }])
  events.push({ key: 'version123', pismoId: '123', description: 'Nowa wersja dokumentu' })
  await f.monitor.check()
  assert.deepEqual(f.notices, [{ count: 1 }, { count: 0, eventCount: 1 }])
})
