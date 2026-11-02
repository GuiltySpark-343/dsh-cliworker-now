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
import { createHash, randomBytes } from 'node:crypto'
import { homedir, hostname } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parse as parseYaml } from 'yaml'
import { CLI_IDS, type ActiveCliId, type Preference, type Worker } from '../src/shared/types.ts'
import type { RuntimeConfig } from '../src/host/process.ts'

const clis: ActiveCliId[] = [...CLI_IDS]
const args = process.argv.slice(2)
const help = `Usage: node --import tsx scripts/smoke-native.ts --list --source-project <absolute path>
       node --import tsx scripts/smoke-native.ts --run --cli <id|all> --source-project <absolute path> [--catalog-only]
Options: --preview-root <path> (default .cache/preview-package)
         --source-state <path> (default installed Desktop state)
         --source-profile <path> (default ~/.dsh/profiles/desktop/cordis.patch.yml)
         --timeout-ms <integer> (default 180000 per turn)
         --inspect-only (one artifact/reply turn plus projected transcript/context evidence)
--help and --list do not import a runtime or start a CLI.
Uses only the exact saved project model/effort. Missing choices are blocked, never guessed.
--run consumes the selected CLI's credits. --catalog-only sends no prompts.
All Worker/session/artifact evidence goes to a new private .test-data/native-smoke/run-* directory.
Existing own-account preparation remains authoritative; no Harness credential injection or Desktop update.`
if (!args.length || args.includes('--help')) {
  console.log(help)
  process.exit(0)
}
const flags = new Set(['--list', '--run', '--catalog-only', '--inspect-only'])
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
const parent = resolve('.test-data/native-smoke')
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
  catalogOnly: !!options.has('--catalog-only'),
  inspectOnly: !!options.has('--inspect-only'),
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

