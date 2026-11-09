const fsp = require('node:fs/promises')
const path = require('node:path')
const mammoth = require('mammoth')
const JSZip = require('jszip')
const { decode } = require('entities')
const { diffLines } = require('diff')

const MAX_TEXT_LENGTH = 2_000_000
const MAX_INPUT_SIZE = 64 * 1024 * 1024
const MAX_XML_ENTRY_SIZE = 20 * 1024 * 1024

function assertSafeArchiveEntry(entry) {
  const uncompressedSize = entry?._data?.uncompressedSize
  if (typeof uncompressedSize === 'number' && uncompressedSize > MAX_XML_ENTRY_SIZE) {
    throw new Error('Wewnętrzna treść dokumentu jest zbyt duża do bezpiecznego porównania.')
  }
}

function xmlToText(xml) {
  return decode(
    xml
      .replace(/<text:tab\b[^>]*\/>/gi, '\t')
      .replace(/<text:line-break\b[^>]*\/>/gi, '\n')
      .replace(/<\/(text:p|text:h|table:table-row)>/gi, '\n')
      .replace(/<[^>]+>/g, ''),
  ).replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

function rtfToText(rtf) {
  return rtf
    .replace(/\\par[d]?\b/g, '\n')
    .replace(/\\tab\b/g, '\t')
    .replace(/\\u(-?\d+)\??/g, (_match, value) => String.fromCharCode(Number(value) & 0xffff))
    .replace(/\\'[0-9a-fA-F]{2}/g, '')
    .replace(/\\[a-zA-Z]+-?\d* ?/g, '')
    .replace(/[{}]/g, '')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

async function extractDocumentText(filePath) {
  const extension = path.extname(filePath).toLowerCase()
  const info = await fsp.stat(filePath)
  if (!info.isFile()) throw new Error('Wybrana ścieżka nie jest plikiem.')
  if (info.size > MAX_INPUT_SIZE) {
    throw new Error('Dokument jest zbyt duży do bezpiecznego porównania w aplikacji.')
  }
  let text

  if (extension === '.docx') {
    const buffer = await fsp.readFile(filePath)
    const archive = await JSZip.loadAsync(buffer)
    const documentEntry = archive.file('word/document.xml')
    if (!documentEntry) throw new Error('Plik DOCX nie zawiera word/document.xml.')
    assertSafeArchiveEntry(documentEntry)
    text = (await mammoth.extractRawText({ buffer })).value
  } else if (extension === '.odt') {
    const archive = await JSZip.loadAsync(await fsp.readFile(filePath))
    const entry = archive.file('content.xml')
    if (!entry) throw new Error('Plik ODT nie zawiera content.xml.')
    assertSafeArchiveEntry(entry)
    text = xmlToText(await entry.async('string'))
  } else if (extension === '.rtf') {
    text = rtfToText(await fsp.readFile(filePath, 'utf8'))
  } else if (['.txt', '.md', '.csv', '.xml', '.html', '.htm'].includes(extension)) {
    text = await fsp.readFile(filePath, 'utf8')
    if (extension === '.html' || extension === '.htm') text = xmlToText(text)
  } else {
    throw new Error('Podgląd różnic obsługuje obecnie DOCX, ODT, RTF, TXT, MD, CSV, XML i HTML.')
  }

  if (text.length > MAX_TEXT_LENGTH) {
    throw new Error('Dokument jest zbyt duży do bezpiecznego porównania w aplikacji.')
  }
  return text.replace(/\r\n/g, '\n').trim()
}

async function compareDocuments(originalPath, changedPath) {
  const [original, changed] = await Promise.all([
    extractDocumentText(originalPath),
    extractDocumentText(changedPath),
  ])
  const changes = diffLines(original, changed).map((part) => ({
    type: part.added ? 'added' : part.removed ? 'removed' : 'unchanged',
    value: part.value,
    count: part.count || 0,
  }))
  return {
    originalName: path.basename(originalPath),
    changedName: path.basename(changedPath),
    changes,
    summary: {
      added: changes.filter((item) => item.type === 'added').reduce((sum, item) => sum + item.count, 0),
      removed: changes.filter((item) => item.type === 'removed').reduce((sum, item) => sum + item.count, 0),
    },
  }
}

module.exports = { compareDocuments, extractDocumentText, rtfToText, xmlToText }
