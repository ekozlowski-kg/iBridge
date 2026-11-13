const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { spawn } = require('node:child_process')
const {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  Notification,
  nativeImage,
  nativeTheme,
  shell,
  Tray,
  session,
  powerMonitor,
} = require('electron')
const { EzdInboxClient } = require('./ezd-inbox-client.cjs')
const { EzdInboxMonitor } = require('./ezd-inbox-monitor.cjs')
const { createInboxWindowController } = require('./ezd-inbox-window.cjs')
const { NotificationPermissions, loadNativePermissions } = require('./notification-permissions.cjs')
const { SessionStore } = require('./session-store.cjs')
const { EzdSessionCoordinator } = require('./ezd-session-coordinator.cjs')
const {
  EzdSignatureCoordinator,
  registerSignatureIpc,
  routeEzdSessionMode,
} = require('./ezd-signature-coordinator.cjs')
const { SignatureHelper } = require('./signature-helper.cjs')
const { DocumentObserver } = require('./document-observer.cjs')
const { UpdateChecker, REPOSITORY_URL } = require('./update-checker.cjs')
const { pendingWork } = require('./quit-policy.cjs')
const { EzdSoapClient } = require('./ezd-soap-client.cjs')
const { EzdAutosync } = require('./ezd-autosync.cjs')
const { DiagnosticLog } = require('./diagnostic-log.cjs')
const { APPLICATION_NAME, resolveApplicationDataDirectory } = require('./app-paths.cjs')
const {
  canCreateApplicationWindow,
  drainBeforeQuit,
  shouldKeepRunningInBackground,
} = require('./app-lifecycle.cjs')
const { createTrayController, trayStatusFromState } = require('./tray-controller.cjs')
const { compareDocuments } = require('./document-text.cjs')
const { isTrustedEzdSender, registerOpenEzdCaseIpc } = require('./ezd-case-link.cjs')
const {
  EZD_SESSION_MODES,
  createEzdSessionPlan,
  createServiceMetadataUrl,
  findProtocolArgument,
  parseProtocolRequest,
  redactProtocolArguments,
  takeProtocolSecret,
} = require('./protocol.cjs')

const isDevelopment = Boolean(process.env.VITE_DEV_SERVER_URL)
const packagedRendererUrl = pathToFileURL(path.join(__dirname, '..', 'dist', 'index.html')).href
const requestedBackgroundLaunch = process.argv.includes('--background')
let mainWindow = null
let store = null
let ezdSessions = null
let ezdSignatures = null
let autosync = null
let documentObserver = null
let updateChecker = null
let quitDialogOpen = false
let forcedExit = false
let expandedWindow = false
const notifiedProblems = new Set()
let diagnosticLog = null
let trayController = null
let inboxMonitor = null
let inboxWindow = null
let lastInboxProblem = null
let notificationPermissions = null
const inboxAlerts = new Set()
let applicationInitialized = false
let queuedProtocolUrl = findProtocolArgument(process.argv)
const queuedProtocolUrls = queuedProtocolUrl ? [queuedProtocolUrl] : []
redactProtocolArguments(process.argv)
if (queuedProtocolUrl) process.title = APPLICATION_NAME
let quitCleanupStarted = false
let quitCleanupFinished = false
let quitRequested = false

if (process.env.EZD_TEST_USERDATA) app.setPath('userData', path.resolve(process.env.EZD_TEST_USERDATA))
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) app.quit()

function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload)
}

function handleNativeThemeUpdated() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#000000' : '#ffffff')
  }
}

function assertTrustedSender(event) {
  if (!isTrustedEzdSender(event, {
    packagedRendererUrl,
    developmentServerUrl: isDevelopment ? process.env.VITE_DEV_SERVER_URL : '',
  })) throw new Error('Odrzucono żądanie z niezaufanego źródła.')
}

function notifyProblem(sessionId, kind, message) {
  const key = `${sessionId}:${kind}`
  if (notifiedProblems.has(key)) return
  notifiedProblems.add(key)
  sendToRenderer('protocol-message', { type: 'error', message })
  if (Notification.isSupported()) {
    const notification = new Notification({ title: APPLICATION_NAME, body: message })
    notification.on('click', () => showMainWindow().catch(() => {}))
    notification.show()
  }
}

