#!/usr/bin/env node
// Build only: does not publish, replace the installed app, or read user documents.
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const { createUpdateFeed } = require('./update-feed.cjs')
const run = promisify(execFile)
const ROOT = path.resolve(__dirname, '..')

function argumentsFor(argv) {
  const options = { arch: process.arch }
  const allowed = ['runtime','output','identity','team-id','notary-profile','arch']
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--test-build') { options.testBuild = true; continue }
    const key = argv[i].replace(/^--/, '')
    if (!allowed.includes(key) || !argv[i+1] || argv[i+1].startsWith('--')) throw new Error(`Invalid argument: ${argv[i]}`)
    options[key] = argv[++i]
  }
  if (!options.runtime || !options.output) throw new Error('Required: --runtime APP --output DIRECTORY')
  if (!['arm64','x64'].includes(options.arch)) throw new Error('Unsupported architecture')
  if (options.testBuild && (options.identity || options['team-id'] || options['notary-profile'])) {
    throw new Error('Test builds must not use production signing options')
  }
  if (!options.testBuild && (!options.identity?.startsWith('Developer ID Application:')
      || !/^[A-Z0-9]{10}$/.test(options['team-id'] || '') || !options['notary-profile'])) {
    throw new Error('Production requires --identity "Developer ID Application: ..." --team-id TEAMID --notary-profile PROFILE')
  }
  return options
}

async function nestedApps(directory) {
  const result = []
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const full = path.join(directory, entry.name)
    result.push(...await nestedApps(full))
    if (entry.name.endsWith('.app')) result.push(full)
  }
  return result
}

