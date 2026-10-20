import { execFile } from 'node:child_process'
import { lstatSync, realpathSync } from 'node:fs'
import { join, resolve, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'

const object = v => !!v && typeof v === 'object' && !Array.isArray(v)
const trustedSid = /^S-1-(?:5-18|5-32-544)$/
const userSid = /^S-\d-(?:\d+-)*\d+$/
const traces = []
let operation = 0
/** Numeric diagnostics only. No native paths, ACLs or file contents are retained. */
export const nativePrivacyDiagnostics = () => traces.map(value => ({ ...value }))
const sameIdentity = (a, b) => a.dev === b.dev && a.ino === b.ino
const sameStat = (a, b) => sameIdentity(a, b) && a.size === b.size && a.mtimeMs === b.mtimeMs &&
  a.ctimeMs === b.ctimeMs && a.mode === b.mode && a.uid === b.uid && a.nlink === b.nlink
const canonical = path => process.platform === 'win32' ? win32.normalize(path).toLowerCase() : resolve(path)

/** A normal NTFS DACL, with current-user ownership; group ownership is never enough.
 * mask=0022 admits other principals' read-only access to Qoder's native root,
 * matching the existing POSIX root rule. Transcript paths remain private. */
export function privateWindowsAcl(value, currentSid, mask = 0o077, allowAdministratorsOwner = false) {
  if (!object(value) || !userSid.test(currentSid ?? '') || value.nullDacl !== false ||
    !Number.isInteger(value.control) || !(value.control & 4) || (value.control & 64) ||
    !Array.isArray(value.aces) || !value.aces.length || value.aces.length > 256 ||
    typeof value.descriptor !== 'string' || !value.descriptor || value.descriptor.length > 32768) return false
  // Native Qoder files created from an elevated terminal can be owned by the
  // Administrators group. Group ownership alone is insufficient: require a
  // direct, applying full-control ACE for the current user on every exact path.
  if (value.owner !== currentSid && !(allowAdministratorsOwner && value.owner === 'S-1-5-32-544' &&
    value.aces.some(ace => object(ace) && ace.type === 0 && !(ace.flags & 8) && ace.sid === currentSid &&
      Number.isInteger(ace.mask) && (((ace.mask >>> 0) & 0x1f01ff) === 0x1f01ff || ((ace.mask >>> 0) & 0x10000000) !== 0)))) return false
  for (const ace of value.aces) {
    if (!object(ace) || ![0, 1].includes(ace.type) || !Number.isInteger(ace.flags) || ace.flags < 0 ||
      (ace.flags & ~31) || !Number.isInteger(ace.mask) || ace.mask < -2147483648 || ace.mask > 4294967295 ||
      typeof ace.sid !== 'string' || !/^S-\d-(?:\d+-)*\d+$/.test(ace.sid)) return false
    // Deny entries cannot widen access. Inherit-only entries do not apply here;
    // each actual child path is independently proved before it is read.
    if (ace.type === 1 || (ace.flags & 8) || ace.sid === currentSid || trustedSid.test(ace.sid)) continue
    const rights = ace.mask >>> 0
    // read/list/execute, read attributes/EA/control, synchronize; no mutation,
    // delete-child, ownership or DACL rights, nor unknown/generic write rights.
    const readOnly = (0x80000000 | 0x20000000 | 0x100000 | 0x20000 | 0x80 | 0x20 | 0x8 | 0x1) >>> 0
    if (mask !== 0o022 ? rights !== 0 : ((rights & ~readOnly) >>> 0) !== 0) return false
  }
  return true
}
function pathInfo(path) {
  const info = lstatSync(path)
  if (info.isSymbolicLink() || !(info.isFile() || info.isDirectory()) || canonical(realpathSync(path)) !== canonical(path))
    throw new Error('Native file identity unavailable')
  return info
}
function posixGuard(entries) {
  const masks = new Map(entries.map(entry => [entry.path, entry.mask ?? 0o077]))
  return { allows(path, info) { return masks.has(path) && !(info.mode & masks.get(path)) &&
    (!process.getuid || info.uid === process.getuid()) } }
}
async function aclBatch(entries, options, deadline) {
  const start = Date.now(), timeout = Math.min(2000, deadline - start)
  if (options.signal?.aborted || timeout <= 0) throw new Error('Native privacy deadline')
  const root = process.env.SystemRoot || 'C:\\Windows'
  if (!/^[A-Za-z]:\\[^\x00-\x1f]*$/.test(root)) throw new Error('Native system root unavailable')
  const executable = join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', fileURLToPath(new URL('./native-file-privacy.ps1', import.meta.url))]
  let ok = false
  try {
    const output = await new Promise((accept, reject) => {
      const child = execFile(executable, args, { windowsHide: true, timeout, killSignal: 'SIGKILL',
        signal: options.signal, maxBuffer: 1024 * 1024, encoding: 'utf8' }, (error, stdout) => error ? reject(error) : accept(stdout))
      child.stdin?.on('error', reject)
      child.stdin?.end(JSON.stringify({ version: 1, paths: entries.map(entry => entry.path) }))
    })
    const result = JSON.parse(output.replace(/^\uFEFF/, ''))
    if (result.version !== 1 || !Array.isArray(result.items) || result.items.length !== entries.length ||
      new Set(result.items.map(value => value.path)).size !== entries.length) throw new Error('Native privacy projection invalid')
    const byPath = new Map(result.items.map(value => [value.path, value]))
    if (!entries.every(entry => privateWindowsAcl(byPath.get(entry.path), result.currentSid, entry.mask ?? 0o077, options.allowAdministratorsOwner === true)))
      throw new Error('Native file is not private')
    ok = true
    return { currentSid: result.currentSid, descriptors: entries.map(entry => byPath.get(entry.path).descriptor) }
  } finally {
    traces.push({ reader: options.reader ?? 'native', operation: options.operation, phase: options.phase, paths: entries.length, durationMs: Date.now() - start, ok })
    if (traces.length > 64) traces.shift()
  }
}
/** POSIX remains synchronous. Windows uses two bounded, asynchronous ACL batches
 * around one complete reader operation, never one process per path or poll. */
export function withNativeFilePrivacy(entries, read, options = {}) {
  if (!Array.isArray(entries) || !entries.length || entries.length > 16 ||
    entries.some(entry => !object(entry) || typeof entry.path !== 'string' || !entry.path ||
      ![undefined, 0o077, 0o022].includes(entry.mask)) || new Set(entries.map(entry => entry.path)).size !== entries.length) return
  if (process.platform !== 'win32') {
    if (options.signal?.aborted) return
    const value = read(posixGuard(entries))
    return value?.then ? value.then(result => options.signal?.aborted ? undefined : result) :
      options.signal?.aborted ? undefined : value
  }
  return (async () => {
    try {
      options = { ...options, operation: ++operation }
      const deadline = Date.now() + Math.min(5000, Math.max(1, options.budgetMs ?? 4000))
      const initial = new Map(entries.map(entry => [entry.path, pathInfo(entry.path)]))
      const pre = await aclBatch(entries, { ...options, phase: 'before' }, deadline)
      // The CLI may flush an append while Get-Acl is running. Bind the same
      // security identity, then let the reader take its own bounded snapshot
      // after proof. A replacement, link or ownership/mode change still fails.
      for (const entry of entries) {
        const original = initial.get(entry.path), current = pathInfo(entry.path)
        if (!sameIdentity(original, current) || original.mode !== current.mode || original.uid !== current.uid ||
          original.nlink !== current.nlink) return
        initial.set(entry.path, current)
      }
      const observed = new Map(initial)
      const guard = { allows(path, info) {
        const original = initial.get(path)
        if (!original || !sameIdentity(original, info)) return false
        observed.set(path, info)
        return true
      } }
      if (options.signal?.aborted) return
      const result = await read(guard)
      if (result === undefined || options.signal?.aborted) return
      const beforePost = new Map(entries.map(entry => [entry.path, pathInfo(entry.path)]))
      if (entries.some(entry => !sameStat(observed.get(entry.path), beforePost.get(entry.path)))) return
      const post = await aclBatch(entries, { ...options, phase: 'after' }, deadline)
      if (post.currentSid !== pre.currentSid || post.descriptors.some((value, i) => value !== pre.descriptors[i]) ||
        entries.some(entry => !sameStat(beforePost.get(entry.path), pathInfo(entry.path))) || options.signal?.aborted) return
      return result
    } catch { return }
  })()
}
