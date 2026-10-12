import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { PassThrough } from 'node:stream'
import { SubprocessExecutableNotFoundError } from '@deepseek-ai/dsh-subprocess'
import { DEFAULT_CONFIG, ProcessCleanupUnconfirmedError, type ProcessBackend } from '../src/host/process.ts'
import { executableFor, resolveCliExecutable } from '../src/host/adapters.ts'
import { findWindowsCodexAppx } from '../src/host/windows-cli-installation.ts'
import { managedZCodeEntry } from '../src/host/zcode-adapter.ts'
import {
  findWindowsDesktopCli,
  windowsOpenCodeDesktopCli,
} from '../src/host/windows-desktop-cli-installation.ts'

const state = vi.hoisted(() => ({ home: '' }))
vi.mock('node:os', async (actual) => ({
  ...(await actual<typeof import('node:os')>()),
  homedir: () => state.home,
}))
vi.mock('../src/host/windows-cli-installation.ts', async (actual) => ({
  ...(await actual<typeof import('../src/host/windows-cli-installation.ts')>()),
  findWindowsCodexAppx: vi.fn(),
}))
vi.mock('../src/host/windows-desktop-cli-installation.ts', async (actual) => ({
  ...(await actual<typeof import('../src/host/windows-desktop-cli-installation.ts')>()),
  findWindowsDesktopCli: vi.fn(),
  windowsOpenCodeDesktopCli: vi.fn(),
}))

// Synthetic lookup failures use the actual SDK error class; it intentionally has no ENOENT code.
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
const appx = vi.mocked(findWindowsCodexAppx)
const desktop = vi.mocked(findWindowsDesktopCli)
const desktopGui = vi.mocked(windowsOpenCodeDesktopCli)
beforeEach(() => {
  state.home = mkdtempSync(join(tmpdir(), 'synthetic-windows-resolution-'))
  vi.stubEnv('APPDATA', join(state.home, 'Roaming'))
  vi.stubEnv('LOCALAPPDATA', join(state.home, 'Local'))
  vi.stubEnv('ProgramFiles', join(state.home, 'Programs'))
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
  appx.mockReset()
  desktop.mockReset()
  desktopGui.mockReset()
})
afterEach(() => {
  Object.defineProperty(process, 'platform', platform)
  vi.unstubAllEnvs()
  rmSync(state.home, { recursive: true, force: true })
})
function backend(resolve: (entry: string) => Promise<string>): ProcessBackend {
  return {
    resolveExecutable: vi.fn(resolve),
    spawn: () => {
      throw new Error('Unexpected process spawn')
    },
  }
}

