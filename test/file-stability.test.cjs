const assert = require('node:assert/strict')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { waitForStableFile } = require('../electron/file-stability.cjs')

async function temporaryFile(t, contents) {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'ezd-ibridge-stable-'))
  t.after(() => fsp.rm(directory, { recursive: true, force: true }))
  const filePath = path.join(directory, 'pismo.docx')
  await fsp.writeFile(filePath, contents)
  return { directory, filePath }
}

test('waits through an atomic replacement and returns two matching samples', async (t) => {
  const fixture = await temporaryFile(t, 'v1')
  const pending = waitForStableFile(fixture.filePath, { sampleMs: 15, maximumMs: 500 })
  await fsp.writeFile(`${fixture.filePath}.tmp`, 'replacement')
  await fsp.rename(`${fixture.filePath}.tmp`, fixture.filePath)
  const stable = await pending
  assert.equal(stable.size, Buffer.byteLength('replacement'))
  assert.equal(typeof stable.mtimeMs, 'number')
})

test('rejects when size or mtime never stabilizes before maximumMs', async () => {
  let mtimeMs = 0
  let clock = 0
  const stat = async () => ({ isFile: () => true, size: 10, mtimeMs: ++mtimeMs })
  await assert.rejects(
    waitForStableFile('/virtual/document.docx', {
      sampleMs: 0,
      maximumMs: 3,
      stat,
      sleep: async () => {},
      now: () => clock++,
    }),
    /nie ustabilizował/i,
  )
})

test('tolerates a transient missing file during replacement', async () => {
  const samples = [
    Object.assign(new Error('missing'), { code: 'ENOENT' }),
    { isFile: () => true, size: 5, mtimeMs: 7 },
    { isFile: () => true, size: 5, mtimeMs: 7 },
  ]
  const stable = await waitForStableFile('/virtual/document.docx', {
    sampleMs: 0,
    maximumMs: 100,
    stat: async () => {
      const sample = samples.shift()
      if (sample instanceof Error) throw sample
      return sample
    },
    sleep: async () => {},
  })
  assert.deepEqual(stable, { size: 5, mtimeMs: 7 })
})
