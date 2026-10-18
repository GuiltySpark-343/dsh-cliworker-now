// Opt-in real acceptance of the isolated preview sources. No CLI starts without --run.
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { homedir, hostname } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parse as parseYaml } from 'yaml'
import type { ActiveCliId, Preference, Worker } from '../src/shared/types.ts'
import type { RuntimeConfig } from '../src/host/process.ts'

const clis: ActiveCliId[] = ['codex', 'omp', 'pi', 'hermes']
const args = process.argv.slice(2)
const help = `Usage: node --import tsx scripts/smoke-steering.ts --list --source-project <absolute path>
       node --import tsx scripts/smoke-steering.ts --run --cli <id|all> --source-project <absolute path>
Options: --preview-root <path> (default .cache/preview-package)
         --source-state <path> (default installed Desktop state)
         --source-profile <path> (default ~/.dsh/profiles/desktop/cordis.patch.yml)
         --timeout-ms <integer> (default 180000 per turn)
--help and --list do not import a runtime or start a CLI.
Uses only the exact saved project model/effort. Missing choices are blocked, never guessed.
--run consumes the selected CLI's credits. --list only reads saved selections.
All Worker/session/steering evidence goes to a new private .test-data/native-steering/run-* directory.
Existing own-account preparation remains authoritative; no Harness credential injection or Desktop update.`
if (!args.length || args.includes('--help')) {
  console.log(help)
  process.exit(0)
}
const flags = new Set(['--list', '--run'])
const pairs = new Set([
  '--cli',
  '--source-project',
  '--preview-root',
  '--source-state',
  '--source-profile',
  '--timeout-ms',
])
const options = new Map<string, string | true>()
for (let index = 0; index < args.length; index++) {
  const arg = args[index]
  if (options.has(arg)) throw new Error('Duplicate smoke option; use --help')
  if (flags.has(arg)) options.set(arg, true)
  else if (pairs.has(arg) && args[index + 1] && !args[index + 1].startsWith('--'))
    options.set(arg, args[++index])
  else throw new Error('Invalid smoke option; use --help')
}
const value = (key: string, fallback = '') =>
  typeof options.get(key) === 'string' ? (options.get(key) as string) : fallback
if (!options.has('--list') && !options.has('--run'))
  throw new Error('Use --list or explicitly opt in with --run')
if (options.has('--list') && options.has('--run')) throw new Error('--list and --run are separate operations')
const projectInput = value('--source-project')
if (!isAbsolute(projectInput)) throw new Error('--source-project must be an existing absolute directory')
const sourceProject = realpathSync(projectInput)
if (!lstatSync(sourceProject).isDirectory()) throw new Error('Source project is not a directory')
const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const profilePath = resolve(value('--source-profile', join(dshHome, 'profiles/desktop/cordis.patch.yml')))
const profile = existsSync(profilePath) ? parseYaml(readFileSync(profilePath, 'utf8')) : []
const deployment: Record<string, unknown>[] = []
function visit(input: unknown) {
  if (Array.isArray(input)) input.forEach(visit)
  else if (input && typeof input === 'object') {
    const object = input as Record<string, unknown>
    if (
      ['dsh-cliworker-now', 'cliworker-now'].includes(String(object.name)) &&
      object.config &&
      typeof object.config === 'object'
    )
      deployment.push(object.config as Record<string, unknown>)
    Object.values(object).forEach(visit)
  }
}
visit(profile)
if (deployment.length > 1)
  throw new Error('Multiple installed CLI Worker configurations; specify an unambiguous profile')
const installed = deployment[0] ?? {}
const sourceState = realpathSync(
  value(
    '--source-state',
    typeof installed.stateDirectory === 'string' ? installed.stateDirectory : join(dshHome, 'cliworker-now'),
  ),
)
const projectKey = (cli: ActiveCliId) =>
  createHash('sha256')
    .update(cli === 'antigravity' ? sourceProject : JSON.stringify([sourceProject, cli]))
    .digest('hex')