async function showInboxAlert(body) {
  if (!Notification.isSupported()) throw new Error('Powiadomienia systemowe niedostępne.')
  const permission = await notificationPermissions.refresh()
  if (permission.status !== 'granted') throw new Error('Włącz banery iBridge w powiadomieniach macOS.')
  const previous = await notificationPermissions.delivered()
  const notification = new Notification({ title: APPLICATION_NAME, body, silent: false })
  // Keep live objects: collecting a new Notification can remove it from Notification Center.
  inboxAlerts.add(notification)
  notification.once('close', () => inboxAlerts.delete(notification))
  notification.once('failed', () => inboxAlerts.delete(notification))
  if (inboxAlerts.size > 100) inboxAlerts.delete(inboxAlerts.values().next().value)
  notification.on('click', () => inboxWindow.open())
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Nie potwierdzono przekazania powiadomienia.')), 10_000)
    notification.once('show', () => { clearTimeout(timeout); resolve() })
    notification.once('failed', () => { clearTimeout(timeout); reject(new Error('System odrzucił powiadomienie.')) })
    notification.show()
  })
  // Electron's "show" event does not confirm that macOS permissions allow a banner.
  let inCenter = null
  if (previous) {
    for (let attempt = 0; attempt < 4; attempt++) {
      const history = await notificationPermissions.delivered()
      if (!history) break
      inCenter = notification.id ? history.includes(notification.id) : history.some(id => !previous.includes(id))
      if (inCenter) break
      await new Promise(resolve => setTimeout(resolve, 200))
    }
  }
  return { inCenter }
}

function setWindowMode(mode) {
  expandedWindow = mode === 'details'
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.setResizable(true)
  mainWindow.setMinimumSize(expandedWindow ? 900 : 320, expandedWindow ? 650 : 350)
  mainWindow.setSize(expandedWindow ? 1200 : 340, expandedWindow ? 800 : 360, false)
  mainWindow.setResizable(expandedWindow)
}

async function finishEditing(sessionId) {
  const session = store.getSession(sessionId)
  if (session.remote?.operation === 'signature') throw new Error('To nie jest sesja edycji.')
  try { return await autosync.finish(sessionId) }
  catch (error) { return store.snapshot() }
}

function createWindow({ showOnReady = true } = {}) {
  const electronReady = app.isReady()
  const windowCount = electronReady ? BrowserWindow.getAllWindows().length : 0
  if (!canCreateApplicationWindow({ electronReady, applicationInitialized, windowCount })) return null

  mainWindow = new BrowserWindow({
    width: expandedWindow ? 1200 : 340,
    height: expandedWindow ? 800 : 360,
    minWidth: expandedWindow ? 900 : 320,
    minHeight: expandedWindow ? 650 : 350,
    resizable: expandedWindow,
    show: false,
    title: APPLICATION_NAME,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#000000' : '#ffffff',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const allowed = url.startsWith('file:') || (isDevelopment && url.startsWith('http://127.0.0.1:'))
    if (!allowed) event.preventDefault()
  })
  mainWindow.once('ready-to-show', () => {
    if (showOnReady) mainWindow.show()
  })
  mainWindow.on('close', (event) => {
    if (!shouldKeepRunningInBackground({ isQuitting: quitRequested })) return
    event.preventDefault()
    mainWindow.hide()
    app.dock?.hide()
  })
  mainWindow.on('closed', () => { mainWindow = null })

  if (isDevelopment) mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL)
  else mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))

  return mainWindow
}

async function showMainWindow() {
  if (app.dock) await app.dock.show()
  app.show()
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow({ showOnReady: true })
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
  app.focus({ steal: true })
}

function applyLaunchAtLogin(enabled) {
  const openAtLogin = Boolean(enabled)
  app.setLoginItemSettings({
    openAtLogin,
    openAsHidden: openAtLogin,
    path: process.execPath,
    args: openAtLogin ? ['--background'] : [],
  })
  return app.getLoginItemSettings({ path: process.execPath }).openAtLogin
}

