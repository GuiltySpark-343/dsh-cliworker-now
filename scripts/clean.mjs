// Retention-aware cleanup of Git-ignored local data. Previews by default; deletes only with --apply.
// Scope: .test-data, .cache and artifacts. Never follows links and never touches lib/, node_modules/,
// doc/local/ or Git-tracked files.
import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const SCOPES = ['.test-data', '.cache', 'artifacts']
const REGENERABLE_DIRECTORIES = new Set(['node_modules', 'npm-cache', 'pnpm-store', '.pnpm-store', '_cacache'])
// build-host-extension.mjs reads .cache/dsh-host-build-deps for the modern Host target.
const CACHE_KEEP = new Map([
  ['dsh-host-build-deps', 'Host extension build dependencies (scripts/build-host-extension.mjs)'],
  ['preview-package', 'isolated preview package (pnpm build:preview)'],
  ['typert', 'generated Typert contracts'],
  ['build-configs', 'generated TypeScript build configs'],
])
const TEST_DATA_KEEP = new Map([['windows-remote', 'Windows remote private config and run evidence']])
const RELEASE = /^dsh-cliworker-now-(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+?)?(\.tgz|\.tgz\.sha256|\.sha256|-verification\.json)$/
export const KEEP_RELEASES = 3
const LOCK_GRACE_MS = 24 * 60 * 60 * 1000
const DOC_ROOTS = ['doc', 'openspec']

export function parseDuration(value) {
  const match = /^(\d+(?:\.\d+)?)([hdw]?)$/.exec(String(value ?? '').trim())
  if (!match) throw new Error(`Invalid --older-than value: ${value} (use e.g. 14d, 36h, 2w)`)
  return Number(match[1]) * { h: 3_600_000, d: 86_400_000, w: 604_800_000 }[match[2] || 'd']
}

export function parseArgs(argv) {
  const options = { apply: false, verbose: false, root: undefined, scopes: SCOPES, keepLast: undefined, olderThanMs: undefined, olderThan: undefined, help: false }
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    const value = () => { if (index + 1 >= argv.length) throw new Error(`${arg} needs a value`); return argv[++index] }
    if (arg === '--apply') options.apply = true
    else if (arg === '--verbose') options.verbose = true
    else if (arg === '--help' || arg === '-h') options.help = true
    else if (arg === '--root') options.root = resolve(value())
    else if (arg === '--scope') {
      // Comma-separated; the leading dot is optional (test-data, cache, artifacts).
      options.scopes = value().split(',').map((name) => SCOPES.find((scope) => scope === name.trim() || scope === `.${name.trim()}`) ?? name)
      for (const scope of options.scopes) if (!SCOPES.includes(scope)) throw new Error(`Unknown --scope: ${scope} (use ${SCOPES.join(', ')})`)
    }
    else if (arg === '--keep-last') {
      const text = value()
      if (!/^\d+$/.test(text)) throw new Error(`Invalid --keep-last value: ${text}`)
      options.keepLast = Number(text)
    } else if (arg === '--older-than') { options.olderThan = value(); options.olderThanMs = parseDuration(options.olderThan) }
    else if (arg === '--') continue
    else throw new Error(`Unknown option: ${arg}; see --help`)
  }
  return options
}

/** `0.2.1-rc.2` → `021rc2`, the suffix used by isolated .cache build directories. */
export function targetTag(version) { return String(version).replace(/[.-]/g, '') }

export function isPidAlive(pid) {
  try { process.kill(pid, 0); return true } catch (error) { return error.code === 'EPERM' }
}

const isLockFile = (name) => name === '.lock' || (/\.(?:lock|pid)$/.test(name) && !/^(?:yarn|Cargo|Gemfile|composer|poetry|flake|bun)\.lock$/.test(name))

function lockState(path, info, now, alive) {
  let text = ''
  try { text = info.size <= 4096 ? readFileSync(path, 'utf8') : '' } catch { /* unreadable locks count as active below */ }
  let pid
  try { const parsed = JSON.parse(text); pid = typeof parsed === 'number' ? parsed : parsed?.pid } catch { pid = /^\s*(\d+)\s*$/.exec(text)?.[1] }
  pid = Number(pid)
  if (Number.isSafeInteger(pid) && pid > 0) return alive(pid) ? `active lock (pid ${pid})` : undefined
  return now - info.mtimeMs < LOCK_GRACE_MS ? 'recent lock without a pid' : undefined
}

