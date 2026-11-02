import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync, readdirSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { withNativeFilePrivacy } from './native-file-privacy.mjs'

const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(value)
const object = value => value && typeof value === 'object' && !Array.isArray(value)
const ratio = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
const amount = value => typeof value === 'number' && Number.isFinite(value) && value >= 0
const count = value => Number.isSafeInteger(value) && value > 0
const time = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT/.test(value) && Number.isFinite(Date.parse(value)) ? Date.parse(value) : undefined
const maxBytes = 16 * 1024 * 1024
const same = (a, b) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs &&
  a.ctimeMs === b.ctimeMs && a.mode === b.mode && a.uid === b.uid && a.nlink === b.nlink

/** Qoder 1.1.73 QI(): exact project bucket, including its long-path hash. */
export function qoderProjectKey(project) {
  const key = project.replace(/[^a-zA-Z0-9]/g, '-')
  if (key.length <= 200) return key
  let hash = 5381
  for (let index = 0; index < project.length; index++) hash = 33 * hash ^ project.charCodeAt(index)
  return `${key.slice(0, 200)}-${Math.abs(hash).toString(36)}`
}

const qoderCli = config => config.cli === 'qodercn' ? 'qodercn' : 'qoder'

export function qoderContextPaths(config) {
  if (!isAbsolute(config.home ?? '') || !isAbsolute(config.project ?? '') || !id(config.sessionId)) return []
  const root = resolve(config.home), projects = join(root, 'projects'), bucket = join(projects, qoderProjectKey(config.project))
  return [root, projects, bucket, join(bucket, `${config.sessionId}.jsonl`)]
}

/** Accept only the exact returned user-message identity and its terminal parent chain. */
export function inspectQoderDurableContext(records, config) {
  if (!Array.isArray(records) || !id(config.sessionId) || !id(config.userMessageId) ||
    typeof config.model !== 'string' || !config.model || config.model.length > 512) return
  if (records.some(row => !object(row) || (row.sessionId !== undefined && row.sessionId !== config.sessionId))) return
  const targets = records.filter(row => row.type === 'user' && row.uuid === config.userMessageId)
  if (targets.length !== 1) return
  const user = targets[0]
  if (user.sessionId !== config.sessionId || user.cwd !== config.project || user.isSidechain !== false ||
    (user.businessModelKey !== undefined && user.businessModelKey !== config.model)) return
  const chain = new Set([user.uuid])
  let terminal, contextRatio
  const requests = new Map()
  let unidentified = 0
  for (const row of records.slice(records.indexOf(user) + 1)) {
    // Another real user turn never supplies the requested turn's context.
    if (row.type === 'user' && !(Array.isArray(row.message?.content) && row.message.content.length > 0 &&
      row.message.content.every(item => item?.type === 'tool_result'))) break
    if (!id(row.uuid) || !chain.has(row.parentUuid)) continue
    chain.add(row.uuid)
    if (row.type !== 'assistant') continue
    if (row.isSidechain !== false || row.cwd !== config.project || row.message?.model !== config.model ||
      row.isApiErrorMessage === true || row.aborted === true) return
    // The same native request can be serialized as multiple content blocks.
    // Replacement by message.id preserves its final receipt without adding it twice.
    // A single usage-bearing row can use its exact transcript UUID; multiple
    // unidentified requests cannot establish a complete invocation total.
    const usage = row.message?.usage
    const key = id(row.message?.id) ? row.message.id : (++unidentified, row.uuid)
    // A distinct request without accounting makes the turn total unknown.
    // Later content-only blocks of an already counted request do not erase it.
    if (object(usage) && Object.keys(usage).length || !requests.has(key))
      requests.set(key, amount(usage?.credits) ? usage.credits : undefined)
    if (row.message?.stop_reason !== 'end_turn') continue
    if (terminal !== undefined) return
    terminal = row
    if (usage?.context_usage_ratio !== undefined) {
      if (!ratio(usage.context_usage_ratio)) return
      contextRatio = usage.context_usage_ratio
    }
  }
  if (terminal === undefined) return
  const values = [...requests.values()]
  const totalCredits = values.reduce((sum, value) => sum + value, 0)
  const providerCredits = values.length && values.every(amount) &&
    (unidentified === 0 || (unidentified === 1 && values.length === 1)) && amount(totalCredits) ? totalCredits : undefined
  if (contextRatio === undefined && providerCredits === undefined) return
  const turnStartedAt = time(user.timestamp), turnEndedAt = time(terminal.timestamp)
  const range = turnStartedAt !== undefined && turnEndedAt !== undefined && turnEndedAt >= turnStartedAt
    ? { turnStartedAt, turnEndedAt } : {}
  const capacity = records.filter(row => row.type === 'runtime-config' && row.sessionId === config.sessionId &&
    row.model === config.model && count(row.contextWindow) &&
    range.turnStartedAt !== undefined && time(row.timestamp) >= range.turnStartedAt && time(row.timestamp) <= range.turnEndedAt)
    .at(-1)?.contextWindow
  return { type: `cliworker.${qoderCli(config)}_context`, source: `${qoderCli(config)}.native-transcript`, basis: 'native-ratio',
    sessionId: config.sessionId, model: config.model, userMessageId: config.userMessageId,
    ...(contextRatio === undefined ? {} : { contextRatio }),
    ...(providerCredits === undefined ? {} : { providerCredits }), ...range,
    ...(capacity === undefined || contextRatio === undefined ? {} : {
      contextCapacity: capacity, contextUsed: Math.round(contextRatio * capacity), contextCapacitySource: `${qoderCli(config)}.native-runtime-config` }) }
}

