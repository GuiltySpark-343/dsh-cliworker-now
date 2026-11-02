import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { withNativeFilePrivacy } from './native-file-privacy.mjs'

const count = value => Number.isSafeInteger(value) && value >= 0
const id = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$/.test(value)
const object = value => value && typeof value === 'object' && !Array.isArray(value)
const maxBytes = 16 * 1024 * 1024

const safeFile = (info, limit, path, privacy) => info.isFile() && !info.isSymbolicLink() && info.nlink === 1 &&
  Number.isSafeInteger(info.size) && info.size >= 0 && info.size <= limit && privacy.allows(path, info)
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino && a.size === b.size &&
  a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.mode === b.mode && a.uid === b.uid && a.nlink === b.nlink
function directory(path, privacy) {
  const info = lstatSync(path)
  if (!info.isDirectory() || info.isSymbolicLink() || !privacy.allows(path, info)) throw new Error('Private Grok directory unavailable')
  return { path, dev: info.dev, ino: info.ino }
}
function stableDirectories(ancestors, privacy) {
  return ancestors.every(old => {
    const current = directory(old.path, privacy)
    return current.dev === old.dev && current.ino === old.ino && realpathSync(old.path) === old.path
  })
}
function snapshot(path, limit = maxBytes, privacy) {
  let fd
  try {
    const entry = lstatSync(path)
    if (!safeFile(entry, limit, path, privacy)) return
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
    const before = fstatSync(fd)
    // Recheck bounds and the complete security identity AFTER opening. A writer
    // may grow/chmod/link/replace the entry between lstat and open.
    if (!safeFile(before, limit, path, privacy) || !sameFile(entry, before)) return
    const bytes = Buffer.alloc(before.size)
    let offset = 0
    while (offset < bytes.length) {
      const read = readSync(fd, bytes, offset, bytes.length - offset, offset)
      if (!read) return
      offset += read
    }
    const after = fstatSync(fd), current = lstatSync(path)
    if (!safeFile(after, limit, path, privacy) || !safeFile(current, limit, path, privacy) || !sameFile(before, after) || !sameFile(before, current)) return
    return { bytes, ino: before.ino, dev: before.dev }
  } finally { if (fd !== undefined) closeSync(fd) }
}
const json = (path, limit, privacy) => {
  const value = snapshot(path, limit, privacy)
  return value && JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(value.bytes))
}
function grokPaths(config) {
  const home = config.home ?? config.env?.GROK_HOME ?? process.env.GROK_HOME ?? join(homedir(), '.grok')
  if (!isAbsolute(home ?? '') || !isAbsolute(config.project ?? '') || !id(config.sessionId) ||
    typeof config.modelId !== 'string' || !config.modelId || config.modelId.length > 500) return
  // Official session persistence uses the URL-encoded cwd, never directory discovery.
  const absoluteHome = resolve(home)
  // macOS supplies /var and /tmp as standard aliases; admit those platform
  // roots but reject symlinks anywhere inside the selected CLI home ancestry.
  const expectedHome = process.platform === 'darwin'
    ? absoluteHome.replace(/^\/(tmp|var)(?=\/|$)/, '/private/$1') : absoluteHome
  const canonicalHome = realpathSync(home)
  if (process.platform === 'win32' ? canonicalHome.toLowerCase() !== expectedHome.toLowerCase() : canonicalHome !== expectedHome) return
  const encoded = encodeURIComponent(config.project).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
  const directories = [canonicalHome, join(canonicalHome, 'sessions'), join(canonicalHome, 'sessions', encoded), join(canonicalHome, 'sessions', encoded, config.sessionId)]
  const root = directories.at(-1)
  return { directories, root, path: join(root, 'updates.jsonl') }
}
function location(config, privacy) {
  const paths = grokPaths(config)
  if (!paths) return
  const { directories, root } = paths
  const ancestors = directories.map(path => directory(path, privacy))
  const summary = json(join(root, 'summary.json'), 1024 * 1024, privacy)
  if (summary?.info?.id !== config.sessionId || summary.info.cwd !== config.project ||
    summary.current_model_id !== config.modelId) return
  if (!stableDirectories(ancestors, privacy)) return
  return { root, path: join(root, 'updates.jsonl'), ancestors }
}