function savedPreference(cli: ActiveCliId): Preference | undefined {
  const path = join(sourceState, `${projectKey(cli)}.preference.json`)
  if (!existsSync(path)) return
  const input = JSON.parse(readFileSync(path, 'utf8'))
  if (
    (input.cli ?? 'antigravity') !== cli ||
    typeof input.model !== 'string' ||
    !input.model.trim() ||
    typeof input.effort !== 'string'
  )
    throw new Error(`Saved ${cli} selection is invalid`)
  return { cli, model: input.model, effort: input.effort }
}
const requested = value('--cli', options.has('--list') ? 'all' : '')
if (requested !== 'all' && !clis.includes(requested as ActiveCliId))
  throw new Error('Specify one supported --cli or all')
const selectedClis = requested === 'all' ? clis : [requested as ActiveCliId]
const selections = selectedClis.map((cli) => ({ cli, preference: savedPreference(cli) }))
if (options.has('--list')) {
  console.log(
    JSON.stringify(
      selections.map(({ cli, preference }) => ({
        cli,
        model: preference?.model ?? null,
        effort: preference?.effort ?? null,
        project: sourceProject,
      })),
      null,
      2,
    ),
  )
  process.exit(0)
}

const timeoutMs = Number(value('--timeout-ms', '180000'))
if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 1_800_000)
  throw new Error('Invalid smoke timeout')
const preview = realpathSync(resolve(value('--preview-root', '.cache/preview-package')))
if (
  preview === realpathSync(resolve('.')) ||
  !existsSync(join(preview, 'src/host/native-worker.ts')) ||
  !existsSync(join(preview, 'lib/native-bridge.mjs'))
)
  throw new Error('Build the isolated preview first; production/legacy lib is not an acceptance source')
const source = (path: string) => pathToFileURL(join(preview, path)).href
const [
  runtimeModule,
  storageModule,
  processModule,
  backendModule,
  pathsModule,
  nativeModule,
  catalogModule,
  cordisModule,
  subprocessModule,
] = await Promise.all([
  import(source('src/host/runtime.ts')),
  import(source('src/host/storage.ts')),
  import(source('src/host/process.ts')),
  import(source('src/host/native-process.ts')),
  import(source('src/host/cli-executable-paths.ts')),
  import(source('src/host/native-worker.ts')),
  import(source('src/host/adapters.ts')),
  import('@deepseek-ai/cordis'),
  import('@deepseek-ai/dsh-subprocess-local'),
])
const { WorkerRuntime } = runtimeModule,
  { WorkerStorage } = storageModule
const { DEFAULT_CONFIG } = processModule,
  { nativeProcessBackend } = backendModule
const { CliExecutablePathStore } = pathsModule,
  { transportFor } = nativeModule
const { catalogFor, validatePreference } = catalogModule
process.umask(0o077)
const parent = resolve('.test-data/native-steering')
mkdirSync(parent, { recursive: true, mode: 0o700 })
const root = realpathSync(mkdtempSync(join(parent, 'run-')))
chmodSync(root, 0o700)
const report: Record<string, any> = {
  createdAt: new Date().toISOString(),
  sourceProject,
  sourceState,
  previewRoot: preview,
  runtimeSha256: createHash('sha256')
    .update(readFileSync(join(preview, 'src/host/runtime.ts')))
    .digest('hex'),
  bridgeSha256: createHash('sha256')
    .update(readFileSync(join(preview, 'lib/native-bridge.mjs')))
    .digest('hex'),
  modelTurns: 0,
  records: [],
  completeAcceptance: false,
}
const safePaths = [
  'executable',
  ...clis.filter((cli) => cli !== 'antigravity').map((cli) => `${cli}Executable`),
  'zcodeAuthDirectory',
  'zcodeBuiltinConfig',
  'hermesHome',
]
const deploymentPaths = Object.fromEntries(
  safePaths.filter((key) => typeof installed[key] === 'string').map((key) => [key, installed[key]]),
)
const machine = createHash('sha256')
  .update(JSON.stringify([process.platform, hostname().toLowerCase()]))
  .digest('hex')
const pathsFile = join(sourceState, 'cli-executable-paths', `${process.platform}-${machine}.json`)
const savedPaths = existsSync(pathsFile) ? JSON.parse(readFileSync(pathsFile, 'utf8')) : undefined
if (savedPaths && (savedPaths.schema !== 1 || savedPaths.identity !== machine))
  throw new Error('Saved CLI path identity mismatch')
