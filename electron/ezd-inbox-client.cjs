const { DOMParser } = require('@xmldom/xmldom')

const EZD_ORIGIN = 'https://ezd.kg.straz.gov.pl'
const INBOX_URL = `${EZD_ORIGIN}/FolderPism.aspx?Status=1`
const MAX_ITEMS = 50_000

class InboxError extends Error {
  constructor(code) { super(code); this.code = code }
}

function text(value, limit = 240) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit)
}

function positiveId(value) {
  const raw = String(value ?? '')
  if (!/^[1-9]\d{0,15}$/.test(raw) || !Number.isSafeInteger(Number(raw))) throw new InboxError('schema')
  return raw
}

function parseContext(html) {
  const doc = new DOMParser({ errorHandler: { warning() {}, error() {}, fatalError() {} } }).parseFromString(html, 'text/html')
  const elements = [...Array.from(doc.getElementsByTagName('span')), ...Array.from(doc.getElementsByTagName('a'))]
  const byId = id => elements.find(e => e.getAttribute('id') === id)
  const actor = byId('lblUzytkownik')
  const substitute = byId('lblUzytkownikZastepstwo')
  const unit = byId('lblDzial')
  const role = text(byId('lblStanowisko')?.textContent)
  if (!actor || !unit || !role) throw new InboxError('login-required')
  const actorId = positiveId(actor.getAttribute('title'))
  const effective = text(substitute?.textContent) ? substitute : actor
  const effectiveId = positiveId(effective.getAttribute('title'))
  const unitId = positiveId(unit.getAttribute('title'))
  return {
    key: JSON.stringify([actorId, effectiveId, unitId, role]),
    label: `${text(actor.textContent)}${effective !== actor ? ` w zastępstwie za ${text(effective.textContent)}` : ''} · ${text(unit.textContent)} · ${role}`,
  }
}

function normalizeItem(item) {
  if (!item || typeof item !== 'object') throw new InboxError('schema')
  const id = positiveId(item.id)
  if (typeof item.nz !== 'string' || !item.nz.trim()) throw new InboxError('schema')
  return { id, title: text(item.nz), caseMark: text(item.ns), sender: text(item.nd),
    inflowSender: text(item.nddk), rpw: text(item.nrdk), transferredAt: text(item.dd), deadline: text(item.tr) }
}

function itemKey(item) { return JSON.stringify([item.id, item.transferredAt]) }

function parseNewLetters(response) {
  if (!response || response.error || !Object.hasOwn(response, 'value')) throw new InboxError('schema')
  if (response.value === null || response.value === '') return []
  if (typeof response.value !== 'string') throw new InboxError('schema')
  if (!response.value.trim()) return []
  // Treat the returned dialog HTML as inert data. Never evaluate AjaxPro code or render HTML.
  const doc = new DOMParser({ errorHandler: { warning() {}, error() {}, fatalError() {} } }).parseFromString(response.value, 'text/html')
  const items = new Map()
  for (const anchor of Array.from(doc.getElementsByTagName('a'))) {
    let url
    try { url = new URL(anchor.getAttribute('href'), EZD_ORIGIN) } catch { continue }
    if (url.origin !== EZD_ORIGIN || url.pathname.toLowerCase() !== '/pismo3.aspx' || url.username || url.password) continue
    const parameter = [...url.searchParams].find(([key]) => key.toLowerCase() === 'idpisma')
    if (!parameter) continue
    const id = positiveId(parameter[1])
    items.set(id, { id, title: text(anchor.textContent) })
    if (items.size > MAX_ITEMS) throw new InboxError('schema')
  }
  if (!items.size) throw new InboxError('schema')
  return [...items.values()]
}

function normalizeEvents(groups) {
  if (groups === null) return []
  if (!Array.isArray(groups) || groups.length > 10_000) throw new InboxError('schema')
  const events = []
  for (const group of groups) {
    if (!Array.isArray(group?.Powiadomienia)) throw new InboxError('schema')
    for (const event of group.Powiadomienia) {
      const id = positiveId(event.Id)
      const pismoId = positiveId(event.IdKoszulki)
      const occurredAt = text(event.DataZdarzeniaShort)
      if (!occurredAt || !Number.isInteger(event.IdZdarzenia)) throw new InboxError('schema')
      events.push({ key: JSON.stringify([id, pismoId, occurredAt]), pismoId, occurredAt,
        code: event.IdZdarzenia, description: text(event.Zdarzenie), actor: text(event.Uzytkownik), title: text(event.NazwaKoszulki) })
      if (events.length > 10_000) throw new InboxError('schema')
    }
  }
  return [...new Map(events.map(event => [event.key, event])).values()]
}

