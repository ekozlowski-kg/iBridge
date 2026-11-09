const crypto = require('node:crypto')
const fsp = require('node:fs/promises')
const { EzdSoapClient, DEFAULT_MAX_FILE_BYTES } = require('./ezd-soap-client.cjs')
const { readStableFile } = require('./file-stability.cjs')
const { sameDocument } = require('./document-catalog.cjs')

function sha256Buffer(data) {
  return crypto.createHash('sha256').update(data).digest('hex')
}

function syncErrorSummary(error) {
  return {
    operation: error?.operation || 'local-sync',
    kind: error?.kind || 'local',
    ezdStatus: Number(error?.ezdStatus || 0),
    httpStatus: Number(error?.httpStatus || 0),
    message: String(error?.message || 'Synchronizacja nie powiodła się.'),
  }
}

class EzdSessionCoordinator {
  constructor({
    store,
    clientFactory = (options) => new EzdSoapClient(options),
    openEditor = async () => {},
    onSessionReady = async () => {},
    maxFileBytes = DEFAULT_MAX_FILE_BYTES,
    stabilityOptions = {},
  }) {
    if (!store) throw new Error('Brak magazynu dokumentów.')
    this.store = store
    this.clientFactory = clientFactory
    this.openEditor = openEditor
    this.onSessionReady = onSessionReady
    this.maxFileBytes = maxFileBytes
    this.stabilityOptions = stabilityOptions
    this.liveSessions = new Map()
    this.receiving = new Map()
    this.reservations = new Map()
  }

  hasLiveSession(sessionId) {
    return this.liveSessions.has(sessionId)
  }

  receive(connection) {
    const key = JSON.stringify([connection.serviceUrl, connection.authToken])
    if (this.receiving.has(key)) return this.receiving.get(key).then(() => this.store.snapshot())
    const operation = this.receiveOnce(connection, key)
    this.receiving.set(key, operation)
    operation.catch(() => {
      if (![...this.liveSessions.values()].some(live => live.requestKey === key)) this.receiving.delete(key)
    })
    return operation
  }

  async receiveOnce({ serviceUrl, authToken }, requestKey) {
    const client = this.clientFactory({ serviceUrl, authToken, maxFileBytes: this.maxFileBytes })
    let imported = false
    try {
      const metadata = await client.checkData()
      if (!metadata.documentName) throw new Error('EZD nie podał nazwy pobieranego dokumentu.')
      const identity = { remote: { ...metadata, serviceUrl } }
      for (const sessionId of this.liveSessions.keys()) {
        if (sameDocument(this.store.getSession(sessionId), identity)) {
          throw new Error('Ten dokument ma już aktywną edycję w iBridge. Zakończ poprzednią edycję przed ponownym otwarciem z EZD.')
        }
      }
      if ([...this.reservations.values()].some(other => sameDocument(other, identity))) {
        throw new Error('Ten dokument jest już pobierany z EZD. Poczekaj na otwarcie edytora.')
      }
      this.reservations.set(requestKey, identity)
      const downloaded = await client.downloadFile()
      const state = await this.store.importRemoteDocument({
        fileName: metadata.documentName,
        data: downloaded.data,
        metadata: { ...metadata, serviceUrl },
      })
      const sessionId = state.sessionId
      if (!sessionId || !state.workingPath) throw new Error('Import nie zwrócił identyfikatora sesji.')
      if (typeof client.setDiagnosticContext === 'function') client.setDiagnosticContext({ sessionId })
      this.liveSessions.set(sessionId, {
        client,
        documentId: Number(metadata.documentId || 0),
        inFlight: null,
        pending: false,
        finishing: null,
        lastUploadedHash: sha256Buffer(downloaded.data),
        remoteFinished: false,
        requestKey,
      })
      imported = true
      await this.onSessionReady({
        sessionId,
        workingPath: state.workingPath,
      })
      await this.openEditor(sessionId)
      return this.store.snapshot()
    } catch (error) {
      if (!imported && typeof client.finishSession === 'function') await client.finishSession().catch(() => {})
      throw error
    } finally {
      this.reservations.delete(requestKey)
    }
  }