const receipt = (worker: Worker) => ({
  id: worker.id,
  runId: worker.runId,
  status: worker.status,
  transport: worker.transport,
  conversationId: worker.conversationId,
})
function wireEvidence(storage: any, worker: Worker, cli: ActiveCliId) {
  const path = storage.rawPath(worker)
  const bytes = readFileSync(path),
    text = bytes.toString('utf8'),
    lines = text.split(/\r?\n/).filter(Boolean)
  const records: any[] = []
  let trailingPartial = false
  for (let index = 0; index < lines.length; index++) {
    try {
      records.push(JSON.parse(lines[index]))
    } catch {
      if (index === lines.length - 1 && !text.endsWith('\n')) trailingPartial = true
      else throw new Error('Current native raw contains an invalid complete record')
    }
  }
  const count = (type: string) => records.filter((record) => record.type === type).length
  const existingRpc = cli === 'pi' || cli === 'omp'
  return {
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.length,
    trailingPartial,
    nativeEnvelopeCount: count('native'),
    eventCount: count('event'),
    sessionCount: count('session'),
    resultCount: count('result'),
    nativeEvidenceKind: existingRpc ? 'existing-rpc-bridge' : 'native-bridge',
    matches:
      !trailingPartial &&
      worker.transport === transportFor(cli) &&
      count('session') > 0 &&
      count('event') > 0 &&
      count('result') === 1 &&
      (existingRpc || count('native') > 0),
  }
}
const cleanFailure = (stage: string) => ({
  stage,
  error: '本阶段验收未通过；请核查此隔离运行的私有 Worker 事件与 raw，未自动重试或切换选型。',
})

