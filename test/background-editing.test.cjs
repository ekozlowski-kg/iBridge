const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')
const { SessionStore } = require('../electron/session-store.cjs')
const { EzdSessionCoordinator } = require('../electron/ezd-session-coordinator.cjs')
const { EzdAutosync } = require('../electron/ezd-autosync.cjs')
const { DocumentObserver, probeWord } = require('../electron/document-observer.cjs')
const { buildDocumentCatalog } = require('../electron/document-catalog.cjs')
const { UpdateChecker, newer } = require('../electron/update-checker.cjs')
const { pendingWork } = require('../electron/quit-policy.cjs')
const hash = b => crypto.createHash('sha256').update(b).digest('hex')
const sleep = ms => new Promise(r => setTimeout(r,ms))
async function wait(predicate) { for(let n=0;n<200;n++) { if (predicate()) return; await sleep(5) }; throw new Error('Timed out') }
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(),'ibridge-061-'))
  const store = new SessionStore({baseDir:dir}); await store.init()
  t.after(async()=>{store.close();await fs.rm(dir,{recursive:true,force:true})})
  return {dir,store}
}

test('simultaneous EZD imports return their own identities and open different files', async t => {
  const {store}=await fixture(t)
  const persist=store.persist.bind(store);let arrived=0,release
  const barrier=new Promise(r=>{release=r})
  store.persist=async()=>{if(++arrived===2)release();await barrier;return persist()}
  const opened=[]
  const c=new EzdSessionCoordinator({store,openEditor:async id=>opened.push(id),clientFactory:({authToken})=>({
    async checkData(){return {documentName:authToken+'.txt',documentId:authToken==='A'?1:2}},
    async downloadFile(){return {data:Buffer.from(authToken)}},async finishSession(){},
  })})
  await Promise.all(['A','B'].map(authToken=>c.receive({serviceUrl:'https://example.test',authToken})))
  assert.equal(c.liveSessions.size,2);assert.equal(new Set(opened).size,2)
  for(const [id,live] of c.liveSessions) assert.equal(store.getSession(id).remote.documentId,live.documentId)
})

test('concurrent version saves preserve one immutable snapshot and valid hash', async t=>{
  const {store}=await fixture(t)
  const {sessionId,workingPath}=await store.importRemoteDocument({fileName:'test.txt',data:Buffer.from('original')})
  await fs.writeFile(workingPath,'changed')
  await Promise.all(Array.from({length:8},()=>store.saveVersion(sessionId)))
  const versions=store.getSession(sessionId).versions
  assert.equal(versions.length,2)
  for(const v of versions) {const b=await fs.readFile(v.path);assert.equal(v.hash,hash(b));assert.equal(v.size,b.length)}
})

test('restart retains unsent bytes, marks connection unavailable and never persists session tokens', async t=>{
  const {store,dir}=await fixture(t)
  const {sessionId,workingPath}=await store.importRemoteDocument({fileName:'test.txt',data:Buffer.from('old'),metadata:{documentId:1}})
  await store.markRemoteSynced(sessionId,{hash:hash('old')})
  await fs.writeFile(workingPath,'unsent');store.close()
  const restarted=new SessionStore({baseDir:dir});t.after(()=>restarted.close());await restarted.init()
  const r=restarted.getSession(sessionId).remote
  assert.equal(r.connectionStatus,'needs-reopen');assert.equal(r.recoveryRequired,true)
  assert.equal(String(await fs.readFile(workingPath)),'unsent')
  assert.doesNotMatch(await fs.readFile(restarted.statePath,'utf8'),/authToken|PIN/)
  assert.equal((await pendingWork(restarted,{hasLiveSession:()=>false})).length,1)
})

test('polling discovers lost fs events; transient failure retries unchanged bytes without another save',async t=>{
  const {store}=await fixture(t)
  const {sessionId,workingPath}=await store.importRemoteDocument({fileName:'test.txt',data:Buffer.from('a')})
  let attempts=0;const errors=[]
  const sync=new EzdAutosync({coordinator:{async sync(){if(++attempts===1)throw Object.assign(new Error('offline'),{kind:'transport'});}},
    onError:e=>errors.push(e),pollMs:10,debounceMs:1,retryDelaysMs:[10],stabilityOptions:{sampleMs:1},watchFactory:()=>({close(){}})})
  t.after(()=>sync.close());sync.watch(sessionId,workingPath)
  await fs.writeFile(workingPath,'b')
  await wait(()=>attempts===2);await sleep(40)
  assert.equal(attempts,2);assert.equal(errors.length,1)
})

