import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import { isAbsolute, join, posix, win32 } from 'node:path'
import { CLI_IDS, type ActiveCliId, type CliId } from '../shared/types.ts'

export interface CliExecutablePath {
  mode: 'auto' | 'manual'
  path: string
}
export interface CliExecutablePathStoreOptions {
  platform?: NodeJS.Platform
  hostname?: string
}
interface PathRecord {
  revision: number
  entry?: CliExecutablePath
}
interface PathFile {
  schema: 1
  identity: string
  entries: Partial<Record<ActiveCliId, PathRecord>>
}

const MAX_BYTES = 256 * 1024
const storageError = () => new Error('CLI 路径记录不可读取或写入，请检查插件存储目录')
const pathError = () => new Error('请输入完整的 CLI 文件绝对路径，不要添加外层引号或展开命令')
const activeCli = (cli: CliId): ActiveCliId => {
  if (!(CLI_IDS as readonly string[]).includes(cli)) throw new Error('CLI 路径管理不支持该 CLI')
  return cli as ActiveCliId
}
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
const keys = (value: Record<string, unknown>, allowed: string[]) =>
  Object.keys(value).every((key) => allowed.includes(key))

/** Paths stay single argv values: spaces and shell metacharacters are literal file-name characters. */
function executablePath(value: string, platform: NodeJS.Platform): string {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > 4096 ||
    /[\x00-\x1f\x7f]/.test(value) ||
    value !== value.trim() ||
    /^["']|["']$/.test(value)
  )
    throw pathError()
  const path = platform === 'win32' ? win32 : posix
  if (
    !path.isAbsolute(value) ||
    (platform === 'win32' ? /[\\/]$/ : /\/$/).test(value) ||
    path.parse(value).root === value
  )
    throw pathError()
  if (platform === 'win32') {
    // Explicit UNC file paths are supported; device namespaces, drive-relative
    // paths and alternate data streams are not executable file selections.
    if (
      /^[\\/]{2}[?.][\\/]/.test(value) ||
      !/^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+[\\/])/.test(value) ||
      value.slice(/^[A-Za-z]:/.test(value) ? 2 : 0).includes(':') ||
      /[<>"|?*]/.test(value) ||
      value
        .slice(win32.parse(value).root.length)
        .split(/[\\/]/)
        .some((part) => /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(part.replace(/[ .]+$/, '')))
    )
      throw pathError()
  }
  const normalized = path.normalize(value)
  if (path.parse(normalized).root === normalized) throw pathError()
  return normalized
}

/** Private per-machine path choices. WorkerStorage's Host lock owns the enclosing directory. */
export class CliExecutablePathStore {
  private readonly root: string
  private readonly directory: string
  private readonly file: string
  private readonly identity: string
  private readonly platform: NodeJS.Platform

  constructor(root: string, options: CliExecutablePathStoreOptions = {}) {
    const machine = options.hostname ?? hostname()
    this.platform = options.platform ?? process.platform
    if (
      !isAbsolute(root) ||
      typeof machine !== 'string' ||
      !machine.trim() ||
      machine.length > 255 ||
      /[\x00-\x1f\x7f]/.test(machine) ||
      ![
        'aix',
        'android',
        'darwin',
        'freebsd',
        'haiku',
        'linux',
        'openbsd',
        'sunos',
        'win32',
        'cygwin',
        'netbsd',
      ].includes(this.platform)
    )
      throw storageError()
    this.identity = createHash('sha256')
      .update(JSON.stringify([this.platform, machine.toLowerCase()]))
      .digest('hex')
    this.privateDirectory(root, true)
    try {
      this.root = realpathSync(root)
    } catch {
      throw storageError()
    }
    this.directory = join(this.root, 'cli-executable-paths')
    this.file = join(this.directory, `${this.platform}-${this.identity}.json`)
    this.prepare()
  }

  read(cli: CliId): CliExecutablePath | undefined {
    const id = activeCli(cli),
      entry = this.load().entries[id]?.entry
    return entry && { ...entry }
  }

  revision(cli: CliId): number {
    const id = activeCli(cli)
    return this.load().entries[id]?.revision ?? 0
  }

  setManual(cli: CliId, path: string): void {
    const id = activeCli(cli),
      normalized = executablePath(path, this.platform)
    const data = this.load(),
      current = data.entries[id]
    if (current?.entry?.mode === 'manual' && this.samePath(current.entry.path, normalized)) return
    data.entries[id] = { revision: this.next(current), entry: { mode: 'manual', path: normalized } }
    this.save(data)
  }