async function promptForLaunchAtLogin() {
  if (
    process.env.EZD_SKIP_LOGIN_PROMPT === '1' ||
    requestedBackgroundLaunch ||
    queuedProtocolUrl ||
    store.state.settings.launchAtLoginPrompted
  ) return

  const answer = await dialog.showMessageBox(mainWindow, {
    type: 'question',
    title: 'Uruchamianie razem z systemem',
    message: `Czy uruchamiać ${APPLICATION_NAME} automatycznie po zalogowaniu?`,
    detail: 'Aplikacja uruchomi się dyskretnie w tle i będzie gotowa przyjąć wywołanie protokołu EZD. Ustawienie można później zmienić w sekcji Ustawienia.',
    buttons: ['Tak, uruchamiaj w tle', 'Nie teraz'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  })
  const launchAtLogin = answer.response === 0 && applyLaunchAtLogin(true)
  await store.updateSettings({ launchAtLogin, launchAtLoginPrompted: true })
}

async function openInPreferredEditor(sessionId) {
  const session = store.getSession(sessionId)
  const editSession = session.remote && session.remote.operation !== 'signature'
  if (editSession && !ezdSessions.hasLiveSession(sessionId)) {
    throw new Error('Ta kopia nie ma aktywnego połączenia. Otwórz dokument ponownie z EZD. Lokalne zmiany znajdziesz w historii.')
  }
  const { editorMode, editorPath } = store.state.settings

  if (editorMode === 'custom' && editorPath) {
    const args = process.platform === 'darwin' && editorPath.toLowerCase().endsWith('.app')
      ? ['-a', editorPath, session.workingPath]
      : [session.workingPath]
    const executable = process.platform === 'darwin' && editorPath.toLowerCase().endsWith('.app')
      ? '/usr/bin/open'
      : editorPath
    const child = spawn(executable, args, { detached: true, stdio: 'ignore' })
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject) })
    child.unref()
    if (editSession) await documentObserver.watch(sessionId, session.workingPath)
    return { ok: true }
  }

  const error = await shell.openPath(session.workingPath)
  if (error) throw new Error(`Nie udało się otworzyć dokumentu: ${error}`)
  if (editSession) await documentObserver.watch(sessionId, session.workingPath)
  return { ok: true }
}

