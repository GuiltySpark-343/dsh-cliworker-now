import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path, { dirname, join, win32 } from 'node:path'
import {
  findWindowsDesktopCli,
  windowsDesktopCliFromMetadata,
  windowsOpenCodeDesktopCli,
  type WindowsDesktopCli,
  type WindowsDesktopOptions,
} from '../src/host/windows-desktop-cli-installation.ts'
import { WindowsCliInstallationError } from '../src/host/windows-cli-installation.ts'
import { ProcessCleanupUnconfirmedError } from '../src/host/process.ts'

// All installation records, files, and PE headers in this suite are synthetic.
// No desktop application, registry query, CLI, account, or model is executed.
const roots: string[] = []
const nativeOptions = { path }
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function temporaryRoot(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'synthetic-desktop-cli-')))
  roots.push(root)
  return root
}
function put(file: string, contents: string | Buffer): string {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, contents)
  return file
}
function syntheticPe(subsystem = 3): Buffer {
  const bytes = Buffer.alloc(256)
  bytes.write('MZ')
  bytes.writeUInt32LE(64, 0x3c)
  bytes.write('PE\0\0', 64)
  bytes.writeUInt16LE(0x20b, 64 + 24)
  bytes.writeUInt16LE(subsystem, 64 + 24 + 68)
  return bytes
}
function install(cli: WindowsDesktopCli, layout: 'resources' | 'root' = 'resources') {
  const root = join(temporaryRoot(), '自定义 工具', cli === 'zcode' ? '编辑器' : '客户端')
  mkdirSync(root, { recursive: true })
  const entry = cli === 'zcode'
    ? put(join(root, 'resources', 'glm', 'zcode.cjs'), '// Synthetic CLI; never executed.\n')
    : put(join(root, ...(layout === 'resources' ? ['resources'] : []), 'opencode-cli.exe'), syntheticPe())
  const provider = cli === 'zcode'
    ? put(join(root, 'resources', 'config', 'provider', 'zcode-builtin.json'), '{"synthetic":true}')
    : undefined
  return { root, entry, provider }
}
const metadata = (records: unknown[], changes: Record<string, unknown> = {}) =>
  JSON.stringify({ schema: 1, complete: true, records, ...changes })
const location = (cli: WindowsDesktopCli, root: string) => ({ cli, source: 'uninstall-location', root })
const target = (cli: WindowsDesktopCli, source: string, entry: string) => ({ cli, source, target: entry })

function syntheticWindowsFiles() {
  const directories = new Map<string, string>()
  const ordinary = new Map<string, string>()
  const pe = new Map<string, string>()
  const key = (entry: string) => win32.normalize(entry).toLowerCase()
  const files: NonNullable<WindowsDesktopOptions['files']> = {
    directory: vi.fn((entry: string) => directories.get(key(entry))),
    ordinaryFile: vi.fn((entry: string) => ordinary.get(key(entry))),
    peFile: vi.fn((entry: string) => pe.get(key(entry))),
  }
  const add = (cli: WindowsDesktopCli, root: string, layout: 'resources' | 'root' = 'resources') => {
    directories.set(key(root), root)
    const entry = cli === 'zcode'
      ? win32.join(root, 'resources', 'glm', 'zcode.cjs')
      : win32.join(root, ...(layout === 'resources' ? ['resources'] : []), 'opencode-cli.exe')
    ordinary.set(key(entry), entry)
    if (cli === 'opencode') pe.set(key(entry), entry)
    else {
      const provider = win32.join(root, 'resources', 'config', 'provider', 'zcode-builtin.json')
      ordinary.set(key(provider), provider)
    }
    return entry
  }
  return { files, options: { path: win32, files }, directories, ordinary, pe, key, add }
}

