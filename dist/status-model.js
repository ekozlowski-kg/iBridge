export function homeSession(sessions = []) {
  const remote = sessions.filter(s => s.remote && s.remote.operation !== 'signature')
  const active = remote.filter(s => s.remote.connectionStatus === 'active' && s.remote.status !== 'sent')
  const needsAttention = remote.filter(s => s.remote.recoveryRequired || s.remote.syncStatus === 'error')
  const sending = active.filter(s => ['pending','syncing'].includes(s.remote.syncStatus) || s.remote.finishStatus === 'finishing')
  const sort = list => [...list].sort((a,b) => String(b.remote.lastUploadAt || b.updatedAt || b.createdAt).localeCompare(String(a.remote.lastUploadAt || a.updatedAt || a.createdAt)))[0]
  return sort(needsAttention) || sort(sending) || sort(remote.filter(s => s.remote.lastUploadAt)) || sort(active) || sort(remote) || null
}
export function compactStatus(session) {
  if (!session) return { tone: 'idle', title: 'Gotowy do pracy', text: 'Otwórz dokument w EZD. Resztą zajmiemy się w tle.', icon: 'file' }
  const r = session.remote
  if (r.recoveryRequired && r.connectionStatus !== 'active') return { tone: 'error', title: 'Zmiany czekają na wysłanie', text: 'Plik zachowany lokalnie. Otwórz ponownie dokument z EZD.', icon: 'warning' }
  if (r.syncStatus === 'error') return { tone: 'error', title: 'Nie udało się wysłać', text: r.retryAt ? 'Plik jest bezpieczny. Spróbujemy ponownie w tle.' : 'Plik zachowany lokalnie. Sprawdź szczegóły.', icon: 'warning' }
  if (r.connectionStatus === 'active' && (['pending','syncing'].includes(r.syncStatus) || r.finishStatus === 'finishing')) return { tone: 'sending', title: r.finishStatus === 'finishing' ? 'Kończenie edycji' : 'Przesyłanie do EZD', text: 'Zapisujemy ostatnią zmianę. Nie musisz nic robić.', icon: 'upload' }
  if (r.lastUploadAt || r.status === 'sent') return { tone: 'success', title: 'Zapisano w EZD', text: r.status === 'sent' ? 'Ostatni zapis przesłany. Edycja zakończona.' : 'Ostatni zapis przesłany do EZD.', icon: 'check' }
  if (r.connectionStatus === 'active') return { tone: 'idle', title: 'Dokument jest otwarty', text: 'Każdy zapis prześlemy automatycznie do EZD.', icon: 'file' }
  return { tone: 'idle', title: 'Gotowy do pracy', text: 'Otwórz dokument z EZD, aby rozpocząć nową sesję.', icon: 'file' }
}
export function connectionLabel(session) {
  const r = session?.remote || {}
  if (r.status === 'sent') return 'Edycja zakończona'
  if (r.connectionStatus !== 'active') return 'Brak aktywnej sesji'
  return r.editorState === 'closed' ? 'Kończenie edycji w tle' : 'Połączony z EZD · zapis automatyczny'
}