async function handleProtocolUrl(rawUrl) {
  const request = parseProtocolRequest(rawUrl)
  if (!request || !store) return

  if (request.kind === 'invalid') {
    await diagnosticLog?.write({
      operation: 'protocol',
      kind: 'protocol',
      phase: 'parse',
      code: request.code || 'EZD_PROTOCOL_INVALID',
    })
    throw new Error(request.message || 'Nieprawidłowe wywołanie protokołu EZD.')
  }

  if (request.kind === 'local-file') {
    const answer = await dialog.showMessageBox(mainWindow, {
      type: 'question',
      title: 'Dokument z przeglądarki',
      message: `Strona internetowa chce otworzyć dokument w ${APPLICATION_NAME}.`,
      detail: path.basename(request.filePath),
      buttons: ['Importuj dokument', 'Anuluj'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    })
    if (answer.response === 0) await store.importDocument(request.filePath)
    return
  }

  if (request.kind === 'ezd-session') {
    const plan = createEzdSessionPlan(request, store.state.settings.acceptLegacyProtocol)
    const secret = takeProtocolSecret(request)
    if (plan.settingsPatch) await store.updateSettings(plan.settingsPatch)
    sendToRenderer('protocol-message', plan.notice)
    if (!store.state.settings.acceptLegacyProtocol) return
    if (!secret?.authToken) throw new Error('Wywołanie EZD nie zawiera tokenu sesji.')

    const connection = {
      serviceUrl: request.serviceUrl,
      authToken: secret.authToken,
    }
    const mode = request.mode ?? EZD_SESSION_MODES.EDIT
    await routeEzdSessionMode({
      mode,
      connection,
      editReceive: (options) => ezdSessions.receive(options),
      signatureReceive: (options) => ezdSignatures.receive(options),
      showSignatureWindow: async () => { setWindowMode('details'); await showMainWindow() },
    })
    notifiedProblems.delete('protocol:receive')
    sendToRenderer('protocol-message', {
      type: 'success',
      message: mode === EZD_SESSION_MODES.SIGN
        ? 'Dokument do podpisu został pobrany z EZD. Wprowadź PIN, aby kontynuować.'
        : 'Dokument został pobrany z EZD i otwarty w edytorze.',
    })
    return
  }

  if (request.kind === 'legacy') {
    sendToRenderer('protocol-message', {
      type: 'warning',
      message: store.state.settings.acceptLegacyProtocol
        ? 'Odebrano stare wywołanie EZD. Adapter serwera SOAP wymaga danych testowych od administratora.'
        : 'Odebrano stare wywołanie EZD, ale jego obsługa jest wyłączona w ustawieniach.',
    })
    return
  }

  sendToRenderer('protocol-message', {
    type: 'warning',
    message: request.message || 'To wywołanie protokołu nie jest jeszcze obsługiwane.',
  })
}

function registerIpc() {
  for (const [channel, handler] of [
    ['inbox:get', () => inboxMonitor.snapshot()],
    ['inbox:enabled', enabled => inboxMonitor.setEnabled(enabled)],
    ['inbox:check', () => inboxMonitor.check()],
    ['inbox:rebind', () => inboxMonitor.rebind()],
    ['inbox:login', () => { inboxWindow.open(); return { ok: true } }],
    ['inbox:test', () => showInboxAlert('To jest test powiadomień iBridge.')],
    ['inbox:permission', () => notificationPermissions.refresh()],
    ['inbox:authorize', () => notificationPermissions.enable()],
    ['inbox:permission-settings', () => notificationPermissions.openSettings()],
  ]) {
    ipcMain.handle(channel, (event, ...args) => { assertTrustedSender(event); return handler(...args) })
  }
  ipcMain.handle('window:mode', (event, mode) => {
    assertTrustedSender(event)
    if (!['compact', 'details'].includes(mode)) throw new Error('Nieprawidłowy tryb okna.')
    setWindowMode(mode)
    return { mode }
  })
  ipcMain.handle('updates:get', event => { assertTrustedSender(event); return updateChecker.snapshot() })
  ipcMain.handle('updates:check', event => { assertTrustedSender(event); return updateChecker.check(true) })
  ipcMain.handle('updates:open', event => {
    assertTrustedSender(event)
    return shell.openExternal(updateChecker.snapshot().url || `${REPOSITORY_URL}/releases`)
  })
  ipcMain.handle('account:open', event => {
    assertTrustedSender(event)
    inboxWindow.open()
    return { ok: true }
  })
  ipcMain.handle('state:get', (event) => {
    assertTrustedSender(event)
    return store.snapshot()
  })

  ipcMain.handle('document:choose', async (event) => {
    assertTrustedSender(event)
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Wybierz dokument',
      properties: ['openFile'],
      filters: [
        { name: 'Dokumenty', extensions: ['doc', 'docx', 'odt', 'rtf', 'txt', 'md', 'pdf', 'xls', 'xlsx', 'ods', 'csv', 'xml', 'html', 'ppt', 'pptx'] },
        { name: 'Wszystkie pliki', extensions: ['*'] },
      ],
    })
    if (result.canceled || !result.filePaths[0]) return null
    return store.importDocument(result.filePaths[0])
  })

  ipcMain.handle('document:import-path', async (event, filePath) => {
    assertTrustedSender(event)
    if (typeof filePath !== 'string') throw new Error('Nieprawidłowa ścieżka pliku.')
    return store.importDocument(filePath)
  })

  ipcMain.handle('document:open-editor', async (event, sessionId) => {
    assertTrustedSender(event)
    return openInPreferredEditor(sessionId)
  })

  registerOpenEzdCaseIpc({
    ipcMain,
    store,
    openExternal: (url) => shell.openExternal(url),
    assertTrustedSender,
  })

  registerSignatureIpc({
    ipcMain,
    coordinator: ezdSignatures,
    assertTrustedSender,
  })

  ipcMain.handle('document:save-version', async (event, sessionId) => {
    assertTrustedSender(event)
    return store.saveVersion(sessionId)
  })

  ipcMain.handle('document:read-editable', async (event, sessionId) => {
    assertTrustedSender(event)
    return store.readEditableDocument(sessionId)
  })

  ipcMain.handle('document:save-editable', async (event, sessionId, text) => {
    assertTrustedSender(event)
    return store.saveEditableDocument(sessionId, text)
  })

  ipcMain.handle('document:replace', async (event, sessionId) => {
    assertTrustedSender(event)
    const session = store.getSession(sessionId)
    const extension = path.extname(session.workingPath).slice(1)
    const result = await dialog.showOpenDialog(mainWindow, {
      title: `Wybierz nową zawartość pliku ${session.name}`,
      properties: ['openFile'],
      filters: extension ? [{ name: session.extension, extensions: [extension] }] : undefined,
    })
    if (result.canceled || !result.filePaths[0]) return null

    const answer = await dialog.showMessageBox(mainWindow, {
      type: 'question',
      title: 'Zmień plik roboczy',
      message: `Czy zastąpić plik roboczy „${session.name}”?`,
      detail: 'Dotychczasowa zawartość pozostanie w historii wersji, a wybrany plik zostanie zapisany jako nowa wersja.',
      buttons: ['Zastąp i zachowaj wersję', 'Anuluj'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    })
    if (answer.response !== 0) return null
    return store.replaceWorkingDocument(sessionId, result.filePaths[0])
  })

  ipcMain.handle('document:sync-ezd', async (event, sessionId) => {
    assertTrustedSender(event)
    const session = store.getSession(sessionId)
    if (!session.remote) throw new Error('To nie jest dokument pobrany z EZD.')
    if (session.remote.status === 'sent') throw new Error('Ten dokument został już odesłany do EZD.')
    return autosync.retry(sessionId).then(() => store.snapshot())
  })

  ipcMain.handle('document:finish-ezd', async (event, sessionId) => {
    assertTrustedSender(event)
    const session = store.getSession(sessionId)
    if (!session.remote) throw new Error('To nie jest dokument pobrany z EZD.')
    if (session.remote.status === 'sent') throw new Error('Ta sesja edycji została już zakończona.')
    const answer = await dialog.showMessageBox(mainWindow, {
      type: 'question',
      title: 'Zakończ edycję w EZD',
      message: 'Czy zsynchronizować dokument i zakończyć sesję edycji?',
      detail: session.name,
      buttons: ['Synchronizuj i zakończ', 'Anuluj'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    })
    if (answer.response !== 0) return null
    await store.patchRemote(sessionId, { editorState: 'closed' })
    return finishEditing(sessionId)
  })

  ipcMain.handle('document:reveal', async (event, sessionId, versionId) => {
    assertTrustedSender(event)
    const session = store.getSession(sessionId)
    const target = versionId
      ? session.versions.find((item) => item.id === versionId)?.path
      : session.workingPath
    if (!target) throw new Error('Nie znaleziono wersji dokumentu.')
    shell.showItemInFolder(target)
    return { ok: true }
  })

  ipcMain.handle('compare:session', async (event, sessionId) => {
    assertTrustedSender(event)
    const session = store.getSession(sessionId)
    return compareDocuments(session.versions[0].path, session.workingPath)
  })

  ipcMain.handle('compare:choose', async (event) => {
    assertTrustedSender(event)
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Wybierz dwa dokumenty do porównania',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Dokumenty tekstowe', extensions: ['docx', 'odt', 'rtf', 'txt', 'md', 'csv', 'xml', 'html'] },
      ],
    })
    if (result.canceled) return null
    if (result.filePaths.length !== 2) throw new Error('Wybierz dokładnie dwa dokumenty.')
    return compareDocuments(result.filePaths[0], result.filePaths[1])
  })

  ipcMain.handle('settings:choose-editor', async (event) => {
    assertTrustedSender(event)
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Wybierz Word, LibreOffice lub inny edytor',
      properties: ['openFile'],
    })
    return result.canceled ? null : result.filePaths[0]
  })

  ipcMain.handle('settings:update', async (event, settings) => {
    assertTrustedSender(event)
    if (!settings || typeof settings !== 'object') throw new Error('Nieprawidłowe ustawienia.')
    return store.updateSettings(settings)
  })

  ipcMain.handle('settings:get-launch-at-login', (event) => {
    assertTrustedSender(event)
    return { enabled: app.getLoginItemSettings({ path: process.execPath }).openAtLogin }
  })

  ipcMain.handle('settings:set-launch-at-login', async (event, enabled) => {
    assertTrustedSender(event)
    if (typeof enabled !== 'boolean') throw new Error('Nieprawidłowe ustawienie uruchamiania przy logowaniu.')
    const launchAtLogin = applyLaunchAtLogin(enabled)
    const state = await store.updateSettings({ launchAtLogin, launchAtLoginPrompted: true })
    return { enabled: launchAtLogin, state }
  })

  ipcMain.handle('settings:reveal-storage', (event) => {
    assertTrustedSender(event)
    shell.showItemInFolder(store.statePath)
    return { ok: true }
  })

  ipcMain.handle('settings:test-service', async (event, rawUrl) => {
    assertTrustedSender(event)
    let url
    try { url = new URL(createServiceMetadataUrl(rawUrl)) } catch { throw new Error('Wpisz poprawny adres URL usługi.') }
    if (!['https:', 'http:'].includes(url.protocol)) throw new Error('Dozwolone są tylko adresy HTTP i HTTPS.')
    if (url.username || url.password) throw new Error('Adres usługi nie może zawierać danych logowania.')
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(6000),
    })
    return { ok: response.ok || (response.status >= 300 && response.status < 400), status: response.status }
  })
}

