import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path, { dirname, join } from 'node:path'

// Synthetic Electron filesystem semantics only: no Electron, installed CLI,
// desktop application, registry, account, or model is started or queried.
const filesystem = vi.hoisted(() => ({
  archive: '',
  originalRequests: 0,
  unavailableOriginal: false,
  physicalFailure: undefined as { operation: 'access' | 'read'; code: string } | undefined,
}))

vi.mock('node:fs', async (load) => {
  const physical = await load<typeof import('node:fs')>()
  return {
    ...physical,
    statSync: (...args: Parameters<typeof physical.statSync>) => {
      if (process.versions.electron && String(args[0]) === filesystem.archive) {
        // Electron can reject a missing archive without an errno code, while
        // a real archive is exposed as a zero-size virtual directory.
        if (!physical.existsSync(args[0])) throw new Error('Invalid package')
        const info = physical.statSync(...args)
        return Object.assign(Object.create(Object.getPrototypeOf(info)), info, {
          size: 0,
          isFile: () => false,
          isDirectory: () => true,
        })
      }
      return physical.statSync(...args)
    },
  }
})

vi.mock('node:module', async (load) => {
  const native = await load<typeof import('node:module')>()
  const physical = await vi.importActual<typeof import('node:fs')>('node:fs')
  const fail = (operation: 'access' | 'read') => {
    if (filesystem.physicalFailure?.operation === operation)
      throw Object.assign(new Error('Synthetic physical filesystem failure'), {
        code: filesystem.physicalFailure.code,
      })
  }
  return {
    ...native,
    createRequire: (...args: Parameters<typeof native.createRequire>) => {
      const nativeRequire = native.createRequire(...args)
      return Object.assign((id: string) => {
        if (id !== 'original-fs') return nativeRequire(id)
        filesystem.originalRequests++
        if (filesystem.unavailableOriginal)
          throw Object.assign(new Error('Synthetic original-fs unavailable'), { code: 'MODULE_NOT_FOUND' })
        return {
          ...physical,
          accessSync: (...values: Parameters<typeof physical.accessSync>) => {
            fail('access')
            return physical.accessSync(...values)
          },
          readSync: (...values: Parameters<typeof physical.readSync>) => {
            fail('read')
            return physical.readSync(...values)
          },
        }
      }, nativeRequire)
    },
  }
})

const roots: string[] = []
const electronDescriptor = Object.getOwnPropertyDescriptor(process.versions, 'electron')
const noAsarDescriptor = Object.getOwnPropertyDescriptor(process, 'noAsar')
const nativeOptions = { path }
beforeEach(() => {
  vi.resetModules()
  filesystem.archive = ''
  filesystem.originalRequests = 0
  filesystem.unavailableOriginal = false
  filesystem.physicalFailure = undefined
  Object.defineProperty(process.versions, 'electron', { configurable: true, value: 'synthetic-electron' })
})
afterEach(() => {
  try {
    expect(Object.getOwnPropertyDescriptor(process, 'noAsar')).toEqual(noAsarDescriptor)
  } finally {
    if (electronDescriptor) Object.defineProperty(process.versions, 'electron', electronDescriptor)
    else delete process.versions.electron
    filesystem.physicalFailure = undefined
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  }
})

function put(file: string, data: Buffer | string): string {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, data)
  return file
}
function syntheticPe(subsystem: 2 | 3): Buffer {
  const data = Buffer.alloc(256)
  data.write('MZ')
  data.writeUInt32LE(64, 0x3c)
  data.write('PE\0\0', 64)
  data.writeUInt16LE(0x20b, 64 + 24)
  data.writeUInt16LE(subsystem, 64 + 24 + 68)
  return data
}
function fixture(desktop = true) {
  const temporary = realpathSync(mkdtempSync(join(tmpdir(), 'synthetic-electron-cli-')))
  roots.push(temporary)
  const root = join(temporary, '自定义 安装')
  const executable = put(join(root, 'opencode.exe'), syntheticPe(desktop ? 2 : 3))
  filesystem.archive = join(root, 'resources', 'app.asar')
  mkdirSync(dirname(filesystem.archive), { recursive: true })
  const cli = join(root, 'resources', 'opencode-cli.exe')
  if (desktop) {
    put(filesystem.archive, 'Synthetic archive marker; not an actual Electron package.')
    put(cli, syntheticPe(3))
  }
  return { executable, cli, archive: filesystem.archive }
}
const loadHelper = () => import('../src/host/windows-desktop-cli-installation.ts')

