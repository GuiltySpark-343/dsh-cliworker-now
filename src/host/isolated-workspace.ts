import { createHash, randomUUID } from 'node:crypto'
import { constants, createReadStream, existsSync, lstatSync, realpathSync } from 'node:fs'
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  rmdir,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, posix } from 'node:path'
import { z } from 'zod'
import { diff3Merge } from './diff3.ts'

/**
 * Plugin-owned project copies for parallel writers. No Git repository is read,
 * created or committed; the copy never contains `.git`.
 */
export const ISOLATION_LIMITS = {
  /** Files plus symbolic links copied from the project. */
  maxEntries: 20_000,
  /** Total size of copied regular files. */
  maxBytes: 1024 ** 3,
  /** Text files up to this size keep a baseline for three-way merge. */
  maxBaseBytes: 2 * 1024 ** 2,
  /** Bound for scanning a copy before merge; agents may create build output. */
  maxScanEntries: 200_000,
}
/** Never copied and never merged, at any depth. */
export const EXCLUDED_NAMES: ReadonlySet<string> = new Set([
  '.git',
  'node_modules',
  '.venv',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  '.next',
  '.nuxt',
  '.turbo',
  '.parcel-cache',
  '.gradle',
])

/** The copy cannot be created; the task falls back to the serial queue. */
export class IsolationUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'IsolationUnavailableError'
  }
}

const fileEntrySchema = z
  .object({
    type: z.literal('file'),
    hash: z.string().regex(/^[a-f\d]{64}$/),
    size: z.number().int().min(0),
    exec: z.boolean(),
    mode: z.number().int().min(0),
    base: z.boolean(),
    mtime: z.string(),
    ctime: z.string(),
  })
  .strict()
const linkEntrySchema = z.object({ type: z.literal('link'), target: z.string().min(1) }).strict()
const dirEntrySchema = z.object({ type: z.literal('dir') }).strict()
const entrySchema = z.discriminatedUnion('type', [fileEntrySchema, linkEntrySchema, dirEntrySchema])
const manifestSchema = z
  .object({
    version: z.literal(1),
    workerId: z.uuid(),
    project: z.string().min(1),
    copy: z.string().min(1),
    createdAt: z.string(),
    entries: z.record(z.string(), entrySchema),
    skippedLinks: z.array(z.string()),
  })
  .strict()
type Entry = z.infer<typeof entrySchema>
type Manifest = z.infer<typeof manifestSchema>

export interface WorkspacePaths {
  directory: string
  copy: string
  base: string
  manifest: string
}
const windows = process.platform === 'win32'
const key = (value: string) => (windows ? value.toLowerCase() : value)

export function isolationRoot(stateDirectory: string): string {
  return join(stateDirectory, 'isolated')
}
export function workspacePaths(root: string, workerId: string, project: string): WorkspacePaths {
  const id = z.uuid().parse(workerId)
  const name = basename(project)
  const directory = join(root, id)
  return {
    directory,
    // Keep the project folder name so the CLI and model see a familiar workspace name.
    copy: join(directory, 'copy', !name || name === '.' || name === '..' ? 'project' : name),
    base: join(directory, 'base'),
    manifest: join(directory, 'workspace.json'),
  }
}

/**
 * The copy is never validated as a user project: projectDirectory() still
 * rejects the plugin state directory. Only the exact scheduler-owned path for
 * this Worker is accepted, and it must be a real directory.
 */
export function assertIsolatedCopy(root: string, workerId: string, project: string): string {
  const expected = workspacePaths(realpathSync(root), workerId, project).copy
  const status = lstatSync(expected, { throwIfNoEntry: false })
  if (!status) throw new Error('隔离副本目录不存在')
  if (status.isSymbolicLink() || !status.isDirectory()) throw new Error('隔离副本目录无效')
  if (key(realpathSync(expected)) !== key(expected)) throw new Error('隔离副本目录无效')
  return expected
}
export function isolatedCopyExists(root: string, workerId: string, project: string): boolean {
  try {
    assertIsolatedCopy(root, workerId, project)
    return true
  } catch {
    return false
  }
}

