import { APPLICATION_NAME, APPLICATION_VERSION } from './branding.js'
import { remoteStatusView } from './remote-status.js'
import { homeSession, compactStatus, connectionLabel } from './status-model.js'

const api = window.mostEzd
const root = document.querySelector('#root')

const EDITABLE_EXTENSIONS = new Set(['TXT', 'MD', 'CSV', 'XML', 'HTML', 'HTM'])
const MAX_DIFF_LINES = 5000
const SIGNATURE_CANCEL_STATES = new Set(['awaiting-pin', 'signing', 'verifying', 'signed-local'])
const SIGNATURE_PROGRESS_STATES = new Set(['awaiting-pin', 'signing', 'verifying', 'signed-local', 'uploading'])
const SIGNATURE_TERMINAL_STATES = new Set(['completed', 'upload-rejected', 'upload-unknown', 'cancelled', 'failed'])
const SIGNATURE_PROFILES = new Set(['PAdES-B-B', 'PAdES-B-T'])
const SIGNATURE_MESSAGES = Object.freeze({
  PKCS11_MISSING: 'Nie znaleziono modułu SimplySign: /usr/local/lib/libSimplySignPKCS.dylib.',
  TOKEN_NOT_READY: 'Zaloguj się lub aktywuj kartę w SimplySign Desktop i ponownie wywołaj podpis z EZD.',
  PIN_INVALID: 'Podany PIN jest nieprawidłowy. Ponownie wywołaj podpis z EZD i spróbuj jeszcze raz.',
  CERTIFICATE_NOT_FOUND: 'SimplySign nie udostępnia certyfikatu wymaganego przez EZD.',
  CERTIFICATE_AMBIGUOUS: 'Znaleziono więcej niż jeden certyfikat pasujący do żądania EZD.',
  PRIVATE_KEY_MISSING: 'Dla wymaganego certyfikatu nie znaleziono klucza prywatnego.',
  PDF_INVALID: 'Dokument przekazany przez EZD nie jest prawidłowym plikiem PDF.',
  PDF_ENCRYPTED: 'Zaszyfrowanego dokumentu PDF nie można podpisać.',
  EXISTING_SIGNATURE_INVALID: 'Dokument zawiera nieprawidłowy wcześniejszy podpis.',
  DOCUMENT_PERMISSIONS_DENIED: 'Uprawnienia dokumentu PDF nie pozwalają dodać podpisu.',
  TSA_UNAVAILABLE: 'Usługa kwalifikowanego znacznika czasu jest niedostępna.',
  TSA_INVALID: 'Nie udało się zweryfikować kwalifikowanego znacznika czasu.',
  CMS_TOO_LARGE: 'Dane podpisu przekroczyły bezpieczny limit dokumentu.',
  SIGNATURE_INVALID: 'Lokalna weryfikacja podpisu nie powiodła się.',
  TIMEOUT: 'Operacja podpisu przekroczyła bezpieczny limit czasu.',
  CANCELLED: 'Operacja podpisu została anulowana.',
  STORE_FAILED: 'Nie można bezpiecznie zapisać lokalnego stanu podpisu.',
  DOWNLOAD_FAILED: 'Nie można pobrać dokumentu do podpisu z EZD.',
  SIGNATURE_FAILED: 'Nie udało się złożyć i zweryfikować podpisu.',
  UPLOAD_REJECTED: 'EZD odrzuciło podpisany dokument.',
  UPLOAD_UNKNOWN: 'Status wysłania nieznany — sprawdź dokument w EZD przed ponowną próbą',
  BUSY: 'Inna operacja podpisu jest już aktywna.',
  REQUEST_NOT_FOUND: 'Nie znaleziono żądania podpisu.',
  APPROVAL_ALREADY_USED: 'To żądanie podpisu zostało już rozstrzygnięte.',
  CANCEL_NOT_ALLOWED: 'Nie można anulować podpisu po rozpoczęciu wysyłania.',
  INVALID_REQUEST: 'Żądanie podpisu jest nieprawidłowe.',
  UNSUPPORTED_MODE: 'Ten tryb podpisu EZD nie jest obsługiwany.',
  PIN_REQUIRED: 'Wprowadź PIN do karty SimplySign.',
})
const GENERIC_SIGNATURE_MESSAGE = 'Operacja podpisu nie powiodła się. Sprawdź stan dokumentu w EZD.'
const signatureUnsubscribers = []

const model = {
  state: null,
  view: 'home',
  activeSessionId: null,
  historyOpen: false,
  editor: null,
  diff: null,
  launchAtLogin: false,
  busy: '',
  toast: null,
  toastTimer: null,
  signature: null,
  updates: { status: 'not-checked' },
  inbox: { enabled: false, status: 'disabled', message: 'Powiadomienia wyłączone.' },
}

const iconPaths = {
  documents: '<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H10l2 2h5.5A2.5 2.5 0 0 1 20 7.5v9A2.5 2.5 0 0 1 17.5 19h-11A2.5 2.5 0 0 1 4 16.5z"/>',
  compare: '<path d="M8 3 4 7l4 4M4 7h11a4 4 0 0 1 4 4v1M16 21l4-4-4-4m4 4H9a4 4 0 0 1-4-4v-1"/>',
  settings: '<path d="M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4Z"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.86 2.86-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6 1.7 1.7 0 0 0-.4 1.1V21H9.6v-.1A1.7 1.7 0 0 0 8.5 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06-2.86-2.86.06-.06A1.7 1.7 0 0 0 4.1 15a1.7 1.7 0 0 0-1.5-1H2.5V10h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.34-1.88l-.06-.06L6.56 4.2l.06.06A1.7 1.7 0 0 0 8.5 4.6a1.7 1.7 0 0 0 1-1.5V3h4v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.88-.34l.06-.06 2.86 2.86-.06.06A1.7 1.7 0 0 0 18.9 9a1.7 1.7 0 0 0 1.5 1h.1v4h-.1a1.7 1.7 0 0 0-1 .99Z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  upload: '<path d="M12 16V4m0 0L7 9m5-5 5 5"/><path d="M5 15v4h14v-4"/>',
  history: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5m4-1v5l3 2"/>',
  file: '<path d="M6 2h8l4 4v16H6z"/><path d="M14 2v5h5"/>',
  edit: '<path d="m4 20 4.5-1 10-10a2.1 2.1 0 0 0-3-3l-10 10zM14 7l3 3"/>',
  external: '<path d="M14 3h7v7m0-7-10 10"/><path d="M18 13v7H4V6h7"/>',
  save: '<path d="M5 3h12l3 3v15H4V3z"/><path d="M8 3v6h8V3M8 21v-7h8v7"/>',
  replace: '<path d="M4 7h11a4 4 0 0 1 4 4v1M8 3 4 7l4 4M20 17H9a4 4 0 0 1-4-4v-1m11 9 4-4-4-4"/>',
  folder: '<path d="M3 6h7l2 2h9v11H3z"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  warning: '<path d="M12 3 2.5 20h19z"/><path d="M12 9v5m0 3h.01"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10h.01"/>',
  shield: '<path d="M12 3 5 6v5c0 5 3 8 7 10 4-2 7-5 7-10V6z"/><path d="m9 12 2 2 4-4"/>',
  power: '<path d="M12 3v9m5.7-6.7a8 8 0 1 1-11.4 0"/>',
  server: '<rect x="3" y="4" width="18" height="6" rx="2"/><rect x="3" y="14" width="18" height="6" rx="2"/><path d="M7 7h.01M7 17h.01"/>',
  storage: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v7c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12v7c0 1.7 3.6 3 8 3s8-1.3 8-3v-7"/>',
  chevron: '<path d="m9 6 6 6-6 6"/>',
}