test('EZD rejection blocks retries even while polling, until an explicit retry',async t=>{
  const {store}=await fixture(t)
  const {sessionId,workingPath}=await store.importRemoteDocument({fileName:'test.txt',data:Buffer.from('a')})
  let attempts=0
  const sync=new EzdAutosync({coordinator:{async sync(){attempts++;throw Object.assign(new Error('rejected'),{kind:'ezd',ezdStatus:1})}},pollMs:10,debounceMs:1,retryDelaysMs:[5],stabilityOptions:{sampleMs:1},watchFactory:()=>({close(){}})})
  t.after(()=>sync.close());sync.watch(sessionId,workingPath);await fs.writeFile(workingPath,'b')
  await wait(()=>attempts===1);await sleep(70);assert.equal(attempts,1)
  await assert.rejects(sync.retry(sessionId));assert.equal(attempts,2)
})

test('close during upload drains latest save and retries finish without reupload',async t=>{
  const {store}=await fixture(t)
  let begin,release;const started=new Promise(r=>begin=r),gate=new Promise(r=>release=r)
  const uploaded=[];let finishCalls=0
  const client={async checkData(){return{documentName:'file.txt',documentId:1}},async downloadFile(){return{data:Buffer.from('original')}},
    async uploadFile(data){uploaded.push(String(data));if(uploaded.length===1){begin();await gate};return{documentId:1}},
    async finishSession(){if(++finishCalls===1)throw Object.assign(new Error('offline'),{kind:'transport',operation:'AddInZakonczSesje'})}}
  const c=new EzdSessionCoordinator({store,clientFactory:()=>client,stabilityOptions:{sampleMs:1}})
  await c.receive({serviceUrl:'https://example.test',authToken:'synthetic'})
  const s=store.state.sessions[0]
  const sync=new EzdAutosync({coordinator:c,pollMs:0,debounceMs:1,retryDelaysMs:[10],stabilityOptions:{sampleMs:1},watchFactory:()=>({close(){}})})
  t.after(()=>sync.close());const entry=sync.watch(s.id,s.workingPath)
  await fs.writeFile(s.workingPath,'first');sync.schedule(entry)
  await started
  const finishing=sync.finish(s.id).catch(()=>{})
  await fs.writeFile(s.workingPath,'final');release();await finishing
  await wait(()=>store.getSession(s.id).remote.status==='sent' && !c.hasLiveSession(s.id))
  assert.deepEqual(uploaded,['first','final']);assert.equal(finishCalls,2);assert.equal(c.hasLiveSession(s.id),false)
})

test('Word requires observed opening and two successful absences; errors are unknown, not closed',async t=>{
  let observation='absent';const states=[],closed=[]
  const o=new DocumentObserver({platform:'darwin',probe:async()=>observation,intervalMs:100000,onState:async e=>states.push(e.state),onClosed:async e=>closed.push(e.sessionId)})
  t.after(()=>o.close());const e=await o.watch('one','/tmp/one.docx');await sleep(1)
  await o.tick(e);assert.equal(closed.length,0)
  observation='open';await o.tick(e);assert.equal(e.state,'open')
  observation='absent';await o.tick(e);assert.equal(closed.length,0)
  observation='open';await o.tick(e) // cancelled close / reopened
  observation='absent';await o.tick(e);assert.equal(closed.length,0)
  await o.tick(e);await o.tick(e);assert.deepEqual(closed,['one'])
  observation='unknown';const other=await o.watch('two','/tmp/two.docx');await sleep(1);assert.equal(other.state,'unknown');assert.deepEqual(closed,['one'])
})

test('Word path is an argv value, never executable script text',async()=>{
  const pathname='/tmp/a" & do shell script.docx'
  const result=await probeWord(pathname,{execFileImpl:(command,args,options,cb)=>{assert.equal(command,'/usr/bin/osascript');assert.equal(args.at(-1),pathname);assert(!args[1].includes(pathname));cb(null,'OPEN\n')}})
  assert.equal(result,'open')
})

test('a transient Word probe failure recovers automatically and finishes after close', async t => {
  let observation = 'unknown'
  let closed = 0
  const observer = new DocumentObserver({ platform: 'darwin', intervalMs: 5,
    probe: async () => observation, onClosed: async () => { closed++ } })
  t.after(() => observer.close())
  const entry = await observer.watch('probe-recovery', '/tmp/probe-recovery.docx')
  await wait(() => entry.state === 'unknown')
  observation = 'open'
  await wait(() => entry.state === 'open')
  observation = 'unknown'
  await wait(() => entry.state === 'unknown')
  assert.equal(closed, 0)
  observation = 'absent'
  await wait(() => closed === 1)
  await sleep(25)
  assert.equal(closed, 1)
})

