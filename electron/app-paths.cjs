const fsp = require('node:fs/promises')
const path = require('node:path')

const APPLICATION_NAME = 'EZD - iBridge'
const LEGACY_APPLICATION_NAMES = ['EZD integracja', 'Integracja EZD', 'Most EZD']

async function directoryExists(directory) {
  try {
    return (await fsp.stat(directory)).isDirectory()
  } catch {
    return false
  }
}

async function resolveApplicationDataDirectory(documentsDirectory) {
  const currentDirectory = path.join(documentsDirectory, APPLICATION_NAME)
  if (await directoryExists(currentDirectory)) return currentDirectory

  for (const legacyName of LEGACY_APPLICATION_NAMES) {
    const legacyDirectory = path.join(documentsDirectory, legacyName)
    // Zachowanie dotychczasowej ścieżki chroni bezwzględne ścieżki wersji
    // zapisane przez starsze wydania aplikacji.
    if (await directoryExists(legacyDirectory)) return legacyDirectory
  }

  return currentDirectory
}

module.exports = {
  APPLICATION_NAME,
  LEGACY_APPLICATION_NAMES,
  resolveApplicationDataDirectory,
}
