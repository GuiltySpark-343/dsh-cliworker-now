import { constants, closeSync, fstatSync, lstatSync, openSync, readSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { withNativeFilePrivacy } from './native-file-privacy.mjs'

const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const count = (value) => Number.isSafeInteger(value) && value >= 0
const id = (value) => typeof value === 'string' && value.length > 0 && value.length <= 480
const keys = ['inputOther', 'output', 'inputCacheRead', 'inputCacheCreation']
const source = 'kimi.durable.main-wire'
const maxBytes = 16 * 1024 * 1024
const pause = (ms) => new Promise((done) => setTimeout(done, ms))

/** Installed 2.1.1 normalizes a missing provider receipt to four zeroes.
 * A positive total with real zero output/cache is still a valid receipt.
 */
export function kimiDurableUsage(value) {
  if (!object(value) || !keys.every((key) => count(value[key]))) return
  const usage = Object.fromEntries(keys.map((key) => [key, value[key]]))
  const total = keys.reduce((sum, key) => sum + usage[key], 0)
  return count(total) && total > 0 ? usage : undefined
}
const sameUsage = (a, b) => keys.every((key) => a[key] === b[key])
const sumUsage = (values) => {
  if (!values.length) return
  const sum = Object.fromEntries(keys.map((key) => [key, 0]))
  for (const value of values) for (const key of keys) {
    sum[key] += value[key]
    if (!count(sum[key])) return
  }
  return sum
}

/** The current CLI's own deterministic workspace key. No directory discovery. */
export function kimiWorkspaceKey(project) {
  const normalized = project.replace(/\\/g, '/').replace(/\/+$/, '')
  let slug = (normalized.split('/').pop() ?? normalized).toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/^-+|-+$/g, '')
  if (!slug || slug === '.' || slug === '..') slug = 'workspace'
  return `wd_${slug}_${createHash('sha256').update(normalized).digest('hex').slice(0, 12)}`
}

/** A baseline must be idle and unambiguous. Branch/undo/migration histories
 * need a full native reducer; this supplement deliberately makes no guess.
 */
export function kimiJournalBaseline(records) {
  if (!Array.isArray(records) || records[0]?.type !== 'metadata' || records[0].protocol_version !== '1.5') return
  const open = new Set(), turns = new Set(), promptIds = new Set()
  for (const row of records.slice(1)) {
    if (!object(row) || ['agent.switched', 'context.undo', 'context.undone'].includes(row.type)) return
    if (row.agentId !== 'main') continue
    if (row.type === 'turn.prompt') {
      if (!count(row.turnId) || turns.has(row.turnId) || !id(row.promptId) || promptIds.has(row.promptId)) return
      turns.add(row.turnId); open.add(row.turnId); promptIds.add(row.promptId)
    } else if (row.type === 'turn.ended') {
      if (!count(row.turnId) || !open.delete(row.turnId)) return
    }
  }
  if (open.size) return
  return { turns, promptIds }
}

/** Parse only records appended after an inode/prefix checked pre-prompt cursor.
 * Turn identity comes from a unique new main turn/prompt id and real step ids,
 * not timestamps or a text search. Text is an extra consistency check only.
 */
