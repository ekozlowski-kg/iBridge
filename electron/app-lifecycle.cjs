function canCreateApplicationWindow({ electronReady, applicationInitialized, windowCount }) {
  return electronReady === true
    && applicationInitialized === true
    && windowCount === 0
}

function shouldKeepRunningInBackground({ isQuitting }) {
  return isQuitting !== true
}

async function drainBeforeQuit({ sessions, signatureSessions, autosync, timeoutMs = 5000 }) {
  let timeout
  const editWork = (async () => {
    try {
      await autosync?.close?.()
    } finally {
      await sessions?.releaseAll?.()
    }
    return { timedOut: false }
  })().catch((error) => ({ timedOut: false, error }))
  const timedOut = new Promise((resolve) => {
    timeout = setTimeout(() => resolve({ timedOut: true }), timeoutMs)
  })
  let editResult
  try {
    editResult = await Promise.race([editWork, timedOut])
  } finally {
    clearTimeout(timeout)
  }
  try {
    // Signature release may be waiting for an already-started upload.  It is
    // deliberately outside the edit timeout: cutting it off would manufacture
    // an ambiguous result while the server call is still in flight.
    await signatureSessions?.releaseAll?.()
    return editResult
  } catch (error) {
    return editResult.error ? editResult : { ...editResult, error }
  }
}

module.exports = {
  canCreateApplicationWindow,
  drainBeforeQuit,
  shouldKeepRunningInBackground,
}