test('a saved closed document with a missing cleanup ACK does not block quit, but unsent changes do', async t => {
  const { store } = await fixture(t)
  const { sessionId, workingPath } = await store.importRemoteDocument({ fileName: 'saved.txt', data: Buffer.from('saved') })
  await store.markRemoteSynced(sessionId, { hash: hash('saved') })
  await store.patchRemote(sessionId, { finishStatus: 'error', editorState: 'closed' })
  const live = { hasLiveSession: () => true }
  assert.deepEqual(await pendingWork(store, live), [])
  await fs.writeFile(workingPath, 'another save')
  assert.equal((await pendingWork(store, live)).length, 1)
  await fs.writeFile(workingPath, 'saved')
  await store.patchRemote(sessionId, { editorState: 'open' })
  assert.equal((await pendingWork(store, live)).length, 1)
})

test('catalog groups server identities and aliases, excludes local files, never merges by filename',()=>{
  const make=(id,doc,pismo=1)=>({id,name:'same.docx',createdAt:id,remote:{documentId:doc,pismoId:pismo,serviceUrl:'https://example.test/service',connectionStatus:'needs-reopen'}})
  const a=make('a',1),b=make('b',2);a.remote.documentIds=[1,2];const c=make('c',2,3)
  const result=buildDocumentCatalog([a,b,c,{id:'local',name:'same.docx'}])
  assert.equal(result.length,2);assert.deepEqual(result.find(x=>x.pismoId===1).sessionIds,['b','a'])
})

test('version check compares numeric semver and uses only canonical repository URLs',async t=>{
  const {dir}=await fixture(t);let calls=0
  const u=new UpdateChecker({currentVersion:'0.6.1',directory:dir,fetchImpl:async()=>{calls++;return new Response(JSON.stringify({tag_name:'v0.10.0',html_url:'https://evil.example'}),{headers:{'content-type':'application/json'}})}})
  assert(newer('v0.10.0','0.9.0'));assert(!newer('v0.6.1-beta','0.6.0'))
  const state=await u.check();assert.equal(state.status,'available');assert.equal(state.url,'https://github.com/ekozlowski-kg/iBridge/releases/tag/v0.10.0')
  await u.check();assert.equal(calls,1)
  const cached=new UpdateChecker({currentVersion:'0.10.0',directory:dir,fetchImpl:async()=>{throw Error('should use cache')}})
  await cached.start();assert.equal(cached.snapshot().status,'current');cached.close()
})

test('empty releases, offline and prereleases do not produce fake updates',async t=>{
  const {dir}=await fixture(t)
  for(const [fetchImpl,status] of [[async()=>new Response('',{status:404}),'no-releases'],[async()=>{throw Error('offline')},'unavailable'],[async()=>new Response(JSON.stringify({tag_name:'v9.0.0',prerelease:true})),'unavailable']]){
    const u=new UpdateChecker({currentVersion:'0.6.1',directory:dir,fetchImpl});assert.equal((await u.check(true)).status,status)
  }
})

test('repeated browser callback for the same token imports and opens only once', async t=>{
  const {store}=await fixture(t);let opened=0,downloads=0
  const c=new EzdSessionCoordinator({store,openEditor:async()=>{opened++},clientFactory:()=>({async checkData(){return{documentName:'one.txt',documentId:9,pismoId:2}},async downloadFile(){downloads++;return{data:Buffer.from('same')}},async finishSession(){}})})
  await Promise.all([c.receive({serviceUrl:'https://example.test',authToken:'same'}),c.receive({serviceUrl:'https://example.test',authToken:'same'})])
  assert.equal(opened,1);assert.equal(downloads,1);assert.equal(store.state.sessions.length,1)
})

test('a new token cannot create competing copies of a document that is still being edited',async t=>{
  const {store}=await fixture(t);let finishedNew=0
  const c=new EzdSessionCoordinator({store,clientFactory:({authToken})=>({async checkData(){return{documentName:'one.txt',documentId:9,pismoId:2}},async downloadFile(){return{data:Buffer.from('same')}},async finishSession(){if(authToken==='new')finishedNew++}})})
  await c.receive({serviceUrl:'https://example.test',authToken:'old'})
  await assert.rejects(c.receive({serviceUrl:'https://example.test',authToken:'new'}),/aktywną edycję/)
  assert.equal(store.state.sessions.length,1);assert.equal(c.liveSessions.size,1);assert.equal(finishedNew,1)
})

test('simultaneous different tokens for one EZD identity reserve only one import',async t=>{
  const {store}=await fixture(t)
  const c=new EzdSessionCoordinator({store,clientFactory:()=>({async checkData(){return{documentName:'one.txt',documentId:9,pismoId:2}},async downloadFile(){await sleep(10);return{data:Buffer.from('same')}},async finishSession(){}})})
  const results=await Promise.allSettled(['a','b'].map(authToken=>c.receive({serviceUrl:'https://example.test',authToken})))
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1)
  assert.equal(store.state.sessions.length,1);assert.equal(c.reservations.size,0)
})
