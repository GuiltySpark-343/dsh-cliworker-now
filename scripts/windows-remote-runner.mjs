// Invoked only by windows-remote.mjs inside a marked, dedicated Windows directory.
import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { mkdir, readFile, writeFile, lstat, open, rm, symlink, readdir } from 'node:fs/promises'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { OWNER, MARKER, PNPM_VERSION, WINDOWS_TESTS, sha256, validRunId, validateRemoteRoot, validateSnapshot, validateArchiveEntries, runtimeManifestFromSnapshot, assertNoLinksWithin, assertNoLinkAncestors } from './windows-remote-common.mjs'

export function isolatedEnvironment(base, run) {
  const env = {}
  for (const [key, value] of Object.entries(base)) if (/^(?:path|pathext|systemroot|windir|comspec|processor_architecture|number_of_processors|os)$/i.test(key)) env[key] = value
  Object.assign(env, {
    HOME: join(run, 'home'), USERPROFILE: join(run, 'home'),
    ProgramFiles: join(run, 'programfiles'), PROGRAMFILES: join(run, 'programfiles'),
    'ProgramFiles(x86)': join(run, 'programfiles'), ProgramData: join(run, 'programdata'), ALLUSERSPROFILE: join(run, 'programdata'),
    APPDATA: join(run, 'home', 'AppData', 'Roaming'), LOCALAPPDATA: join(run, 'home', 'AppData', 'Local'),
    TEMP: join(run, 'temp'), TMP: join(run, 'temp'), DSH_HOME: join(run, 'dsh'),
    XDG_CONFIG_HOME: join(run, 'home', '.config'), XDG_CACHE_HOME: join(run, 'cache'),
    npm_config_userconfig: join(run, 'npm-user.npmrc'), npm_config_globalconfig: join(run, 'npm-global.npmrc'),
    npm_config_cache: join(run, 'cache', 'npm'), PNPM_HOME: join(run, 'pnpm-home'),
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(run, 'gitconfig'), CI: 'true',
  })
  return env
}

export async function assertOwnedRoot(root) {
  validateRemoteRoot(root.replaceAll('\\', '/'))
  await assertNoLinkAncestors(root)
  const info = await lstat(root)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Remote root is not an owned regular directory')
  const marker = await lstat(join(root, MARKER))
  if (!marker.isFile() || marker.isSymbolicLink()) throw new Error('Invalid remote root marker')
  const owner = JSON.parse(await readFile(join(root, MARKER), 'utf8'))
  if (owner.kind !== OWNER.kind || owner.schema !== OWNER.schema) throw new Error('Remote root ownership marker does not match')
}

export async function acquireRunLock(root, runId) {
  const lock = await open(join(root, 'run.lock'), 'wx')
  await lock.writeFile(JSON.stringify({ ...OWNER, runId, pid: process.pid, startedAt: new Date().toISOString() }))
  await lock.close()
}

const errorText = (error) => error instanceof Error ? error.stack ?? error.message : String(error)
export function stageOutcome(exitCode, signal) { return { exitCode, signal: signal ?? null, success: exitCode === 0 && !signal } }

