const fsp = require('node:fs/promises')

async function waitForStableFile(filePath, options = {}) {
  const stat = options.stat || fsp.stat
  const sleep = options.sleep || ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)))
  const now = options.now || Date.now
  const sampleMs = options.sampleMs ?? 200
  const maximumMs = options.maximumMs ?? 5000
  const started = now()
  let previous = null

  while (now() - started <= maximumMs) {
    let info
    try {
      info = await stat(filePath)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      previous = null
      await sleep(sampleMs)
      continue
    }
    if (typeof info.isFile === 'function' && !info.isFile()) {
      throw new Error('Obserwowana ścieżka nie jest plikiem.')
    }
    const current = { size: info.size, mtimeMs: info.mtimeMs }
    if (previous && previous.size === current.size && previous.mtimeMs === current.mtimeMs) {
      return current
    }
    previous = current
    await sleep(sampleMs)
  }

  const error = new Error('Plik nie ustabilizował się przed upływem limitu czasu.')
  error.kind = 'file-changing'
  error.retryable = true
  throw error
}

async function readStableFile(filePath, { maximumBytes = 128 * 1024 * 1024, ...options } = {}) {
  const stable = await waitForStableFile(filePath, options)
  if (stable.size > maximumBytes) throw new Error('Dokument jest zbyt duży do wysłania.')
  const bytes = await fsp.readFile(filePath)
  const after = await fsp.stat(filePath)
  if (bytes.length !== stable.size || after.size !== stable.size || after.mtimeMs !== stable.mtimeMs) {
    const error = new Error('Dokument zmienił się w trakcie odczytu. Ponowimy próbę po zakończeniu zapisu.')
    error.kind = 'file-changing'
    error.retryable = true
    throw error
  }
  return bytes
}

module.exports = { waitForStableFile, readStableFile }