  requireLiveSession(sessionId) {
    const live = this.liveSessions.get(sessionId)
    if (!live) throw new Error('Sesja połączenia z EZD nie jest już dostępna — otwórz dokument ponownie z EZD.')
    return live
  }

  async sync(sessionId) {
    const live = this.requireLiveSession(sessionId)
    if (live.remoteFinished) throw new Error('Sesja EZD została już zakończona.')
    live.pending = true
    await this.store.markRemoteSyncPending(sessionId)
    if (!live.inFlight) {
      live.inFlight = (async () => {
        try {
          return await this.drainSyncQueue(sessionId, live)
        } finally {
          live.inFlight = null
        }
      })()
    }
    return live.inFlight
  }

  async drainSyncQueue(sessionId, live) {
    while (live.pending) {
      live.pending = false
      try {
        await this.store.markRemoteSyncing(sessionId)
        const session = this.store.getSession(sessionId)
        if (session.missing) throw new Error('Nie znaleziono lokalnej kopii dokumentu.')
        const data = await readStableFile(session.workingPath, { ...this.stabilityOptions, maximumBytes: this.maxFileBytes })
        if (!data.length) throw new Error('Nie można wysłać pustego dokumentu.')
        if (data.length > this.maxFileBytes) throw new Error('Dokument jest zbyt duży do wysłania do EZD.')
        const currentHash = sha256Buffer(data)

        if (currentHash === live.lastUploadedHash) {
          await this.store.markRemoteSynced(sessionId, {
            hash: currentHash,
            documentId: live.documentId,
          })
          continue
        }

        await this.store.saveVersion(sessionId, { data })
        const result = await live.client.uploadFile(data)
        if (Number(result.documentId) > 0) live.documentId = Number(result.documentId)
        live.lastUploadedHash = currentHash
        await this.store.patchRemote?.(sessionId, { lastUploadAt: new Date().toISOString(), lastUploadHash: currentHash })
        await this.store.markRemoteSynced(sessionId, {
          hash: currentHash,
          documentId: live.documentId,
        })
      } catch (error) {
        live.pending = false
        await this.store.markRemoteSyncError(sessionId, syncErrorSummary(error)).catch(() => {})
        throw error
      }
    }
    return this.store.snapshot()
  }

  async finish(sessionId) {
    const live = this.requireLiveSession(sessionId)
    if (live.finishing) return live.finishing
    live.finishing = (async () => {
      try {
        await this.store.patchRemote?.(sessionId, { finishStatus: 'finishing', finishError: null })
        if (!live.remoteFinished) {
          // Check again after draining: the editor may have performed its final
          // atomic save while the preceding upload was still in flight.
          for (;;) {
            await this.sync(sessionId)
            const session = this.store.getSession(sessionId)
            const bytes = await readStableFile(session.workingPath, { ...this.stabilityOptions, maximumBytes: this.maxFileBytes })
            if (sha256Buffer(bytes) === live.lastUploadedHash && !live.pending && !live.inFlight) break
          }
          await live.client.finishSession()
          live.remoteFinished = true
        }
      const state = await this.store.markRemoteUploaded(sessionId, {
        documentId: live.documentId,
      })
      this.dropSession(sessionId)
      return state
      } catch (error) {
        await this.store.patchRemote?.(sessionId, { finishStatus: 'error', finishError: syncErrorSummary(error) }).catch(() => {})
        throw error
      }
    })()
    try {
      return await live.finishing
    } finally {
      if (this.liveSessions.has(sessionId)) live.finishing = null
    }
  }

  async upload(sessionId) {
    return this.finish(sessionId)
  }

  dropSession(sessionId) {
    const live = this.liveSessions.get(sessionId)
    if (live?.requestKey) this.receiving.delete(live.requestKey)
    this.liveSessions.delete(sessionId)
  }

  async releaseAll() {
    const sessionIds = [...this.liveSessions.keys()]
    return Promise.allSettled(sessionIds.map((sessionId) => this.finish(sessionId)))
  }
}

module.exports = { EzdSessionCoordinator }
