// Opt-in real acceptance of goal injection and native fork, using the isolated preview sources.
// No CLI prompt is sent without --run. --list reads model catalogs only.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { homedir, hostname } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parse as parseYaml } from 'yaml'
import { CLI_IDS, type ActiveCliId, type Worker } from '../src/shared/types.ts'
import type { RuntimeConfig } from '../src/host/process.ts'

const help = `Usage: node --import tsx scripts/smoke-features.ts --list [--cli <id|all>]
       node --import tsx scripts/smoke-features.ts --run --cli <id> --model <id> --effort <value> [--earlier] [--pause]
--list reads each CLI's real model catalog and sends no prompt.
--run consumes credits: 2 turns (goal), +2 when the CLI supports latest fork, +2 with --earlier, +1 with --pause.
The model and effort must come from the CLI's real catalog; nothing is guessed.
Evidence goes to a new private .test-data/feature-smoke/run-* directory.`
const args = process.argv.slice(2)
if (!args.length || args.includes('--help')) {
  console.log(help)
  process.exit(0)
}
const options = new Map<string, string | true>()
for (let index = 0; index < args.length; index++) {
  const arg = args[index]!
  if (['--list', '--run', '--earlier', '--pause'].includes(arg)) options.set(arg, true)
  else if (['--cli', '--model', '--effort', '--timeout-ms'].includes(arg) && args[index + 1])
    options.set(arg, args[++index]!)
  else throw new Error(`Invalid option ${arg}; use --help`)
}
const value = (key: string, fallback = '') => (typeof options.get(key) === 'string' ? (options.get(key) as string) : fallback)
const clis = [...CLI_IDS] as ActiveCliId[]
const requested = value('--cli', options.has('--list') ? 'all' : '')
if (requested !== 'all' && !clis.includes(requested as ActiveCliId)) throw new Error('Specify --cli')
if (options.has('--run') && requested === 'all') throw new Error('--run takes one --cli')

const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const profilePath = join(dshHome, 'profiles/desktop/cordis.patch.yml')
const profile = existsSync(profilePath) ? parseYaml(readFileSync(profilePath, 'utf8')) : []
const deployment: Record<string, unknown>[] = []
const visit = (input: unknown): void => {
  if (Array.isArray(input)) input.forEach(visit)
  else if (input && typeof input === 'object') {
    const object = input as Record<string, unknown>
    if (['dsh-cliworker-now', 'cliworker-now'].includes(String(object.name)) && object.config && typeof object.config === 'object')
      deployment.push(object.config as Record<string, unknown>)
    Object.values(object).forEach(visit)
  }
}
visit(profile)
const installed = deployment[0] ?? {}
const sourceState = realpathSync(typeof installed.stateDirectory === 'string' ? installed.stateDirectory : join(dshHome, 'cliworker-now'))
const deploymentPaths = Object.fromEntries(
  ['executable', ...clis.map((cli) => `${cli}Executable`), 'zcodeAuthDirectory', 'zcodeBuiltinConfig', 'hermesHome']
    .filter((key) => typeof installed[key] === 'string').map((key) => [key, installed[key]]),
)
const machine = createHash('sha256').update(JSON.stringify([process.platform, hostname().toLowerCase()])).digest('hex')
const pathsFile = join(sourceState, 'cli-executable-paths', `${process.platform}-${machine}.json`)
const savedPaths = existsSync(pathsFile) ? JSON.parse(readFileSync(pathsFile, 'utf8')) : undefined

const preview = realpathSync(resolve('.cache/preview-package'))
if (!existsSync(join(preview, 'src/host/worker-fork.ts'))) throw new Error('Build the isolated preview first')
const source = (path: string) => pathToFileURL(join(preview, path)).href
const [runtimeModule, storageModule, processModule, backendModule, pathsModule, catalogModule, conversationModule, featureModule, modelsModule, cordisModule, subprocessModule] =
  await Promise.all([
    import(source('src/host/runtime.ts')),
    import(source('src/host/storage.ts')),
    import(source('src/host/process.ts')),
    import(source('src/host/native-process.ts')),
    import(source('src/host/cli-executable-paths.ts')),
    import(source('src/host/adapters.ts')),
    import(source('src/host/harness-conversation.ts')),
    import(source('src/shared/conversation-features.ts')),
    import(source('src/shared/models.ts')),
    import('@deepseek-ai/cordis'),
    import('@deepseek-ai/dsh-subprocess-local'),
  ])
const timeoutMs = Number(value('--timeout-ms', '240000'))
process.umask(0o077)
const parentDir = resolve('.test-data/feature-smoke')
mkdirSync(parentDir, { recursive: true, mode: 0o700 })
const root = realpathSync(mkdtempSync(join(parentDir, 'run-')))
chmodSync(root, 0o700)

