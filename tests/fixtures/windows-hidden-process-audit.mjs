// Explicit Windows/Electron OS acceptance fixture. Only synthetic Node programs
// are launched; no installed AI CLI, account, credential or model is accessed.
// argv: preview package root, Harness module root, output JSON, optional node.exe.
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'

const [packageRoot, moduleRoot, output, configuredNode] = process.argv.slice(2)
if (process.platform !== 'win32' || !process.versions.electron || !packageRoot || !moduleRoot || !output)
  throw new Error('Run this synthetic audit with Windows Electron and the three required paths')
const require = createRequire(join(moduleRoot, '__cliworker_synthetic_audit__.cjs'))
const { Context } = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')).href)
const { LocalSubprocessRuntime } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-subprocess-local')).href)
const { nativeProcessBackend } = await import(pathToFileURL(join(packageRoot, 'lib/types/host/native-process.js')).href)
const directory = await mkdtemp(join(tmpdir(), 'cwn-hidden-os-synthetic-'))
const entry = join(directory, 'native-fixture.mjs')
await writeFile(entry, `import {spawn} from 'node:child_process';
const mode=process.argv[2];
if(mode==='echo') {
 const chunks=[];process.stdin.on('data',chunk=>chunks.push(chunk));
 process.stdin.on('end',()=>{
  process.stdout.write(JSON.stringify({args:process.argv.slice(3),hex:Buffer.concat(chunks).toString('hex'),cwd:process.cwd(),env:process.env.CWN_SYNTHETIC,nodeEnv:process.env.ELECTRON_RUN_AS_NODE??null}));
  process.stderr.write('synthetic-stderr');process.exitCode=17;
 });
} else if(mode==='bulk') {
 const chunks=[];process.stdin.on('data',chunk=>chunks.push(chunk));process.stdin.on('end',()=>{
  const data=Buffer.concat(chunks);process.stdout.write(data);process.stderr.write(data);process.exitCode=23;
 });
} else if(mode==='early') {
 process.stdout.write('early-native-exit');process.exitCode=0;
} else {
 const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:mode==='natural'?['ignore',1,2]:'ignore',windowsHide:true});child.unref();
 process.stdout.write(JSON.stringify({pid:child.pid})+'\\n');
 if(mode==='natural') process.exitCode=7;else setInterval(()=>{},1000);
}
`)
const ctx = new Context()
const handles = [], fixturePids = [], cases = []
let cleanupConfirmed = true
await ctx.plugin(LocalSubprocessRuntime)
const warnings = []
const logger = Reflect.get(ctx.subprocess, 'ctx').logger
const originalWarn = logger.warn
logger.warn = (...args) => { warnings.push(args.map(String).join(' ')); originalWarn.apply(logger, args) }
const backend = nativeProcessBackend(ctx.subprocess)
const node = configuredNode ?? await ctx.subprocess.resolveExecutable('node.exe')
assert.notEqual(node.toLowerCase(), process.execPath.toLowerCase(), 'Synthetic payload must use a console Node executable')
const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }
const launch = (args, overrides = {}) => {
  const handle = backend.spawn({
    argv: [node, entry, ...args], cwd: directory,
    env: { CWN_SYNTHETIC: 'unchanged', ELECTRON_RUN_AS_NODE: undefined },
    stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' }, graceMs: 500,
    ...overrides,
  })
  handles.push(handle)
  void handle.done.catch(() => {})
  return handle
}
const consume = async stream => { let value='';if(stream)for await(const chunk of stream)value+=String(chunk);return value }
const firstPID = handle => new Promise((resolve, reject) => {
  let buffer = ''
  const cleanup=()=>{handle.stdout.off('data',receive);handle.stdout.off('error',reject);handle.stdout.off('end',ended)}
  const ended=()=>{cleanup();reject(new Error('Fixture child did not publish a PID'))}
  const receive=chunk=>{
    buffer += String(chunk)
    if (buffer.includes('\n')) {
      cleanup()
      try {
        const pid = JSON.parse(buffer.split('\n')[0]).pid
        assert.ok(Number.isInteger(pid) && pid > 1, 'Fixture child must publish a valid PID')
        fixturePids.push(pid);handle.stdout.resume();resolve(pid)
      } catch(error) { reject(error) }
    }
  }
  handle.stdout.on('data',receive);handle.stdout.once('error',reject);handle.stdout.once('end',ended)
})
async function check(name, run) {
  const start = Date.now()
  try { cases.push({ name, ok: true, ...(await run()), elapsedMs: Date.now()-start }) }
  catch (error) { cases.push({ name, ok: false, message: String(error.message).slice(0, 300), elapsedMs: Date.now()-start }) }
}
try {
  await check('literal argv, binary stdin, separate output, environment and nonzero exit', async () => {
    const args = ['中文 空格', '& no-shell', 'quote"', '', '\\tail\\']
    const h = launch(['echo', ...args]), bytes = Buffer.from([0,13,10,255,32,65])
    const stdout = consume(h.stdout), stderr = consume(h.stderr)
    h.stdin.end(bytes)
    const [outcome, raw, error] = await Promise.all([h.done, stdout, stderr])
    assert.deepEqual(outcome,{exitCode:17,signal:null})
    assert.deepEqual(JSON.parse(raw),{args,hex:bytes.toString('hex'),cwd:directory,env:'unchanged',nodeEnv:null})
    assert.equal(error,'synthetic-stderr')
    assert.equal(await h.waitForExit(AbortSignal.timeout(5000)),true)
    return { exitCode: outcome.exitCode, binaryInputPreserved: true }
  })
  await check('SDK collected output remains readable', async () => {
    const h=launch(['echo'],{stdio:{stdin:'pipe',stdout:{maxBytes:4096},stderr:{maxBytes:4096}}})
    h.stdin.end('synthetic collection')
    assert.deepEqual(await h.done,{exitCode:17,signal:null})
    assert.equal(await h.waitForExit(AbortSignal.timeout(5000)),true)
    const out=await h.collected.stdout.readFrom(0),err=await h.collected.stderr.readFrom(0)
    assert.equal(JSON.parse(out.text).hex,Buffer.from('synthetic collection').toString('hex'))
    assert.equal(err.text,'synthetic-stderr')
    return { collectionPreserved: true }
  })
  await check('large binary output and stdin EOF retain every byte under backpressure',async()=>{
    const h=launch(['bulk']),bytes=Buffer.alloc(2*1024*1024)
    for(let index=0;index<bytes.length;index++)bytes[index]=index%256
    const digest=async stream=>{const hash=createHash('sha256');let size=0;for await(const chunk of stream){hash.update(chunk);size+=chunk.length;await new Promise(resolve=>setTimeout(resolve,1))}return{hash:hash.digest('hex'),size}}
    const stdout=digest(h.stdout),stderr=digest(h.stderr);h.stdin.end(bytes)
    assert.deepEqual(await h.done,{exitCode:23,signal:null})
    const expected={hash:createHash('sha256').update(bytes).digest('hex'),size:bytes.length}
    assert.deepEqual(await stdout,expected);assert.deepEqual(await stderr,expected)
    assert.equal(await h.waitForExit(AbortSignal.timeout(5000)),true)
    return { bytesPerStream:bytes.length, exactBinaryOutput:true }
  })
  await check('native early exit closes an otherwise open stdin relay',async()=>{
    const h=launch(['early']),stdout=consume(h.stdout),stderr=consume(h.stderr)
    // Intentionally leave Host stdin open; the native program never reads it.
    assert.deepEqual(await h.done,{exitCode:0,signal:null})
    assert.equal(await h.waitForExit(AbortSignal.timeout(5000)),true)
    assert.equal(await stdout,'early-native-exit');assert.equal(await stderr,'')
    return { stdinLeftOpenByCaller:true, relayExited:true }
  })
  await check('native spawn failure is not wrapper success', async () => {
    const h=launch([],{argv:[join(directory,'missing-native.exe')],stdio:{stdin:'ignore',stdout:'pipe',stderr:'pipe'}})
    h.stdout.resume();h.stderr.resume()
    await assert.rejects(h.done,error=>error.code==='ENOENT')
    assert.equal(await h.waitForExit(AbortSignal.timeout(5000)),true)
    return { spawnError: 'ENOENT' }
  })
  for(const method of ['terminate','abort']) await check(method+' kills detached descendants through the original SDK Job',async()=>{
    const controller=new AbortController(),h=launch(['hold'],{signal:controller.signal}),pid=await firstPID(h)
    h.stderr.resume()
    assert.equal(alive(pid),true)
    if(method==='terminate')h.terminate();else controller.abort()
    assert.equal(await h.waitForExit(AbortSignal.timeout(5000)),true)
    await h.done
    assert.equal(alive(pid),false)
    return { detachedDescendantExited: true }
  })
  for(const privateHelper of [false,true]) await check('natural parent exit with inherited pipes'+(privateHelper?' through private launcher':''),async()=>{
    const h=launch(['natural'],privateHelper?{argv:[process.execPath,join(packageRoot,'lib/types/host/private-launch.mjs'),node,entry,'natural']}:{})
    const pid=await firstPID(h)
    h.stderr.resume()
    assert.deepEqual(await h.done,{exitCode:7,signal:null})
    assert.equal(alive(pid),true)
    assert.equal(await h.waitForExit(AbortSignal.timeout(150)),false)
    h.terminate()
    assert.equal(await h.waitForExit(AbortSignal.timeout(5000)),true)
    assert.equal(alive(pid),false)
    return { rootExitCode: 7, descendantRetainedOutputPipes:true, rangeRemainedLiveUntilStop: true }
  })
} finally {
  for(const h of handles) {
    h.terminate()
    if(!await h.waitForExit(AbortSignal.timeout(5000)).catch(()=>false))cleanupConfirmed=false
    await h.done.catch(()=>{})
  }
  await ctx.fiber.dispose().catch(()=>{cleanupConfirmed=false})
  logger.warn=originalWarn
  if(fixturePids.some(alive))cleanupConfirmed=false
  if(cleanupConfirmed)await rm(directory,{recursive:true,force:true})
  const report={synthetic:true,platform:process.platform,electron:process.versions.electron,cases,
    nativeJobFallback: warnings.some(x=>x.includes('weaker process-tree containment')),
    cleanupConfirmed,remainingFixturePids:fixturePids.filter(alive)}
  await writeFile(output,JSON.stringify(report,null,2),{mode:0o600})
  process.stdout.write(JSON.stringify(report)+'\n')
  if(!cleanupConfirmed||report.nativeJobFallback||cases.some(item=>!item.ok))process.exitCode=1
}
