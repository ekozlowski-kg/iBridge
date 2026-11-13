const assert = require('node:assert/strict')
const test = require('node:test')
const { EventEmitter } = require('node:events')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { AutomaticUpdater, updateSupport, feedUrl, DAY } = require('../electron/automatic-updater.cjs')

function fixture(overrides = {}) {
  const native = new EventEmitter()
  const calls = []
  native.setFeedURL = value => calls.push(['feed', value])
  native.checkForUpdates = () => calls.push(['check'])
  native.quitAndInstall = () => calls.push(['install'])
  const updater = new AutomaticUpdater({ nativeUpdater: native, currentVersion: '0.6.3',
    support: { enabled: true, url: feedUrl('arm64') },
    now: () => 1000, setTimer: () => ({ unref() {} }), clearTimer() {},
    requestQuit: () => calls.push(['quit']), ...overrides })
  return { native, calls, updater }
}

test('starts a native JSON feed automatically and prevents duplicate downloads', async () => {
  const { native, calls, updater } = fixture()
  await updater.start()
  assert.deepEqual(calls, [['feed', {url: feedUrl('arm64'), serverType:'json'}], ['check']])
  updater.check(true)
  native.emit('update-available')
  assert.equal(updater.snapshot().status, 'downloading')
  updater.check(true)
  await updater.start()
  assert.equal(calls.filter(c => c[0] === 'check').length, 1)
})

test('downloaded update waits for normal quit without interrupting editing', async () => {
  const { native, calls, updater } = fixture()
  await updater.start()
  native.emit('update-downloaded', {}, '', '0.6.4')
  assert.equal(updater.snapshot().status, 'ready')
  assert.equal(updater.snapshot().latestVersion, '0.6.4')
  assert.equal(calls.some(c => ['quit','install'].includes(c[0])), false)
  updater.check(true)
  assert.equal(calls.filter(c => c[0] === 'check').length, 1)
})

test('explicit restart refuses active documents and signatures', async () => {
  const { native, calls, updater } = fixture({canRestart:async () => false})
  await updater.start()
  native.emit('update-downloaded')
  assert.equal((await updater.requestRestart()).status, 'waiting-for-documents')
  assert.equal(updater.installAfterCleanup(), false)
  assert.equal(calls.some(c => c[0] === 'quit'), false)
})

test('restart requests normal cleanup before native installation', async () => {
  const { native, calls, updater } = fixture({canRestart:async () => true})
  await updater.start()
  native.emit('update-downloaded')
  await Promise.all([updater.requestRestart(), updater.requestRestart()])
  assert.deepEqual(calls.filter(c => ['quit','install'].includes(c[0])), [['quit']])
  updater.close()
  assert.equal(updater.installAfterCleanup(), true)
  assert.equal(updater.installAfterCleanup(), false)
  assert.deepEqual(calls.slice(-2), [['quit'], ['install']])
})

test('a new document can cancel a pending restart before cleanup', async () => {
  const { native, updater } = fixture({canRestart:async () => true})
  await updater.start()
  native.emit('update-downloaded')
  await updater.requestRestart()
  updater.cancelRestart()
  assert.equal(updater.installAfterCleanup(), false)
  assert.equal(updater.snapshot().status, 'waiting-for-documents')
})

test('a native install exception falls back to normal quit after cleanup', async () => {
  const { native, updater } = fixture({canRestart:async () => true})
  native.quitAndInstall = () => { throw Error('native failure') }
  await updater.start()
  native.emit('update-downloaded')
  await updater.requestRestart()
  assert.equal(updater.installAfterCleanup(), false)
  assert.equal(updater.restartRequested, false)
})

test('checks once daily but retries after an error, with no browser fallback', async () => {
  let now = 1000
  const { native, calls, updater } = fixture({now:() => now})
  await updater.start()
  native.emit('update-not-available')
  now += DAY-1
  updater.check()
  assert.equal(calls.filter(c => c[0] === 'check').length, 1)
  now += 1
  updater.check()
  native.emit('error', new Error('private-path-and-network-error'))
  assert.equal(updater.snapshot().status, 'unavailable')
  assert.equal(JSON.stringify(updater.snapshot()).includes('private-path'), false)
  now += 60*60*1000
  updater.check()
  assert.equal(calls.filter(c => c[0] === 'check').length, 3)
})

test('test/unsigned copies do not contact the update service', async () => {
  const { calls, updater } = fixture({support:{enabled:false, reason:'signing-required'}})
  await updater.start()
  updater.check(true)
  await updater.requestRestart()
  assert.equal(updater.snapshot().status, 'setup-required')
  assert.deepEqual(calls, [])
})

test('native exceptions are visible and late shutdown errors are harmless', async () => {
  const { native, updater } = fixture()
  native.checkForUpdates = () => { throw Error('offline') }
  await updater.start()
  assert.equal(updater.snapshot().status, 'unavailable')
  updater.close()
  native.emit('error', Error('late'))
  native.emit('update-downloaded')
  assert.equal(updater.snapshot().status, 'unavailable')
})

test('architecture-specific feeds cannot be redirected by renderer input', () => {
  assert.match(feedUrl('x64'), /RELEASES-darwin-x64\.json$/)
  assert.throws(() => feedUrl('../../other'))
})

test('activation requires a valid Developer ID signature matching the embedded team', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(),'ibridge-updater-'))
  t.after(() => fs.rm(dir, {recursive:true,force:true}))
  const configPath = path.join(dir,'auto-update.json')
  await fs.writeFile(configPath, JSON.stringify({enabled:true,teamId:'ABCDE12345'}))
  const options = {isPackaged:true,platform:'darwin',arch:'arm64',
    execPath:'/Applications/EZD - iBridge.app/Contents/MacOS/EZD - iBridge',configPath}
  const calls = []
  const run = async (_command, args) => {
    calls.push(args)
    return {stderr:'Authority=Developer ID Application: Example (ABCDE12345)\nTeamIdentifier=ABCDE12345\n'}
  }
  assert.equal((await updateSupport({...options,run})).enabled, true)
  assert.deepEqual(calls[0], ['--verify','--deep','--strict','/Applications/EZD - iBridge.app'])
  assert.equal((await updateSupport({...options,run:async()=>({stderr:'Signature=adhoc'})})).enabled, false)
  assert.equal((await updateSupport({...options,run:async()=>({stderr:'Authority=Developer ID Application: X\nTeamIdentifier=WRONG12345\n'})})).enabled, false)
  assert.equal((await updateSupport({...options,run:async()=>{throw Error('corrupt signature')}})).enabled, false)
  assert.equal((await updateSupport({...options,isPackaged:false,run})).reason, 'development')
  await fs.writeFile(configPath, JSON.stringify({enabled:false}))
  assert.equal((await updateSupport({...options,run})).enabled, false)
})