for (const { cli, preference } of selections) {
  const record: Record<string, any> = {
    cli,
    model: preference?.model ?? null,
    effort: preference?.effort ?? null,
    project: sourceProject,
    modelTurns: 0,
    passed: false,
  }
  report.records.push(record)
  console.log(JSON.stringify({ cli, phase: 'selection', status: preference ? 'selected' : 'blocked' }))
  if (!preference) {
    record.blocked = '没有此项目保存选型；未发送模型请求'
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
    stage = 'initialization'
  try {
    await ctx.plugin(subprocessModule.LocalSubprocessRuntime)
    const backend = nativeProcessBackend(ctx.subprocess)
    const config: RuntimeConfig = {
      ...DEFAULT_CONFIG,
      ...deploymentPaths,
      cliExecutablePaths: paths,
      // Account sources are unchanged; workers, projects and native sessions are isolated below.
      stateDirectory: sourceState,
      timeoutMs,
      graceMs: 5000,
      maxConcurrent: 1,
    }
    runtime = new WorkerRuntime(store, backend, config)
    if (options.has('--catalog-only')) {
      stage = 'catalog'
      const catalog = await catalogFor(cli, backend, config, workspace, AbortSignal.timeout(timeoutMs))
      validatePreference(preference, catalog)
      record.catalogConfirmed = true
      record.passed = true
      continue
    }
    const parentSession = `native-smoke-${cli}-${randomBytes(8).toString('hex')}`
    const marker = `NATIVE_${cli}_${randomBytes(12).toString('hex')}`,
      artifactPath = join(workspace, 'artifact.json')
    stage = 'artifact'
    record.modelTurns++
    report.modelTurns++
    const first = (await runtime.submit(
      parentSession,
      workspace,
      `${cli} native protocol acceptance`,
      `Use your native file-writing tool to create artifact.json in the current directory with exactly this JSON: ${JSON.stringify({ cli, marker, value: 23 })}. Then reply exactly ${marker}. Do not use shell, other agents, network tools, or merely describe the file.`,
      preference,
      'accept-edits',
    ).done) as Worker
    record.initial = receipt(first)
    if (first.status !== 'completed' || !first.conversationId)
      throw new Error('First native turn did not complete')
    const artifact = readFileSync(artifactPath)
    if (artifact.length > 65536) throw new Error('Artifact exceeds fixture limit')
    const json = JSON.parse(artifact.toString('utf8'))
    const toolConfirmed = store
      .history(first.id)
      .some(
        (event: any) =>
          event.runId === first.runId &&
          event.kind === 'tool' &&
          ['COMPLETED', 'SUCCESS', 'DONE'].includes(event.state?.toUpperCase() ?? ''),
      )
    const wire = wireEvidence(store, first, cli)
    record.artifact = {
      matches: json.cli === cli && json.marker === marker && json.value === 23,
      toolConfirmed,
      sha256: createHash('sha256').update(artifact).digest('hex'),
      wire,
    }
    if (!record.artifact.matches || !toolConfirmed || !wire.matches)
      throw new Error('Artifact/tool/native transport evidence failed')
    console.log(JSON.stringify({ cli, phase: 'artifact', status: 'passed', transport: first.transport }))
    if (options.has('--inspect-only')) {
      stage = 'inspection'
      const events = store.history(first.id).filter((event: any) => event.runId === first.runId)
      const snapshot = runtime.snapshot(parentSession, first.id)
      const timeline = snapshot.timeline
      const replies = timeline.filter((item: any) => item.kind === 'assistant')
      const tools = timeline.filter((item: any) => item.kind === 'tool')
      const telemetry = snapshot.telemetry
      record.inspection = {
        assistantEventCount: events.filter((event: any) => event.kind === 'assistant').length,
        assistantMessageCount: replies.length,
        finalReplyMatched: replies.at(-1)?.text.trim() === marker,
        tools: tools.map((item: any) => ({ state: item.state, name: item.toolCall?.name,
          hasNativeCallId: !!item.toolCall?.callId, hasInput: item.toolCall?.input !== undefined,
          hasOutput: item.toolCall?.output !== undefined })),
        telemetry,
      }
      if (!record.inspection.finalReplyMatched || !tools.length || tools.some((item: any) => !item.toolCall))
        throw new Error('Public response/tool inspection did not match native evidence')
      record.passed = true
      console.log(JSON.stringify({ cli, phase: 'inspection', status: 'passed',
        assistantEventCount: record.inspection.assistantEventCount, assistantMessageCount: replies.length,
        contextUsed: telemetry?.contextUsed, contextCapacity: telemetry?.contextCapacity }))
      continue
    }
    stage = 'followup'
    record.modelTurns++
    report.modelTurns++
    const second = (await runtime.submit(
      parentSession,
      workspace,
      first.title,
      'Without reading any files or calling tools, repeat only the exact NATIVE marker from our previous turn.',
      preference,
      'accept-edits',
      first.id,
    ).done) as Worker
    const noTools = !store
      .history(second.id)
      .some((event: any) => event.runId === second.runId && event.kind === 'tool')
    record.followup = {
      ...receipt(second),
      sameWorker: second.id === first.id,
      sameConversation: second.conversationId === first.conversationId,
      markerMatched: second.lastResult?.trim() === marker,
      noTools,
      wire: wireEvidence(store, second, cli),
    }
    if (
      second.status !== 'completed' ||
      !record.followup.sameWorker ||
      !record.followup.sameConversation ||
      !record.followup.markerMatched ||
      !noTools ||
      !record.followup.wire.matches
    )
      throw new Error('Same-session memory acceptance failed')
    console.log(JSON.stringify({ cli, phase: 'followup', status: 'passed' }))
    stage = 'cancel'
    record.modelTurns++
    report.modelTurns++
    const third = runtime.submit(
      parentSession,
      workspace,
      first.title,
      'Use no tools. Start your reply with COUNTING and then print every integer from 1 through 50000, one per line, without summarizing or stopping early.',
      preference,
      'accept-edits',
      first.id,
    )
    let unsubscribe = () => {},
      timer: ReturnType<typeof setTimeout> | undefined
    try {
      await new Promise<void>((yes, no) => {
        const inspect = () => {
          const worker = store.workers.get(third.worker.id)
          if (!worker || !['queued', 'running'].includes(worker.status))
            return no(new Error('Cancel fixture ended before interruption'))
          if (
            worker.status === 'running' &&
            store
              .history(worker.id)
              .some(
                (event: any) =>
                  event.runId === third.worker.runId && event.kind === 'assistant' && event.text.trim(),
              )
          )
            yes()
        }
        unsubscribe = runtime.subscribe(inspect)
        timer = setTimeout(
          () => no(new Error('No current-turn assistant output before cancel deadline')),
          Math.min(timeoutMs, 90000),
        )
        inspect()
      })
      if (store.workers.get(third.worker.id)?.status !== 'running')
        throw new Error('Cancel fixture completed before stop')
      const stopped = (await runtime.stop(parentSession, third.worker.id)) as Worker
      const done = (await third.done) as Worker
      record.cancel = {
        ...receipt(stopped),
        outputObserved: true,
        stopAwaited: true,
        doneStatus: done.status,
        sameConversation: stopped.conversationId === first.conversationId,
        wire: wireEvidence(store, done, cli),
      }
      if (
        stopped.status !== 'interrupted' ||
        done.status !== 'interrupted' ||
        !record.cancel.sameConversation
      )
        throw new Error('Cancel process-range acceptance failed')
      console.log(JSON.stringify({ cli, phase: 'cancel', status: 'passed' }))
    } catch {
      record.cancel = {
        inconclusive: true,
        reason: '没有在仍running的本轮正文后完成stop→interrupted→done，不计取消通过',
      }
      await runtime.stop(parentSession, third.worker.id).catch(() => {})
      await third.done.catch(() => {})
      throw new Error('Cancellation acceptance is inconclusive')
    } finally {
      unsubscribe()
      if (timer) clearTimeout(timer)
    }
    record.passed = true
  } catch {
    Object.assign(record, cleanFailure(stage))
    console.log(JSON.stringify({ cli, phase: stage, status: 'failed', modelTurns: record.modelTurns }))
  } finally {
    if (runtime) await runtime.close()
    else store.close()
    await ctx.fiber.dispose()
    writeFileSync(join(root, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
  }
}
report.completeAcceptance = report.records.every((record: any) => record.passed && !record.blocked)
report.finishedAt = new Date().toISOString()
writeFileSync(join(root, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
console.log(
  JSON.stringify({
    report: join(root, 'report.json'),
    modelTurns: report.modelTurns,
    passed: report.records.filter((record: any) => record.passed).map((record: any) => record.cli),
    blocked: report.records.filter((record: any) => record.blocked).map((record: any) => record.cli),
    completeAcceptance: report.completeAcceptance,
  }),
)
if (!report.completeAcceptance) process.exitCode = 1