/** Bounded, stable, no-follow read of one native transcript; never reads credentials or prompt text into a cache. */
function readPrivateQoderContext(config, options = {}) {
  const paths = qoderContextPaths(config)
  if (!paths.length) return
  return withNativeFilePrivacy(paths.map((path, index) => ({ path, mask: index === 0 || process.platform === 'win32' ? 0o022 : 0o077 })), privacy => {
  let fd
  try {
    const expected = process.platform === 'darwin' ? paths[0].replace(/^\/(tmp|var)(?=\/|$)/, '/private/$1') : paths[0]
    const canonical = realpathSync(paths[0])
    if (process.platform === 'win32' ? canonical.toLowerCase() !== expected.toLowerCase() : canonical !== expected) return
    const directories = paths.slice(0, -1).map((path, index) => {
      const info = lstatSync(path)
      // The native Qoder root may be 0755. Transcript directories must be private.
      if (!info.isDirectory() || info.isSymbolicLink() || !privacy.allows(path, info)) throw new Error('Unsafe Qoder directory')
      return { path, info }
    })
    const file = paths.at(-1), entry = lstatSync(file)
    const safe = info => info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && privacy.allows(file, info) && Number.isSafeInteger(info.size) && info.size >= 0 && info.size <= maxBytes
    if (!safe(entry)) return
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
    const before = fstatSync(fd)
    if (!safe(before) || !same(entry, before)) return
    const bytes = Buffer.alloc(before.size)
    let offset = 0
    while (offset < bytes.length) {
      const n = readSync(fd, bytes, offset, bytes.length - offset, offset)
      if (!n) return
      offset += n
    }
    if (!safe(fstatSync(fd)) || !same(before, fstatSync(fd)) || !same(before, lstatSync(file))) return
    if (directories.some(({ path, info }) => { const now = lstatSync(path); return now.isSymbolicLink() || !same(info, now) })) return
    if (bytes.length && bytes.at(-1) !== 10) return
    const lines = new TextDecoder('utf8', { fatal: true }).decode(bytes).trimEnd().split('\n').filter(Boolean)
    if (lines.length > 20000 || lines.some(line => Buffer.byteLength(line) > 2 * 1024 * 1024)) return
    return inspectQoderDurableContext(lines.map(line => JSON.parse(line)), config)
  } catch { return } finally { if (fd !== undefined) closeSync(fd) }
  }, { ...options, reader: 'qoder', allowAdministratorsOwner: true })
}

// Sync historical callers never block the Host waiting for an external process.
export function readQoderDurableContext(config) {
  if (process.platform === 'win32') return
  const observed = readPrivateQoderContext(config)
  return supplementWindow(config, observed) ?? observed
}
export async function readQoderDurableContextAsync(config, options = {}) {
  const observed = await readPrivateQoderContext(config, options)
  const enriched = await supplementWindow(config, observed, options)
  return options.signal?.aborted ? undefined : enriched ?? observed
}