export function inspectKimiDurableTurn(baseline, appended, expected) {
  if (!baseline || !Array.isArray(appended)) return
  const relevant = appended.filter((row) => object(row) && row.agentId === 'main')
  if (appended.some((row) => !object(row) || ['agent.switched', 'context.undo', 'context.undone', 'context.clear'].includes(row.type)) ||
    relevant.some((row) => row.type === 'turn.steer')) return
  const prompts = relevant.filter((row) => row.type === 'turn.prompt')
  if (prompts.length !== 1) return
  const prompt = prompts[0], turnId = prompt.turnId
  if (!count(turnId) || [...baseline.turns].some((previous) => previous >= turnId) ||
    !id(prompt.promptId) || baseline.promptIds.has(prompt.promptId) || prompt.origin?.kind !== 'user' ||
    !Array.isArray(prompt.input) || prompt.input.length !== 1 || prompt.input[0]?.type !== 'text' ||
    prompt.input[0].text !== expected.prompt) return
  // There must not be another concurrent/unknown main turn in the appended tail.
  if (relevant.some((row) => row.turnId !== undefined && row.turnId !== turnId)) return
  const terminals = relevant.filter((row) => row.type === 'turn.ended')
  if (terminals.length !== 1 || !['completed', 'cancelled', 'failed', 'blocked'].includes(terminals[0].reason)) return
  const promptIndex = relevant.indexOf(prompt), terminalIndex = relevant.indexOf(terminals[0])
  if (promptIndex >= terminalIndex) return
  const steps = new Map(), responses = [], stepBills = [], bills = [], requests = new Map()
  let unknownStep = false, unknownBill = false, auxiliary = false, delegation = expected.hasChildren === true
  const messageIds = new Map()
  for (let i = 0; i < relevant.length; i++) {
    const row = relevant[i]
    if (row.type === 'usage.record') {
      const usage = kimiDurableUsage(row.usage)
      if (row.model !== expected.model) return
      if (!usage) unknownBill = true
      if (row.usageScope !== 'turn' || i < promptIndex || i > terminalIndex) auxiliary = true
      if (usage) bills.push(usage)
    }
    if (row.type === 'llm.request') {
      if (row.modelAlias !== expected.model) return
      if (i <= promptIndex || i >= terminalIndex || row.kind !== 'loop' ||
        typeof row.turnStep !== 'string' || !row.turnStep.startsWith(`${turnId}.`)) auxiliary = true
      else requests.set(row.turnStep, (requests.get(row.turnStep) ?? 0) + 1)
    }
    if (row.type !== 'context.append_loop_event') continue
    const event = row.event
    if (!object(event) || event.turnId !== String(turnId) || i <= promptIndex || i >= terminalIndex) return
    if (event.type === 'tool.call' && ['Agent', 'AgentSwarm', 'Task', 'SendMessage'].includes(event.name)) delegation = true
    if (event.type === 'step.begin') {
      if (!id(event.uuid) || !count(event.step) || event.step < 1 || steps.has(event.uuid) ||
        event.step !== steps.size + 1 || [...steps.values()].some((step) => !step.closed)) return
      steps.set(event.uuid, { number: event.step, closed: false })
    } else if (event.type === 'step.end') {
      const step = steps.get(event.uuid)
      if (!step || step.closed || step.number !== event.step) return
      step.closed = true
      const usage = kimiDurableUsage(event.usage)
      if (!usage) { unknownStep = true; continue }
      stepBills.push(usage)
      if (id(event.messageId)) {
        messageIds.set(event.messageId, (messageIds.get(event.messageId) ?? 0) + 1)
        responses.push({ stepId: event.uuid, responseId: event.messageId, usage })
      }
    }
  }
  if ([...steps.values()].some((step) => !step.closed)) unknownStep = true
  const stepSum = sumUsage(stepBills), billSum = sumUsage(bills)
  const complete = terminals[0].reason === 'completed' && steps.size > 0 && !unknownStep && !unknownBill &&
    !auxiliary && !delegation && stepBills.length === bills.length && stepSum && billSum && sameUsage(stepSum, billSum)
    && requests.size === steps.size && [...steps.values()].every((step) => requests.get(`${turnId}.${step.number}`) === 1)
  return { turnId: String(turnId), responses: responses.filter((response) => messageIds.get(response.responseId) === 1),
    ...(billSum ? { usage: billSum, scope: complete ? 'run' : 'reported' } : {}) }
}

const same = (a, b) => a.dev === b.dev && a.ino === b.ino && a.size === b.size &&
  a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.mode === b.mode && a.uid === b.uid && a.nlink === b.nlink
function privateDirectory(path, privacy) {
  const stat = lstatSync(path)
  if (!stat.isDirectory() || stat.isSymbolicLink() || !privacy.allows(path, stat)) throw new Error('Private CLI directory unavailable')
  return stat
}
function snapshot(path, limit = maxBytes, privacy) {
  let fd
  const safe = stat => stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 &&
    Number.isSafeInteger(stat.size) && stat.size >= 0 && stat.size <= limit && privacy.allows(path, stat)
  try {
    const entry = lstatSync(path)
    if (!safe(entry)) return
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
    const before = fstatSync(fd)
    if (!safe(before) || !same(before, entry)) return
    const bytes = Buffer.alloc(before.size)
    let offset = 0
    while (offset < bytes.length) {
      const read = readSync(fd, bytes, offset, bytes.length - offset, offset)
      if (!read) return
      offset += read
    }
    const after = fstatSync(fd), current = lstatSync(path)
    if (!safe(after) || !safe(current) || !same(before, after) || !same(before, current)) return
    return { bytes, ino: before.ino, dev: before.dev }
  } finally { if (fd !== undefined) closeSync(fd) }
}
function journalRecords(bytes) {
  if (!bytes.length || bytes.at(-1) !== 10) return
  try {
    return new TextDecoder('utf8', { fatal: true }).decode(bytes).trimEnd().split('\n').map((line) => JSON.parse(line))
  } catch { return }
}

/** Best-effort, bounded, strictly read-only supplement to the owned ACP process.
 * No server/agent is started and no CLI file or permissions are changed.
 */
