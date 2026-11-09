const fs = require('node:fs/promises')
const crypto = require('node:crypto')
async function pendingWork(store, coordinator) {
  const pending = []
  for (const session of store.state.sessions) {
    const remote = session.remote
    if (!remote || remote.operation === 'signature') continue
    let unsent = ['pending', 'syncing', 'error'].includes(remote.syncStatus)
    const baseline = remote.lastSyncedHash || session.versions?.[0]?.hash
    try {
      const bytes = await fs.readFile(session.workingPath)
      if (baseline) unsent ||= crypto.createHash('sha256').update(bytes).digest('hex') !== baseline
    } catch { unsent ||= Boolean(session.dirty) }
    if (unsent || coordinator?.hasLiveSession(session.id)
        || ['error','finishing','unconfirmed'].includes(remote.finishStatus)) pending.push(session)
  }
  return pending
}
module.exports = { pendingWork }