app.on('second-instance', (_event, argv) => {
  const protocolUrl = findProtocolArgument(argv)
  if (!protocolUrl) showMainWindow().catch(() => {})
  redactProtocolArguments(argv)
  if (protocolUrl) {
    if (!applicationInitialized) { queuedProtocolUrls.push(protocolUrl); queuedProtocolUrl ||= protocolUrl }
    else handleProtocolUrl(protocolUrl).catch(error => notifyProblem('protocol', 'receive', error.message))
  }
})

app.on('open-url', (event, url) => {
  event.preventDefault()
  if (applicationInitialized) {
    handleProtocolUrl(url).catch((error) => {
      notifyProblem('protocol', 'receive', error.message)
    })
  }
  else { queuedProtocolUrls.push(url); queuedProtocolUrl ||= url }
})

app.whenReady().then(async () => {
  app.setName(APPLICATION_NAME)
  Menu.setApplicationMenu(null)
  nativeTheme.on('updated', handleNativeThemeUpdated)
  if (process.env.EZD_SKIP_PROTOCOL_REGISTRATION !== '1') {
    app.setAsDefaultProtocolClient('most-ezd')
    app.setAsDefaultProtocolClient('ezd')
  }

  const dataDirectory = process.env.EZD_DATA_DIRECTORY
    ? path.resolve(process.env.EZD_DATA_DIRECTORY)
    : await resolveApplicationDataDirectory(app.getPath('documents'))
  diagnosticLog = new DiagnosticLog({ directory: path.join(dataDirectory, 'logi') })
  store = new SessionStore({
    baseDir: dataDirectory,
    onChange: (event) => {
      sendToRenderer('state-changed', event)
      trayController?.updateState(event.state)
      if (event.type === 'remote-synced') {
        for (const key of notifiedProblems) if (key.startsWith(`${event.payload.id}:sync`)) notifiedProblems.delete(key)
      }
    },
  })
  await store.init()
  ezdSessions = new EzdSessionCoordinator({
    store,
    openEditor: openInPreferredEditor,
    onSessionReady: ({ sessionId, workingPath }) => autosync.watch(sessionId, workingPath),
    clientFactory: (options) => new EzdSoapClient({
      ...options,
      onDiagnostic: (event) => diagnosticLog.write(event),
    }),
  })
  ezdSignatures = new EzdSignatureCoordinator({
    store,
    helper: new SignatureHelper(),
    clientFactory: (options) => new EzdSoapClient({
      ...options,
      onDiagnostic: (event) => diagnosticLog.write({
        operation: 'signature',
        kind: event.kind,
        phase: event.operation === 'AddInPodpisUpload' ? 'uploading' : 'downloading',
        durationMs: event.durationMs,
        size: event.size,
        httpStatus: event.httpStatus,
        ezdStatus: event.ezdStatus,
      }),
    }),
    onEvent: (channel, payload) => sendToRenderer(channel, payload),
    onDiagnostic: (event) => diagnosticLog.write(event),
  })
  autosync = new EzdAutosync({
    coordinator: ezdSessions,
    onError: async event => {
      const { error, firstOccurrence, ...safe } = event
      await diagnosticLog.write(safe)
      const remote = store.getSession(event.sessionId).remote
      const cleanupOnly = event.operation === 'AddInZakonczSesje'
        && remote.syncStatus === 'synced' && !remote.recoveryRequired
      if (cleanupOnly) {
        // Keep the real server result in diagnostics. A rejected cleanup does
        // not undo an acknowledged upload and needs no alarming banner.
        if (!event.retryable) {
          await store.patchRemote(event.sessionId, { connectionStatus: 'needs-reopen', retryAt: null })
          ezdSessions.dropSession(event.sessionId)
          autosync.unwatch(event.sessionId)
          documentObserver.unwatch(event.sessionId)
        }
        return
      }
      if ([401,403].includes(Number(error?.httpStatus))) {
        await store.patchRemote(event.sessionId, { connectionStatus: 'needs-reopen', recoveryRequired: true })
        ezdSessions.dropSession(event.sessionId)
        autosync.unwatch(event.sessionId)
        documentObserver.unwatch(event.sessionId)
      }
      if (firstOccurrence) notifyProblem(event.sessionId, event.operation === 'AddInZakonczSesje' ? 'finish' : 'sync',
        event.retryable ? 'Nie udało się połączyć z EZD. Plik zachowany lokalnie; ponowimy próbę w tle.' : event.message)
    },
    onRetry: ({ sessionId, retryAt }) => store.patchRemote(sessionId, { retryAt }),
    onFinished: ({ sessionId }) => documentObserver.unwatch(sessionId),
  })
  documentObserver = new DocumentObserver({
    onState: async ({ sessionId, state }) => {
      await store.patchRemote(sessionId, { editorState: state })
    },
    onClosed: ({ sessionId }) => finishEditing(sessionId),
  })
  updateChecker = new UpdateChecker({ currentVersion: app.getVersion(), directory: dataDirectory,
    onChange: state => sendToRenderer('updates-changed', state) })
  inboxWindow = createInboxWindowController({ BrowserWindow, session, ipcMain,
    onLoaded: () => inboxMonitor?.check() })
  notificationPermissions = new NotificationPermissions({ directory: dataDirectory, native: loadNativePermissions(),
    onChange: state => sendToRenderer('inbox-permission-changed', state),
    openSettings: () => shell.openExternal('x-apple.systempreferences:com.apple.Notifications-Settings.extension'),
    prompt: async () => {
      await showMainWindow()
      const answer = await dialog.showMessageBox(mainWindow, { type: 'question', title: APPLICATION_NAME,
        message: 'Włączyć powiadomienia o nowych pismach?',
        detail: 'iBridge sprawdza EZD w tle co 30 sekund. Zgoda macOS pozwoli wyświetlać banery i odtwarzać dźwięk. Jeśli wcześniej odmówiono zgody, otworzymy ustawienia systemowe.',
        buttons: ['Włącz powiadomienia', 'Później'], defaultId: 0, cancelId: 1, noLink: true })
      return answer.response === 0
    },
  })
  inboxMonitor = new EzdInboxMonitor({
    client: new EzdInboxClient({ fetchImpl: inboxWindow.session.fetch.bind(inboxWindow.session) }),
    directory: dataDirectory,
    notify: async ({ count, eventCount = 0 }) => {
      const delivered = await showInboxAlert(`${count ? `Nowe pisma w EZD: ${count}. ` : ''}${eventCount ? `Inne powiadomienia EZD: ${eventCount}. ` : ''}Kliknij, aby otworzyć EZD w iBridge.`)
      if (delivered.inCenter !== true) throw new Error('Nie potwierdzono zapisu w Centrum powiadomień macOS.')
    },
    onChange: state => {
      sendToRenderer('inbox-changed', state)
      trayController?.updateInbox(state)
      if (['ready', 'disabled'].includes(state.status)) lastInboxProblem = null
      if (state.enabled && ['login-required', 'account-changed', 'storage-error'].includes(state.status)
        && state.status !== lastInboxProblem && Notification.isSupported()
        && notificationPermissions.snapshot().status === 'granted') {
        lastInboxProblem = state.status
        const notification = new Notification({ title: APPLICATION_NAME, body: state.message })
        notification.on('click', () => showMainWindow().catch(() => {}))
        notification.show()
      }
    },
  })
  powerMonitor.on('resume', () => inboxMonitor?.check())
  trayController = createTrayController({
    Tray,
    Menu,
    nativeImage,
    iconPath: path.join(__dirname, '..', 'dist', 'ibridge-trayTemplate.png'),
    applicationName: APPLICATION_NAME,
    onOpen: () => showMainWindow().catch(() => {}),
    onOpenInbox: () => inboxWindow.open(),
    onQuit: () => {
      app.quit()
    },
  })
  trayController.updateState(store.snapshot())
  // Monitoring starts by default; an explicitly saved opt-out is preserved.
  await inboxMonitor.init()
  registerIpc()
  if (process.env.EZD_SKIP_UPDATE_CHECK !== '1') updateChecker.start().catch(() => {})
  applicationInitialized = true
  const loginItem = app.getLoginItemSettings({ path: process.execPath })
  const startHidden = Boolean(queuedProtocolUrl) || requestedBackgroundLaunch || loginItem.wasOpenedAsHidden
  if (startHidden) app.dock?.hide()
  createWindow({ showOnReady: !startHidden })
  mainWindow.on('focus', () => notificationPermissions.refresh().catch(() => {}))
  notificationPermissions.onboard().then(() => notificationPermissions.snapshot().status === 'not-determined' ? undefined : promptForLaunchAtLogin()).catch((error) => {
    sendToRenderer('protocol-message', { type: 'error', message: error.message })
  })

  if (queuedProtocolUrls.length) {
    const values = queuedProtocolUrls.splice(0)
    queuedProtocolUrl = null
    mainWindow.webContents.once('did-finish-load', () => {
      for (const value of values) handleProtocolUrl(value).catch((error) => {
        notifyProblem('protocol', 'receive', error.message)
      })
    })
  }
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  showMainWindow().catch(() => {})
})