export class KimiDurableUsageObserver {
  constructor(config) { this.config = config }
  prepare(sessionId, signal) {
    this.saved = undefined
    const generation = this.generation = (this.generation ?? 0) + 1
    try {
      if (typeof sessionId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$/.test(sessionId) ||
        typeof this.config.project !== 'string' || !isAbsolute(this.config.project)) return
      const effectiveHome = this.config.env?.KIMI_CODE_HOME ?? process.env.KIMI_CODE_HOME ?? join(homedir(), '.kimi-code')
      if (typeof effectiveHome !== 'string' || !isAbsolute(effectiveHome)) return
      this.home = resolve(effectiveHome)
      const pieces = ['sessions', kimiWorkspaceKey(this.config.project), sessionId]
      let path = this.home
      this.directories = [path]
      for (const piece of pieces) { path = join(path, piece); this.directories.push(path) }
      this.sessionDirectory = path
      for (const piece of ['agents', 'main']) { path = join(path, piece); this.directories.push(path) }
      this.path = join(path, 'wire.jsonl')
      const value = withNativeFilePrivacy(this.privacyPaths(), privacy => {
        const directories = this.directories.map(path => ({ path, info: privateDirectory(path, privacy) }))
        const meta = this.readMetadata(sessionId, privacy)
        if (!meta) return
        const before = snapshot(this.path, maxBytes, privacy)
        const records = before && journalRecords(before.bytes)
        const baseline = records && kimiJournalBaseline(records)
        if (!baseline) return
        return { before, baseline, directories, count: records.length, sessionId, hasChildren: Object.keys(meta.agents ?? {}).some(key => key !== 'main') }
      }, { reader: 'kimi-prepare', signal })
      const save = saved => { if (generation === this.generation && !signal?.aborted) this.saved = saved }
      if (value?.then) return value.then(save)
      save(value)
    } catch { this.saved = undefined }
  }
  privacyPaths() { return [...this.directories, join(this.sessionDirectory, 'state.json'), this.path].map(path => ({ path })) }
  readMetadata(sessionId, privacy) {
    const read = snapshot(join(this.sessionDirectory, 'state.json'), 1024 * 1024, privacy)
    if (!read) return
    const meta = JSON.parse(read.bytes.toString('utf8'))
    if (meta.version !== 2 || meta.id !== sessionId || meta.cwd !== this.config.project ||
      !object(meta.agents) || !object(meta.agents.main) || meta.agents.main.type !== 'main' ||
      (meta.agents.main.parentAgentId !== undefined && meta.agents.main.parentAgentId !== null)) return
    return meta
  }
  async finish(result, sessionId, io) {
    const saved = this.saved
    this.saved = undefined
    this.generation = (this.generation ?? 0) + 1
    if (!saved || saved.sessionId !== sessionId || !['end_turn', 'cancelled', 'refusal'].includes(result?.stopReason) || io.signal?.aborted) return
    const receipt = await withNativeFilePrivacy(this.privacyPaths(), async privacy => {
      const deadline = Date.now() + 500
      do {
        try {
          if (io.signal?.aborted) return
          for (const old of saved.directories) {
            const now = privateDirectory(old.path, privacy)
            if (now.dev !== old.info.dev || now.ino !== old.info.ino) return
          }
          const after = snapshot(this.path, maxBytes, privacy)
          if (!after || after.ino !== saved.before.ino || after.dev !== saved.before.dev ||
            after.bytes.length < saved.before.bytes.length ||
            !after.bytes.subarray(0, saved.before.bytes.length).equals(saved.before.bytes)) return
          const records = journalRecords(after.bytes), meta = this.readMetadata(sessionId, privacy)
          if (!meta) return
          const receipt = records && inspectKimiDurableTurn(saved.baseline, records.slice(saved.count), {
            prompt: this.config.prompt, model: this.config.preference.model,
            hasChildren: saved.hasChildren || Object.keys(meta.agents).some(key => key !== 'main'),
          })
          if (receipt) return receipt
        } catch { return }
        if (!io.signal?.aborted && Date.now() < deadline) await pause(25)
        else return
      } while (Date.now() <= deadline)
    }, { reader: 'kimi-finish', signal: io.signal })
    if (!receipt || io.signal?.aborted) return
    const identity = { source, sessionId, model: this.config.preference.model, turnId: receipt.turnId }
    for (const response of receipt.responses) io.native({ type: 'cliworker.kimi_response_usage', ...identity, ...response })
    if (receipt.usage) io.native({ type: 'cliworker.kimi_usage', ...identity,
      scope: result.stopReason === 'end_turn' ? receipt.scope : 'reported', usage: receipt.usage })
  }
}