const GOAL_MARK = '【当前目标】'
/** Records each native request prompt the bridge received (request file is deleted after the run). */
const launches: Array<{ prompt?: string; forkOperation?: string; argvHasGoal: boolean }> = []
function record(spec: any) {
  const request = spec.argv?.at(-1)
  let parsed: any
  if (typeof request === 'string' && request.endsWith('.json') && existsSync(request))
    try { parsed = JSON.parse(readFileSync(request, 'utf8')) } catch {}
  launches.push({
    ...(typeof parsed?.prompt === 'string' ? { prompt: parsed.prompt } : {}),
    ...(parsed?.forkOperation ? { forkOperation: parsed.forkOperation } : {}),
    argvHasGoal: (spec.argv ?? []).some((part: unknown) => typeof part === 'string' && part.includes(GOAL_MARK)),
  })
}
/** macOS runs Workers through spawnTerminal, Windows through spawn; observe both. */
function observe(backend: any) {
  return {
    resolveExecutable: (name: string) => backend.resolveExecutable(name),
    spawn(spec: any) { record(spec); return backend.spawn(spec) },
    ...(backend.spawnTerminal ? { spawnTerminal: (spec: any) => { record(spec); return backend.spawnTerminal(spec) } } : {}),
  }
}

async function setup(cli: ActiveCliId, dir: string) {
  const workspace = join(dir, 'workspace'), state = join(dir, 'worker-state')
  for (const path of [dir, workspace, state]) mkdirSync(path, { recursive: true, mode: 0o700 })
  const store = new storageModule.WorkerStorage(state), paths = new pathsModule.CliExecutablePathStore(state)
  const saved = savedPaths?.entries?.[cli]?.entry
  if (saved?.path && saved.mode === 'manual') paths.setManual(cli, saved.path)
  else if (saved?.path && saved.mode === 'auto') paths.remember(cli, saved.path, paths.revision(cli))
  const ctx = new cordisModule.Context()
  await ctx.plugin(subprocessModule.LocalSubprocessRuntime)
  const backend = observe(backendModule.nativeProcessBackend(ctx.subprocess))
  const config: RuntimeConfig = {
    ...processModule.DEFAULT_CONFIG, ...deploymentPaths, cliExecutablePaths: paths,
    // Account sources are the installed ones; Workers and native sessions are isolated here.
    stateDirectory: sourceState, timeoutMs, graceMs: 5000, maxConcurrent: 1,
  }
  return { ctx, store, backend, config, workspace }
}

if (options.has('--list')) {
  const out: any[] = []
  for (const cli of requested === 'all' ? clis : [requested as ActiveCliId]) {
    const env = await setup(cli, join(root, `list-${cli}`))
    try {
      const catalog = await catalogModule.catalogFor(cli, env.backend, env.config, env.workspace, AbortSignal.timeout(90000))
      out.push({ cli, notice: catalog.notice, models: catalog.models?.map((model: any) => ({ id: model.id, name: model.name, efforts: model.efforts?.map((e: any) => e.value ?? e) ?? model.supportedEfforts })) })
    } catch (error) {
      out.push({ cli, blocked: String((error as Error)?.message ?? error).slice(0, 300) })
    } finally {
      env.store.close()
      await env.ctx.fiber.dispose()
    }
  }
  writeFileSync(join(root, 'catalogs.json'), JSON.stringify(out, null, 2), { mode: 0o600 })
  console.log(JSON.stringify(out, null, 2))
  process.exit(0)
}

