import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { withNativeFilePrivacy } from './native-file-privacy.mjs'

const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(value)
const object = value => value && typeof value === 'object' && !Array.isArray(value)
const ratio = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
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
  let terminal
  for (const row of records.slice(records.indexOf(user) + 1)) {
    // Another real user turn never supplies the requested turn's context.
    if (row.type === 'user' && !(Array.isArray(row.message?.content) && row.message.content.length > 0 &&
      row.message.content.every(item => item?.type === 'tool_result'))) break
    if (!id(row.uuid) || !chain.has(row.parentUuid)) continue
    chain.add(row.uuid)
    if (row.type !== 'assistant') continue
    if (row.isSidechain !== false || row.cwd !== config.project || row.message?.model !== config.model ||
      row.isApiErrorMessage === true || row.aborted === true) return
    if (row.message?.stop_reason !== 'end_turn') continue
    if (terminal !== undefined || !ratio(row.message?.usage?.context_usage_ratio)) return
    terminal = row.message.usage.context_usage_ratio
  }
  if (terminal === undefined) return
  return { type: 'cliworker.qoder_context', source: 'qoder.native-transcript', basis: 'native-ratio',
    sessionId: config.sessionId, model: config.model, userMessageId: config.userMessageId, contextRatio: terminal }
}

/** Bounded, stable, no-follow read of one native transcript; never reads credentials or prompt text into a cache. */
function readPrivateQoderContext(config, options = {}) {
  const paths = qoderContextPaths(config)
  if (!paths.length) return
  return withNativeFilePrivacy(paths.map((path, index) => ({ path, mask: index === 0 ? 0o022 : 0o077 })), privacy => {
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
  }, { ...options, reader: 'qoder' })
}

// Sync historical callers never block the Host waiting for an external process.
export function readQoderDurableContext(config) {
  if (process.platform === 'win32') return
  return readPrivateQoderContext(config)
}
export async function readQoderDurableContextAsync(config, options = {}) {
  return readPrivateQoderContext(config, options)
}