describe('Windows default executable fallback without changing other platforms', () => {
  it.each(['win32', 'darwin'] as const)(
    'prefers a deployed managed ZCode runtime on %s while preserving explicit custom paths',
    async (target) => {
      Object.defineProperty(process, 'platform', { ...platform, value: target })
      const managed = managedZCodeEntry(),
        bundled = join(state.home, 'Local/Programs/ZCode/resources/glm/zcode.cjs')
      for (const entry of [managed, bundled]) {
        mkdirSync(dirname(entry), { recursive: true })
        writeFileSync(entry, '// Synthetic installation entry; never executed.\n')
      }
      const lookup = backend(async (entry) => entry)
      expect(executableFor('zcode', DEFAULT_CONFIG)).toBe(managed)
      expect(executableFor('zcode', { ...DEFAULT_CONFIG, zcodeExecutable: 'zcode' })).toBe(managed)
      await expect(resolveCliExecutable('zcode', lookup, DEFAULT_CONFIG)).resolves.toBe(managed)
      expect(lookup.resolveExecutable).not.toHaveBeenCalled()
      const custom = join(state.home, 'custom/zcode.cjs')
      expect(executableFor('zcode', { ...DEFAULT_CONFIG, zcodeExecutable: custom })).toBe(custom)
      const missing = new SubprocessExecutableNotFoundError('synthetic missing explicit ZCode')
      await expect(
        resolveCliExecutable(
          'zcode',
          backend(async () => {
            throw missing
          }),
          {
            ...DEFAULT_CONFIG,
            zcodeExecutable: custom,
          },
        ),
      ).rejects.toBe(missing)
    },
  )
  it('falls back to the Windows Desktop bundle or PATH only when managed ZCode is absent', async () => {
    const bundled = join(state.home, 'Local/Programs/ZCode/resources/glm/zcode.cjs')
    mkdirSync(dirname(bundled), { recursive: true })
    writeFileSync(bundled, '// Synthetic bundled CLI; never executed.\n')
    expect(executableFor('zcode', DEFAULT_CONFIG)).toBe(bundled)
    await expect(
      resolveCliExecutable(
        'zcode',
        backend(async (entry) => entry),
        DEFAULT_CONFIG,
      ),
    ).resolves.toBe(bundled)
    rmSync(bundled)
    expect(executableFor('zcode', DEFAULT_CONFIG)).toBe('zcode')
    const missing = new SubprocessExecutableNotFoundError('synthetic no native ZCode installation')
    await expect(
      resolveCliExecutable(
        'zcode',
        backend(async () => {
          throw missing
        }),
        DEFAULT_CONFIG,
      ),
    ).rejects.toThrow('ZCode CLI 未找到')
    expect(desktop).toHaveBeenCalledOnce()
  })
  it('rejects a broken managed ZCode installation instead of silently switching runtimes', async () => {
    const managed = managedZCodeEntry(),
      bundled = join(state.home, 'Local/Programs/ZCode/resources/glm/zcode.cjs')
    mkdirSync(managed, { recursive: true })
    mkdirSync(dirname(bundled), { recursive: true })
    writeFileSync(bundled, '// Synthetic bundled CLI; never executed.\n')
    await expect(
      resolveCliExecutable(
        'zcode',
        backend(async (entry) => entry),
        DEFAULT_CONFIG,
      ),
    ).rejects.toThrow('CLI 脚本路径不是普通文件')
  })
  it('discovers the registered Codex CLI after the real SDK missing-executable error', async () => {
    appx.mockResolvedValue('C:\\registered\\codex.exe')
    const process = backend(async (entry) => {
      if (entry === 'codex') throw new SubprocessExecutableNotFoundError('synthetic missing PATH')
      return entry
    })
    await expect(resolveCliExecutable('codex', process, DEFAULT_CONFIG)).resolves.toBe(
      'C:\\registered\\codex.exe',
    )
    expect(appx).toHaveBeenCalledOnce()
    expect(process.resolveExecutable).toHaveBeenLastCalledWith('C:\\registered\\codex.exe')
  })
  it('preserves explicit Codex configuration and never replaces a broken requested entry', async () => {
    const process = backend(async () => {
      throw new SubprocessExecutableNotFoundError('synthetic bad configured entry')
    })
    await expect(
      resolveCliExecutable('codex', process, { ...DEFAULT_CONFIG, codexExecutable: 'C:\\custom\\codex.exe' }),
    ).rejects.toThrow('synthetic bad')
    expect(appx).not.toHaveBeenCalled()
  })
  it('preserves a working PATH entry without querying another installed account runtime', async () => {
    await expect(
      resolveCliExecutable(
        'codex',
        backend(async () => 'C:\\preferred\\codex.exe'),
        DEFAULT_CONFIG,
      ),
    ).resolves.toBe('C:\\preferred\\codex.exe')
    expect(appx).not.toHaveBeenCalled()
  })
  it('does not hide a permission or unsupported-launcher failure behind Appx fallback', async () => {
    const denied = Object.assign(new Error('synthetic denied'), { code: 'EACCES' })
    await expect(
      resolveCliExecutable(
        'codex',
        backend(async () => {
          throw denied
        }),
        DEFAULT_CONFIG,
      ),
    ).rejects.toBe(denied)
    expect(appx).not.toHaveBeenCalled()
  })
  it('retains missing status when neither PATH nor a registered Codex package exists', async () => {
    const missing = new SubprocessExecutableNotFoundError('synthetic missing')
    appx.mockResolvedValue(undefined)
    await expect(
      resolveCliExecutable(
        'codex',
        backend(async () => {
          throw missing
        }),
        DEFAULT_CONFIG,
      ),
    ).rejects.toBe(missing)
  })
  it('reports Hermes incomplete installation evidence without inventing a CLI version or launching an installer', async () => {
    mkdirSync(join(state.home, 'Local/hermes/tools/git-fixture'), { recursive: true })
    const process = backend(async () => {
      throw new SubprocessExecutableNotFoundError('synthetic missing')
    })
    await expect(resolveCliExecutable('hermes', process, DEFAULT_CONFIG)).rejects.toMatchObject({
      code: 'CLI_INSTALLATION_UNAVAILABLE',
      installed: false,
      message: '检测到 Hermes 安装目录，但未找到可用 CLI 入口，请完成安装或配置已有入口',
    })
    expect(appx).not.toHaveBeenCalled()
  })
  it('does not consult Windows installers or install residue on macOS', async () => {
    Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' })
    mkdirSync(join(state.home, 'Local/hermes/tools'), { recursive: true })
    expect(executableFor('codex', DEFAULT_CONFIG)).toBe('codex')
    const missing = new SubprocessExecutableNotFoundError('synthetic missing')
    await expect(
      resolveCliExecutable(
        'codex',
        backend(async () => {
          throw missing
        }),
        DEFAULT_CONFIG,
      ),
    ).rejects.toBe(missing)
    await expect(
      resolveCliExecutable(
        'hermes',
        backend(async () => {
          throw missing
        }),
        DEFAULT_CONFIG,
      ),
    ).rejects.toBe(missing)
    expect(appx).not.toHaveBeenCalled()
  })
  it('does not adopt a late fallback after cancellation', async () => {
    const controller = new AbortController()
    appx.mockImplementation(async () => {
      controller.abort()
      return 'C:\\registered\\codex.exe'
    })
    const process = backend(async () => {
      throw new SubprocessExecutableNotFoundError('synthetic missing')
    })
    await expect(resolveCliExecutable('codex', process, DEFAULT_CONFIG, controller.signal)).rejects.toThrow()
    expect(process.resolveExecutable).toHaveBeenCalledOnce()
  })

  it.each(['zcode', 'opencode'] as const)(
    'discovers %s from Desktop metadata after missing PATH',
    async (cli) => {
      const entry =
        cli === 'zcode'
          ? 'E:\\自定义 安装\\resources\\glm\\zcode.cjs'
          : 'D:\\OpenCode\\resources\\opencode-cli.exe'
      desktop.mockResolvedValue(entry)
      const native = backend(async (value) => {
        if (value === cli) throw new SubprocessExecutableNotFoundError('synthetic missing PATH')
        return value
      })
      await expect(resolveCliExecutable(cli, native, DEFAULT_CONFIG)).resolves.toBe(entry)
      expect(desktop).toHaveBeenCalledOnce()
      expect(native.resolveExecutable).toHaveBeenCalledTimes(cli === 'zcode' ? 1 : 2)
    },
  )

  it.each(['zcode', 'opencode'] as const)(
    'preserves explicit, working PATH and access failures for %s',
    async (cli) => {
      await expect(
        resolveCliExecutable(
          cli,
          backend(async () => 'D:\\native\\cli.exe'),
          DEFAULT_CONFIG,
        ),
      ).resolves.toBe('D:\\native\\cli.exe')
      const missing = new SubprocessExecutableNotFoundError('synthetic explicit missing')
      await expect(
        resolveCliExecutable(
          cli,
          backend(async () => {
            throw missing
          }),
          {
            ...DEFAULT_CONFIG,
            [`${cli}Executable`]: 'D:\\explicit\\cli.exe',
          },
        ),
      ).rejects.toBe(missing)
      const denied = Object.assign(new Error('synthetic denied'), { code: 'EACCES' })
      await expect(
        resolveCliExecutable(
          cli,
          backend(async () => {
            throw denied
          }),
          DEFAULT_CONFIG,
        ),
      ).rejects.toBe(denied)
      expect(desktop).not.toHaveBeenCalled()
    },
  )

  it('uses only the CLI accompanying a PATH OpenCode GUI and rejects an explicit GUI', async () => {
    const gui = 'D:\\Desktop\\OpenCode.exe',
      entry = 'D:\\Desktop\\resources\\opencode-cli.exe'
    desktopGui.mockImplementation((_entry, explicit) => {
      if (explicit) throw new Error('执行路径指向桌面主程序')
      return entry
    })
    await expect(
      resolveCliExecutable(
        'opencode',
        backend(async () => gui),
        DEFAULT_CONFIG,
      ),
    ).resolves.toBe(entry)
    await expect(
      resolveCliExecutable(
        'opencode',
        backend(async () => gui),
        { ...DEFAULT_CONFIG, opencodeExecutable: gui },
      ),
    ).rejects.toThrow('桌面主程序')
    expect(desktop).not.toHaveBeenCalled()
  })

  it('never queries desktop metadata on macOS and rejects a late result after cancellation', async () => {
    Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' })
    const missing = new SubprocessExecutableNotFoundError('synthetic missing')
    await expect(
      resolveCliExecutable(
        'opencode',
        backend(async () => {
          throw missing
        }),
        DEFAULT_CONFIG,
      ),
    ).rejects.toBe(missing)
    expect(desktop).not.toHaveBeenCalled()
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
    const controller = new AbortController()
    desktop.mockImplementation(async () => {
      controller.abort()
      return 'D:\\cli\\opencode-cli.exe'
    })
    const native = backend(async () => {
      throw missing
    })
    await expect(
      resolveCliExecutable('opencode', native, DEFAULT_CONFIG, controller.signal),
    ).rejects.toThrow()
    expect(native.resolveExecutable).toHaveBeenCalledOnce()
  })

  it.each([
    ['codex', true],
    ['codex', false],
    ['zcode', true],
    ['zcode', false],
    ['opencode', true],
    ['opencode', false],
  ] as const)(
    'awaits %s metadata cleanup on cancellation and preserves unconfirmed exit (confirmed=%s)',
    async (cli, confirmed) => {
      const controller = new AbortController()
      const stdout = new PassThrough(),
        stderr = new PassThrough()
      let finish!: (value: { exitCode: null }) => void
      let confirmCleanup!: (value: boolean) => void
      const done = new Promise<{ exitCode: null }>((resolve) => {
        finish = resolve
      })
      const cleanup = new Promise<boolean>((resolve) => {
        confirmCleanup = resolve
      })
      const terminate = vi.fn()
      const waitForExit = vi.fn(() => cleanup)
      const process = backend(async () => {
        throw new SubprocessExecutableNotFoundError('synthetic missing PATH')
      })
      process.spawn = vi.fn((spec) => {
        spec.signal!.addEventListener(
          'abort',
          () => {
            stdout.end()
            stderr.end()
            finish({ exitCode: null })
          },
          { once: true },
        )
        return { stdout, stderr, done, terminate, waitForExit } as ReturnType<ProcessBackend['spawn']>
      })
      // Exercise the real captureCatalogMetadata lifecycle through the resolver.
      // Only Windows registration parsing is replaced; no real subprocess runs.
      const captureMetadata = async (capture: (argv: string[], cwd: string) => Promise<string>) => {
        await capture(['synthetic-appx-query'], state.home)
        return undefined
      }
      appx.mockImplementation(captureMetadata)
      desktop.mockImplementation(async (_cli, capture) => captureMetadata(capture))
      let settled = false
      const result = resolveCliExecutable(cli, process, DEFAULT_CONFIG, controller.signal).then(
        () => {
          settled = true
          return undefined
        },
        (error: unknown) => {
          settled = true
          return error
        },
      )
      await vi.waitFor(() => expect(process.spawn).toHaveBeenCalledOnce())
      const cancellation = new Error('synthetic cancelled')
      controller.abort(cancellation)
      await vi.waitFor(() => expect(waitForExit).toHaveBeenCalledOnce())
      expect(terminate).toHaveBeenCalledOnce()
      expect(settled).toBe(false)
      confirmCleanup(confirmed)
      const error = await result
      if (confirmed) expect(error).toBe(cancellation)
      else expect(error).toBeInstanceOf(ProcessCleanupUnconfirmedError)
      expect(process.resolveExecutable).toHaveBeenCalledOnce()
    },
  )
})