function icon(name) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${iconPaths[name] || ''}</svg>`
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;')
}

function safeSignatureText(value, maximumLength = 512) {
  if (typeof value !== 'string') return ''
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, maximumLength)
}

function safeSignatureCode(value) {
  return typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(value) ? value : 'UNKNOWN'
}

function signatureMessage(code) {
  return SIGNATURE_MESSAGES[code] || GENERIC_SIGNATURE_MESSAGE
}

function hasPositiveRemoteId(value) {
  return Number.isSafeInteger(value) && value > 0
}

function signatureEventMatches(payload) {
  return Boolean(
    model.signature
      && payload
      && payload.requestId === model.signature.requestId
      && payload.sessionId === model.signature.sessionId,
  )
}

function formatBytes(bytes) {
  const value = Number(bytes || 0)
  if (value < 1024) return `${value} B`
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(value < 10 * 1024 ? 1 : 0)} KB`
  return `${(value / 1024 ** 2).toFixed(value < 10 * 1024 ** 2 ? 1 : 0)} MB`
}

function formatDate(value, { timeOnly = false } = {}) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  if (timeOnly) return new Intl.DateTimeFormat('pl-PL', { hour: '2-digit', minute: '2-digit' }).format(date)
  return new Intl.DateTimeFormat('pl-PL', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}

function currentSession() {
  return model.state?.sessions?.find((session) => session.id === model.activeSessionId) || null
}

function acceptState(nextState) {
  if (!nextState?.sessions || !nextState?.settings) return
  model.state = nextState
  if (!nextState.sessions.some((session) => session.id === model.activeSessionId)) {
    model.activeSessionId = nextState.sessions[0]?.id || null
  }
  if (model.editor && !nextState.sessions.some((session) => session.id === model.editor.sessionId)) {
    model.editor = null
  }
}

function showToast(message, type = 'success') {
  clearTimeout(model.toastTimer)
  model.toast = { message: String(message), type }
  render()
  model.toastTimer = setTimeout(() => {
    model.toast = null
    render()
  }, 4800)
}

async function withBusy(label, operation) {
  if (model.busy) return null
  model.busy = label
  render()
  try {
    return await operation()
  } catch (error) {
    showToast(error?.message || 'Wystąpił nieoczekiwany błąd.', 'error')
    return null
  } finally {
    model.busy = ''
    render()
  }
}

function renderDocumentNavigation() {
  const groups = new Map()
  for (const doc of model.state.documents || []) {
    const mark = doc.caseMark || 'Bez znaku sprawy'
    if (!groups.has(mark)) groups.set(mark, [])
    groups.get(mark).push(doc)
  }
  return `<section class="document-nav" aria-label="Sprawy otwierane z EZD">
    <div class="document-nav-header"><span>Sprawy · otwierane z EZD</span></div>
    <div class="document-nav-list case-tree">${[...groups].map(([mark, docs]) => `
      <details open class="case-group"><summary>${escapeHtml(mark)} <small>${docs.length}</small></summary>
      ${docs.map(doc => {
        const session = model.state.sessions.find(s => s.id === doc.currentSessionId)
        const selected = doc.sessionIds.includes(model.activeSessionId)
        return `<button type="button" class="${selected ? 'selected' : ''}" data-action="select-session" data-session-id="${escapeHtml(doc.currentSessionId)}">
          <span class="mini-file-icon">${escapeHtml(session?.extension || 'PLIK')}</span><span>
          <strong>${escapeHtml(doc.name)}</strong><small>${escapeHtml(doc.conflict ? 'Kilka aktywnych sesji — sprawdź historię' : connectionLabel(session))}</small></span></button>`
      }).join('')}</details>`).join('') || '<p class="document-nav-empty">Otwórz dokument z EZD, aby rozpocząć.</p>'}</div>
    </section>`
}

function renderCompact() {
  const session = homeSession(model.state.sessions)
  const status = compactStatus(session)
  return `<main class="compact-home ${status.tone}" aria-label="Status synchronizacji">
    <div class="transfer-symbol" aria-hidden="true">${icon(status.icon)}</div>
    <h1>${escapeHtml(status.title)}</h1><p class="compact-description">${escapeHtml(status.text)}</p>
    ${session ? `<div class="last-document"><span class="document-glyph">${icon('file')}</span><div><strong>${escapeHtml(session.name)}</strong>
      <small>${escapeHtml(session.remote.caseMark || 'Bez znaku sprawy')}${session.remote.lastUploadAt ? ` · ${formatDate(session.remote.lastUploadAt, { timeOnly: true })}` : ''}</small></div></div>` : '<div class="compact-spacer"></div>'}
    <div class="compact-actions"><button class="button primary" type="button" data-action="latest-details" ${session ? '' : 'disabled'}>Szczegóły ${icon('chevron')}</button>
    <button class="button" type="button" data-action="navigate" data-view="cases">${icon('documents')} Sprawy</button></div>
  </main>`
}

function renderCasesPage() {
  const documents = model.state.documents || []
  return `<section class="page"><div class="page-width"><header class="page-header"><div class="page-header-copy"><h1>Sprawy i dokumenty</h1><p>Jeden wpis na dokument EZD. Lokalne kopie znajdziesz w jego historii.</p></div></header>
    <section class="account-notice"><strong>Pełne konto EZD</strong><p>${escapeHtml(model.state.accountCatalog?.message || 'Pełna lista konta wymaga skonfigurowanego API EZD.')}</p><button class="button" type="button" data-action="open-account">Otwórz konto w EZD ${icon('external')}</button></section>
    <h2 class="known-documents-title">Otwierane z EZD w iBridge</h2>
    ${documents.map(doc => `<button type="button" class="catalog-document" data-action="select-session" data-session-id="${escapeHtml(doc.currentSessionId)}"><span>${icon('file')}</span><span><strong>${escapeHtml(doc.name)}</strong><small>${escapeHtml(doc.caseMark || 'Bez znaku sprawy')} · ${doc.sessionIds.length} ${doc.sessionIds.length === 1 ? 'otwarcie' : 'otwarć'}</small></span>${icon('chevron')}</button>`).join('') || '<p>Nie ma jeszcze dokumentów otwieranych z EZD.</p>'}
    </div></section>`
}

function renderUpdateSettings() {
  const u = model.updates
  const labels = { 'not-checked': 'Nie sprawdzono', checking: 'Sprawdzanie…', current: 'Masz aktualną wersję', available: `Dostępna wersja ${u.latestVersion || ''}`, 'no-releases': 'Brak opublikowanych wydań stabilnych', unavailable: 'Nie można teraz sprawdzić wersji. Spróbuj później.' }
  return `<section class="settings-section"><div class="settings-title">${icon('info')}<div><h2>Aktualizacje</h2><p>Wersja ${APPLICATION_VERSION} · sprawdzanie przy starcie i raz dziennie.</p></div></div><div class="settings-controls"><p role="status">${escapeHtml(labels[u.status] || labels['not-checked'])}</p><div class="header-actions"><button type="button" class="button compact" data-action="check-updates" ${u.status === 'checking' ? 'disabled' : ''}>Sprawdź aktualizacje</button>${u.status === 'available' ? '<button type="button" class="button primary compact" data-action="open-release">Pobierz wydanie</button>' : ''}</div></div></section>`
}