/** Shown to the CLI before the task text; the user prompt itself is unchanged. */
export function isolationPromptNotice(copy: string, project: string): string {
  return [
    '【隔离副本】',
    `本轮在项目的隔离副本中运行，当前工作目录：${copy}`,
    `原项目路径：${project}。不要写入原项目路径；用户消息中提到原项目的路径时，请改用当前工作目录中的对应路径。`,
    '副本不包含 .git 与依赖目录（如 node_modules），不要执行 git 提交。改动由用户确认后合并回原项目。',
    '【隔离副本说明结束】',
    '',
    '',
  ].join('\n')
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 })
  if (!windows) await chmod(path, 0o700)
}

interface Scanned {
  kind: 'file' | 'link' | 'dir' | 'special'
  size: number
  mode: number
  mtime: string
  ctime: string
  target?: string
}
/** Relative POSIX path of a link target, or undefined when it can leave the project. */
export function insideTarget(path: string, target: string): string | undefined {
  const normalized = target.replaceAll('\\', '/')
  if (isAbsolute(target) || posix.isAbsolute(normalized) || /^[a-z]:/i.test(normalized)) return undefined
  const resolved = posix.normalize(posix.join(posix.dirname(path), normalized))
  if (resolved === '..' || resolved.startsWith('../') || posix.isAbsolute(resolved)) return undefined
  return resolved
}
/** Pre-order walk that never follows links and never enters excluded names. */
async function scanTree(
  root: string,
  options: { signal?: AbortSignal; maxEntries: number; maxBytes?: number },
): Promise<Map<string, Scanned>> {
  const entries = new Map<string, Scanned>()
  let count = 0,
    bytes = 0
  const pending: string[] = ['']
  while (pending.length) {
    options.signal?.throwIfAborted()
    const directory = pending.pop()!
    const names = (await readdir(join(root, ...directory.split('/').filter(Boolean)))).sort()
    const children: string[] = []
    for (const name of names) {
      if (EXCLUDED_NAMES.has(name)) continue
      const path = directory ? `${directory}/${name}` : name
      const status = await lstat(join(root, ...path.split('/')), { bigint: true })
      const common = {
        size: Number(status.size),
        mode: Number(status.mode) & 0o7777,
        mtime: String(status.mtimeNs),
        ctime: String(status.ctimeNs),
      }
      if (status.isDirectory()) {
        entries.set(path, { kind: 'dir', ...common })
        children.push(path)
        continue
      }
      if (status.isSymbolicLink()) entries.set(path, { kind: 'link', ...common, target: await readlink(join(root, ...path.split('/'))) })
      else if (status.isFile()) {
        entries.set(path, { kind: 'file', ...common })
        bytes += common.size
      } else entries.set(path, { kind: 'special', ...common })
      count++
      if (count > options.maxEntries)
        throw new IsolationUnavailableError(`项目文件数超过隔离副本上限（${options.maxEntries} 个）`)
      if (options.maxBytes !== undefined && bytes > options.maxBytes)
        throw new IsolationUnavailableError(`项目文件总大小超过隔离副本上限（${Math.round(options.maxBytes / 1024 ** 2)} MiB）`)
    }
    // Reverse so the stack visits children in sorted order; parents stay before descendants.
    pending.push(...children.reverse())
  }
  return entries
}

async function digest(path: string, size: number, inspectText: boolean): Promise<{ hash: string; text: boolean }> {
  if (size <= 8 * 1024 ** 2) {
    const data = await readFile(path)
    return {
      hash: createHash('sha256').update(data).digest('hex'),
      text: inspectText && size <= ISOLATION_LIMITS.maxBaseBytes && !data.includes(0),
    }
  }
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
  return { hash: hash.digest('hex'), text: false }
}
const executable = (mode: number) => !windows && (mode & 0o111) !== 0
const nativePath = (root: string, path: string) => join(root, ...path.split('/'))