describe('synthetic Windows Desktop metadata and custom installation discovery', () => {
  it.each(['zcode', 'opencode'] as const)('finds %s from registry InstallLocation alone without DisplayIcon or shortcuts', (cli) => {
    const fixture = syntheticWindowsFiles()
    const root = 'E:\\自定义 应用\\产品任意目录'
    const entry = fixture.add(cli, root)
    expect(windowsDesktopCliFromMetadata(cli, metadata([location(cli, root)]), fixture.options)).toBe(entry)
  })

  it.each([
    ['zcode', 'C:\\Users\\synthetic user\\AppData\\Local\\Programs\\ZCode'],
    ['zcode', 'C:\\Program Files\\ZCode'],
    ['opencode', 'C:\\Users\\synthetic user\\AppData\\Local\\Programs\\@opencodedesktop\\OpenCode'],
    ['opencode', 'C:\\Users\\synthetic user\\AppData\\Local\\OpenCode'],
    ['opencode', 'C:\\Program Files\\OpenCode'],
  ] as const)('finds %s from the default location alone at %s without registry or shortcuts', (cli, root) => {
    const fixture = syntheticWindowsFiles()
    const entry = fixture.add(cli, root)
    expect(windowsDesktopCliFromMetadata(cli, metadata([
      { cli, source: 'default-location', root },
    ]), fixture.options)).toBe(entry)
  })

  it.each([
    ['zcode', 'ZCode.exe'],
    ['opencode', 'OpenCode.exe'],
    ['opencode', 'OpenCode Beta.exe'],
    ['opencode', 'OpenCode-Dev.exe'],
    ['opencode', 'OpenCode Desktop.exe'],
  ] as const)('finds %s from an already running %s path alone without any registration or shortcut', (cli, name) => {
    const fixture = syntheticWindowsFiles()
    const root = 'G:\\自定义 用户应用\\没有注册表或快捷方式'
    const entry = fixture.add(cli, root)
    expect(windowsDesktopCliFromMetadata(cli, metadata([
      target(cli, 'running-process', win32.join(root, name)),
    ]), fixture.options)).toBe(entry)
  })

  it.each(['zcode', 'opencode'] as const)('does not scan or guess an arbitrary %s folder when every discovery source is absent', (cli) => {
    const fixture = syntheticWindowsFiles()
    fixture.add(cli, 'H:\\不可发现的便携文件夹\\未运行应用')
    expect(windowsDesktopCliFromMetadata(cli, metadata([]), fixture.options)).toBeUndefined()
    expect(fixture.files.directory).not.toHaveBeenCalled()
    expect(fixture.files.ordinaryFile).not.toHaveBeenCalled()
    expect(fixture.files.peFile).not.toHaveBeenCalled()
  })

  it('deduplicates the same CLI found through defaults, a running process and registry metadata', () => {
    const fixture = syntheticWindowsFiles()
    const root = 'C:\\Program Files\\OpenCode'
    const entry = fixture.add('opencode', root)
    expect(windowsDesktopCliFromMetadata('opencode', metadata([
      { cli: 'opencode', source: 'default-location', root },
      target('opencode', 'running-process', win32.join(root, 'OpenCode.exe')),
      location('opencode', root),
    ]), fixture.options)).toBe(entry)
  })

  it.each([
    ['zcode', 'uninstall-icon', 'uninstallerIcon.ico'],
    ['zcode', 'uninstall-icon', 'ZCode.exe'],
    ['zcode', 'app-path', 'ZCode.exe'],
    ['zcode', 'shortcut', 'ZCode.exe'],
    ['opencode', 'uninstall-icon', 'uninstallerIcon.ico'],
    ['opencode', 'uninstall-icon', 'OpenCode.exe'],
    ['opencode', 'app-path', 'OpenCode.exe'],
    ['opencode', 'shortcut', 'OpenCode Beta.exe'],
  ] as const)('finds %s from %s with %s when InstallLocation is empty', (cli, source, name) => {
    const fixture = syntheticWindowsFiles()
    const root = 'F:\\中文 空格\\任意安装目录'
    const entry = fixture.add(cli, root)
    const file = win32.join(root, name)
    // DisplayIcon can include a quoted EXE/ICO plus an icon index.
    const value = source === 'uninstall-icon' ? `"${file}",-7` : file
    expect(windowsDesktopCliFromMetadata(cli, metadata([target(cli, source, value)]), fixture.options)).toBe(entry)
  })

  it('deduplicates 32/64-bit registration, casing differences, icons and shortcuts', () => {
    const fixture = syntheticWindowsFiles()
    const root = 'E:\\中文 软件\\ZCode'
    const entry = fixture.add('zcode', root)
    const records = [
      location('zcode', root),
      location('zcode', root.toLowerCase()),
      target('zcode', 'uninstall-icon', `"${root}\\uninstallerIcon.ico",0`),
      target('zcode', 'shortcut', `${root}\\ZCode.exe`),
      target('zcode', 'app-path', `${root}\\ZCode.exe`),
    ]
    expect(windowsDesktopCliFromMetadata('zcode', metadata(records), fixture.options)).toBe(entry)
  })

  it.each(['zcode', 'opencode'] as const)('rejects multiple different usable %s installations without exposing their paths', (cli) => {
    const first = install(cli), second = install(cli)
    const raw = metadata([location(cli, first.root), location(cli, second.root)])
    let failure: unknown
    try { windowsDesktopCliFromMetadata(cli, raw, nativeOptions) } catch (error) { failure = error }
    expect(failure).toBeInstanceOf(WindowsCliInstallationError)
    expect(failure).toMatchObject({ code: 'CLI_INSTALLATION_UNAVAILABLE', installed: false })
    expect((failure as Error).message).toContain('多个可用安装')
    expect((failure as Error).message).toContain(`${cli}Executable`)
    expect((failure as Error).message).not.toContain(first.root)
    expect((failure as Error).message).not.toContain(second.root)
  })

  it('uses the one complete installation despite stale or incomplete sibling registrations', () => {
    const good = install('zcode'), broken = install('zcode')
    rmSync(broken.provider!)
    const stale = join(temporaryRoot(), '已经删除的安装')
    expect(windowsDesktopCliFromMetadata('zcode', metadata([
      location('zcode', stale), location('zcode', broken.root), location('zcode', good.root),
    ]), nativeOptions)).toBe(good.entry)
  })

  it('keeps an unreadable installation failure visible even beside a valid installation', () => {
    const fixture = syntheticWindowsFiles()
    const root = 'D:\\完整安装', deniedRoot = 'E:\\没有读取权限'
    fixture.add('zcode', root)
    vi.mocked(fixture.files.directory).mockImplementation((entry) => {
      if (entry === deniedRoot) throw Object.assign(new Error(`synthetic denied ${deniedRoot}`), { code: 'EACCES' })
      return fixture.directories.get(fixture.key(entry))
    })
    expect(() => windowsDesktopCliFromMetadata('zcode', metadata([
      location('zcode', deniedRoot), location('zcode', root),
    ]), fixture.options)).toThrow('探测失败')
  })

  it('returns no entry for complete empty metadata and missing stale locations', () => {
    expect(windowsDesktopCliFromMetadata('zcode', metadata([]))).toBeUndefined()
    expect(windowsDesktopCliFromMetadata('opencode', metadata([
      location('opencode', 'E:\\已经卸载'),
    ]), syntheticWindowsFiles().options)).toBeUndefined()
  })

  it('does not infer a ZCode entry from an unrelated OpenCode record', () => {
    const fixture = syntheticWindowsFiles()
    fixture.add('opencode', 'E:\\软件\\OpenCode')
    expect(windowsDesktopCliFromMetadata('zcode', metadata([
      location('opencode', 'E:\\软件\\OpenCode'),
    ]), fixture.options)).toBeUndefined()
    expect(fixture.files.directory).not.toHaveBeenCalled()
  })

  it.each(['cli', 'provider'] as const)('requires both ZCode CLI and provider when the %s is missing', (missing) => {
    const fixture = install('zcode')
    rmSync(missing === 'cli' ? fixture.entry : fixture.provider!)
    expect(() => windowsDesktopCliFromMetadata('zcode', metadata([
      location('zcode', fixture.root),
    ]), nativeOptions)).toThrow('配套文件不可用')
  })

  it('rejects canonical ZCode files redirected outside the recorded installation', () => {
    const fixture = syntheticWindowsFiles(), root = 'E:\\自定义 ZCode'
    const entry = fixture.add('zcode', root)
    fixture.ordinary.set(fixture.key(entry), 'F:\\另一个安装\\resources\\glm\\zcode.cjs')
    expect(() => windowsDesktopCliFromMetadata('zcode', metadata([
      location('zcode', root),
    ]), fixture.options)).toThrow('配套文件不可用')
  })
})