/** Markdown paths such as `.test-data/x/y.json`; a trailing `*` or `{` marks a name prefix. */
export function collectReferences(root) {
  const references = new Map(SCOPES.map((scope) => [scope, []]))
  const files = []
  const visit = (directory) => {
    let entries
    try { entries = readdirSync(directory, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) visit(path)
      else if (entry.isFile() && entry.name.endsWith('.md')) files.push(path)
    }
  }
  for (const directory of DOC_ROOTS) visit(join(root, directory))
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    const source = file.slice(root.length + 1).split(sep).join('/')
    for (const scope of SCOPES) {
      const pattern = new RegExp(`(?:^|[^\\w./-])${scope.replace('.', '\\.')}/([^\\s\`'"()<>\\[\\]{},;:*|，。、；：（）]+)([*{]?)`, 'g')
      for (const match of text.matchAll(pattern)) {
        const path = match[1].replace(/[./]+$/, '')
        if (path) references.get(scope).push({ path, prefix: Boolean(match[2]) && !match[1].endsWith('/'), source })
      }
    }
  }
  return references
}

export function gitTrackedFiles(root, git = process.env.GIT || 'git') {
  const output = execFileSync(git, ['-C', root, 'ls-files', '-z', '--', ...SCOPES], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  return output.split('\0').filter(Boolean)
}

/** Disk usage without following links; hard-linked files count once per run. */
function measure(path, seen, visitor) {
  const info = lstatSync(path)
  let bytes = 0
  if (!info.isSymbolicLink()) {
    const key = `${info.dev}:${info.ino}`
    if (info.nlink <= 1 || !seen.has(key)) { if (info.nlink > 1) seen.add(key); bytes = info.blocks != null ? info.blocks * 512 : info.size }
  }
  const result = { bytes, newest: info.mtimeMs }
  if (!info.isDirectory() || info.isSymbolicLink()) return result
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name)
    const handled = visitor?.child?.(child, entry)
    const inner = handled ?? measure(child, seen, visitor)
    result.bytes += inner.bytes
    result.newest = Math.max(result.newest, inner.newest)
  }
  return result
}

