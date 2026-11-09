const assert = require('node:assert/strict')
const test = require('node:test')

const {
  createEzdPismoUrl,
  isTrustedEzdSender,
  openEzdCaseForSession,
} = require('../electron/ezd-case-link.cjs')

test('creates the fixed EZD Pismo URL for a positive safe PismoId', () => {
  assert.equal(
    createEzdPismoUrl(1474132),
    'https://ezd.kg.straz.gov.pl/Pismo3.aspx?idpisma=1474132',
  )
})

test('rejects non-positive or unsafe PismoIds instead of constructing a URL', () => {
  for (const invalid of [0, -1, 1.2, NaN, Infinity, '1&x=2']) {
    assert.throws(() => createEzdPismoUrl(invalid))
  }
})

test('accepts only the exact packaged or configured development main frame', () => {
  const origins = {
    packagedRendererUrl: 'file:///Applications/EZD%20-%20iBridge.app/Contents/Resources/app/dist/index.html',
    developmentServerUrl: 'http://127.0.0.1:5173/',
  }
  const mainFrameEvent = (url) => {
    const mainFrame = { url }
    return { senderFrame: mainFrame, sender: { mainFrame } }
  }
  const subframeEvent = (url) => {
    const mainFrame = { url }
    return { senderFrame: { url, parent: mainFrame }, sender: { mainFrame } }
  }

  assert.equal(isTrustedEzdSender(mainFrameEvent(origins.packagedRendererUrl), origins), true)
  assert.equal(isTrustedEzdSender(mainFrameEvent('http://127.0.0.1:5173/editor'), origins), true)
  assert.equal(isTrustedEzdSender(mainFrameEvent('file:///tmp/unrelated.html'), origins), false)
  assert.equal(isTrustedEzdSender(subframeEvent(origins.packagedRendererUrl), origins), false)
  assert.equal(isTrustedEzdSender(mainFrameEvent('http://127.0.0.1:5174/'), origins), false)
})

test('opens only the URL derived from the stored session PismoId', async () => {
  const openedUrls = []
  const store = {
    getSession(sessionId) {
      assert.equal(sessionId, 'session-123')
      return { remote: { pismoId: 1474132 } }
    },
  }

  await openEzdCaseForSession({
    store,
    openExternal: async (url) => openedUrls.push(url),
  }, 'session-123', 'https://attacker.invalid/')

  assert.deepEqual(openedUrls, [
    'https://ezd.kg.straz.gov.pl/Pismo3.aspx?idpisma=1474132',
  ])
})

test('does not navigate when the session is missing, local, or has an invalid PismoId', async () => {
  const openedUrls = []
  const openExternal = async (url) => openedUrls.push(url)

  for (const getSession of [
    () => { throw new Error('Nie znaleziono sesji dokumentu.') },
    () => ({ remote: null }),
    () => ({ remote: { pismoId: 0 } }),
    () => ({ remote: { pismoId: Number.MAX_SAFE_INTEGER + 1 } }),
  ]) {
    await assert.rejects(
      openEzdCaseForSession({ store: { getSession }, openExternal }, 'session-123'),
    )
  }

  assert.deepEqual(openedUrls, [])
})

test('propagates shell failures without reporting a successful navigation', async () => {
  const shellFailure = new Error('blocked by shell')
  await assert.rejects(
    openEzdCaseForSession({
      store: { getSession: () => ({ remote: { pismoId: 1474132 } }) },
      openExternal: async () => { throw shellFailure },
    }, 'session-123'),
    shellFailure,
  )
})