function renderShell() {
  const compact = model.view === 'home' && !model.signature
  root.classList.toggle('compact-root', compact)
  if (compact) return renderCompact()
  const views = [
    ['home', 'check', 'Podsumowanie'],
    ['cases', 'documents', 'Sprawy i dokumenty'],
    ['compare', 'compare', 'Porównaj'],
    ['settings', 'settings', 'Ustawienia'],
  ]
  const navigation = views.map(([view, iconName, label]) => `
    <button type="button" class="nav-item ${model.view === view ? 'active' : ''}" data-action="navigate" data-view="${view}">
      ${icon(iconName)}<span>${label}</span>
    </button>
  `).join('')

  return `
    <div class="app-shell">
      <aside class="nav-rail">
        <div class="brand">
          <img src="./ibridge-puzzle.png" alt="Logo ${APPLICATION_NAME}" />
          <div class="brand-copy">
            <strong>${APPLICATION_NAME}</strong>
            <small>by Emil Kozłowski</small>
          </div>
        </div>
        <nav class="primary-nav" aria-label="Główna nawigacja">${navigation}</nav>
        ${renderDocumentNavigation()}
      </aside>
      <main class="main-surface">${renderMain()}</main>
      <footer class="status-bar">
        <span>${icon('shield')} Synchronizacja z EZD · lokalna historia wersji</span>
        <span class="status-author">Emil Kozłowski (KCKR)</span>
      </footer>
      ${renderToast()}
      ${renderSignatureModal()}
      ${model.busy ? `<div class="busy-overlay"><div class="busy-card"><span class="spinner"></span>${escapeHtml(model.busy)}</div></div>` : ''}
    </div>
  `
}

function renderMain() {
  if (model.view === 'cases') return renderCasesPage()
  if (model.view === 'compare') return renderComparePage()
  if (model.view === 'settings') return renderSettingsPage()
  return renderDocumentsPage()
}

function renderDropZone() {
  return `
    <div class="drop-zone" data-drop-zone>
      <div class="drop-icon">${icon('upload')}</div>
      <div>
        <strong>Przeciągnij dokument tutaj</strong>
        <span>DOCX, ODT, PDF, arkusze, prezentacje i pliki tekstowe do 128 MB</span>
      </div>
      <button type="button" class="button primary" data-action="choose-document">Wybierz plik</button>
    </div>
  `
}

function signatureStatusView(remote) {
  const views = {
    downloading: ['signature-progress', 'Pobieranie dokumentu do podpisu', 'Odczytywanie danych i polityki podpisu z EZD.'],
    'awaiting-pin': ['signature-progress', 'Oczekuje na zatwierdzenie podpisu', 'Wprowadź PIN w bezpiecznym panelu podpisu.'],
    signing: ['signature-progress', 'Składanie podpisu kwalifikowanego', 'SimplySign wykonuje operację kluczem prywatnym.'],
    verifying: ['signature-progress', 'Weryfikacja podpisanego PDF', 'Podpis i integralność dokumentu są sprawdzane lokalnie.'],
    'signed-local': ['signature-progress', 'Podpis zweryfikowany lokalnie', 'Przygotowywanie zweryfikowanej wersji do wysłania.'],
    uploading: ['signature-progress', 'Wysyłanie podpisanego dokumentu', 'Wysyłania do EZD nie można już anulować.'],
    completed: ['signature-completed', 'Podpis wysłany do EZD', 'EZD potwierdziło odebranie podpisanego dokumentu.'],
    'upload-rejected': ['signature-error', 'EZD odrzuciło podpisany dokument', signatureMessage('UPLOAD_REJECTED')],
    'upload-unknown': ['signature-unknown', 'Status wysłania nieznany', signatureMessage('UPLOAD_UNKNOWN')],
    cancelled: ['signature-cancelled', 'Podpis anulowany', signatureMessage('CANCELLED')],
    failed: ['signature-error', 'Podpis nie został złożony', signatureMessage(remote.code)],
  }
  const [className, title, detail] = views[remote.status] || views.failed
  return { className, title, detail }
}

function documentStatus(session) {
  if (session.missing) return { className: 'error', title: 'Nie znaleziono pliku roboczego', detail: 'Użyj „Zmień plik”, aby wskazać zgodny dokument.' }
  if (session.remote?.operation === 'signature') return signatureStatusView(session.remote)
  if (session.remote) return remoteStatusView(session.remote)
  if (session.dirty) return { className: 'changed', title: 'Wykryto niezapisaną zmianę', detail: 'Zapisz wersję, aby utrwalić bieżący stan dokumentu.' }
  return { className: '', title: 'Dokument jest aktualny', detail: 'Zmiany są monitorowane, a wersje mogą być zapisywane automatycznie.' }
}

function renderDocumentsPage() {
  const session = currentSession()
  const drawer = renderHistoryDrawer(session)
  return `
    <section class="documents-page ${model.historyOpen ? 'history-visible' : ''}">
      <div class="documents-content">
        <div class="page-width">
          <header class="page-header">
            <div class="page-header-copy">
              <h1>Szczegóły dokumentu</h1>
              <p>${session ? escapeHtml(session.name) : 'Dodaj dokument lokalny lub otwórz go bezpośrednio z EZD.'}</p>
            </div>
            <div class="header-actions">
              <button type="button" class="button" data-action="toggle-history" aria-expanded="${model.historyOpen}">
                ${icon('history')} Historia wersji${session ? ` (${session.versions.length})` : ''}
              </button>
            </div>
          </header>
          ${session ? renderWorkspace(session) : `${renderDropZone()}${renderEmptyDocuments()}`}
        </div>
      </div>
      ${drawer}
    </section>
  `
}

function renderEmptyDocuments() {
  return `
    <div class="empty-state">
      <div class="empty-state-icon">${icon('file')}</div>
      <h2>Nie ma jeszcze aktywnego dokumentu</h2>
      <p>Dodaj plik powyżej albo uruchom odnośnik protokołu EZD. Dokument pojawi się na liście po lewej — bez dodatkowej rozwijanej listy.</p>
      <button type="button" class="button" data-action="choose-document">${icon('plus')} Dodaj dokument</button>
    </div>
  `
}

function renderCaseBanner(session) {
  if (!session.remote) return ''
  const remote = session.remote
  const canOpen = hasPositiveRemoteId(remote.pismoId)
  const pismoId = canOpen
    ? `<div><dt>Pismo ID</dt><dd>${remote.pismoId}</dd></div>`
    : ''
  const documentId = hasPositiveRemoteId(remote.documentId)
    ? `<div><dt>Dokument ID</dt><dd>${remote.documentId}</dd></div>`
    : ''
  return `
    <section class="case-banner" aria-labelledby="case-banner-title">
      <div class="case-banner-copy">
        <span class="case-banner-label">Sprawa EZD</span>
        <h2 id="case-banner-title" class="case-banner-pismo-name">${escapeHtml(remote.pismoName || session.name)}</h2>
        <span class="case-banner-mark-label">Znak sprawy</span>
        <p class="case-banner-case-mark">${escapeHtml(remote.caseMark || 'Nieprzekazany przez EZD')}</p>
      </div>
      <dl class="case-identifiers">${pismoId}${documentId}</dl>
      <button type="button" class="button primary case-open-button" data-action="open-ezd-case" ${canOpen ? '' : 'disabled'}>
        ${icon('external')} Otwórz sprawę w EZD
      </button>
    </section>
  `
}