  reset(cli: CliId): void {
    const id = activeCli(cli),
      data = this.load()
    // Keep an epoch even when there is no entry, so an in-flight pre-reset
    // discovery cannot restore the removed path, including after Host restart.
    data.entries[id] = { revision: this.next(data.entries[id]) }
    this.save(data)
  }

  remember(cli: CliId, path: string, expectedRevision: number): boolean {
    const id = activeCli(cli),
      data = this.load(),
      current = data.entries[id]
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw storageError()
    if ((current?.revision ?? 0) !== expectedRevision || current?.entry?.mode === 'manual') return false
    const normalized = executablePath(path, this.platform)
    if (current?.entry && this.samePath(current.entry.path, normalized)) return true
    data.entries[id] = { revision: this.next(current), entry: { mode: 'auto', path: normalized } }
    this.save(data)
    return true
  }

  private samePath(left: string, right: string): boolean {
    return this.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
  }

  private next(current?: PathRecord): number {
    const value = (current?.revision ?? 0) + 1
    if (!Number.isSafeInteger(value)) throw storageError()
    return value
  }

  private privateDirectory(path: string, recursive = false): void {
    try {
      let info
      try {
        info = lstatSync(path)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        mkdirSync(path, { recursive, mode: 0o700 })
        info = lstatSync(path)
      }
      if (info.isSymbolicLink() || !info.isDirectory()) throw storageError()
      chmodSync(path, 0o700)
    } catch {
      throw storageError()
    }
  }

  private prepare(): void {
    this.privateDirectory(this.root)
    this.privateDirectory(this.directory)
  }

  private fileInfo() {
    try {
      const info = lstatSync(this.file)
      if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1 || info.size > MAX_BYTES)
        throw storageError()
      return info
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw storageError()
    }
  }

  private load(): PathFile {
    this.prepare()
    const info = this.fileInfo()
    if (!info) return { schema: 1, identity: this.identity, entries: {} }
    let fd: number | undefined
    try {
      fd = openSync(this.file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      const before = fstatSync(fd)
      if (
        !before.isFile() ||
        before.nlink !== 1 ||
        before.dev !== info.dev ||
        before.ino !== info.ino ||
        before.size > MAX_BYTES
      )
        throw storageError()
      fchmodSync(fd, 0o600)
      const buffer = Buffer.alloc(before.size + 1)
      let length = 0
      while (length < buffer.length) {
        const size = readSync(fd, buffer, length, buffer.length - length, null)
        if (!size) break
        length += size
      }
      const after = fstatSync(fd),
        current = this.fileInfo()
      if (
        length !== before.size ||
        after.size !== before.size ||
        after.mtimeMs !== before.mtimeMs ||
        !current ||
        current.dev !== before.dev ||
        current.ino !== before.ino ||
        current.size !== after.size ||
        current.mtimeMs !== after.mtimeMs
      )
        throw storageError()
      const value: unknown = JSON.parse(buffer.subarray(0, length).toString('utf8'))
      if (
        !record(value) ||
        !keys(value, ['schema', 'identity', 'entries']) ||
        value.schema !== 1 ||
        value.identity !== this.identity ||
        !record(value.entries)
      )
        throw storageError()
      for (const [cli, item] of Object.entries(value.entries)) {
        activeCli(cli as CliId)
        if (
          !record(item) ||
          !keys(item, ['revision', 'entry']) ||
          !Number.isSafeInteger(item.revision) ||
          (item.revision as number) < 1
        )
          throw storageError()
        if (item.entry !== undefined) {
          if (
            !record(item.entry) ||
            !keys(item.entry, ['mode', 'path']) ||
            !['auto', 'manual'].includes(item.entry.mode as string) ||
            typeof item.entry.path !== 'string'
          )
            throw storageError()
          if (executablePath(item.entry.path, this.platform) !== item.entry.path) throw storageError()
        }
      }
      return value as unknown as PathFile
    } catch {
      throw storageError()
    } finally {
      if (fd !== undefined) closeSync(fd)
    }
  }

  private save(value: PathFile): void {
    const temp = `${this.file}.${randomUUID()}.tmp`
    let fd: number | undefined,
      created = false
    try {
      this.prepare()
      this.fileInfo()
      const data = JSON.stringify(value)
      if (Buffer.byteLength(data) > MAX_BYTES) throw storageError()
      fd = openSync(
        temp,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      )
      created = true
      fchmodSync(fd, 0o600)
      writeFileSync(fd, data)
      fsyncSync(fd)
      closeSync(fd)
      fd = undefined
      this.prepare()
      this.fileInfo()
      renameSync(temp, this.file)
    } catch {
      throw storageError()
    } finally {
      if (fd !== undefined) closeSync(fd)
      if (created) rmSync(temp, { force: true })
    }
  }
}