describe('synthetic metadata validation and privacy boundary', () => {
  it.each([
    ['incomplete', metadata([], { complete: false })],
    ['wrong schema', metadata([], { schema: 2 })],
    ['invalid JSON', 'SYNTHETIC PRIVATE PATH E:\\私有\\broken'],
    ['not an object', 'null'],
    ['missing records', '{"schema":1,"complete":true}'],
    ['too many records', metadata(Array.from({ length: 129 }, () => location('zcode', 'E:\\zcode')))],
    ['too many UTF-8 bytes', metadata([], { extra: '中'.repeat(23000) })],
    ['unknown product', metadata([{ cli: 'other', source: 'uninstall-location', root: 'E:\\tool' }])],
    ['unknown source', metadata([{ cli: 'zcode', source: 'execute-command', root: 'E:\\tool' }])],
    ['extra command property', metadata([{ ...location('zcode', 'E:\\tool'), command: 'synthetic PRIVATE command' }])],
    ['both root and target', metadata([{ ...location('zcode', 'E:\\tool'), target: 'E:\\tool\\ZCode.exe' }])],
    ['target used as location', metadata([target('zcode', 'uninstall-location', 'E:\\tool\\ZCode.exe')])],
    ['target used as default location', metadata([target('zcode', 'default-location', 'E:\\tool\\ZCode.exe')])],
    ['root used as running process', metadata([{ cli: 'zcode', source: 'running-process', root: 'E:\\tool' }])],
  ])('rejects %s as a safe discovery failure', (_name, raw) => {
    const fixture = syntheticWindowsFiles()
    expect(() => windowsDesktopCliFromMetadata('zcode', raw, fixture.options)).toThrow(
      'ZCode 桌面安装信息探测失败，请配置 zcodeExecutable',
    )
    expect(fixture.files.directory).not.toHaveBeenCalled()
  })

  it.each([
    'relative\\ZCode', 'E:relative\\ZCode', '\\\\server\\share\\ZCode', '\\\\?\\E:\\ZCode',
    '\\\\.\\pipe\\ZCode', '\\rooted\\ZCode', 'E:\\tool\\..\\ZCode', 'E:\\tool\nZCode',
    'E:\\tool\u0000ZCode', 'E:\\tool"ZCode', `E:\\${'a'.repeat(2050)}`,
  ])('rejects unsafe synthetic Windows metadata path %j', (root) => {
    const fixture = syntheticWindowsFiles()
    expect(() => windowsDesktopCliFromMetadata('zcode', metadata([
      location('zcode', root),
    ]), fixture.options)).toThrow('探测失败')
    expect(fixture.files.directory).not.toHaveBeenCalled()
  })

  it.each([
    ['shortcut', 'E:\\tool\\other.exe'],
    ['shortcut', 'E:\\tool\\ZCode.exe --run-private-command'],
    ['app-path', 'E:\\tool\\ZCode.cmd'],
    ['uninstall-icon', 'E:\\tool\\uninstaller.ps1'],
    ['running-process', 'E:\\tool\\ZCode-updater.exe'],
    ['running-process', 'E:\\tool\\ZCode.exe --synthetic-command'],
  ])('does not execute or adopt %s metadata containing %j', (source, value) => {
    expect(() => windowsDesktopCliFromMetadata('zcode', metadata([
      target('zcode', source, value),
    ]), syntheticWindowsFiles().options)).toThrow('探测失败')
  })

  it('accepts a UTF-8 BOM and whitespace around completed JSON', () => {
    expect(windowsDesktopCliFromMetadata('zcode', `\uFEFF  ${metadata([])}\r\n`)).toBeUndefined()
  })
})