/** Only known fixed log roots and a bounded set of regular native run logs. */
export function qoderMeteringPaths(config) {
  const base = qoderContextPaths(config)
  if (!base.length) return []
  const logs = join(base[0], 'logs'), runs = join(logs, 'runs')
  try {
    if ([logs, runs].some(path => { const s = lstatSync(path); return !s.isDirectory() || s.isSymbolicLink() })) return base
    const names = readdirSync(runs)
    if (names.length > 512) return base
    const candidates = names.filter(name => /^[A-Za-z0-9._-]{1,200}$/.test(name)).map(name => {
      const directory = join(runs, name), file = join(directory, 'qodercli.log')
      try {
        const d = lstatSync(directory), f = lstatSync(file)
        return d.isDirectory() && !d.isSymbolicLink() && f.isFile() && !f.isSymbolicLink()
          ? { directory, file, modified: f.mtimeMs } : undefined
      } catch { return }
    }).filter(Boolean).sort((a, b) => b.modified - a.modified).slice(0, 4)
    return candidates.length ? [...base, logs, runs, ...candidates.flatMap(v => [v.directory, v.file])] : base
  } catch { return base }
}

/** Never accepts an unbound, subsequent-turn or subagent window. */
export function inspectQoderLogWindow(text, binding, observed) {
  if (!id(binding.sessionId) || !amount(observed.turnStartedAt) || !amount(observed.turnEndedAt) ||
    observed.turnEndedAt < observed.turnStartedAt) return
  const session = binding.sessionId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const auto = new RegExp(`\\[auto-compact\\]\\[session:${session}\\]\\[main\\][^\\r\\n]*?\\bwindow=(\\d+)\\b`)
  const runtime = new RegExp(`session\\.runtime_config[^\\r\\n]*?\\bsession=${session}(?=\\s|[,;]|$)[^\\r\\n]*?\\bcontext_window=(\\d+)\\b`)
  let latest
  for (const line of text.split('\n')) {
    const stamp = line.match(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)/)?.[0]
    const at = time(stamp)
    if (at === undefined || at < observed.turnStartedAt || at > observed.turnEndedAt) continue
    const match = line.match(auto) ?? line.match(runtime)
    const value = match && Number(match[1]), model = line.match(/\bmodel=([^\s,;]+)/)?.[1]
    if (!count(value) || (model && model !== binding.model)) continue
    if (!latest || at >= latest.at) latest = { at, value }
  }
  return latest?.value
}

function supplementWindow(config, observed, options = {}) {
  if (!observed || observed.contextRatio === undefined || observed.contextCapacity !== undefined ||
    observed.turnStartedAt === undefined || observed.turnEndedAt === undefined || options.signal?.aborted) return
  const paths = qoderMeteringPaths(config)
  if (paths.length <= 4) return
  // Transcript proof is independent: optional missing/unsafe logs cannot erase it.
  const entries = [paths[0], ...paths.slice(4)].map(path => ({ path, mask: (/qodercli(?:cn)?\.log$/).test(path) && process.platform !== 'win32' ? 0o077 : 0o022 }))
  return withNativeFilePrivacy(entries, privacy => {
    let capacity
    for (let index = 6; index < paths.length; index += 2) {
      let fd
      try {
        const directories = [paths[0], paths[4], paths[5], paths[index]].map(path => {
          const s = lstatSync(path)
          if (!s.isDirectory() || s.isSymbolicLink() || !privacy.allows(path, s)) throw new Error('Unsafe log directory')
          return { path, info: s }
        })
        const file = paths[index + 1], before = lstatSync(file)
        if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || !privacy.allows(file, before) || before.size > 32 * 1024 * 1024) continue
        fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
        if (!same(before, fstatSync(fd))) continue
        const size = Math.min(before.size, 256 * 1024), bytes = Buffer.alloc(size)
        let offset = 0
        while (offset < size) { const n = readSync(fd, bytes, offset, size - offset, before.size - size + offset); if (!n) break; offset += n }
        if (offset !== size || !same(before, fstatSync(fd)) || !same(before, lstatSync(file)) ||
          directories.some(v => !same(v.info, lstatSync(v.path)))) continue
        const text = bytes.toString('utf8'), complete = before.size > size ? text.slice(text.indexOf('\n') + 1) : text
        const window = inspectQoderLogWindow(complete.slice(0, complete.lastIndexOf('\n') + 1), config, observed)
        if (window !== undefined) { capacity = window; break }
      } catch { /* Optional logs never invalidate the proven transcript. */ } finally { if (fd !== undefined) closeSync(fd) }
    }
    return capacity === undefined ? undefined : { ...observed, contextCapacity: capacity,
      contextUsed: Math.round(observed.contextRatio * capacity), contextCapacitySource: `${qoderCli(config)}.native-session-log` }
  }, { ...options, reader: 'qoder-log', allowAdministratorsOwner: true, budgetMs: Math.min(options.budgetMs ?? 2000, 2000) })
}