/** A completed, exact prompt's published context counter; never usage.json or text tokenization. */
export function inspectGrokDurableContext(records, config) {
  if (!Array.isArray(records) || !id(config.sessionId) || !id(config.promptId)) return
  let ended = false, used, unknown = false
  for (const record of records) {
    const params = record?.params, update = params?.update
    if (!object(record) || !object(params) || params.sessionId !== config.sessionId || params._meta?.isReplay === true) return
    if (!['session/update', '_x.ai/session/update'].includes(record.method)) continue
    const promptId = params._meta?.promptId ?? update?.prompt_id
    if (promptId !== undefined && promptId !== config.promptId) {
      // A newer prompt cannot be mistaken for the requested completed run.
      if (ended) return
      continue
    }
    if (update?.sessionUpdate === 'agent_message_chunk' && promptId === config.promptId &&
      Object.hasOwn(params._meta ?? {}, 'totalTokens')) {
      if (ended) return
      const value = params._meta.totalTokens
      if (!count(value)) { used = undefined; unknown = true }
      else { used = value; unknown = false }
    }
    if (update?.sessionUpdate === 'turn_completed' && update.prompt_id === config.promptId) {
      if (ended || update.stop_reason !== 'end_turn') return
      ended = true
    }
  }
  if (!ended || used === undefined || unknown) return
  return { type: 'cliworker.grok_context', source: 'grok.durable.updates',
    sessionId: config.sessionId, modelId: config.modelId, promptId: config.promptId,
    contextUsed: used, basis: 'native-estimate' }
}

/** Read only this session. The caller must supply its run's native prompt id. */
function privateGrokRead(config, baseline, options = {}) {
  let paths
  try { paths = grokPaths(config) } catch { return }
  if (!paths) return
  return withNativeFilePrivacy([...paths.directories, ...['summary.json', 'updates.jsonl', 'signals.json'].map(name => join(paths.root, name))].map(path => ({ path })), privacy => {
  try {
    if (!id(config.promptId)) return
    const where = location(config, privacy)
    if (!where) return
    const read = snapshot(where.path, maxBytes, privacy)
    if (!read || (baseline && (read.ino !== baseline.ino || read.dev !== baseline.dev ||
      read.bytes.length <= baseline.bytes.length || !read.bytes.subarray(0, baseline.bytes.length).equals(baseline.bytes)))) return
    if (read.bytes.length && read.bytes.at(-1) !== 10) return
    const bytes = baseline ? read.bytes.subarray(baseline.bytes.length) : read.bytes
    const rows = new TextDecoder('utf8', { fatal: true }).decode(bytes).trimEnd().split('\n').filter(Boolean).map(row => JSON.parse(row))
    const observation = inspectGrokDurableContext(rows, config)
    if (!observation) return
    const signals = json(join(where.root, 'signals.json'), 1024 * 1024, privacy)
    // Signals alone can lag a compact turn. Only use its capacity when its
    // native count agrees with the exact completed prompt's own update.
    if (signals?.contextTokensUsed === observation.contextUsed && count(signals.contextWindowTokens) && signals.contextWindowTokens > 0)
      observation.contextCapacity = signals.contextWindowTokens
    if (!stableDirectories(where.ancestors, privacy)) return
    return observation
  } catch { return }
  }, { ...options, reader: 'grok' })
}
export function readGrokDurableContext(config, baseline) {
  if (process.platform === 'win32') return
  return privateGrokRead(config, baseline)
}
export async function readGrokDurableContextAsync(config, baseline, options = {}) {
  return privateGrokRead(config, baseline, options)
}

export class GrokDurableContextObserver {
  constructor(config) { this.config = config }
  prepare(sessionId, signal) {
    this.saved = undefined
    const generation = this.generation = (this.generation ?? 0) + 1
    try {
      const config = { ...this.config, modelId: this.config.preference.model, sessionId }
      const paths = grokPaths(config)
      if (!paths) return
      const value = withNativeFilePrivacy([...paths.directories, join(paths.root, 'summary.json'), paths.path].map(path => ({ path })), privacy => {
        const where = location(config, privacy)
        if (!where) return
        const baseline = snapshot(where.path, maxBytes, privacy)
        if (baseline && stableDirectories(where.ancestors, privacy) && (!baseline.bytes.length || baseline.bytes.at(-1) === 10)) return { config, baseline }
      }, { reader: 'grok-prepare', signal })
      if (value?.then) return value.then(saved => { if (generation === this.generation && !signal?.aborted) this.saved = saved })
      this.saved = value
    } catch { /* Missing durable data is unknown; do not alter native storage. */ }
  }
  async finish(result, sessionId, io) {
    const saved = this.saved
    this.saved = undefined
    this.generation = (this.generation ?? 0) + 1
    if (!saved || result?.stopReason !== 'end_turn' || result?._meta?.sessionId !== sessionId ||
      saved.config.sessionId !== sessionId || result._meta.modelId !== saved.config.modelId || !id(result._meta.promptId)) return
    const config = { ...saved.config, promptId: result._meta.promptId }, deadline = Date.now() + (process.platform === 'win32' ? 4000 : 300)
    do {
      if (io.signal?.aborted) return
      const value = await readGrokDurableContextAsync(config, saved.baseline, { signal: io.signal, budgetMs: Math.max(1, deadline - Date.now()) })
      if (value) { io.native(value); return }
      if (process.platform === 'win32' || io.signal?.aborted || Date.now() >= deadline) return
      await new Promise(resolve => setTimeout(resolve, 25))
    } while (Date.now() <= deadline)
  }
}
