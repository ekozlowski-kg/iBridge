function formatRemoteDate(value) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return new Intl.DateTimeFormat('pl-PL', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}

export function remoteStatusView(remote = {}) {
  if (remote.recoveryRequired && remote.connectionStatus !== 'active') return {
    className: 'error', title: 'Lokalne zmiany czekają na wysłanie',
    detail: 'Plik jest zachowany. Otwórz dokument ponownie z EZD i przywróć potrzebną treść z historii lokalnych kopii.',
  }
  if (remote.status === 'sent') {
    const date = formatRemoteDate(remote.uploadedAt)
    return {
      className: 'sent',
      title: 'Edycja zakończona w EZD',
      detail: date ? `Sesję zakończono ${date}.` : 'Sesja edycji została zakończona.',
    }
  }

  if (remote.syncStatus === 'synced' && !remote.recoveryRequired
      && (remote.finishStatus === 'error' || remote.finishStatus === 'unconfirmed')) {
    return { className: 'synced', title: 'Zapisano w EZD', detail: 'Ostatni zapis został potwierdzony przez EZD.' }
  }
  if (remote.connectionStatus === 'needs-reopen') {
    return { className: remote.recoveryRequired ? 'error' : 'idle', title: remote.recoveryRequired ? 'Lokalne zmiany czekają na wysłanie' : 'Brak aktywnej sesji EZD', detail: 'Otwórz dokument ponownie z EZD. Ta lokalna kopia nie jest automatycznie synchronizowana.' }
  }
  if (remote.syncStatus === 'error') {
    const error = remote.lastError || {}
    const detail = [
      error.operation || 'Synchronizacja',
      Number(error.ezdStatus) ? `status ${Number(error.ezdStatus)}` : null,
      !Number(error.ezdStatus) && Number(error.httpStatus) ? `HTTP ${Number(error.httpStatus)}` : null,
      error.message || null,
    ].filter(Boolean).join(' · ')
    return { className: 'error', title: 'Błąd synchronizacji', detail }
  }

  if (remote.syncStatus === 'pending') {
    return {
      className: 'pending',
      title: 'Oczekuje na stabilny zapis',
      detail: 'Plik zostanie wysłany automatycznie, gdy edytor zakończy zapis.',
    }
  }

  if (remote.syncStatus === 'syncing') {
    return {
      className: 'syncing',
      title: 'Synchronizacja…',
      detail: 'Wysyłanie najnowszej zapisanej wersji do EZD.',
    }
  }

  if (remote.syncStatus === 'synced') {
    const date = formatRemoteDate(remote.lastSyncedAt)
    return {
      className: 'synced',
      title: 'Zapisano w EZD',
      detail: date ? `Ostatnia poprawna synchronizacja: ${date}.` : 'Najnowsza wersja jest zapisana w EZD.',
    }
  }

  return {
    className: 'idle',
    title: 'Oczekuje na zapis',
    detail: 'Po zapisaniu dokumentu zmiany zostaną automatycznie wysłane do EZD.',
  }
}