describe('synthetic Electron physical filesystem Windows CLI detection', () => {
  it.each([false, true])('preserves a console CLI with a missing ASAR marker (explicit=%s)', async (explicit) => {
    const { executable, archive } = fixture(false)
    const patched = await import('node:fs')
    let patchedError: unknown
    try { patched.statSync(archive) } catch (error) { patchedError = error }
    expect(patchedError).toMatchObject({ message: 'Invalid package' })
    expect(patchedError).not.toHaveProperty('code')
    const { windowsOpenCodeDesktopCli } = await loadHelper()
    expect(filesystem.originalRequests).toBe(0)
    expect(windowsOpenCodeDesktopCli(executable, explicit, nativeOptions)).toBeUndefined()
    expect(filesystem.originalRequests).toBeGreaterThan(0)
  })

  it('resolves the independent CLI when patched fs exposes its ASAR as a virtual directory', async () => {
    const { executable, cli, archive } = fixture()
    const patched = await import('node:fs')
    expect(patched.statSync(archive).isDirectory()).toBe(true)
    expect(patched.statSync(archive).isFile()).toBe(false)
    expect(patched.statSync(archive).size).toBe(0)
    const { windowsOpenCodeDesktopCli } = await loadHelper()
    expect(windowsOpenCodeDesktopCli(executable, false, nativeOptions)).toBe(cli)
    expect(filesystem.originalRequests).toBeGreaterThan(0)
  })

  it('still rejects an explicitly configured GUI when its physical ASAR exists', async () => {
    const { executable } = fixture()
    const { windowsOpenCodeDesktopCli } = await loadHelper()
    expect(() => windowsOpenCodeDesktopCli(executable, true, nativeOptions))
      .toThrow('执行路径指向桌面主程序')
  })

  it('reports a desktop with no companion CLI rather than accepting the GUI', async () => {
    const { executable, cli } = fixture()
    rmSync(cli)
    const { windowsOpenCodeDesktopCli } = await loadHelper()
    expect(() => windowsOpenCodeDesktopCli(executable, false, nativeOptions))
      .toThrow('桌面已存在，但没有可用独立 CLI')
  })

  it.each(['damaged PE', 'directory'] as const)('rejects a companion CLI that is a %s', async (kind) => {
    const { executable, cli } = fixture()
    if (kind === 'directory') { rmSync(cli); mkdirSync(cli) }
    else writeFileSync(cli, 'Synthetic invalid executable')
    const { windowsOpenCodeDesktopCli } = await loadHelper()
    expect(() => windowsOpenCodeDesktopCli(executable, false, nativeOptions))
      .toThrow('桌面 CLI 入口不可用')
    // A rejection must follow physical validation, not the patched ASAR error.
    expect(filesystem.originalRequests).toBeGreaterThan(0)
  })

  it.each([
    { operation: 'access', code: 'EACCES' },
    { operation: 'read', code: 'EIO' },
  ] as const)('preserves physical $code errors without falling back to patched fs', async (failure) => {
    const { executable } = fixture()
    filesystem.physicalFailure = failure
    const { windowsOpenCodeDesktopCli } = await loadHelper()
    expect(() => windowsOpenCodeDesktopCli(executable, false, nativeOptions))
      .toThrow('桌面 CLI 入口不可用')
    expect(filesystem.originalRequests).toBeGreaterThan(0)
  })

  it('reports unavailable original-fs instead of silently using patched fs', async () => {
    const { executable } = fixture(false)
    filesystem.unavailableOriginal = true
    const { windowsOpenCodeDesktopCli } = await loadHelper()
    expect(() => windowsOpenCodeDesktopCli(executable, false, nativeOptions))
      .toThrow('桌面 CLI 入口不可用')
    expect(filesystem.originalRequests).toBeGreaterThan(0)
  })

  it('uses regular Node filesystem semantics without requesting original-fs outside Electron', async () => {
    delete process.versions.electron
    const { executable, cli } = fixture()
    const { windowsOpenCodeDesktopCli } = await loadHelper()
    expect(windowsOpenCodeDesktopCli(executable, false, nativeOptions)).toBe(cli)
    expect(filesystem.originalRequests).toBe(0)
  })
})