async function writeManifest(paths: WorkspacePaths, manifest: Manifest): Promise<void> {
  const temporary = `${paths.manifest}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, JSON.stringify(manifestSchema.parse(manifest)), { mode: 0o600, flag: 'wx' })
    await rename(temporary, paths.manifest)
  } finally {
    await rm(temporary, { force: true })
  }
}
async function readManifest(paths: WorkspacePaths): Promise<Manifest> {
  return manifestSchema.parse(JSON.parse(await readFile(paths.manifest, 'utf8')))
}

/**
 * Copies `project` into this Worker's private workspace and records the
 * baseline. Any failure, limit or cancellation removes the partial copy.
 */
export async function createIsolatedWorkspace(input: {
  root: string
  workerId: string
  project: string
  signal?: AbortSignal
  limits?: Partial<typeof ISOLATION_LIMITS>
}): Promise<{ path: string; skippedLinks: number }> {
  const limits = { ...ISOLATION_LIMITS, ...input.limits }
  await ensurePrivateDirectory(input.root)
  const paths = workspacePaths(realpathSync(input.root), input.workerId, input.project)
  await rm(paths.directory, { recursive: true, force: true })
  try {
    const scanned = await scanTree(input.project, {
      signal: input.signal,
      maxEntries: limits.maxEntries,
      maxBytes: limits.maxBytes,
    })
    await mkdir(paths.directory, { mode: 0o700 })
    if (!windows) await chmod(paths.directory, 0o700)
    await mkdir(paths.copy, { recursive: true, mode: 0o700 })
    await mkdir(paths.base, { mode: 0o700 })
    const entries: Record<string, Entry> = {}
    const skippedLinks: string[] = []
    for (const [path, entry] of scanned) {
      input.signal?.throwIfAborted()
      const target = nativePath(paths.copy, path)
      if (entry.kind === 'dir') {
        await mkdir(target)
        entries[path] = { type: 'dir' }
      } else if (entry.kind === 'link') {
        // Only relative links that stay inside the project are recreated; nothing is followed.
        if (!insideTarget(path, entry.target!)) {
          skippedLinks.push(path)
          continue
        }
        try {
          await symlink(entry.target!, target)
          entries[path] = { type: 'link', target: entry.target! }
        } catch {
          skippedLinks.push(path)
        }
      } else if (entry.kind === 'file') {
        // Clone where the filesystem supports it (APFS, Btrfs, ReFS); otherwise a plain copy.
        await copyFile(nativePath(input.project, path), target, constants.COPYFILE_FICLONE)
        const status = await lstat(target, { bigint: true })
        const size = Number(status.size)
        const { hash, text } = await digest(target, size, true)
        if (text) {
          const base = nativePath(paths.base, path)
          await mkdir(dirname(base), { recursive: true, mode: 0o700 })
          await copyFile(target, base, constants.COPYFILE_FICLONE)
          if (!windows) await chmod(base, 0o600)
        }
        const mode = Number(status.mode) & 0o7777
        entries[path] = {
          type: 'file',
          hash,
          size,
          mode,
          exec: executable(mode),
          base: text,
          mtime: String(status.mtimeNs),
          ctime: String(status.ctimeNs),
        }
      }
      // Sockets, FIFOs and devices are not project content.
    }
    input.signal?.throwIfAborted()
    await writeManifest(paths, {
      version: 1,
      workerId: input.workerId,
      project: input.project,
      copy: paths.copy,
      createdAt: new Date().toISOString(),
      entries,
      skippedLinks,
    })
    return { path: paths.copy, skippedLinks: skippedLinks.length }
  } catch (error) {
    await removeIsolatedWorkspace(input.root, input.workerId)
    throw error
  }
}

/** Removes the whole Worker workspace and confirms it is gone. */
export async function removeIsolatedWorkspace(root: string, workerId: string): Promise<void> {
  const directory = join(root, z.uuid().parse(workerId))
  await rm(directory, { recursive: true, force: true, maxRetries: 3 })
  if (existsSync(directory)) throw new Error('隔离副本未能完全删除，请稍后重试')
}

type Side =
  | { type: 'file'; hash: string; exec: boolean; mode: number; size: number; path: string }
  | { type: 'link'; target: string }
  | { type: 'dir' }
  | { type: 'special' }
type Main = Side | { type: 'unsafe' }
function same(left: Side | Main | undefined, right: Side | Main | undefined): boolean {
  if (!left || !right) return !left && !right
  if (left.type !== right.type) return false
  if (left.type === 'file' && right.type === 'file') return left.hash === right.hash && left.exec === right.exec
  if (left.type === 'link' && right.type === 'link') return left.target === right.target
  return left.type === 'dir'
}

export interface MergeConflict {
  path: string
  reason: string
  /** The user may take the copy's version; otherwise only keeping the project version is safe. */
  resolvable: boolean
}
/** A user's decision for one conflicting path. */
export type MergeResolution = 'copy' | 'project'
export type MergeResult =
  | { status: 'merged'; written: string[]; deleted: string[]; kept: string[] }
  | { status: 'conflict'; conflicts: MergeConflict[]; copy: string }

type Action =
  | { kind: 'write'; path: string; source: Buffer | string; mode?: number; expected?: Main }
  | { kind: 'link'; path: string; target: string; expected?: Main }
  | { kind: 'delete'; path: string; expected: Main }
  | { kind: 'mkdir'; path: string }
  | { kind: 'rmdir'; path: string }

/** Exact-case, link-free view of one main-directory path. */
class MainView {
  private listings = new Map<string, Set<string> | undefined>()
  constructor(private project: string) {}
  private async names(directory: string) {
    if (!this.listings.has(directory))
      this.listings.set(directory, await readdir(nativePath(this.project, directory)).then((names) => new Set(names), () => undefined))
    return this.listings.get(directory)
  }
  /** Every existing parent must be a real directory named with the exact case. */
  async parentsSafe(path: string): Promise<boolean | 'missing'> {
    const parts = path.split('/')
    for (let index = 1; index < parts.length; index++) {
      const parent = parts.slice(0, index).join('/')
      const status = await lstat(nativePath(this.project, parent)).catch(() => undefined)
      if (!status) return 'missing'
      if (status.isSymbolicLink() || !status.isDirectory()) return false
      if (!(await this.names(parts.slice(0, index - 1).join('/')))?.has(parts[index - 1]!)) return false
    }
    return true
  }
  async entry(path: string): Promise<Main | undefined> {
    const parents = await this.parentsSafe(path)
    if (parents === 'missing') return undefined
    if (!parents) return { type: 'unsafe' }
    const full = nativePath(this.project, path)
    const status = await lstat(full).catch(() => undefined)
    if (!status) return undefined
    if (!(await this.names(posix.dirname(path) === '.' ? '' : posix.dirname(path)))?.has(posix.basename(path)))
      return { type: 'unsafe' }
    if (status.isSymbolicLink()) return { type: 'link', target: await readlink(full) }
    if (status.isDirectory()) return { type: 'dir' }
    if (!status.isFile()) return { type: 'special' }
    const mode = status.mode & 0o7777
    return { type: 'file', ...(await digest(full, status.size, false)), exec: executable(mode), mode, size: status.size, path: full }
  }
}

async function readText(path: string, size: number): Promise<string | undefined> {
  if (size > ISOLATION_LIMITS.maxBaseBytes) return undefined
  const data = await readFile(path)
  // latin1 maps every byte to one code unit, so line merge is byte exact for any encoding.
  return data.includes(0) ? undefined : data.toString('latin1')
}
function finalMode(main: Main | undefined, copy: { mode: number; exec: boolean }, baseExec?: boolean): number {
  if (main?.type !== 'file') return copy.mode & 0o777
  const exec = baseExec !== undefined && copy.exec !== baseExec ? copy.exec : main.exec
  if (exec === main.exec) return main.mode
  return exec ? main.mode | ((main.mode & 0o444) >> 2) : main.mode & ~0o111
}

/**
 * Three-way merge of the copy into the project. Nothing is written to the
 * project unless every changed path merges cleanly; the result is a plain
 * uncommitted working-tree change.
 */
export async function mergeIsolatedWorkspace(input: {
  root: string
  workerId: string
  project: string
  signal?: AbortSignal
  /** Per-path user decisions; a conflict without one keeps the project untouched. */
  resolutions?: Readonly<Record<string, MergeResolution>>
}): Promise<MergeResult> {
  const copy = assertIsolatedCopy(input.root, input.workerId, input.project)
  const paths = workspacePaths(realpathSync(input.root), input.workerId, input.project)
  const manifest = await readManifest(paths)
  if (manifest.project !== input.project || manifest.copy !== copy || manifest.workerId !== input.workerId)
    throw new Error('隔离副本元数据与当前任务不一致')
  const scanned = await scanTree(copy, { signal: input.signal, maxEntries: ISOLATION_LIMITS.maxScanEntries }).catch(
    (error) => {
      if (error instanceof IsolationUnavailableError) throw new Error('副本中的文件过多，无法合并')
      throw error
    },
  )
  // Changes made in the copy, relative to the recorded baseline.
  const changed: { path: string; base?: Entry; copy?: Side }[] = []
  for (const path of new Set([...Object.keys(manifest.entries), ...scanned.keys()])) {
    input.signal?.throwIfAborted()
    const base = manifest.entries[path]
    const current = scanned.get(path)
    let side: Side | undefined
    if (current?.kind === 'file') {
      const unchanged =
        base?.type === 'file' && base.size === current.size && base.mtime === current.mtime && base.ctime === current.ctime
      const full = nativePath(copy, path)
      side = {
        type: 'file',
        hash: unchanged ? base.hash : (await digest(full, current.size, false)).hash,
        exec: executable(current.mode),
        mode: current.mode,
        size: current.size,
        path: full,
      }
    } else if (current?.kind === 'link') side = { type: 'link', target: current.target! }
    else if (current) side = { type: current.kind }
    const baseSide: Side | undefined =
      base?.type === 'file' ? { type: 'file', hash: base.hash, exec: base.exec, mode: base.mode, size: base.size, path: '' } : base
    if (!same(baseSide, side)) changed.push({ path, base, copy: side })
  }
  const conflicts: MergeConflict[] = []
  const kept: string[] = []
  // A decided conflict becomes an action (copy) or is skipped (project); structural ones only allow skipping.
  const conflict = (path: string, reason: string, take?: () => void) => {
    const decision = input.resolutions?.[path]
    if (decision === 'project') kept.push(path)
    else if (decision === 'copy' && take) take()
    else conflicts.push({ path, reason, resolvable: !!take })
  }
  // Case-only renames would delete the new name on case-insensitive filesystems.
  const byCase = new Map<string, string[]>()
  for (const { path } of changed) byCase.set(path.toLowerCase(), [...(byCase.get(path.toLowerCase()) ?? []), path])
  const caseRenames = new Set([...byCase.values()].filter((group) => group.length > 1).flat())
  const main = new MainView(input.project)
  const actions: Action[] = []
  for (const change of changed) {
    input.signal?.throwIfAborted()
    const { path, base, copy: side } = change
    if (caseRenames.has(path)) {
      conflict(path, '仅大小写不同的改名，请手动处理')
      continue
    }
    const current = await main.entry(path)
    if (current?.type === 'unsafe') {
      conflict(path, '主目录中该路径经过符号链接、不是目录或大小写不一致')
      continue
    }
    const baseSide: Side | undefined =
      base?.type === 'file' ? { type: 'file', hash: base.hash, exec: base.exec, mode: base.mode, size: base.size, path: '' } : base
    if (same(current, side)) continue
    if (side?.type === 'special') {
      conflict(path, '副本中出现了特殊文件')
      continue
    }
    if (side?.type === 'link' && !insideTarget(path, side.target)) {
      conflict(path, '副本中的符号链接指向项目外')
      continue
    }
    if (base && side && base.type !== side.type) {
      conflict(path, '副本改变了文件类型（文件、目录或链接），请手动处理')
      continue
    }
    const takeCopy = () => {
      if (!side) actions.push(current?.type === 'dir' ? { kind: 'rmdir', path } : { kind: 'delete', path, expected: current! })
      else if (side.type === 'dir') actions.push({ kind: 'mkdir', path })
      else if (side.type === 'link') actions.push({ kind: 'link', path, target: side.target, expected: current })
      else if (side.type === 'file')
        actions.push({
          kind: 'write',
          path,
          source: side.path,
          mode: finalMode(current, side, base?.type === 'file' ? base.exec : undefined),
          expected: current,
        })
    }
    if (same(baseSide, current)) {
      takeCopy()
      continue
    }
    if (base?.type === 'file' && side?.type === 'file' && current?.type === 'file') {
      const texts =
        base.base
          ? await Promise.all([
              readText(nativePath(paths.base, path), base.size),
              readText(current.path, current.size),
              readText(side.path, side.size),
            ])
          : []
      if (texts.length && texts.every((text) => text !== undefined)) {
        const merged = diff3Merge(texts[0]!, texts[1]!, texts[2]!)
        if (merged.clean) {
          actions.push({
            kind: 'write',
            path,
            source: Buffer.from(merged.text, 'latin1'),
            mode: finalMode(current, side, base.exec),
            expected: current,
          })
          continue
        }
        conflict(path, merged.reason === 'too-large' ? '改动过大，无法自动合并' : '两边改动了相同或相邻的行', takeCopy)
        continue
      }
      conflict(path, '二进制或超大文件两边都有改动', takeCopy)
      continue
    }
    if (!side) conflict(path, '副本删除了主目录中已修改的内容', takeCopy)
    else if (!base) conflict(path, '两边都新增了同名内容且不一致', takeCopy)
    else if (!current) conflict(path, '主目录已删除副本中修改过的内容', takeCopy)
    else conflict(path, '两边的文件类型或内容不一致', takeCopy)
  }
  if (conflicts.length) return { status: 'conflict', conflicts: conflicts.sort((a, b) => (a.path < b.path ? -1 : 1)), copy }
  await applyActions(input.project, actions, input.signal)
  return {
    status: 'merged',
    written: actions.filter((action) => action.kind === 'write' || action.kind === 'link').map((action) => action.path).sort(),
    deleted: actions.filter((action) => action.kind === 'delete').map((action) => action.path).sort(),
    kept: kept.sort(),
  }
}

/** Stage every write first, then delete, then rename into place. */
async function applyActions(project: string, actions: Action[], signal?: AbortSignal): Promise<void> {
  const staged: { action: Extract<Action, { kind: 'write' }>; temporary: string }[] = []
  const created: string[] = []
  const ensureParents = async (path: string) => {
    const parts = path.split('/').slice(0, -1)
    for (let index = 1; index <= parts.length; index++) {
      const directory = parts.slice(0, index).join('/')
      const full = nativePath(project, directory)
      const status = await lstat(full).catch(() => undefined)
      if (status && (status.isSymbolicLink() || !status.isDirectory()))
        throw new Error(`主目录中的 ${directory} 不是目录，已停止合并`)
      if (!status) {
        await mkdir(full)
        created.push(full)
      }
    }
  }
  // A fresh view per check: earlier steps may have created parent directories.
  const unchanged = async (path: string, expected: Main | undefined) => {
    if (!same(await new MainView(project).entry(path), expected)) throw new Error(`合并期间主目录中的 ${path} 发生变化，请重新合并`)
  }
  try {
    for (const action of actions) {
      signal?.throwIfAborted()
      if (action.kind !== 'write') continue
      await ensureParents(action.path)
      const target = nativePath(project, action.path)
      const temporary = join(dirname(target), `.${basename(target)}.cwn-merge-${randomUUID().slice(0, 8)}`)
      const data = typeof action.source === 'string' ? await readFile(action.source) : action.source
      await writeFile(temporary, data, { flag: 'wx', mode: 0o600 })
      staged.push({ action, temporary })
    }
  } catch (error) {
    await Promise.all(staged.map(({ temporary }) => rm(temporary, { force: true })))
    for (const directory of created.reverse()) await rmdir(directory).catch(() => undefined)
    throw error
  }
  // From here on the project changes; a failure leaves a re-mergeable state
  // because already written paths equal the copy and are skipped next time.
  try {
    for (const action of actions) {
      if (action.kind !== 'delete') continue
      await unchanged(action.path, action.expected)
      await unlink(nativePath(project, action.path))
    }
    for (const { action, temporary } of staged) {
      await unchanged(action.path, action.expected)
      const target = nativePath(project, action.path)
      if (!windows && action.mode !== undefined) await chmod(temporary, action.mode)
      await rename(temporary, target)
    }
    for (const action of actions) {
      if (action.kind === 'link') {
        await unchanged(action.path, action.expected)
        await ensureParents(action.path)
        const target = nativePath(project, action.path)
        if (action.expected) await unlink(target)
        await symlink(action.target, target)
      } else if (action.kind === 'mkdir') {
        await ensureParents(`${action.path}/.`)
      }
    }
    // Remove directories the copy deleted, deepest first, only when empty.
    for (const action of actions
      .filter((item): item is Extract<Action, { kind: 'rmdir' }> => item.kind === 'rmdir')
      .sort((a, b) => b.path.length - a.path.length))
      await rmdir(nativePath(project, action.path)).catch(() => undefined)
  } catch (error) {
    await Promise.all(staged.map(({ temporary }) => rm(temporary, { force: true })))
    throw new Error(`合并写回中途失败，主目录可能已部分更新，可再次合并：${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    })
  }
}
