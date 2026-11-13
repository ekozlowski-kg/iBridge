const fs = require('node:fs/promises')
const crypto = require('node:crypto')
const { REPOSITORY_URL } = require('../electron/update-checker.cjs')

async function createUpdateFeed({ version, arch, archive, now = new Date() }) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) throw new Error('Stable x.y.z version required')
  if (!['arm64','x64'].includes(arch)) throw new Error('Unsupported architecture')
  const bytes = await fs.readFile(archive)
  if (!bytes.length) throw new Error('Empty update archive')
  const name = `EZD-iBridge-${version}-darwin-${arch}.zip`
  return { currentRelease: version, releases: [{ version, updateTo: {
    version, name: version,
    url: `${REPOSITORY_URL}/releases/download/v${version}/${name}`,
    pub_date: now.toISOString(),
    notes: 'Aktualizacja iBridge',
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'), size: bytes.length,
  }}] }
}
module.exports = { createUpdateFeed }