function renderWorkspace(session) {
  const status = documentStatus(session)
  const isSignature = session.remote?.operation === 'signature'
  const canEdit = !session.remote || isSignature || session.remote.connectionStatus === 'active'
  const editable = canEdit && !isSignature && EDITABLE_EXTENSIONS.has(String(session.extension).toUpperCase())
  const recentVersions = [...session.versions].reverse().slice(0, 4)
  const activity = recentVersions.map((version, index) => `
    <div class="activity-row ${index === 0 ? 'current' : ''}">
      <span class="activity-dot"></span>
      <time>${formatDate(version.createdAt, { timeOnly: true })}</time>
      <div>
        <strong>${escapeHtml(version.label)}${version.automatic ? ' · automatyczna' : ''}</strong>
        <p>${formatDate(version.createdAt)} · ${formatBytes(version.size)}</p>
      </div>
    </div>
  `).join('')

  const remoteActions = session.remote && !isSignature && session.remote.status !== 'sent' && session.remote.connectionStatus === 'active'
    ? `
      <button type="button" class="button success" data-action="finish-ezd">${icon('check')} Zakończ edycję w EZD</button>
    `
    : ''

  return `
    <article class="workspace">
      ${renderCaseBanner(session)}

      <div class="document-heading">
        <span class="file-icon">${escapeHtml(session.extension || 'PLIK')}</span>
        <div>
          <h2>${escapeHtml(session.name)}</h2>
          <p>${escapeHtml(session.workingPath)}</p>
        </div>
        <button type="button" class="icon-button" data-action="reveal-document" title="Pokaż w Finderze" aria-label="Pokaż w Finderze">${icon('folder')}</button>
      </div>

      ${!session.remote ? renderDropZone() : ''}
      ${session.remote && !isSignature ? `<div class="connection-note"><strong>${escapeHtml(connectionLabel(session))}</strong><span>${escapeHtml(session.remote.editorState === 'unknown' && canEdit ? 'Wysyłanie jest automatyczne. Po pracy wybierz Zakończ edycję.' : !canEdit ? 'Ta kopia jest historyczna. Nową edycję rozpocznij w EZD.' : 'Każdy stabilny zapis wysyłamy automatycznie.')}</span></div>` : ''}

      <section class="actions-card file-work-card" aria-labelledby="file-work-title">
        <h3 id="file-work-title">Praca z plikiem</h3>
        <div class="file-work-toolbar" data-file-work-toolbar role="group" aria-labelledby="file-work-title">
          ${editable ? `<button type="button" class="button primary" data-action="edit-document">${icon('edit')} Edytuj w aplikacji</button>` : ''}
          ${canEdit ? `<button type="button" class="button ${editable ? '' : 'primary'}" data-action="open-external">${icon('external')} Otwórz w edytorze</button>` : ''}
          ${isSignature || !canEdit ? '' : `<button type="button" class="button" data-action="replace-document">${icon('replace')} Zmień plik</button>`}
          ${isSignature || !canEdit ? '' : `<button type="button" class="button" data-action="save-version">${icon('save')} Zapisz wersję</button>`}
          ${remoteActions}
        </div>
        <dl class="file-details">
          <div><dt>Format</dt><dd>${escapeHtml(session.extension)}</dd></div>
          <div><dt>Rozmiar</dt><dd>${formatBytes(session.size)}</dd></div>
          <div><dt>Wersje</dt><dd>${session.versions.length}</dd></div>
          <div><dt>Źródło</dt><dd>${session.remote ? 'EZD' : 'Lokalne'}</dd></div>
        </dl>
      </section>

      <div class="document-status ${status.className}">
        <span class="status-dot"></span>
        <div><strong>${escapeHtml(status.title)}</strong><p>${escapeHtml(status.detail)}</p></div>
      </div>

      <section class="workspace-card">
        <h3>Ostatnia aktywność</h3>
        <div class="activity-list">${activity}</div>
      </section>
      ${model.editor?.sessionId === session.id ? renderEditor(session) : ''}
    </article>
  `
}

function renderEditor(session) {
  const editor = model.editor
  const dirty = editor.text !== editor.originalText
  return `
    <section class="editor-card" aria-label="Edytor dokumentu">
      <header class="editor-header">
        <div>
          <strong>Edycja: ${escapeHtml(session.name)}</strong>
          <small id="editor-state" class="${dirty ? 'editor-dirty' : ''}">${dirty ? 'Niezapisane zmiany' : 'Wszystkie zmiany zapisane'}</small>
        </div>
        <div class="editor-actions">
          <button type="button" class="button compact" data-action="close-editor">Zamknij</button>
          <button type="button" class="button primary compact" data-action="save-editor" ${dirty ? '' : 'disabled'}>${icon('save')} Zapisz jako wersję</button>
        </div>
      </header>
      <textarea class="document-editor" data-document-editor spellcheck="true" aria-label="Treść dokumentu">${escapeHtml(editor.text)}</textarea>
      <footer class="editor-footer">
        <span>UTF-8 · skrót zapisu ⌘S</span>
        <span id="editor-count">${editor.text.length.toLocaleString('pl-PL')} znaków</span>
      </footer>
    </section>
  `
}

function renderHistoryDrawer(session) {
  const related = (model.state.documents || []).find(d => d.sessionIds.includes(session?.id))
  const previous = (related?.sessionIds || []).map(id => model.state.sessions.find(s => s.id === id)).filter(s => s && s.id !== session?.id)
  const versions = session ? [...session.versions].reverse() : []
  const rows = versions.map((version, index) => `
    <button type="button" class="version-row ${index === 0 ? 'latest' : ''}" data-action="reveal-version" data-version-id="${escapeHtml(version.id)}">
      <span class="version-icon">${icon('file')}</span>
      <span class="version-copy">
        <strong>${escapeHtml(version.label)}${index === 0 ? ' · najnowsza' : ''}</strong>
        <small>${formatDate(version.createdAt)}${version.automatic ? ' · auto' : ''}</small>
      </span>
      <span class="version-size">${formatBytes(version.size)}</span>
    </button>
  `).join('')

  return `
    <aside class="history-drawer ${model.historyOpen ? 'open' : ''}" aria-hidden="${!model.historyOpen}">
      <div class="history-inner">
        <header class="history-header">
          <div class="history-title"><h2>Historia wersji</h2><span class="count-badge">${versions.length}</span></div>
          <button type="button" class="icon-button" data-action="toggle-history" title="Zamknij historię" aria-label="Zamknij historię">${icon('close')}</button>
        </header>
        <div class="history-list">
          ${rows || '<p class="history-empty">Wybierz dokument, aby zobaczyć jego wersje.</p>'}
        </div>
        ${previous.map(s => `<div class="previous-session"><button type="button" class="button compact" data-action="select-session" data-session-id="${escapeHtml(s.id)}">${escapeHtml(formatDate(s.createdAt))} · ${escapeHtml(connectionLabel(s))}</button></div>`).join('')}
        ${session && !session.remote ? `<footer class="history-footer"><button type="button" class="button wide" data-action="save-version">${icon('save')} Zapisz bieżącą wersję</button></footer>` : ''}
      </div>
    </aside>
  `
}

function renderComparePage() {
  return `
    <section class="page">
      <div class="page-width">
        <header class="page-header">
          <div class="page-header-copy"><h1>Porównaj dokumenty</h1><p>Sprawdź różnice między wersjami lub dwoma wybranymi plikami.</p></div>
          <div class="header-actions">
            ${currentSession() ? `<button type="button" class="button" data-action="compare-active">Porównaj aktywny z oryginałem</button>` : ''}
            <button type="button" class="button primary" data-action="compare-files">${icon('compare')} Wybierz dwa pliki</button>
          </div>
        </header>
        ${model.diff ? renderDiff() : `
          <div class="empty-state">
            <div class="empty-state-icon">${icon('compare')}</div>
            <h2>Wybierz dokumenty do porównania</h2>
            <p>Obsługiwane są DOCX, ODT, RTF, TXT, Markdown, CSV, XML i HTML. Analiza odbywa się lokalnie.</p>
            <button type="button" class="button" data-action="compare-files">Wybierz dwa pliki</button>
          </div>
        `}
      </div>
    </section>
  `
}