export function planClean(options) {
  const root = resolve(options.root)
  const now = options.now ?? Date.now()
  const alive = options.isPidAlive ?? isPidAlive
  const references = options.references ?? collectReferences(root)
  const tracked = options.trackedFiles
  const warnings = []
  const items = []
  const seen = new Set()
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const target = pkg.devDependencies?.['@deepseek-ai/dsh']
  if (!target) throw new Error('package.json does not pin @deepseek-ai/dsh')
  const tag = targetTag(target)
  const forbidden = ['lib', 'node_modules', 'doc/local'].map((path) => join(root, path))
  const touchesForbidden = (path) => forbidden.some((item) => item === path || item.startsWith(path + sep) || path.startsWith(item + sep))
  const relative = (path) => path.slice(root.length + 1).split(sep).join('/')
  const isTracked = (rel) => tracked?.some((file) => file === rel || file.startsWith(rel + '/'))
  const referenceFor = (scope, rel, { topLevel }) => {
    const inner = rel.slice(scope.length + 1)
    return references.get(scope)?.find((ref) => {
      if (topLevel) {
        const first = ref.path.split('/')[0]
        return ref.prefix && !ref.path.includes('/') ? inner.startsWith(first) : first === inner
      }
      return ref.path === inner || ref.path.startsWith(inner + '/') || (ref.prefix && inner.startsWith(ref.path))
    })
  }
  const add = (item) => { items.push({ ...item, path: relative(item.absolute) }); return item }
  /** Hard guards shared by every scope; returns a keep reason or undefined. */
  const guard = (absolute, scope, { topLevel = true } = {}) => {
    const rel = relative(absolute)
    if (touchesForbidden(absolute)) return 'protected repository path'
    if (isTracked(rel)) return 'contains Git-tracked files'
    const ref = referenceFor(scope, rel, { topLevel })
    if (ref && scope !== 'artifacts') return `referenced in ${ref.source}`
    return undefined
  }
  const policy = options.olderThanMs !== undefined ? (age) => age > options.olderThanMs : undefined

  for (const scope of options.scopes ?? SCOPES) {
    const directory = join(root, scope)
    if (!existsSync(directory)) continue
    const info = lstatSync(directory)
    if (info.isSymbolicLink() || !info.isDirectory()) { warnings.push(`${scope} is not a real directory; skipped`); continue }
    const names = readdirSync(directory).sort()
    if (names.includes('.keep')) {
      const usage = measure(directory, seen)
      add({ absolute: directory, scope, action: 'keep', reason: '.keep marker', ...usage })
      continue
    }
    if (scope === '.test-data') planTestData(directory, names)
    else if (scope === '.cache') planCache(directory, names)
    else planArtifacts(directory, names)
  }

  function planTestData(directory, names) {
    const candidates = []
    for (const name of names) {
      const absolute = join(directory, name)
      const info = lstatSync(absolute)
      if (info.isSymbolicLink()) { add({ absolute, scope: '.test-data', action: 'keep', reason: 'symbolic link (not followed)', bytes: 0, newest: info.mtimeMs }); continue }
      const isRegenerable = (entry) => (entry.isDirectory() && REGENERABLE_DIRECTORIES.has(entry.name)) || (entry.isFile() && entry.name.endsWith('.tgz'))
      if (isRegenerable({ name, isDirectory: () => info.isDirectory(), isFile: () => info.isFile() })) {
        const usage = measure(absolute, seen)
        const reason = guard(absolute, '.test-data')
        add({ absolute, scope: '.test-data', action: reason ? 'keep' : 'remove', reason: reason ?? (name.endsWith('.tgz') ? 'regenerable package copy (*.tgz)' : 'regenerable dependency/cache directory'), ...usage })
        continue
      }
      const locks = []
      if (info.isFile() && isLockFile(name)) { const state = lockState(absolute, info, now, alive); if (state) locks.push(state) }
      // Only an entry-level marker counts; packages ship their own nested .keep files.
      const keepMarker = info.isDirectory() && existsSync(join(absolute, '.keep'))
      const regenerable = []
      const usage = measure(absolute, seen, {
        child(path, entry) {
          if (entry.isFile() && isLockFile(entry.name)) {
            const state = lockState(path, lstatSync(path), now, alive)
            if (state) locks.push(state)
          }
          if (!isRegenerable(entry)) return undefined
          const result = measure(path, seen)
          regenerable.push({ absolute: path, ...result })
          return result
        },
      })
      const fixed = TEST_DATA_KEEP.get(name)
      const protect = fixed ?? (keepMarker ? '.keep marker' : undefined) ?? locks[0] ?? guard(absolute, '.test-data')
      const entry = { absolute, scope: '.test-data', ...usage, regenerable, protect, frozen: keepMarker || locks.length > 0 }
      candidates.push(entry)
    }
    // --keep-last ranks only entries that are otherwise prunable.
    const ranked = candidates.filter((entry) => !entry.protect).sort((a, b) => b.newest - a.newest)
    const rank = new Map(ranked.map((entry, index) => [entry, index]))
    const pruning = options.keepLast !== undefined || policy
    for (const entry of candidates) {
      let reason = entry.protect
      if (!reason) {
        const age = now - entry.newest
        if (!pruning) reason = 'evidence (pass --keep-last/--older-than to prune)'
        else if (options.keepLast !== undefined && rank.get(entry) < options.keepLast) reason = `among newest ${options.keepLast} evidence entries`
        else if (policy && !policy(age)) reason = `newer than ${options.olderThan}`
      }
      if (!reason) {
        const why = [options.keepLast !== undefined ? `beyond newest ${options.keepLast}` : '', policy ? `older than ${options.olderThan}` : ''].filter(Boolean).join(', ')
        add({ ...entry, action: 'remove', reason: `evidence ${why}` })
        continue
      }
      let kept = entry.bytes
      for (const regen of entry.regenerable) {
        const blocked = entry.frozen ? '.keep marker or active lock' : touchesForbidden(regen.absolute) ? 'protected repository path'
          : isTracked(relative(regen.absolute)) ? 'contains Git-tracked files' : referenceFor('.test-data', relative(regen.absolute), { topLevel: false }) ? 'referenced path' : undefined
        if (blocked) continue
        kept -= regen.bytes
        add({ absolute: regen.absolute, scope: '.test-data', action: 'remove', reason: regen.absolute.endsWith('.tgz') ? 'regenerable package copy (*.tgz)' : 'regenerable dependency/cache directory', bytes: regen.bytes, newest: regen.newest })
      }
      add({ absolute: entry.absolute, scope: '.test-data', action: 'keep', reason, bytes: kept, newest: entry.newest })
    }
  }

  function planCache(directory, names) {
    for (const name of names) {
      const absolute = join(directory, name)
      const info = lstatSync(absolute)
      if (info.isSymbolicLink()) { add({ absolute, scope: '.cache', action: 'keep', reason: 'symbolic link (not followed)', bytes: 0, newest: info.mtimeMs }); continue }
      const locks = []
      if (info.isFile() && isLockFile(name)) { const state = lockState(absolute, info, now, alive); if (state) locks.push(state) }
      const usage = measure(absolute, seen, { child(path, entry) { if (entry.isFile() && isLockFile(entry.name)) { const state = lockState(path, lstatSync(path), now, alive); if (state) locks.push(state) } } })
      const pid = /^dsh-host-extension-output-(\d+)$/.exec(name)?.[1]
      let reason = CACHE_KEEP.get(name) ?? (name.includes(tag) ? `current DSH ${target} target` : undefined)
        ?? (pid && alive(Number(pid)) ? `active build (pid ${pid})` : undefined) ?? (info.isDirectory() && existsSync(join(absolute, '.keep')) ? '.keep marker' : undefined)
        ?? locks[0] ?? guard(absolute, '.cache')
      const old = /(\d{3})rc(\d+)/.exec(name)
      const kind = old && old[0] !== tag ? `old DSH target (${old[0]})` : 'non-retained cache'
      if (!reason) {
        if (!policy) reason = `${kind} (pass --older-than to prune)`
        else if (!policy(now - usage.newest)) reason = `${kind}, newer than ${options.olderThan}`
      }
      add({ absolute, scope: '.cache', action: reason ? 'keep' : 'remove', reason: reason ?? `${kind} older than ${options.olderThan}`, ...usage })
    }
  }

  function planArtifacts(directory, names) {
    const groups = new Map()
    for (const name of names) {
      const absolute = join(directory, name)
      const info = lstatSync(absolute)
      const match = info.isFile() ? RELEASE.exec(name) : null
      if (!match) {
        add({ absolute, scope: 'artifacts', action: 'keep', reason: info.isSymbolicLink() ? 'symbolic link (not followed)' : 'outside release retention rules', ...(info.isSymbolicLink() ? { bytes: 0, newest: info.mtimeMs } : measure(absolute, seen)) })
        continue
      }
      const version = `${match[1]}.${match[2]}.${match[3]}${match[4] ?? ''}`
      const group = groups.get(version) ?? { version, numbers: match.slice(1, 4).map(Number), prerelease: Boolean(match[4]), files: [] }
      group.files.push({ absolute, kind: match[5] === '-verification.json' ? 'verification' : match[5] === '.tgz' ? 'package' : 'checksum', ...measure(absolute, seen) })
      groups.set(version, group)
    }
    const compare = (a, b) => b.numbers[0] - a.numbers[0] || b.numbers[1] - a.numbers[1] || b.numbers[2] - a.numbers[2]
    const formal = [...groups.values()].filter((group) => !group.prerelease && group.files.some((file) => file.kind === 'package')).sort(compare)
    const retained = new Set(formal.slice(0, KEEP_RELEASES))
    for (const group of groups.values()) {
      const packaged = group.files.some((file) => file.kind === 'package')
      for (const file of group.files) {
        const rel = relative(file.absolute)
        const ref = referenceFor('artifacts', rel, { topLevel: true })
        const note = ref ? `; referenced in ${ref.source}, verification.json keeps its hash` : ''
        let reason = file.kind === 'verification' ? 'verification evidence is never removed automatically' : guard(file.absolute, 'artifacts')
        let remove = false
        if (!reason) {
          if (!packaged) reason = 'checksum without a package (kept)'
          else if (retained.has(group)) reason = `one of ${KEEP_RELEASES} newest formal releases`
          else if (group.prerelease) {
            if (!policy) reason = 'pre-release package (pass --older-than to prune)'
            else if (!policy(now - file.newest)) reason = `pre-release package, newer than ${options.olderThan}`
            else { remove = true; reason = `pre-release package older than ${options.olderThan}${note}` }
          } else { remove = true; reason = `older than the ${KEEP_RELEASES} newest formal releases${note}` }
        }
        add({ absolute: file.absolute, scope: 'artifacts', action: remove ? 'remove' : 'keep', reason, bytes: file.bytes, newest: file.newest })
      }
    }
  }

  if (!tracked) warnings.push('Git-tracked file check unavailable')
  return { root, target, items, warnings }
}

