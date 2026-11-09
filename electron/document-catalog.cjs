function serverKey(remote) {
  try {
    const url = new URL(remote.serviceUrl)
    return `${url.origin.toLowerCase()}${url.pathname.replace(/\/+$/, '').toLowerCase()}`
  } catch { return String(remote.serviceUrl || '') }
}
function ids(session) {
  const r = session.remote
  return [...new Set([r.sourceDocumentId, r.documentId, ...(r.documentIds || [])])].filter(x => Number.isSafeInteger(x) && x > 0)
}
function sameDocument(a, b) {
  if (!a.remote || !b.remote) return false
  return serverKey(a.remote) === serverKey(b.remote)
    && Number(a.remote.pismoId || 0) === Number(b.remote.pismoId || 0)
    && (a.remote.operation || 'edit') === (b.remote.operation || 'edit')
    && ids(a).some(x => ids(b).includes(x))
}
function buildDocumentCatalog(sessions = []) {
  const groups = []
  for (const session of sessions) {
    if (!session.remote) continue
    let group = groups.find(g => g.sessions.some(s => sameDocument(s, session)))
    if (!group) { group = { sessions: [] }; groups.push(group) }
    group.sessions.push(session)
    // Acknowledged upload IDs can connect older groups without relying on names.
    for (const other of [...groups]) {
      if (other === group || !other.sessions.some(a => group.sessions.some(b => sameDocument(a, b)))) continue
      group.sessions.push(...other.sessions)
      groups.splice(groups.indexOf(other), 1)
    }
  }
  return groups.map(g => {
    g.sessions.sort((a,b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    const live = g.sessions.filter(s => s.remote.connectionStatus === 'active' && s.remote.status !== 'sent')
    const current = live[0] || g.sessions[0]
    return { id: g.sessions.at(-1).id, name: current.name, caseMark: current.remote.caseMark || '',
      pismoId: current.remote.pismoId || 0, currentSessionId: current.id,
      sessionIds: g.sessions.map(s=>s.id), activeSessionIds: live.map(s=>s.id), conflict: live.length > 1 }
  })
}
module.exports = { buildDocumentCatalog, sameDocument }