function renderDiff() {
  let renderedLines = 0
  let truncated = false
  const output = []
  for (const part of model.diff.changes || []) {
    const lines = String(part.value || '').split('\n')
    if (lines.at(-1) === '') lines.pop()
    for (const line of lines) {
      if (renderedLines >= MAX_DIFF_LINES) {
        truncated = true
        break
      }
      const className = part.type === 'added' ? 'added' : part.type === 'removed' ? 'removed' : ''
      const sign = part.type === 'added' ? '+' : part.type === 'removed' ? '−' : '·'
      output.push(`<div class="diff-line ${className}"><span class="diff-sign">${sign}</span><code>${escapeHtml(line || ' ')}</code></div>`)
      renderedLines += 1
    }
    if (truncated) break
  }

  return `
    <div class="diff-card">
      <div class="diff-toolbar">
        <div class="diff-files">
          <div><small>Wersja bazowa</small><strong>${escapeHtml(model.diff.originalName)}</strong></div>
          <span class="diff-arrow">→</span>
          <div><small>Wersja porównywana</small><strong>${escapeHtml(model.diff.changedName)}</strong></div>
        </div>
        <div class="diff-summary">
          <span class="diff-removed-count">− ${Number(model.diff.summary?.removed || 0)}</span>
          <span class="diff-added-count">+ ${Number(model.diff.summary?.added || 0)}</span>
        </div>
      </div>
      <div class="diff-content">${output.join('')}${truncated ? '<p class="diff-truncated">Widok skrócono do 5000 linii, aby zachować płynność aplikacji.</p>' : ''}</div>
    </div>
  `
}

function renderSettingsPage() {
  const settings = model.state.settings
  const automaticEditor = settings.editorMode !== 'custom'
  return `
    <section class="page">
      <div class="page-width">
        <header class="page-header">
          <div class="page-header-copy"><h1>Ustawienia</h1><p>Domyślna konfiguracja jest gotowa do pracy od pierwszego uruchomienia.</p></div>
        </header>
        <div class="settings-grid">
          ${renderUpdateSettings()}
          <section class="settings-section">
            <div class="settings-title">${icon('info')}<div><h2>Powiadomienia z EZD</h2><p>iBridge sam sprawdza folder Nowe i powiadomienia EZD w tle, bez uruchamiania przeglądarki.</p></div></div>
            <div class="settings-controls">
              <label class="toggle-row">
                <span class="toggle-copy"><strong>Powiadomienia macOS o nowych pismach i zdarzeniach</strong><small>Co 60 sekund, gdy iBridge jest uruchomiony. Pierwszy odczyt tworzy stan początkowy.</small></span>
                <input type="checkbox" data-setting="inbox-enabled" ${model.inbox.enabled ? 'checked' : ''} />
                <span class="toggle"></span>
              </label>
              <p role="status">${escapeHtml(model.inbox.message)}</p>
              ${model.inbox.account ? `<p><strong>Konto:</strong> ${escapeHtml(model.inbox.account)}</p>` : ''}
              ${model.inbox.lastCheckAt ? `<p>Ostatni poprawny odczyt: ${escapeHtml(formatDate(model.inbox.lastCheckAt))} · Nowe: ${model.inbox.count}</p>` : ''}
              <div class="header-actions">
                <button type="button" class="button compact" data-action="inbox-login">Zaloguj do EZD</button>
                <button type="button" class="button compact" data-action="inbox-check" ${!model.inbox.enabled ? 'disabled' : ''}>Sprawdź teraz</button>
                ${model.inbox.status === 'account-changed' ? '<button type="button" class="button compact" data-action="inbox-rebind">Użyj bieżącego konta</button>' : ''}
              </div>
              <p>Po zalogowaniu możesz zamknąć okno EZD. Sesja EZD jest przechowywana w iBridge; po jej wygaśnięciu zaloguj się ponownie.</p>
            </div>
          </section>
          <section class="settings-section">
            <div class="settings-title">${icon('power')}<div><h2>Uruchamianie</h2><p>Aplikacja może czekać w tle na odnośniki EZD.</p></div></div>
            <div class="settings-controls">
              <label class="toggle-row">
                <span class="toggle-copy"><strong>Uruchamiaj razem z systemem</strong><small>Po zalogowaniu aplikacja uruchomi się w tle, bez otwierania okna.</small></span>
                <input type="checkbox" data-setting="launch-at-login" ${model.launchAtLogin ? 'checked' : ''} />
                <span class="toggle"></span>
              </label>
            </div>
          </section>

          <section class="settings-section">
            <div class="settings-title">${icon('server')}<div><h2>${APPLICATION_NAME}</h2><p>Obsługa protokołów most-ezd: i ezd: oraz połączenia SOAP.</p></div></div>
            <div class="settings-controls">
              <label class="toggle-row">
                <span class="toggle-copy"><strong>Przyjmuj wywołania protokołu EZD</strong><small>Włączone domyślnie, aby odnośniki EZD działały od razu.</small></span>
                <input type="checkbox" data-setting="accept-protocol" ${settings.acceptLegacyProtocol !== false ? 'checked' : ''} />
                <span class="toggle"></span>
              </label>
              <label class="field-label">
                <span>ADRES USŁUGI</span>
                <span class="field-with-button">
                  <input class="text-input" type="url" value="${escapeHtml(settings.serviceUrl)}" data-setting="service-url" spellcheck="false" />
                  <button type="button" class="button compact" data-action="test-service">Testuj</button>
                </span>
              </label>
              <div class="security-note">${icon('shield')}<div><strong>Bezpieczne połączenie</strong><p>Token sesji pozostaje wyłącznie w pamięci procesu i nie jest zapisywany w historii ani plikach ustawień.</p></div></div>
            </div>
          </section>

          <section class="settings-section">
            <div class="settings-title">${icon('history')}<div><h2>Wersjonowanie</h2><p>Każda edycja może automatycznie utworzyć kopię w historii.</p></div></div>
            <div class="settings-controls">
              <label class="toggle-row">
                <span class="toggle-copy"><strong>Automatycznie zapisuj wersje</strong><small>Po wykryciu zmiany aplikacja tworzy wersję po krótkiej chwili bezczynności.</small></span>
                <input type="checkbox" data-setting="automatic-versions" ${settings.automaticVersions !== false ? 'checked' : ''} />
                <span class="toggle"></span>
              </label>
            </div>
          </section>

          <section class="settings-section">
            <div class="settings-title">${icon('edit')}<div><h2>Edytor zewnętrzny</h2><p>Pliki tekstowe można zmieniać w aplikacji; inne formaty otwierają się w programie systemowym.</p></div></div>
            <div class="settings-controls">
              <div class="radio-list">
                <label class="radio-row ${automaticEditor ? 'selected' : ''}">
                  <input type="radio" name="editor-mode" value="automatic" data-setting="editor-mode" ${automaticEditor ? 'checked' : ''} />
                  <span><strong>Automatyczny</strong><small>macOS wybiera Word, LibreOffice lub właściwy program.</small></span>
                </label>
                <label class="radio-row ${!automaticEditor ? 'selected' : ''}">
                  <input type="radio" name="editor-mode" value="custom" data-setting="editor-mode" ${!automaticEditor ? 'checked' : ''} />
                  <span><strong>Wybrany program</strong><small>${escapeHtml(settings.editorPath || 'Nie wybrano programu')}</small></span>
                  <button type="button" class="button compact" data-action="choose-editor">Wybierz</button>
                </label>
              </div>
            </div>
          </section>

          <section class="settings-section">
            <div class="settings-title">${icon('storage')}<div><h2>Dane aplikacji</h2><p>Dokumenty robocze i wersje są przechowywane lokalnie.</p></div></div>
            <div class="settings-controls">
              <code class="storage-path" title="${escapeHtml(model.state.storagePath)}">${escapeHtml(model.state.storagePath)}</code>
              <button type="button" class="button compact" data-action="reveal-storage">${icon('folder')} Pokaż w Finderze</button>
              <span class="toggle-copy"><small>${APPLICATION_NAME} ${APPLICATION_VERSION} · Emil Kozłowski (KCKR)</small></span>
            </div>
          </section>
        </div>
      </div>
    </section>
  `
}