// Minimal opt-in steering acceptance. The model runs only a bounded sleep and replies;
// observations use exact Host/native identity and events, not CLI self-reported success.
for (const { cli, preference } of selections) {
  const record: Record<string, any> = {
    cli,
    model: preference?.model ?? null,
    effort: preference?.effort ?? null,
    passed: false,
  }
  report.records.push(record)
  if (!preference) {
    record.blocked = '未保存选型；没有调用模型'
    continue
  }
  const runRoot = join(root, cli),
    workspace = join(runRoot, 'workspace'),
    state = join(runRoot, 'worker-state')
  for (const path of [runRoot, workspace, state]) mkdirSync(path, { recursive: true, mode: 0o700 })
  const store = new WorkerStorage(state),
    paths = new CliExecutablePathStore(state)
  const saved = savedPaths?.entries?.[cli]?.entry
  if (saved?.path && saved.mode === 'manual') paths.setManual(cli, saved.path)
  else if (saved?.path && saved.mode === 'auto') paths.remember(cli, saved.path, paths.revision(cli))
  const ctx = new cordisModule.Context()
  let runtime: any,
    submission: any,
    stage = 'startup',
    unsubscribe = () => {}
  try {
    await ctx.plugin(subprocessModule.LocalSubprocessRuntime)
    const config = {
      ...DEFAULT_CONFIG,
      ...deploymentPaths,
      cliExecutablePaths: paths,
      stateDirectory: sourceState,
      timeoutMs,
      graceMs: 5000,
      maxConcurrent: 1,
    }
    runtime = new WorkerRuntime(store, nativeProcessBackend(ctx.subprocess), config)
    const parentSession = `steering-smoke-${cli}-${randomBytes(6).toString('hex')}`
    const marker = `STEERING_${cli}_${randomBytes(8).toString('hex')}`,
      requestId = randomUUID()
    report.modelTurns++
    const streamingFixture = cli === 'pi' || cli === 'omp'
    submission = runtime.submit(
      parentSession,
      workspace,
      `${cli} native steering acceptance`,
      streamingFixture
        ? 'Use no tools. Print every integer from 1 through 500, one per line, without omissions or summarizing. Begin immediately with 1. This is a bounded streaming acceptance task.'
        : 'Use your native shell tool exactly once to run python3 -c "import time; time.sleep(4)". This is a bounded wait only. After the tool completes, reply BASE_REPLY. Do not edit files, use network tools, or call other agents.',
      preference,
      'accept-edits',
    )
    const runId = submission.worker.runId
    await new Promise<void>((yes, no) => {
      const timer = setTimeout(
        () => no(new Error('No active tool before steering deadline')),
        Math.min(timeoutMs, 90000),
      )
      const inspect = () => {
        const w = store.workers.get(submission.worker.id)
        const events = store.history(w.id).filter((e: any) => e.runId === runId)
        if (
          w.status === 'running' &&
          events.some((e: any) =>
            streamingFixture ? e.kind === 'assistant' && e.text.trim() : e.kind === 'tool',
          )
        ) {
          clearTimeout(timer)
          yes()
        } else if (!['queued', 'running'].includes(w.status)) {
          clearTimeout(timer)
          no(new Error('Run ended before steer'))
        }
      }
      unsubscribe = runtime.subscribe(inspect)
      inspect()
    })
    unsubscribe()
    const before = store.workers.get(submission.worker.id)
    const conversationId = before.conversationId
    record.before = receipt(before)
    stage = 'native-steer'
    const prompt = streamingFixture
      ? `For your next assistant response in this same run, reply exactly ${marker}. No tools, numbers, or explanation.`
      : `After the current bounded wait tool completes, replace BASE_REPLY with exactly ${marker}. Use no further tools.`
    await runtime.sendRunningMessage(
      parentSession,
      before.id,
      prompt,
      runId,
      requestId,
      AbortSignal.timeout(20000),
      'steer',
    )
    record.accepted = true
    // Same ID must return its original acceptance without another native delivery.
    await runtime.sendRunningMessage(
      parentSession,
      before.id,
      prompt,
      runId,
      requestId,
      AbortSignal.timeout(20000),
      'steer',
    )
    stage = 'completion'
    const done = await submission.done
    const events = store.history(done.id)
    record.after = receipt(done)
    record.sameRun = done.runId === runId
    record.sameConversation = !!conversationId && done.conversationId === conversationId
    record.userMessages = events.filter(
      (e: any) => e.kind === 'user' && e.queuedFollowupId === requestId && e.runId === runId,
    ).length
    const assistantEvents = events.filter((e: any) => e.kind === 'assistant' && e.runId === runId)
    const lastAssistantStep = assistantEvents.at(-1)?.step
    const lastAssistant = assistantEvents
      .filter((e: any) => e.step === lastAssistantStep)
      .map((e: any) => e.text)
      .join('')
    record.outputMatched = lastAssistant.trim() === marker
    record.queuedEmpty = runtime.snapshot(parentSession, done.id).queuedFollowups.length === 0
    record.wire = wireEvidence(store, done, cli)
    record.passed =
      done.status === 'completed' &&
      record.sameRun &&
      record.sameConversation &&
      record.userMessages === 1 &&
      record.outputMatched &&
      record.queuedEmpty &&
      record.wire.matches
    if (!record.passed) throw new Error('Identity/event/output acceptance did not match')
    console.log(
      JSON.stringify({
        cli,
        status: 'passed',
        sameRun: true,
        sameConversation: true,
        singleUserMessage: true,
        outputMatched: true,
      }),
    )
  } catch (error) {
    record.failedStage = stage
    record.error = String(error).slice(0, 400)
    if (runtime && submission)
      await runtime.stop(submission.worker.parentSessionId, submission.worker.id).catch(() => {})
    if (submission) await submission.done.catch(() => {})
    console.log(JSON.stringify({ cli, status: 'failed', stage }))
  } finally {
    unsubscribe()
    if (runtime) await runtime.close()
    else store.close()
    await ctx.fiber.dispose()
    writeFileSync(join(root, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
  }
}
report.finishedAt = new Date().toISOString()
report.completeAcceptance = report.records.every((r: any) => r.passed)
writeFileSync(join(root, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
console.log(
  JSON.stringify({
    report: join(root, 'report.json'),
    passed: report.records.filter((r: any) => r.passed).map((r: any) => r.cli),
    completeAcceptance: report.completeAcceptance,
  }),
)
if (!report.completeAcceptance) process.exitCode = 1