async function build(options) {
  if (process.platform !== 'darwin') throw new Error('Build on macOS')
  const metadata = JSON.parse(await fs.readFile(path.join(ROOT,'package.json'), 'utf8'))
  const runtime = await fs.realpath(options.runtime)
  const runtimeResources = path.join(runtime,'Contents/Resources/app')
  const signer = path.join(runtimeResources,'signer/ibridge-signer.jar')
  const signerHash = crypto.createHash('sha256').update(await fs.readFile(signer)).digest('hex')
  await run('/usr/bin/codesign', ['--verify','--deep','--strict',runtime])
  const main = await run('/usr/bin/plutil',['-extract','CFBundleExecutable','raw','-o','-',path.join(runtime,'Contents/Info.plist')])
  for (const binary of [path.join(runtime,'Contents/MacOS',main.stdout.trim()), path.join(runtimeResources,'signer/runtime/bin/java')]) {
    const { stdout } = await run('/usr/bin/lipo',['-archs',binary])
    if (!stdout.trim().split(/\s+/).includes(options.arch)) throw new Error(`Runtime architecture mismatch: ${options.arch}`)
  }
  // Fail before copying a runtime if the required signing key is unavailable.
  if (!options.testBuild) {
    const { stdout } = await run('/usr/bin/security',['find-identity','-v','-p','codesigning'])
    if (!stdout.includes(`"${options.identity}"`)) throw new Error('Developer ID signing identity is not available in Keychain')
    if (!options.identity.endsWith(`(${options['team-id']})`)) throw new Error('Signing identity and Team ID differ')
  }
  const output = path.resolve(options.output)
  await fs.mkdir(output, {recursive:true})
  const name = `EZD-iBridge-${metadata.version}-darwin-${options.arch}${options.testBuild ? '-test' : ''}.zip`
  const feedName = `RELEASES-darwin-${options.arch}.json`
  const outputs = [name, `${name}.sha256`, `${name}.build.json`]
  if (!options.testBuild) outputs.push(feedName)
  for (const file of outputs) {
    try { await fs.access(path.join(output,file)) } catch (e) { if (e.code === 'ENOENT') continue; throw e }
    throw new Error(`Refusing to overwrite ${file}`)
  }
  const scratch = path.join(ROOT,'work')
  await fs.mkdir(scratch, {recursive:true})
  const temp = await fs.mkdtemp(path.join(scratch,'release-'))
  try {
    const app = path.join(temp,'EZD - iBridge.app')
    await fs.cp(runtime,app,{recursive:true,verbatimSymlinks:true})
    const resources = path.join(app,'Contents/Resources/app')
    for (const folder of ['electron','dist']) {
      await fs.rm(path.join(resources,folder),{recursive:true,force:true})
      await fs.cp(path.join(ROOT,folder),path.join(resources,folder),{recursive:true})
    }
    await fs.copyFile(path.join(ROOT,'package.json'),path.join(resources,'package.json'))
    await fs.writeFile(path.join(resources,'auto-update.json'),JSON.stringify(options.testBuild
      ? {enabled:false,reason:'test-build'} : {enabled:true,teamId:options['team-id']})+'\n')
    const apps = [...await nestedApps(app),app]
    for (const bundle of apps) {
      const info = path.join(bundle,'Contents/Info.plist')
      for (const key of ['CFBundleShortVersionString','CFBundleVersion']) {
        await run('/usr/bin/plutil',['-replace',key,'-string',metadata.version,info])
      }
    }
    if (options.testBuild) {
      for (const bundle of apps) {
        const args = ['--force','--sign','-','--timestamp=none']
        if (bundle === app) args.push('--entitlements',path.join(ROOT,'scripts/entitlements-app.plist'))
        await run('/usr/bin/codesign',[...args,bundle])
      }
    } else {
      const { sign } = await import('@electron/osx-sign')
      await sign({ app, identity:options.identity, platform:'darwin', type:'distribution',
        optionsForFile: file => ({ hardenedRuntime:true,
          entitlements:path.join(ROOT,'scripts',file.includes('/signer/runtime/') ? 'entitlements-java.plist' : 'entitlements-app.plist') }) })
    }
    await run('/usr/bin/codesign',['--verify','--deep','--strict',app])
    if (!options.testBuild) {
      const result = await run('/usr/bin/codesign',['-dv','--verbose=4',app])
      if (!result.stderr.split(/\r?\n/).includes(`TeamIdentifier=${options['team-id']}`)
          || !result.stderr.includes('Authority=Developer ID Application:')) throw new Error('Signing verification failed')
      const submission = path.join(temp,'notarization.zip')
      await run('/usr/bin/ditto',['-c','-k','--norsrc','--keepParent',app,submission])
      const { stdout } = await run('/usr/bin/xcrun',['notarytool','submit',submission,
        '--keychain-profile',options['notary-profile'],'--wait','--output-format','json'], {maxBuffer:4*1024*1024})
      if (JSON.parse(stdout).status !== 'Accepted') throw new Error('Apple did not accept notarization; no release was generated')
      await run('/usr/bin/xcrun',['stapler','staple',app])
      await run('/usr/bin/xcrun',['stapler','validate',app])
      await run('/usr/bin/codesign',['--verify','--deep','--strict',app])
      await run('/usr/sbin/spctl',['--assess','--type','execute','--verbose=2',app])
    }
    const stagedZip = path.join(temp,name)
    await run('/usr/bin/ditto',['-c','-k','--norsrc','--keepParent',app,stagedZip])
    const sha256 = crypto.createHash('sha256').update(await fs.readFile(stagedZip)).digest('hex')
    const manifest = {version:metadata.version,arch:options.arch,testBuild:Boolean(options.testBuild),
      automaticUpdates:!options.testBuild,sha256,signerJarSha256:signerHash,
      signing:options.testBuild ? 'ad-hoc; not notarized' : 'Developer ID; notarized and stapled',
      sourceRepository:'https://github.com/ekozlowski-kg/iBridge'}
    await fs.writeFile(path.join(temp,`${name}.build.json`),JSON.stringify(manifest,null,2)+'\n')
    await fs.writeFile(path.join(temp,`${name}.sha256`),`${sha256}  ${name}\n`)
    if (!options.testBuild) {
      const feed = await createUpdateFeed({version:metadata.version,arch:options.arch,archive:stagedZip})
      await fs.writeFile(path.join(temp,feedName),JSON.stringify(feed,null,2)+'\n')
    }
    // No externally usable production feed exists until all verification passes.
    for (const file of outputs) await fs.copyFile(path.join(temp,file),path.join(output,file),require('node:fs').constants.COPYFILE_EXCL)
    return {archive:path.join(output,name),...manifest}
  } finally { await fs.rm(temp,{recursive:true,force:true}) }
}
if (require.main === module) {
  Promise.resolve().then(() => build(argumentsFor(process.argv.slice(2))))
    .then(result => console.log(JSON.stringify(result,null,2)))
    .catch(error => { console.error(error.message); process.exitCode = 1 })
}
module.exports = { argumentsFor, build }