function signatureStateMessage(signature) {
  if (signature.state === 'upload-unknown') return SIGNATURE_MESSAGES.UPLOAD_UNKNOWN
  if (signature.terminalCode) return signatureMessage(signature.terminalCode)
  const messages = {
    'awaiting-pin': 'Sprawdź dane operacji i wprowadź PIN do karty SimplySign.',
    signing: 'SimplySign składa podpis kwalifikowany. Możesz anulować operację przed wysyłką.',
    verifying: 'Podpisany PDF jest weryfikowany lokalnie przed wysłaniem.',
    'signed-local': 'Podpis jest poprawny. Trwa przygotowanie zweryfikowanych danych do wysłania.',
    uploading: 'Podpisany dokument jest wysyłany do EZD. Tej operacji nie można już anulować.',
    completed: 'EZD potwierdziło odebranie podpisanego dokumentu.',
    'upload-rejected': SIGNATURE_MESSAGES.UPLOAD_REJECTED,
    cancelled: SIGNATURE_MESSAGES.CANCELLED,
    failed: GENERIC_SIGNATURE_MESSAGE,
  }
  return messages[signature.state] || GENERIC_SIGNATURE_MESSAGE
}

function renderSignatureModal() {
  const signature = model.signature
  if (!signature) return ''
  const cancelAllowed = SIGNATURE_CANCEL_STATES.has(signature.state)
  const terminal = SIGNATURE_TERMINAL_STATES.has(signature.state)
  const pinRequired = signature.state === 'awaiting-pin'
  const stateSteps = ['awaiting-pin', 'signing', 'verifying', 'signed-local', 'uploading', 'completed']
  const step = Math.max(0, stateSteps.indexOf(signature.state))
  const progress = Math.round((step / (stateSteps.length - 1)) * 100)
  const verified = signature.subject && signature.profile
    ? `
      <section class="signature-verified" aria-label="Zweryfikowany podpis">
        <strong>Podpis zweryfikowany</strong>
        <dl>
          <div><dt>Podpisujący</dt><dd>${escapeHtml(signature.subject)}</dd></div>
          <div><dt>Profil</dt><dd>${escapeHtml(signature.profile)}</dd></div>
        </dl>
      </section>
    `
    : ''

  return `
    <div class="signature-modal" data-signature-state="${escapeHtml(signature.state)}">
      <div class="signature-dialog" role="dialog" aria-modal="true" aria-labelledby="signature-dialog-title">
        <header class="signature-dialog-header">
          <span class="signature-dialog-icon">${icon('shield')}</span>
          <div>
            <span>Podpis kwalifikowany</span>
            <h2 id="signature-dialog-title">Podpisz dokument dla EZD</h2>
          </div>
        </header>

        <dl class="signature-metadata">
          <div><dt>Dokument</dt><dd>${escapeHtml(signature.fileName || 'Dokument PDF')}</dd></div>
          <div><dt>Znak sprawy</dt><dd>${escapeHtml(signature.caseMark || 'Brak znaku sprawy')}</dd></div>
          <div><dt>Nazwa sprawy/pisma</dt><dd>${escapeHtml(signature.pismoName || signature.fileName || 'Dokument EZD')}</dd></div>
          <div><dt>Oczekiwany certyfikat</dt><dd><code>${escapeHtml(signature.certificateSerial || 'Brak numeru')}</code></dd></div>
          <div><dt>Tryb</dt><dd>${signature.mode === 9 ? 'Podpis widoczny' : 'Podpis niewidoczny'}</dd></div>
          <div><dt>Znacznik czasu</dt><dd>Kwalifikowany znacznik czasu: ${signature.includeTimestamp ? 'wymagany' : 'niewymagany'}</dd></div>
        </dl>

        <section class="signature-status signature-status-${escapeHtml(signature.state)}" role="status">
          <div class="signature-status-heading"><strong>${escapeHtml(signature.state === 'upload-unknown' ? 'Wymagana kontrola w EZD' : 'Stan operacji')}</strong><span>${progress}%</span></div>
          <div class="signature-progress progress-${step}" role="progressbar" aria-label="Postęp podpisu" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${progress}"><span></span></div>
          <p>${escapeHtml(signatureStateMessage(signature))}</p>
        </section>

        ${verified}

        ${pinRequired ? `
          <label class="signature-pin-field" for="signature-pin">
            <span>PIN SimplySign</span>
            <input id="signature-pin" type="password" autocomplete="off" spellcheck="false" data-signature-pin ${signature.submitting ? 'disabled' : ''} />
            <small>PIN jest przekazywany wyłącznie do lokalnego modułu podpisu i nie jest zapisywany.</small>
          </label>
        ` : ''}

        <footer class="signature-dialog-actions">
          ${cancelAllowed ? `<button type="button" class="button" data-action="cancel-signature" ${signature.cancelling ? 'disabled' : ''}>Anuluj podpis</button>` : ''}
          ${terminal ? '<button type="button" class="button" data-action="dismiss-signature">Zamknij</button>' : ''}
          ${pinRequired ? `<button type="button" class="button primary" data-action="approve-signature" ${signature.submitting ? 'disabled' : ''}>${signature.submitting ? 'Podpisywanie…' : 'Podpisz kwalifikowanym podpisem'}</button>` : ''}
        </footer>
      </div>
    </div>
  `
}

function renderToast() {
  if (!model.toast) return ''
  const toastIcon = model.toast.type === 'error' ? 'warning' : model.toast.type === 'warning' ? 'info' : 'check'
  return `
    <div class="toast ${escapeHtml(model.toast.type)}" role="status">
      ${icon(toastIcon)}
      <span>${escapeHtml(model.toast.message)}</span>
      <button type="button" class="icon-button" data-action="close-toast" aria-label="Zamknij">${icon('close')}</button>
    </div>
  `
}

function render() {
  if (!model.state) return
  root.innerHTML = renderShell()
}

async function chooseDocument() {
  const state = await api.chooseDocument()
  if (!state) return
  acceptState(state)
  model.activeSessionId = state.sessions[0]?.id || model.activeSessionId
  model.view = 'documents'
  showToast('Dokument został dodany.')
}

async function importDroppedFile(file) {
  const filePath = api.getPathForFile(file)
  if (!filePath) throw new Error('Nie udało się odczytać ścieżki upuszczonego pliku.')
  const state = await api.importPath(filePath)
  acceptState(state)
  model.activeSessionId = state.sessions[0]?.id || model.activeSessionId
  model.view = 'documents'
  showToast('Dokument został dodany.')
}