describe('synthetic OpenCode CLI file and Desktop GUI distinction', () => {
  it.each(['resources', 'root'] as const)('validates the independent %s CLI using real file and PE reads', (layout) => {
    const fixture = install('opencode', layout)
    put(join(fixture.root, 'OpenCode.exe'), syntheticPe(2))
    expect(windowsDesktopCliFromMetadata('opencode', metadata([
      location('opencode', fixture.root),
    ]), nativeOptions)).toBe(fixture.entry)
  })

  it.each(['resources', 'root'] as const)('accepts and deduplicates direct %s CLI App Paths/shortcut targets', (layout) => {
    const fixture = install('opencode', layout)
    expect(windowsDesktopCliFromMetadata('opencode', metadata([
      target('opencode', 'app-path', fixture.entry),
      target('opencode', 'shortcut', fixture.entry),
      location('opencode', fixture.root),
    ]), nativeOptions)).toBe(fixture.entry)
  })

  it('rejects a direct OpenCode CLI whose canonical target escapes its installation', () => {
    const fixture = syntheticWindowsFiles(), root = 'E:\\正常 OpenCode'
    const entry = fixture.add('opencode', root)
    fixture.pe.set(fixture.key(entry), 'F:\\另一个安装\\opencode-cli.exe')
    expect(() => windowsDesktopCliFromMetadata('opencode', metadata([
      target('opencode', 'app-path', entry),
    ]), fixture.options)).toThrow('重定向')
  })

  it.each(['empty', 'text', 'truncated', 'bad-offset', 'bad-signature', 'directory'] as const)(
    'rejects a %s OpenCode executable rather than treating its name as proof', (kind) => {
      const fixture = install('opencode')
      if (kind === 'directory') { rmSync(fixture.entry); mkdirSync(fixture.entry) }
      else {
        const bytes = syntheticPe()
        if (kind === 'bad-offset') bytes.writeUInt32LE(5000, 0x3c)
        if (kind === 'bad-signature') bytes.write('FAIL', 64)
        let contents: string | Buffer = bytes
        if (kind === 'empty') contents = ''
        if (kind === 'text') contents = 'Synthetic non-PE program; never executed.'
        if (kind === 'truncated') contents = Buffer.from('MZ')
        writeFileSync(fixture.entry, contents)
      }
      expect(() => windowsDesktopCliFromMetadata('opencode', metadata([
        location('opencode', fixture.root),
      ]), nativeOptions)).toThrow(WindowsCliInstallationError)
    },
  )

  it('reports a desktop-only installation without ever selecting the GUI', () => {
    const fixture = install('opencode')
    rmSync(fixture.entry)
    const gui = put(join(fixture.root, 'OpenCode.exe'), syntheticPe(2))
    expect(() => windowsDesktopCliFromMetadata('opencode', metadata([
      target('opencode', 'shortcut', gui),
    ]), nativeOptions)).toThrow('桌面已存在，但没有可用独立 CLI')
  })

  it.each(['OpenCode.exe', 'OpenCode Beta.exe', 'OpenCode Dev.exe', 'OpenCode Desktop.exe'])(
    'resolves the independent CLI beside a packaged %s GUI', (name) => {
      const fixture = install('opencode')
      const gui = put(join(fixture.root, name), syntheticPe(2))
      put(join(fixture.root, 'resources', 'app.asar'), 'Synthetic packaged desktop marker')
      expect(windowsOpenCodeDesktopCli(gui, false, nativeOptions)).toBe(fixture.entry)
    },
  )

  it('reports an explicitly configured Desktop GUI instead of silently replacing it', () => {
    const fixture = install('opencode')
    const gui = put(join(fixture.root, 'OpenCode.exe'), syntheticPe(2))
    put(join(fixture.root, 'resources', 'app.asar'), 'Synthetic packaged desktop marker')
    expect(() => windowsOpenCodeDesktopCli(gui, true, nativeOptions)).toThrow('执行路径指向桌面主程序')
  })

  it('recognizes a legacy GUI by its PE subsystem and uses only its adjacent CLI', () => {
    const fixture = install('opencode', 'root')
    const gui = put(join(fixture.root, 'OpenCode.exe'), syntheticPe(2))
    expect(windowsOpenCodeDesktopCli(gui, false, nativeOptions)).toBe(fixture.entry)
  })

  it('reports a legacy GUI with no independent CLI instead of returning it as a command', () => {
    const fixture = install('opencode', 'root')
    rmSync(fixture.entry)
    const gui = put(join(fixture.root, 'OpenCode.exe'), syntheticPe(2))
    expect(() => windowsOpenCodeDesktopCli(gui, false, nativeOptions)).toThrow('桌面已存在，但没有可用独立 CLI')
  })

  it('keeps a native console opencode.exe unchanged even when another CLI is beside it', () => {
    const fixture = install('opencode', 'root')
    const consoleEntry = put(join(fixture.root, 'opencode.exe'), syntheticPe(3))
    expect(windowsOpenCodeDesktopCli(consoleEntry, false, nativeOptions)).toBeUndefined()
    expect(windowsOpenCodeDesktopCli(consoleEntry, true, nativeOptions)).toBeUndefined()
  })

  it('rejects ambiguity between root and resources CLIs instead of preferring one layout', () => {
    const fixture = install('opencode')
    put(join(fixture.root, 'opencode-cli.exe'), syntheticPe())
    const gui = put(join(fixture.root, 'OpenCode.exe'), syntheticPe(2))
    expect(() => windowsOpenCodeDesktopCli(gui, false, nativeOptions)).toThrow('多个可用安装')
  })
})

