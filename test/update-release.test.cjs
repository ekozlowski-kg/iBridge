const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const {createUpdateFeed} = require('../scripts/update-feed.cjs')
const {argumentsFor} = require('../scripts/release-mac.cjs')

test('release metadata pins version, architecture, archive size and digest',async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(),'ibridge-feed-'))
  t.after(() => fs.rm(dir,{recursive:true,force:true}))
  const archive = path.join(dir,'test.zip')
  const bytes = Buffer.from('archive fixture')
  await fs.writeFile(archive,bytes)
  const feed = await createUpdateFeed({version:'0.6.3',arch:'arm64',archive})
  assert.equal(feed.currentRelease,'0.6.3')
  assert.equal(feed.releases.length,1)
  const update = feed.releases[0].updateTo
  assert.equal(update.url,'https://github.com/ekozlowski-kg/iBridge/releases/download/v0.6.3/EZD-iBridge-0.6.3-darwin-arm64.zip')
  assert.equal(update.size,bytes.length)
  assert.equal(update.sha256,crypto.createHash('sha256').update(bytes).digest('hex'))
  await assert.rejects(createUpdateFeed({version:'0.6.3-beta',arch:'arm64',archive}))
  await assert.rejects(createUpdateFeed({version:'0.6.3',arch:'bad',archive}))
})

test('production builds cannot silently fall back to ad-hoc signing', () => {
  const base = ['--runtime','/runtime.app','--output','/output']
  assert.throws(() => argumentsFor(base), /Production requires/)
  assert.throws(() => argumentsFor([...base,'--identity','-','--team-id','ABCDE12345','--notary-profile','release']), /Production requires/)
  const signed = argumentsFor([...base,'--identity','Developer ID Application: Example (ABCDE12345)',
    '--team-id','ABCDE12345','--notary-profile','release'])
  assert.equal(signed.testBuild,undefined)
  assert.equal(argumentsFor([...base,'--test-build']).testBuild,true)
  assert.throws(() => argumentsFor([...base,'--test-build','--identity','Developer ID Application: X']), /must not use production/)
})
