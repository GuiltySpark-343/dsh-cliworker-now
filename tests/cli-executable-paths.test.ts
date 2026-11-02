import { afterEach, describe, expect, it } from 'vitest'
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CliExecutablePathStore,
  type CliExecutablePathStoreOptions,
} from '../src/host/cli-executable-paths.ts'
import { CLI_IDS, type CliId } from '../src/shared/types.ts'

// Synthetic path choices only. No user's install, credentials, or CLI is accessed.
const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})
function fixture(options: CliExecutablePathStoreOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), 'synthetic-cli-paths-'))
  directories.push(root)
  const identity = { platform: 'darwin' as const, hostname: 'synthetic-machine', ...options }
  const store = new CliExecutablePathStore(root, identity)
  const directory = join(root, 'cli-executable-paths')
  const file = () => join(directory, readdirSync(directory).find((name) => name.endsWith('.json'))!)
  return { root, directory, identity, store, file }
}

describe('private persisted CLI executable paths', () => {
  it('remembers automatic discovery across Host restarts and returns independent snapshots', () => {
    const f = fixture()
    expect(f.store.read('zcode')).toBeUndefined()
    expect(f.store.revision('zcode')).toBe(0)
    expect(f.store.remember('zcode', '/Applications/中文 ZCode/cli.cjs', 0)).toBe(true)
    const restarted = new CliExecutablePathStore(f.root, f.identity)
    expect(restarted.read('zcode')).toEqual({ mode: 'auto', path: '/Applications/中文 ZCode/cli.cjs' })
    expect(restarted.revision('zcode')).toBe(1)
    const copy = restarted.read('zcode')!
    copy.path = '/changed-only-in-caller'
    expect(restarted.read('zcode')?.path).toBe('/Applications/中文 ZCode/cli.cjs')
  })

  it('keeps manual missing-file selections and never overwrites them with discovery', () => {
    const f = fixture()
    f.store.setManual('opencode', '/synthetic/nonexistent/OpenCode CLI')
    expect(f.store.read('opencode')).toEqual({ mode: 'manual', path: '/synthetic/nonexistent/OpenCode CLI' })
    const revision = f.store.revision('opencode')
    expect(f.store.remember('opencode', '/different/opencode', revision)).toBe(false)
    expect(new CliExecutablePathStore(f.root, f.identity).read('opencode')).toEqual(f.store.read('opencode'))
  })

  it('changes automatic discovery into an explicit manual selection even at the same path', () => {
    const f = fixture()
    f.store.remember('claude', '/synthetic/claude', 0)
    const old = f.store.revision('claude')
    f.store.setManual('claude', '/synthetic/claude')
    expect(f.store.read('claude')?.mode).toBe('manual')
    expect(f.store.revision('claude')).toBe(old + 1)
    expect(f.store.remember('claude', '/late/claude', old)).toBe(false)
  })

  it('rejects a discovery that started before manual editing or reset', () => {
    const f = fixture(),
      old = f.store.revision('codex')
    f.store.setManual('codex', '/manual/codex')
    expect(f.store.remember('codex', '/late/codex', old)).toBe(false)
    const beforeReset = f.store.revision('codex')
    f.store.reset('codex')
    expect(f.store.read('codex')).toBeUndefined()
    const restarted = new CliExecutablePathStore(f.root, f.identity)
    expect(restarted.remember('codex', '/late/codex', beforeReset)).toBe(false)
    expect(restarted.remember('codex', '/fresh/codex', restarted.revision('codex'))).toBe(true)
    expect(restarted.read('codex')).toEqual({ mode: 'auto', path: '/fresh/codex' })
  })

  it('reset invalidates discovery even when no previous path has been saved', () => {
    const f = fixture()
    f.store.reset('zcode')
    expect(f.store.read('zcode')).toBeUndefined()
    expect(f.store.revision('zcode')).toBe(1)
    expect(f.store.remember('zcode', '/late/zcode', 0)).toBe(false)
  })

  it('keeps each CLI revision independent and retains updates made by another store instance', () => {
    const f = fixture(),
      second = new CliExecutablePathStore(f.root, f.identity)
    f.store.setManual('codex', '/manual/codex')
    expect(second.remember('zcode', '/discovered/zcode', 0)).toBe(true)
    f.store.reset('claude')
    expect(second.read('codex')).toEqual({ mode: 'manual', path: '/manual/codex' })
    expect(f.store.read('zcode')).toEqual({ mode: 'auto', path: '/discovered/zcode' })
    expect(second.revision('claude')).toBe(1)
  })

  it('does not rewrite identical manual or automatic choices', () => {
    const f = fixture()
    f.store.remember('pi', '/synthetic/pi', 0)
    const before = readFileSync(f.file(), 'utf8'),
      revision = f.store.revision('pi')
    expect(f.store.remember('pi', '/synthetic/pi', revision)).toBe(true)
    expect(f.store.revision('pi')).toBe(revision)
    expect(readFileSync(f.file(), 'utf8')).toBe(before)
    f.store.setManual('pi', '/synthetic/pi')
    const manual = readFileSync(f.file(), 'utf8'),
      manualRevision = f.store.revision('pi')
    f.store.setManual('pi', '/synthetic/pi')
    expect(f.store.revision('pi')).toBe(manualRevision)
    expect(readFileSync(f.file(), 'utf8')).toBe(manual)
  })

  it('isolates machines and platforms even when the same enclosing store is copied or shared', () => {
    const f = fixture()
    f.store.setManual('hermes', '/machine-a/hermes')
    const other = new CliExecutablePathStore(f.root, { ...f.identity, hostname: 'other-machine' })
    expect(other.read('hermes')).toBeUndefined()
    other.setManual('hermes', '/machine-b/hermes')
    const windows = new CliExecutablePathStore(f.root, { ...f.identity, platform: 'win32' })
    expect(windows.read('hermes')).toBeUndefined()
    windows.setManual('hermes', 'E:\\Custom Apps\\hermes.exe')
    expect(f.store.read('hermes')?.path).toBe('/machine-a/hermes')
    expect(other.read('hermes')?.path).toBe('/machine-b/hermes')
    expect(readdirSync(f.directory)).toHaveLength(3)
  })

  it('supports every active CLI while refusing retired or untrusted IDs', () => {
    const f = fixture()
    for (const cli of CLI_IDS) {
      f.store.setManual(cli, `/synthetic/${cli}`)
      expect(f.store.read(cli)).toEqual({ mode: 'manual', path: `/synthetic/${cli}` })
    }
    for (const cli of ['harness', '../escape', '__proto__', 'unknown'] as CliId[]) {
      expect(() => f.store.read(cli)).toThrow('不支持')
      expect(() => f.store.revision(cli)).toThrow('不支持')
      expect(() => f.store.setManual(cli, '/synthetic/cli')).toThrow('不支持')
      expect(() => f.store.reset(cli)).toThrow('不支持')
      expect(() => f.store.remember(cli, '/synthetic/cli', 0)).toThrow('不支持')
    }
  })

  it('accepts literal POSIX file names with spaces and shell metacharacters without interpreting them', () => {
    const f = fixture(),
      path = "/synthetic/O'Connor & Tools/cli;$(literal) --preview"
    f.store.setManual('claude', path)
    expect(f.store.read('claude')?.path).toBe(path)
    f.store.setManual('claude', '/synthetic/cli\\')
    expect(f.store.read('claude')?.path).toBe('/synthetic/cli\\')
  })

  it('accepts Windows drive paths, Unicode, spaces and explicit UNC files; normalizes idempotently', () => {
    const f = fixture({ platform: 'win32' })
    f.store.setManual('zcode', 'E:/中文 & Tools/ZCode/resources/glm/zcode.cjs')
    expect(f.store.read('zcode')?.path).toBe('E:\\中文 & Tools\\ZCode\\resources\\glm\\zcode.cjs')
    const revision = f.store.revision('zcode')
    f.store.setManual('zcode', 'e:\\中文 & Tools\\zcode\\resources\\glm\\zcode.cjs')
    expect(f.store.revision('zcode')).toBe(revision)
    f.store.setManual('opencode', '\\\\server\\CLI Tools\\opencode.exe')
    expect(f.store.read('opencode')?.path).toBe('\\\\server\\CLI Tools\\opencode.exe')
  })

  it.each([
    '',
    'claude',
    './cli',
    '~/bin/cli',
    '$HOME/bin/cli',
    'node /tmp/cli.cjs',
    '"/tmp/cli"',
    "'/tmp/cli'",
    '/tmp/cli\0',
    '/tmp/cli\n--flag',
    '/tmp/cli\r',
    '/tmp/cli\t',
    '/',
    '/tmp/',
  ])('rejects invalid POSIX selection %j without erasing saved state', (path) => {
    const f = fixture()
    f.store.setManual('claude', '/valid/claude')
    expect(() => f.store.setManual('claude', path)).toThrow('完整')
    expect(f.store.read('claude')?.path).toBe('/valid/claude')
  })

  it.each([
    'C:cli.exe',
    '\\tools\\cli.exe',
    '/usr/bin/cli',
    '%APPDATA%\\cli.exe',
    '\\\\?\\C:\\cli.exe',
    '\\\\.\\pipe\\cli',
    'C:\\cli.exe:stream',
    '\\\\server\\share\\cli.exe:stream',
    'C:\\',
    '\\\\server\\share',
    'C:\\bad"name.exe',
    'C:\\NUL.exe',
    'C:\\tools\\CON',
    '\\\\server\\share\\COM1.exe',
  ])('rejects incomplete, device or ADS Windows selection %j', (path) => {
    const f = fixture({ platform: 'win32' })
    expect(() => f.store.setManual('opencode', path)).toThrow('完整')
    expect(f.store.read('opencode')).toBeUndefined()
  })

  it('rejects malformed persisted data without overwriting it', () => {
    const f = fixture()
    f.store.setManual('codex', '/valid/codex')
    const file = f.file()
    writeFileSync(file, '{invalid json', { mode: 0o600 })
    expect(() => f.store.read('codex')).toThrow('路径记录')
    expect(() => f.store.setManual('codex', '/new/codex')).toThrow('路径记录')
    expect(readFileSync(file, 'utf8')).toBe('{invalid json')
  })

  it('checks persisted identity, active IDs, revisions, modes and paths on every read', () => {
    const f = fixture()
    f.store.setManual('codex', '/valid/codex')
    const file = f.file(),
      original = JSON.parse(readFileSync(file, 'utf8'))
    const corrupt = [
      { ...original, identity: 'another-machine' },
      { ...original, entries: { harness: { revision: 1 } } },
      { ...original, entries: { codex: { revision: -1 } } },
      { ...original, entries: { codex: { revision: 1, entry: { mode: 'unknown', path: '/cli' } } } },
      { ...original, entries: { codex: { revision: 1, entry: { mode: 'manual', path: 'node /cli' } } } },
      { ...original, credentials: 'forbidden-extra-property' },
    ]
    for (const value of corrupt) {
      writeFileSync(file, JSON.stringify(value))
      expect(() => f.store.read('codex')).toThrow('路径记录')
    }
  })

  it('rejects oversized, hard-linked and directory-shaped store files', () => {
    const f = fixture()
    f.store.setManual('codex', '/valid/codex')
    const file = f.file(),
      original = readFileSync(file)
    writeFileSync(file, Buffer.alloc(256 * 1024 + 1))
    expect(() => f.store.read('codex')).toThrow('路径记录')
    writeFileSync(file, original)
    const other = join(f.root, 'other-private-file.json')
    linkSync(file, other)
    expect(() => f.store.read('codex')).toThrow('路径记录')
    expect(() => f.store.reset('codex')).toThrow('路径记录')
    rmSync(file)
    mkdirSync(file)
    expect(() => f.store.setManual('codex', '/new/codex')).toThrow('路径记录')
  })

  it('refuses a symlink or junction replacing its private directory and leaves the target untouched', () => {
    const f = fixture(),
      external = join(f.root, 'unrelated')
    mkdirSync(external)
    renameSync(f.directory, join(f.root, 'original-private-directory'))
    symlinkSync(external, f.directory, process.platform === 'win32' ? 'junction' : 'dir')
    expect(() => f.store.setManual('codex', '/new/codex')).toThrow('路径记录')
    expect(() => new CliExecutablePathStore(f.directory, f.identity)).toThrow('路径记录')
    expect(readdirSync(external)).toEqual([])
  })

  it.skipIf(process.platform === 'win32')(
    'refuses a file symlink without altering its target or following dangling links',
    () => {
      const f = fixture()
      f.store.setManual('codex', '/valid/codex')
      const file = f.file(),
        target = join(f.root, 'external.json')
      writeFileSync(target, 'unrelated', { mode: 0o644 })
      rmSync(file)
      symlinkSync(target, file)
      expect(() => f.store.read('codex')).toThrow('路径记录')
      expect(() => f.store.reset('codex')).toThrow('路径记录')
      expect(readFileSync(target, 'utf8')).toBe('unrelated')
      expect(statSync(target).mode & 0o777).toBe(0o644)
      rmSync(target)
      expect(() => f.store.setManual('codex', '/new/codex')).toThrow('路径记录')
    },
  )

  it.skipIf(process.platform === 'win32')(
    'keeps directories at 0700 and files at 0600 with no temporary leftovers',
    () => {
      const f = fixture()
      f.store.setManual('codex', '/private/codex')
      expect(statSync(f.root).mode & 0o777).toBe(0o700)
      expect(statSync(f.directory).mode & 0o777).toBe(0o700)
      expect(statSync(f.file()).mode & 0o777).toBe(0o600)
      chmodSync(f.directory, 0o755)
      chmodSync(f.file(), 0o644)
      f.store.read('codex')
      expect(statSync(f.directory).mode & 0o777).toBe(0o700)
      expect(statSync(f.file()).mode & 0o777).toBe(0o600)
      expect(readdirSync(f.directory)).toHaveLength(1)
    },
  )
})