describe('synthetic Windows metadata capture lifecycle', () => {
  it('runs only a fixed noninteractive encoded metadata query from the Windows system directory', async () => {
    const capture = vi.fn(async () => metadata([]))
    await expect(findWindowsDesktopCli('zcode', capture, new AbortController().signal, {
      SystemRoot: 'C:\\Windows',
    })).resolves.toBeUndefined()
    const [argv, cwd] = capture.mock.calls[0] as unknown as [string[], string]
    expect(argv.slice(0, 5)).toEqual([
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand',
    ])
    expect(argv).toHaveLength(6)
    expect(cwd).toEqual(expect.any(String))
    const query = Buffer.from(argv[5], 'base64').toString('utf16le')
    expect(query).toContain('OpenBaseKey')
    expect(query).toContain('GetLink')
    expect(query).not.toMatch(/Invoke-Expression|Start-Process|\.Save\(|\.Start\(/i)
  })

  it('re-queries metadata on refresh rather than caching an earlier absence', async () => {
    const capture = vi.fn(async () => metadata([]))
    await findWindowsDesktopCli('zcode', capture, new AbortController().signal)
    await findWindowsDesktopCli('zcode', capture, new AbortController().signal)
    expect(capture).toHaveBeenCalledTimes(2)
  })

  it('does not begin a query that has already been cancelled', async () => {
    const controller = new AbortController(), capture = vi.fn(async () => metadata([]))
    const reason = new Error('synthetic cancelled before query')
    controller.abort(reason)
    await expect(findWindowsDesktopCli('zcode', capture, controller.signal)).rejects.toBe(reason)
    expect(capture).not.toHaveBeenCalled()
  })

  it('does not adopt late metadata after cancellation', async () => {
    const controller = new AbortController(), reason = new Error('synthetic cancelled during query')
    const capture = vi.fn(async () => {
      controller.abort(reason)
      // Invalid late payload would produce a discovery error if parsing resumed.
      return 'synthetic late private metadata must never be parsed'
    })
    await expect(findWindowsDesktopCli('opencode', capture, controller.signal)).rejects.toBe(reason)
  })

  it('preserves the cancellation reason when capture also rejects', async () => {
    const controller = new AbortController(), reason = new Error('synthetic cancellation')
    const capture = vi.fn(async () => {
      controller.abort(reason)
      throw new Error('synthetic capture interrupted')
    })
    await expect(findWindowsDesktopCli('zcode', capture, controller.signal)).rejects.toBe(reason)
  })

  it('preserves unconfirmed process cleanup even if cancellation is also requested', async () => {
    const controller = new AbortController(), cleanup = new ProcessCleanupUnconfirmedError()
    const capture = vi.fn(async () => { controller.abort(); throw cleanup })
    await expect(findWindowsDesktopCli('zcode', capture, controller.signal)).rejects.toBe(cleanup)
  })

  it('projects metadata process failures without exposing captured output or paths', async () => {
    const capture = vi.fn(async () => { throw new Error('synthetic private E:\\账号\\secret metadata') })
    await expect(findWindowsDesktopCli('opencode', capture, new AbortController().signal)).rejects.toThrow(
      'OpenCode 桌面安装信息探测失败，请配置 opencodeExecutable',
    )
  })

  it('does not launch a query with an unsafe Windows system root', async () => {
    const capture = vi.fn(async () => metadata([]))
    await expect(findWindowsDesktopCli('zcode', capture, new AbortController().signal, {
      SystemRoot: '\\\\remote\\Windows',
    })).rejects.toThrow('探测失败')
    expect(capture).not.toHaveBeenCalled()
  })
})