export function formatBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++ }
  return `${value >= 10 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`
}

/** Deletes planned items; an item that became a link since planning is left alone. */
export function applyPlan(plan) {
  const results = []
  for (const item of plan.items.filter((entry) => entry.action === 'remove')) {
    const absolute = join(plan.root, ...item.path.split('/'))
    try {
      const info = lstatSync(absolute)
      if (info.isSymbolicLink()) throw new Error('became a symbolic link')
      rmSync(absolute, { recursive: true, force: false, maxRetries: 2 })
      results.push({ ...item, removed: true })
    } catch (error) { results.push({ ...item, removed: false, error: error.message }) }
  }
  return results
}

function report(plan, options) {
  const remove = plan.items.filter((item) => item.action === 'remove').sort((a, b) => b.bytes - a.bytes)
  const keep = plan.items.filter((item) => item.action === 'keep')
  const total = (list) => formatBytes(list.reduce((sum, item) => sum + item.bytes, 0))
  const row = (item) => `  ${formatBytes(item.bytes).padStart(8)}  ${item.path}  — ${item.reason}`
  console.log(`${options.apply ? 'Applying cleanup' : 'Dry run (nothing is deleted; pass --apply to delete)'} in ${plan.root}`)
  console.log(`Scopes ${(options.scopes ?? SCOPES).join(', ')}; pinned DSH target ${plan.target}; --keep-last ${options.keepLast ?? 'unset'}; --older-than ${options.olderThan ?? 'unset'}`)
  for (const warning of plan.warnings) console.log(`Warning: ${warning}`)
  console.log(`\nRemove: ${remove.length} item(s), ${total(remove)}`)
  for (const item of remove) console.log(row(item))
  console.log(`\nKeep: ${keep.length} item(s), ${total(keep)}`)
  if (options.verbose) { for (const item of keep) console.log(row(item)); return remove }
  const groups = new Map()
  for (const item of keep) {
    const reason = item.reason.replace(/^referenced in .*/, 'referenced in docs').replace(/\(pid \d+\)/, '(pid)')
    const key = `${item.scope}\u0000${reason}`
    const group = groups.get(key) ?? { scope: item.scope, reason, items: [] }
    group.items.push(item)
    groups.set(key, group)
  }
  for (const group of groups.values()) {
    const names = group.items.map((item) => item.path.slice(group.scope.length + 1))
    const sample = names.length > 4 ? `${names.slice(0, 4).join(', ')}, … (+${names.length - 4})` : names.join(', ')
    console.log(`  ${total(group.items).padStart(8)}  ${group.scope} ×${group.items.length}  — ${group.reason}: ${sample}`)
  }
  console.log('  (--verbose lists every kept item)')
  return remove
}