class EzdInboxClient {
  constructor({ fetchImpl }) { this.fetchImpl = fetchImpl }

  async request(path, signal, body, { ajaxMethod } = {}) {
    const response = await this.fetchImpl(`${EZD_ORIGIN}${path}`, {
      method: body ? 'POST' : 'GET', credentials: 'include', redirect: 'manual', cache: 'no-store', signal,
      headers: ajaxMethod
        ? { 'Content-Type': 'text/plain; charset=utf-8', 'X-AjaxPro-Method': ajaxMethod, Accept: 'application/json, text/plain, text/javascript' }
        : body ? { 'Content-Type': 'application/json; charset=utf-8', Accept: 'application/json' } : { Accept: 'text/html' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    if ([301, 302, 303, 307, 308, 401, 403].includes(response.status)) throw new InboxError('login-required')
    if (!response.ok) throw new InboxError('connection-error')
    const type = response.headers.get('content-type') || ''
    if (body && !(type.includes('json') || (ajaxMethod && /text\/(plain|javascript)/i.test(type)))) throw new InboxError('login-required')
    if (Number(response.headers.get('content-length')) > 8 * 1024 * 1024) throw new InboxError('schema')
    // Bound actual decoded bytes too; do not trust a missing/incorrect Content-Length.
    const reader = response.body.getReader()
    const chunks = []
    let length = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.byteLength
      if (length > 8 * 1024 * 1024) { await reader.cancel(); throw new InboxError('schema') }
      chunks.push(Buffer.from(value))
    }
    const content = Buffer.concat(chunks).toString('utf8')
    if (!body) return content
    try { return JSON.parse(content) } catch { throw new InboxError('schema') }
  }

  async context(signal) { return parseContext(await this.request('/FolderPism.aspx?Status=1', signal)) }

  async snapshot(signal, expectedContext = null) {
    const context = await this.context(signal)
    if (expectedContext && context.key !== expectedContext) throw new InboxError('account-changed')
    const primaryItems = parseNewLetters(await this.request('/ajaxpro/ezd.Web.Outlook,ezd.Web.ashx', signal, {}, { ajaxMethod: 'SprawdzNowePisma' }))
    const after = await this.context(signal)
    if (after.key !== context.key) throw new InboxError('account-changed')
    return { context, primaryItems }
  }

  async supplement(signal, expectedContext) {
    const context = await this.context(signal)
    if (context.key !== expectedContext) throw new InboxError('account-changed')
    const groups = await this.request('/api/koszulki/grupyfolderu', signal, { IdStatus: '1' })
    if (!Array.isArray(groups) || groups.length > 240) throw new InboxError('schema')
    const items = []
    const groupKeys = new Set()
    for (const group of groups) {
      if (![group.Rok, group.Miesiac, group.Dzien, group.Ilosc].every(v => Number.isInteger(v) && v >= 0)
        || group.Rok < 2000 || group.Rok > 9999 || group.Miesiac > 12 || group.Dzien > 31) throw new InboxError('schema')
      const groupKey = `${group.Rok}_${group.Miesiac}_${group.Dzien}`
      if (groupKeys.has(groupKey) || items.length + group.Ilosc > MAX_ITEMS) throw new InboxError('schema')
      groupKeys.add(groupKey)
      const rows = await this.request('/api/koszulki/koszulkigrupyfolderu', signal, { Id: groupKey, Status: '1' })
      if (!Array.isArray(rows) || rows.length !== group.Ilosc) throw new InboxError('incomplete')
      items.push(...rows.map(normalizeItem))
    }
    if (new Set(items.map(item => item.id)).size !== items.length) throw new InboxError('incomplete')
    // This is the same read/poll request used by PowiadomieniaController.
    // Never call the separate odrzuckoszulki endpoint, which dismisses events.
    const events = normalizeEvents(await this.request('/api/powiadomienia/pooluser', signal,
      { Display: '1100/760', System: 'iBridge macOS', Page: INBOX_URL }))
    const after = await this.context(signal)
    if (after.key !== context.key) throw new InboxError('account-changed')
    return { context, items, events }
  }
}

module.exports = { EzdInboxClient, InboxError, parseContext, normalizeItem, normalizeEvents, parseNewLetters, itemKey, EZD_ORIGIN, INBOX_URL }