async function saveCurrentVersion() {
  const session = currentSession()
  if (!session) return
  const result = await api.saveVersion(session.id)
  if (!result) return
  acceptState(result.state)
  showToast(result.created ? 'Zapisano nową wersję.' : 'Bieżąca wersja jest już zapisana.')
}

async function saveEditor() {
  if (!model.editor) return
  const result = await api.saveEditableDocument(model.editor.sessionId, model.editor.text)
  if (!result) return
  acceptState(result.state)
  model.editor.originalText = model.editor.text
  showToast(result.created ? 'Zapisano treść jako nową wersję.' : 'Treść nie uległa zmianie.')
}

function closeEditor() {
  if (!model.editor) return
  if (model.editor.text !== model.editor.originalText && !window.confirm('Zamknąć edytor i odrzucić niezapisane zmiany?')) return
  model.editor = null
  render()
}

function handleSignatureRequested(payload) {
  model.view = 'documents'
  api.setWindowMode('details').catch(() => {})
  if (!payload || typeof payload !== 'object') return
  const requestId = safeSignatureText(payload.requestId, 128)
  const sessionId = safeSignatureText(payload.sessionId, 128)
  if (!requestId || !sessionId) return
  model.signature = {
    requestId,
    sessionId,
    fileName: safeSignatureText(payload.fileName),
    caseMark: safeSignatureText(payload.caseMark),
    pismoName: safeSignatureText(payload.pismoName),
    certificateSerial: safeSignatureText(payload.expectedCertificateSerial, 256),
    mode: payload.mode === 9 ? 9 : 6,
    includeTimestamp: payload.includeTimestamp === true,
    state: 'awaiting-pin',
    submitting: false,
    cancelling: false,
    terminalCode: '',
    subject: '',
    profile: '',
  }
  if (model.state?.sessions?.some((session) => session.id === sessionId)) {
    model.activeSessionId = sessionId
    model.view = 'documents'
  }
  render()
  queueMicrotask(() => root.querySelector('[data-signature-pin]')?.focus())
}

function handleSignatureProgress(payload) {
  if (!signatureEventMatches(payload) || !SIGNATURE_PROGRESS_STATES.has(payload.status)) return
  model.signature.state = payload.status
  model.signature.terminalCode = ''
  render()
}

function handleSignatureFinished(payload) {
  if (!signatureEventMatches(payload) || !SIGNATURE_TERMINAL_STATES.has(payload.status)) return
  const code = safeSignatureCode(payload.code)
  const successful = payload.status === 'completed' && code === 'OK'
  model.signature.state = payload.status
  model.signature.submitting = false
  model.signature.cancelling = false
  model.signature.terminalCode = successful ? '' : code
  model.signature.subject = successful ? safeSignatureText(payload.subject) : ''
  model.signature.profile = successful && SIGNATURE_PROFILES.has(payload.profile) ? payload.profile : ''
  render()
}

function trapSignatureFocus(event) {
  if (event.key !== 'Tab' || !model.signature || !SIGNATURE_CANCEL_STATES.has(model.signature.state)) {
    return false
  }
  const controls = [...root.querySelectorAll(
    '.signature-dialog button:not([disabled]), .signature-dialog input:not([disabled]), .signature-dialog [tabindex="0"]',
  )]
  if (!controls.length) return false
  const first = controls[0]
  const last = controls.at(-1)
  const active = document.activeElement
  if (!controls.includes(active) || (event.shiftKey && active === first) || (!event.shiftKey && active === last)) {
    event.preventDefault()
    ;(event.shiftKey ? last : first).focus()
    return true
  }
  return false
}

async function approveCurrentSignature() {
  const signature = model.signature
  if (!signature || signature.state !== 'awaiting-pin' || signature.submitting) return
  signature.submitting = true
  signature.terminalCode = ''
  const requestId = signature.requestId
  const input = root.querySelector('[data-signature-pin]')
  if (!input) {
    signature.submitting = false
    render()
    return
  }
  let pin = input.value
  input.value = ''
  input.disabled = true
  render()
  try {
    if (!pin) {
      if (model.signature?.requestId === requestId) {
        model.signature.submitting = false
        model.signature.terminalCode = 'PIN_REQUIRED'
        render()
      }
      return
    }
    await api.approveSignature(requestId, pin)
  } catch (error) {
    const current = model.signature
    if (current?.requestId === requestId && !SIGNATURE_TERMINAL_STATES.has(current.state)) {
      current.state = 'failed'
      current.submitting = false
      current.terminalCode = safeSignatureCode(error?.code)
      current.subject = ''
      current.profile = ''
      render()
    }
  } finally {
    pin = ''
    const current = model.signature
    if (current?.requestId === requestId && current.state === 'awaiting-pin') {
      current.submitting = false
      render()
    }
  }
}

async function cancelCurrentSignature() {
  const signature = model.signature
  if (!signature || !SIGNATURE_CANCEL_STATES.has(signature.state) || signature.cancelling) return
  signature.cancelling = true
  const requestId = signature.requestId
  render()
  try {
    await api.cancelSignature(requestId)
  } catch (error) {
    const current = model.signature
    if (current?.requestId === requestId && SIGNATURE_CANCEL_STATES.has(current.state)) {
      current.state = 'failed'
      current.terminalCode = safeSignatureCode(error?.code)
      current.subject = ''
      current.profile = ''
    }
  } finally {
    const current = model.signature
    if (current?.requestId === requestId) current.cancelling = false
    render()
  }
}