const usage = `Usage: node scripts/clean.mjs [--apply] [--scope test-data,cache,artifacts] [--keep-last N] [--older-than 14d] [--root DIR] [--verbose]

Previews cleanup of Git-ignored .test-data, .cache and artifacts; deletes only with --apply.
  always     .test-data node_modules / npm-cache / pnpm-store / _cacache and *.tgz copies
             artifacts: tgz + sha256 older than the ${KEEP_RELEASES} newest formal releases
  --older-than  .cache entries other than the pinned DSH target, dsh-host-build-deps,
                preview-package, typert and build-configs; .test-data evidence; pre-release tgz
  --keep-last   keep the newest N prunable .test-data evidence entries
Kept: .keep in a scope or top-level entry directory, active locks, paths cited in doc/ or openspec/ Markdown, Git-tracked files,
verification.json, links (never followed), lib/, node_modules/, doc/local/.`

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) { console.log(usage); return }
  const root = options.root ?? resolve(dirname(fileURLToPath(import.meta.url)), '..')
  let trackedFiles
  try { trackedFiles = gitTrackedFiles(root) } catch (error) {
    if (options.apply) throw new Error(`Cannot verify Git-tracked files (${error.message.split('\n')[0]}); refusing --apply`)
  }
  const plan = planClean({ ...options, root, trackedFiles })
  report(plan, options)
  if (!options.apply) return
  const results = applyPlan(plan)
  const failed = results.filter((item) => !item.removed)
  const freed = results.filter((item) => item.removed).reduce((sum, item) => sum + item.bytes, 0)
  console.log(`\nRemoved ${results.length - failed.length} item(s), about ${formatBytes(freed)} freed.`)
  for (const item of failed) console.log(`Failed: ${item.path}: ${item.error}`)
  if (failed.length) process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1 })
}
