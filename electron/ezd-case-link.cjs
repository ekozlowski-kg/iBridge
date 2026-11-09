const EZD_PISMO_URL_PREFIX = 'https://ezd.kg.straz.gov.pl/Pismo3.aspx?idpisma='

function createEzdPismoUrl(pismoId) {
  if (typeof pismoId !== 'number' || !Number.isSafeInteger(pismoId) || pismoId <= 0) {
    throw new Error('Nieprawidłowy identyfikator pisma EZD.')
  }
  return `${EZD_PISMO_URL_PREFIX}${pismoId}`
}

async function openEzdCaseForSession({ store, openExternal }, sessionId) {
  const session = store.getSession(sessionId)
  if (!session.remote) throw new Error('To nie jest dokument pobrany z EZD.')
  const url = createEzdPismoUrl(session.remote.pismoId)
  await openExternal(url)
  return { ok: true }
}

function isTrustedEzdSender(event, { packagedRendererUrl, developmentServerUrl = '' } = {}) {
  const frame = event?.senderFrame
  if (!frame || frame !== event?.sender?.mainFrame || typeof frame.url !== 'string') return false
  if (frame.url === packagedRendererUrl) return true
  if (!developmentServerUrl) return false
  try {
    return new URL(frame.url).origin === new URL(developmentServerUrl).origin
  } catch {
    return false
  }
}

function createOpenEzdCaseHandler({ store, openExternal, assertTrustedSender }) {
  return async (event, sessionId) => {
    assertTrustedSender(event)
    return openEzdCaseForSession({ store, openExternal }, sessionId)
  }
}

function registerOpenEzdCaseIpc({ ipcMain, store, openExternal, assertTrustedSender }) {
  ipcMain.handle(
    'document:open-ezd-case',
    createOpenEzdCaseHandler({ store, openExternal, assertTrustedSender }),
  )
}

module.exports = {
  createEzdPismoUrl,
  createOpenEzdCaseHandler,
  isTrustedEzdSender,
  openEzdCaseForSession,
  registerOpenEzdCaseIpc,
}