root.addEventListener('click', async (event) => {
  const control = event.target.closest('[data-action]')
  if (!control) return
  const action = control.dataset.action

  if (action === 'latest-details') {
    const latest = homeSession(model.state.sessions)
    model.activeSessionId = latest?.id || null
    model.view = 'documents'
    await api.setWindowMode('details')
    render()
    return
  }
  if (action === 'open-account') { await api.openEzdAccount(); return }
  if (action === 'check-updates') { model.updates = await api.checkUpdates(); render(); return }
  if (action === 'open-release') { await api.openRelease(); return }
  if (action === 'navigate') {
    model.view = control.dataset.view
    await api.setWindowMode(model.view === 'home' ? 'compact' : 'details')
    render()
    return
  }
  if (action === 'select-session') {
    if (model.editor && model.editor.text !== model.editor.originalText && model.editor.sessionId !== control.dataset.sessionId) {
      if (!window.confirm('Zmienić dokument i odrzucić niezapisane zmiany w edytorze?')) return
    }
    model.activeSessionId = control.dataset.sessionId
    model.editor = null
    model.view = 'documents'
    await api.setWindowMode('details')
    render()
    return
  }
  if (action === 'toggle-history') {
    model.historyOpen = !model.historyOpen
    render()
    return
  }
  if (action === 'close-toast') {
    clearTimeout(model.toastTimer)
    model.toast = null
    render()
    return
  }
  if (action === 'close-editor') {
    closeEditor()
    return
  }
  if (action === 'approve-signature') return approveCurrentSignature()
  if (action === 'cancel-signature') return cancelCurrentSignature()
  if (action === 'dismiss-signature') {
    if (model.signature && SIGNATURE_TERMINAL_STATES.has(model.signature.state)) {
      model.signature = null
      render()
    }
    return
  }

  await withBusy('Proszę czekać…', async () => {
    const session = currentSession()
    if (action === 'choose-document') return chooseDocument()
    if (action === 'open-ezd-case' && session?.remote && hasPositiveRemoteId(session.remote.pismoId)) {
      await api.openEzdCase(session.id)
    } else if (action === 'open-external' && session) {
      await api.openInEditor(session.id)
      showToast('Dokument otwarto w przypisanym edytorze.')
    } else if (action === 'edit-document' && session) {
      const document = await api.readEditableDocument(session.id)
      model.editor = { sessionId: session.id, text: document.text, originalText: document.text }
      model.view = 'documents'
    } else if (action === 'save-editor') {
      await saveEditor()
    } else if (action === 'replace-document' && session) {
      const result = await api.replaceDocument(session.id)
      if (result) {
        acceptState(result.state)
        model.editor = null
        showToast('Plik roboczy został zmieniony, a poprzednia zawartość zachowana w historii.')
      }
    } else if (action === 'save-version') {
      await saveCurrentVersion()
    } else if (action === 'sync-ezd' && session) {
      const state = await api.syncToEzd(session.id)
      if (state) {
        acceptState(state)
        showToast('Dokument został zsynchronizowany z EZD.')
      }
    } else if (action === 'finish-ezd' && session) {
      const state = await api.finishEzdSession(session.id)
      if (state) {
        acceptState(state)
        if (state.sessions.find(s => s.id === session.id)?.remote?.status === 'sent') showToast('Edycja została zakończona.')
      }
    } else if (action === 'reveal-document' && session) {
      await api.revealDocument(session.id)
    } else if (action === 'reveal-version' && session) {
      await api.revealDocument(session.id, control.dataset.versionId)
    } else if (action === 'compare-active' && session) {
      model.diff = await api.compareSession(session.id)
    } else if (action === 'compare-files') {
      const diff = await api.chooseCompareFiles()
      if (diff) model.diff = diff
    } else if (action === 'choose-editor') {
      const editorPath = await api.chooseEditor()
      if (editorPath) acceptState(await api.updateSettings({ editorMode: 'custom', editorPath }))
    } else if (action === 'test-service') {
      const value = root.querySelector('[data-setting="service-url"]')?.value || ''
      const result = await api.testService(value)
      showToast(result.ok ? `Usługa odpowiada (HTTP ${result.status}).` : `Usługa zwróciła HTTP ${result.status}.`, result.ok ? 'success' : 'warning')
    } else if (action === 'inbox-login') {
      await api.loginInbox()
    } else if (action === 'inbox-check') {
      model.inbox = await api.checkInbox()
    } else if (action === 'inbox-rebind') {
      model.inbox = await api.rebindInbox()
    } else if (action === 'reveal-storage') {
      await api.revealStorage()
    }
  })
})

root.addEventListener('change', async (event) => {
  const control = event.target.closest('[data-setting]')
  if (!control) return
  const setting = control.dataset.setting
  await withBusy('Zapisywanie ustawienia…', async () => {
    if (setting === 'launch-at-login') {
      const result = await api.setLaunchAtLogin(control.checked)
      model.launchAtLogin = result.enabled
      acceptState(result.state)
      showToast(result.enabled ? 'Autostart został włączony.' : 'Autostart został wyłączony.')
    } else if (setting === 'inbox-enabled') {
      model.inbox = await api.setInboxEnabled(control.checked)
    } else if (setting === 'accept-protocol') {
      acceptState(await api.updateSettings({ acceptLegacyProtocol: control.checked }))
    } else if (setting === 'automatic-versions') {
      acceptState(await api.updateSettings({ automaticVersions: control.checked }))
    } else if (setting === 'service-url') {
      acceptState(await api.updateSettings({ serviceUrl: control.value.trim() }))
    } else if (setting === 'editor-mode') {
      acceptState(await api.updateSettings({ editorMode: control.value }))
    }
  })
})

root.addEventListener('input', (event) => {
  if (!event.target.matches('[data-document-editor]') || !model.editor) return
  model.editor.text = event.target.value
  const dirty = model.editor.text !== model.editor.originalText
  const stateLabel = root.querySelector('#editor-state')
  const countLabel = root.querySelector('#editor-count')
  const saveButton = root.querySelector('[data-action="save-editor"]')
  if (stateLabel) {
    stateLabel.textContent = dirty ? 'Niezapisane zmiany' : 'Wszystkie zmiany zapisane'
    stateLabel.classList.toggle('editor-dirty', dirty)
  }
  if (countLabel) countLabel.textContent = `${model.editor.text.length.toLocaleString('pl-PL')} znaków`
  if (saveButton) saveButton.disabled = !dirty
})

root.addEventListener('dragover', (event) => {
  const zone = event.target.closest('[data-drop-zone]')
  if (!zone) return
  event.preventDefault()
  zone.classList.add('dragging')
})

root.addEventListener('dragleave', (event) => {
  event.target.closest('[data-drop-zone]')?.classList.remove('dragging')
})

root.addEventListener('drop', async (event) => {
  const zone = event.target.closest('[data-drop-zone]')
  if (!zone) return
  event.preventDefault()
  zone.classList.remove('dragging')
  const file = event.dataTransfer?.files?.[0]
  if (!file) return
  await withBusy('Dodawanie dokumentu…', () => importDroppedFile(file))
})

window.addEventListener('keydown', async (event) => {
  if (trapSignatureFocus(event)) return
  if (event.key === 'Escape' && model.signature && SIGNATURE_CANCEL_STATES.has(model.signature.state)) {
    event.preventDefault()
    await cancelCurrentSignature()
    return
  }
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's' && model.editor) {
    event.preventDefault()
    if (model.editor.text !== model.editor.originalText) {
      await withBusy('Zapisywanie dokumentu…', saveEditor)
    }
  }
})

window.addEventListener('beforeunload', (event) => {
  if (model.editor && model.editor.text !== model.editor.originalText) {
    event.preventDefault()
    event.returnValue = ''
  }
})

function clearSignatureSubscriptions() {
  while (signatureUnsubscribers.length) {
    const unsubscribe = signatureUnsubscribers.pop()
    try { unsubscribe() } catch {}
  }
}

window.addEventListener('unload', clearSignatureSubscriptions)

async function initialize() {
  if (!api) throw new Error('Most aplikacji nie został załadowany.')
  try {
    for (const [method, handler] of [
      ['onSignatureRequested', handleSignatureRequested],
      ['onSignatureProgress', handleSignatureProgress],
      ['onSignatureFinished', handleSignatureFinished],
    ]) {
      const unsubscribe = api[method](handler)
      if (typeof unsubscribe === 'function') signatureUnsubscribers.push(unsubscribe)
    }

    const [state, loginItem] = await Promise.all([
      api.getState(),
      api.getLaunchAtLogin().catch(() => ({ enabled: false })),
    ])
    acceptState(state)
    model.launchAtLogin = Boolean(loginItem.enabled)
    render()

    api.onStateChanged((event) => {
      acceptState(event.state)
      render()
    })
    api.onProtocolMessage((message) => {
      if (message.type === 'error' || message.type === 'warning') showToast(message.message || 'Sprawdź stan sesji.', message.type)
    })
    model.updates = await api.getUpdates()
    model.inbox = await api.getInbox()
    api.onInboxChanged(inbox => { model.inbox = inbox; if (model.view === 'settings') render() })
    api.onUpdatesChanged(updates => { model.updates = updates; if (model.view === 'settings') render() })
  } catch (error) {
    clearSignatureSubscriptions()
    throw error
  }
}

initialize().catch((error) => {
  root.innerHTML = `<div class="loading-screen"><img src="./ibridge-puzzle.png" alt="" /><p>${escapeHtml(error.message || 'Nie udało się uruchomić aplikacji.')}</p></div>`
})