app.on('before-quit', (event) => {
  if (quitCleanupFinished) return
  event.preventDefault()
  if (quitDialogOpen) return
  if (!quitCleanupStarted) {
    quitDialogOpen = true
    ;(async () => {
      const pending = store ? await pendingWork(store, ezdSessions) : []
      if (pending.length && !forcedExit) {
        const answer = await dialog.showMessageBox(mainWindow, { type: 'warning', title: APPLICATION_NAME,
          message: 'Dokument jest nadal otwarty lub zmiany czekają na wysłanie.',
          detail: 'Wyjście zachowa pliki lokalnie. Po ponownym uruchomieniu może być konieczne otwarcie dokumentu z EZD.',
          buttons: ['Kontynuuj synchronizację', 'Wyjdź i zachowaj pliki lokalnie'], defaultId: 0, cancelId: 0, noLink: true })
        if (answer.response !== 1) return
        forcedExit = true
      }
      quitCleanupStarted = true
      quitRequested = true
      documentObserver?.close()
      updateChecker?.close()
      await inboxMonitor?.close()
      inboxWindow?.close()
      // Do not silently finish a session while its document is still open.
      await ezdSignatures?.releaseAll()
      let timeout
      try { await Promise.race([autosync?.close(), new Promise(resolve => { timeout = setTimeout(resolve, 5000) })]) }
      finally { clearTimeout(timeout) }
      if (store) {
        for (const session of store.state.sessions) {
          if (session.remote?.operation === 'signature' || session.remote?.connectionStatus !== 'active') continue
          session.remote.connectionStatus = 'needs-reopen'
          if (['syncing','pending'].includes(session.remote.syncStatus)) session.remote.syncStatus = 'pending'
        }
        await store.persist()
        await store.persistTail
      }
      store?.close()
      trayController?.dispose()
      trayController = null
      nativeTheme.removeListener('updated', handleNativeThemeUpdated)
      quitCleanupFinished = true
      app.quit()
    })().catch(error => {
      quitCleanupStarted = false
      quitRequested = false
      notifyProblem('application', 'quit', 'Nie udało się bezpiecznie zapisać stanu. Aplikacja pozostaje uruchomiona.')
    }).finally(() => { quitDialogOpen = false })
    return
  }
})