async function main() {
  if (process.platform !== 'win32') throw new Error('The remote runner requires native Windows')
  const [major, minor] = process.versions.node.split('.').map(Number)
  if (major < 22 || (major === 22 && minor < 19)) throw new Error('Native Node >=22.19 is required')
  const args = process.argv.slice(2)
  const cancel = args[0] === '--cancel'
  if (cancel) args.shift()
  const [root, runId, packageHash, snapshotHash] = args
  if (!validRunId(runId) || (!cancel && (!/^[a-f\d]{64}$/.test(packageHash ?? '') || !/^[a-f\d]{64}$/.test(snapshotHash ?? '')))) throw new Error('Invalid runner arguments')
  await assertOwnedRoot(root)
  const run = join(root, 'runs', runId)
  await assertNoLinksWithin(root, join(run, MARKER))
  if ((await lstat(join(root, 'runs'))).isSymbolicLink()) throw new Error('Runs directory may not be a link')
  const runInfo = await lstat(run)
  if (!runInfo.isDirectory() || runInfo.isSymbolicLink()) throw new Error('Invalid dedicated run directory')
  const runMarker = JSON.parse(await readFile(join(run, MARKER), 'utf8'))
  if (runMarker.kind !== OWNER.kind || runMarker.schema !== OWNER.schema || runMarker.runId !== runId) throw new Error('Run marker does not match')
  if (cancel) {
    try {
      const completed = JSON.parse(await readFile(join(run, 'report.json'), 'utf8'))
      if (completed.finishedAt) {
        if (!completed.cleanup?.confirmed || !completed.cleanup?.lockReleased) throw new Error('Finished run cleanup is unconfirmed')
        console.log('Run already finished with confirmed cleanup.')
        return
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error }
    const lock = JSON.parse(await readFile(join(root, 'run.lock'), 'utf8'))
    if (lock.runId !== runId) throw new Error('Refusing to cancel another run')
    await writeFile(join(run, 'cancel.json'), JSON.stringify({ runId, requestedAt: new Date().toISOString() }))
    for (let attempt = 0; attempt < 30; attempt++) {
      await new Promise((r) => setTimeout(r, 1000))
      const completed = JSON.parse(await readFile(join(run, 'report.json'), 'utf8'))
      if (completed.finishedAt && completed.cleanup?.confirmed && completed.cleanup?.lockReleased) {
        console.log('Owner runner confirmed its process cleanup and lock release.')
        return
      }
    }
    throw new Error('Cancellation cleanup unconfirmed; preserve run.lock and inspect the run report')
  }

  const report = {
    schema: 1, runId, startedAt: new Date().toISOString(), finishedAt: null, success: false,
    platform: process.platform, architecture: process.arch, node: process.version, pnpm: PNPM_VERSION,
    sourceSnapshotSha256: snapshotHash, macPackageSha256: packageHash, receivedPackageSha256: null,
    modelCalls: 0, guiVerified: false, officialCliSmokeExecuted: false,
    evidenceBoundary: {
      synthetic: '账号、CLI 协议和 launcher 数据来自测试夹具；没有访问生产账号。',
      native: 'Windows 本机 Node、Job/ConPTY/Python 进程用例及 SDK 依赖；具体通过数见 Vitest JSON。',
      unverified: ['真实模型生成', '官方 CLI 额外启动探针', 'Harness Desktop 界面', 'Windows 全量测试矩阵'],
    },
    stages: [], cleanup: { confirmed: false, lockReleased: false },
  }
  await assertNoLinksWithin(root, join(run, 'logs'))
  await mkdir(join(run, 'logs'), { recursive: true })
  const reportPath = join(run, 'report.json')
  const persist = async () => { await assertNoLinksWithin(root, reportPath); await writeFile(reportPath, JSON.stringify(report, null, 2)) }
  let lockOwned = false
  let currentChild = null
  let aborted = false
  let cleanupConfirmed = true
  const source = join(run, 'source')
  const env = isolatedEnvironment(process.env, run)
  const timers = new Set()
  async function killOwnedChild() {
    const child = currentChild
    if (!child || child.exitCode !== null) return
    const exit = new Promise((r) => child.once('close', r))
    const status = await new Promise((r) => {
      const killer = spawn(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true })
      killer.once('error', () => r(-1))
      killer.once('close', (code) => r(code))
    })
    const closed = await Promise.race([exit.then(() => true), new Promise((r) => setTimeout(() => r(false), 10000))])
    if (!closed || (status !== 0 && child.exitCode === null)) cleanupConfirmed = false
  }
  let cancelling = null
  const abort = () => {
    aborted = true
    if (!cancelling) cancelling = killOwnedChild().catch(() => { cleanupConfirmed = false })
  }
  process.on('SIGINT', abort)
  process.on('SIGTERM', abort)
  const cancelPoll = setInterval(async () => {
    try { await lstat(join(run, 'cancel.json')); abort() } catch (error) { if (error.code !== 'ENOENT') abort() }
  }, 1000)
  cancelPoll.unref()

  async function stage(name, file, argv, { cwd = source, timeout = 15 * 60 * 1000, capture = false } = {}) {
    if (aborted) throw new Error('Run interrupted')
    const item = { name, startedAt: new Date().toISOString(), command: [file, ...argv], exitCode: null, signal: null, success: false }
    report.stages.push(item)
    await persist()
    console.log(`Starting ${name}`)
    await assertNoLinksWithin(root, join(run, 'logs', `${name}.log`))
    const log = createWriteStream(join(run, 'logs', `${name}.log`))
    const child = spawn(file, argv, { cwd, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    currentChild = child
    let output = ''
    child.stdout.on('data', (bytes) => { log.write(bytes); if (capture) output += bytes.toString() })
    child.stderr.on('data', (bytes) => log.write(bytes))
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; abort() }, timeout)
    timers.add(timer)
    const result = await new Promise((r) => {
      child.once('error', (error) => r({ exitCode: -1, signal: null, error: errorText(error) }))
      child.once('close', (exitCode, signal) => r({ exitCode, signal }))
    })
    clearTimeout(timer); timers.delete(timer)
    if (cancelling) await cancelling
    currentChild = null
    await new Promise((r) => log.end(r))
    Object.assign(item, stageOutcome(result.exitCode, result.signal), { finishedAt: new Date().toISOString() })
    if (result.error) item.error = result.error
    if (timedOut) item.error = 'Stage timed out; owned process tree cancellation requested'
    await persist()
    console.log(`${name}: ${item.success ? 'passed' : 'failed'} (${item.exitCode})`)
    if (!item.success || aborted) throw new Error(`${name} failed (${item.exitCode}); inspect logs/${name}.log`)
    return output
  }

  try {
    await acquireRunLock(root, runId)
    lockOwned = true
    for (const name of ['source', 'home', 'cache', 'temp', 'dsh', 'pnpm-home', 'programfiles', 'programdata']) await mkdir(join(run, name))
    const fileEnvironmentKeys = new Set(['npm_config_userconfig', 'npm_config_globalconfig', 'git_config_global'])
    for (const [, path] of Object.entries(env).filter(([key, value]) => !fileEnvironmentKeys.has(key.toLowerCase()) && typeof value === 'string' && value.startsWith(run))) {
      await assertNoLinksWithin(root, path)
      await mkdir(path, { recursive: true })
    }
    for (const file of ['npm-user.npmrc', 'npm-global.npmrc', 'gitconfig']) await writeFile(join(run, file), '')
    const received = await readFile(join(run, 'plugin.tgz'))
    report.receivedPackageSha256 = sha256(received)
    if (report.receivedPackageSha256 !== packageHash) throw new Error('Mac package transfer hash mismatch')
    const snapshotBytes = await readFile(join(run, 'snapshot.json'))
    if (sha256(snapshotBytes) !== snapshotHash) throw new Error('Source snapshot transfer hash mismatch')
    const snapshot = validateSnapshot(JSON.parse(snapshotBytes.toString()))
    report.sourceFiles = snapshot.files.length
    for (const file of snapshot.files) {
      const output = join(source, ...file.path.split('/'))
      await mkdir(dirname(output), { recursive: true })
      await writeFile(output, Buffer.from(file.data, 'base64'), { flag: 'wx' })
    }
    const manifest = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'))
    if (manifest.packageManager !== `pnpm@${PNPM_VERSION}`) throw new Error('Source packageManager is not the pinned pnpm version')
    report.packageVersion = manifest.version
    const tools = join(root, 'tools')
    await assertNoLinksWithin(root, tools)
    await mkdir(tools, { recursive: true })
    if ((await lstat(tools)).isSymbolicLink()) throw new Error('Tools directory must not be a link')
    const pnpm = join(tools, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs')
    await assertNoLinksWithin(root, pnpm)
    try { await lstat(pnpm) } catch (error) {
      if (error.code !== 'ENOENT') throw error
      const npm = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
      await stage('prepare-pnpm', process.execPath, [npm, 'install', '--prefix', tools, '--no-audit', '--no-fund', '--ignore-scripts', `pnpm@${PNPM_VERSION}`])
    }
    const actualPnpm = (await stage('pnpm-version', process.execPath, [pnpm, '--version'], { capture: true })).trim()
    if (actualPnpm !== PNPM_VERSION) throw new Error(`Unexpected pnpm version ${actualPnpm}`)
    await stage('install', process.execPath, [pnpm, 'install', '--frozen-lockfile', '--config.verifyDepsBeforeRun=false'], { timeout: 25 * 60 * 1000 })
    const tar = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
    const archivePath = join(run, 'plugin.tgz')
    const listing = await stage('package-list', tar, ['-tzf', archivePath], { capture: true })
    const verbose = await stage('package-entries', tar, ['-tvzf', archivePath], { capture: true })
    validateArchiveEntries(listing, verbose, runtimeManifestFromSnapshot(snapshot))
    const artifact = join(run, 'artifact')
    await mkdir(artifact)
    await stage('package-unpack', tar, ['-xzf', archivePath, '-C', artifact])
    // Client typecheck self-imports the generated Remote contract. Use the same
    // Mac package's generated lib; no Windows build replaces the package under test.
    const copyTypes = "import {cp,access} from 'node:fs/promises';import {join} from 'node:path';const [from,to]=process.argv.slice(1);await cp(from,to,{recursive:true,errorOnExist:true,force:false});await access(join(to,'typert.remote-client.d.ts'));console.log('Generated contracts prepared from the verified Mac package')"
    await stage('mac-contract-types', process.execPath, ['--input-type=module', '-e', copyTypes, join(artifact, 'package', 'lib'), join(source, 'lib')])
    report.generatedTypesSource = 'The verified Mac package lib; not rebuilt on Windows'
    await stage('typecheck', process.execPath, [pnpm, '--config.verifyDepsBeforeRun=false', 'typecheck'])
    await stage('windows-tests', process.execPath, [pnpm, '--config.verifyDepsBeforeRun=false', 'exec', 'vitest', 'run', ...WINDOWS_TESTS,
      '--reporter=default', '--reporter=json', `--outputFile=${join(run, 'windows-tests.json')}`])
    const testResult = JSON.parse(await readFile(join(run, 'windows-tests.json'), 'utf8'))
    report.windowsTestsSha256 = sha256(await readFile(join(run, 'windows-tests.json')))
    report.tests = { success: testResult.success, passed: testResult.numPassedTests, failed: testResult.numFailedTests, pending: testResult.numPendingTests, total: testResult.numTotalTests }
    report.expectedPlatformSkip = 'POSIX official Pi launcher test is excluded on native Windows; Windows launch behavior has its own test.'
    if (!testResult.success || testResult.numFailedTests || !testResult.numPassedTests) throw new Error('Vitest JSON does not confirm passed tests')
    // This private junction is removed in finally; it never points at a Desktop installation.
    const dependencies = join(artifact, 'package', 'node_modules')
    await symlink(join(source, 'node_modules'), dependencies, 'junction')
    const load = `const m=await import(${JSON.stringify(pathToFileURL(join(artifact, 'package', 'lib', 'index.js')).href)});if(typeof m.default!=='function'||m.default!==m.CliWorkerService)throw Error('Host service export mismatch');console.log(JSON.stringify({platform:process.platform,architecture:process.arch,exports:Object.keys(m),hostService:m.default.name}))`
    await stage('mac-package-host-load', process.execPath, ['--input-type=module', '-e', load])
    report.success = true
  } catch (error) {
    report.error = errorText(error)
    process.exitCode = 1
  } finally {
    clearInterval(cancelPoll)
    for (const timer of timers) clearTimeout(timer)
    process.off('SIGINT', abort); process.off('SIGTERM', abort)
    if (cancelling) await cancelling
    if (currentChild) await killOwnedChild()
    try {
      const link = join(run, 'artifact', 'package', 'node_modules')
      if ((await lstat(link)).isSymbolicLink()) await rm(link)
    } catch (error) { if (error.code !== 'ENOENT') { cleanupConfirmed = false; report.cleanup.error = errorText(error) } }
    report.cleanup.confirmed = cleanupConfirmed
    if (lockOwned && cleanupConfirmed) {
      try {
        const lock = JSON.parse(await readFile(join(root, 'run.lock'), 'utf8'))
        if (lock.runId !== runId || lock.pid !== process.pid) throw new Error('Run lock ownership changed')
        await rm(join(root, 'run.lock'))
        report.cleanup.lockReleased = true
      } catch (error) { report.cleanup.confirmed = false; report.cleanup.error = errorText(error) }
    }
    if (!report.cleanup.confirmed || aborted) { report.success = false; process.exitCode = 1 }
    report.interrupted = aborted
    report.finishedAt = new Date().toISOString()
    await persist()
    console.log(`Report: ${reportPath}; success=${report.success}`)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(errorText(error)); process.exitCode = 1 })
}