const cli = requested as ActiveCliId
const requestedPreference = { cli, model: value('--model'), effort: value('--effort') }
if (!requestedPreference.model) throw new Error('--model is required')
const env = await setup(cli, join(root, cli))
const catalog = await catalogModule.catalogFor(cli, env.backend, env.config, env.workspace, AbortSignal.timeout(90000))
catalogModule.validatePreference(requestedPreference, catalog)
// Grouped choices (e.g. Antigravity) execute the exact per-effort variant ID, as the UI saves it.
const preference = modelsModule.resolveModel(requestedPreference, catalog.models)
const runtime = new runtimeModule.WorkerRuntime(env.store, env.backend, env.config)
const parent = `feature-smoke-${cli}-${randomBytes(6).toString('hex')}`
const word1 = `ALPHA${randomBytes(3).toString('hex').toUpperCase()}`
const word2 = `BRAVO${randomBytes(3).toString('hex').toUpperCase()}`
const goalToken = `GOAL${randomBytes(3).toString('hex').toUpperCase()}`
const report: Record<string, any> = { cli, model: preference.model, effort: preference.effort, createdAt: new Date().toISOString(), turns: 0, steps: [] }
const save = () => writeFileSync(join(root, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
const reply = (worker: Worker) => (worker.lastResult ?? '').trim()

async function turn(label: string, prompt: string, previousId?: string) {
  const before = launches.length
  report.turns++
  const worker = (await runtime.submit(parent, env.workspace, `${cli} feature acceptance`, prompt, preference, 'accept-edits', previousId).done) as Worker
  const seen = launches.slice(before).filter((launch) => !launch.forkOperation)
  const step = {
    label, workerId: worker.id, runId: worker.runId, status: worker.status, conversationId: worker.conversationId,
    reply: reply(worker).slice(0, 400),
    promptObserved: seen.some((launch) => launch.prompt !== undefined || launch.argvHasGoal),
    goalInjected: seen.some((launch) => launch.prompt?.includes(GOAL_MARK) || launch.argvHasGoal),
  }
  report.steps.push(step)
  save()
  console.log(JSON.stringify(step))
  if (worker.status !== 'completed') throw new Error(`${label}: run ended ${worker.status}`)
  return worker
}

function bind(worker: Worker) {
  const stored = env.store.workers.get(worker.id)!
  if (stored.harnessConversation) return
  const record = { workerId: worker.id, parentSessionId: parent, sessionId: randomUUID(), initialRunId: worker.runId }
  stored.harnessConversation = conversationModule.harnessConversationBinding(record, false, false, featureModule.bridgedFeatureSupport(stored))
  env.store.save(stored)
}
/** Stand-in for the Harness child-conversation bridge: the cut is given as a run ID. */
function bridge(runs: Record<string, { runId: string; turn: number }>, latest: string) {
  return {
    forkHistory: async (_source: Worker, at: string) => {
      const cut = runs[at || latest]!
      return { seed: [], runId: cut.runId, earlier: !!at && at !== latest, turn: cut.turn }
    },
    createFork: async (_parent: unknown, worker: Worker) => ({
      binding: conversationModule.harnessConversationBinding(
        { workerId: worker.id, parentSessionId: parent, sessionId: randomUUID(), initialRunId: worker.runId },
        false, false, featureModule.bridgedFeatureSupport(worker)),
      commit: async () => {},
      rollback: async () => {},
    }),
  }
}

let failure: unknown
try {
  const first = await turn('A 初始轮', `Do not use any tools. Keep in mind the first code word: ${word1}. Reply with exactly: OK`)
  const goal = runtime.setWorkerGoal(parent, first.id, `Every reply must start with the token ${goalToken} followed by a space.`, 0)
  report.goal = goal
  const second = await turn('B 目标轮', `The second code word is ${word2}. Reply with the first code word only.`, first.id)
  report.goalCheck = {
    injectedIntoCliInput: report.steps.at(-1).goalInjected,
    replyStartsWithGoalToken: reply(second).startsWith(goalToken),
    replyHasFirstWord: reply(second).includes(word1),
    sameConversation: second.conversationId === first.conversationId,
  }
  save()
  const support = featureModule.bridgedFeatureSupport(second)
  report.support = support
  if (support.fork.supported) {
    bind(second)
    const runs = { A: { runId: first.runId, turn: 1 }, B: { runId: second.runId, turn: 2 } }
    const forked = await runtime.forkWorker({ id: parent } as any, second.id, '', bridge(runs, 'B') as any, AbortSignal.timeout(timeoutMs))
    const forkWorker = env.store.workers.get(forked.workerId) as Worker
    report.fork = { ...forked, conversationIdAtCreate: forkWorker.conversationId ?? null, goalCopied: forkWorker.goal?.objective === goal.objective }
    const onFork = await turn('F 分支轮', 'Reply with the second code word only.', forked.workerId)
    const original = await turn('O 原会话续聊', 'Reply with exactly: STILL-HERE', second.id)
    Object.assign(report.fork, {
      forkConversation: onFork.conversationId,
      sourceConversation: second.conversationId,
      newConversationId: !!onFork.conversationId && onFork.conversationId !== second.conversationId,
      historyKept: reply(onFork).includes(word2),
      originalContinues: original.conversationId === second.conversationId && reply(original).includes('STILL-HERE'),
    })
    save()
    if (options.has('--earlier')) {
      const earlier = await runtime.forkWorker({ id: parent } as any, second.id, 'A', bridge(runs, 'B') as any, AbortSignal.timeout(timeoutMs))
      const onEarlier = await turn('E 较早分支轮', 'If you were told a second code word, reply with it; otherwise reply exactly NONE.', earlier.workerId)
      report.earlier = {
        ...earlier,
        conversationId: onEarlier.conversationId,
        newConversationId: !!onEarlier.conversationId && onEarlier.conversationId !== second.conversationId,
        excludesLaterTurn: !reply(onEarlier).includes(word2),
      }
      save()
    }
  }
  if (options.has('--pause')) {
    const current = env.store.workers.get(second.id) as Worker
    runtime.setWorkerGoalStatus(parent, second.id, 'paused', current.goal!.revision)
    const paused = await turn('P 暂停目标轮', 'Reply with exactly: PAUSED-OK', second.id)
    report.pause = { injectedIntoCliInput: report.steps.at(-1).goalInjected, reply: reply(paused).slice(0, 200) }
    save()
  }
} catch (error) {
  failure = error
  report.error = String((error as Error)?.stack ?? error).slice(0, 2000)
} finally {
  await runtime.close()
  await env.ctx.fiber.dispose()
  report.finishedAt = new Date().toISOString()
  save()
}
console.log(JSON.stringify({ report: join(root, 'report.json'), turns: report.turns, goalCheck: report.goalCheck, fork: report.fork, earlier: report.earlier, pause: report.pause, error: report.error?.split('\n')[0] }, null, 2))
if (failure) process.exitCode = 1
