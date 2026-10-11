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

const state = vi.hoisted(() => ({ home: '' }))
vi.mock('node:os', async (actual) => ({
  ...(await actual<typeof import('node:os')>()),
  homedir: () => state.home,
}))
vi.mock('../src/host/windows-cli-installation.ts', async (actual) => ({
  ...(await actual<typeof import('../src/host/windows-cli-installation.ts')>()),
  findWindowsCodexAppx: vi.fn(),
}))

// Synthetic lookup failures use the actual SDK error class; it intentionally has no ENOENT code.
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
const appx = vi.mocked(findWindowsCodexAppx)
beforeEach(() => {
  state.home = mkdtempSync(join(tmpdir(), 'synthetic-windows-resolution-'))
  vi.stubEnv('APPDATA', join(state.home, 'Roaming'))
  vi.stubEnv('LOCALAPPDATA', join(state.home, 'Local'))
  vi.stubEnv('ProgramFiles', join(state.home, 'Programs'))
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
  appx.mockReset()
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
  it.each(['win32', 'darwin'] as const)('prefers a deployed managed ZCode runtime on %s while preserving explicit custom paths', async (target) => {
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
    await expect(resolveCliExecutable('zcode', backend(async () => { throw missing }), {
      ...DEFAULT_CONFIG, zcodeExecutable: custom,
    })).rejects.toBe(missing)
  })
  it('falls back to the Windows Desktop bundle or PATH only when managed ZCode is absent', async () => {
    const bundled = join(state.home, 'Local/Programs/ZCode/resources/glm/zcode.cjs')
    mkdirSync(dirname(bundled), { recursive: true })
    writeFileSync(bundled, '// Synthetic bundled CLI; never executed.\n')
    expect(executableFor('zcode', DEFAULT_CONFIG)).toBe(bundled)
    await expect(resolveCliExecutable('zcode', backend(async (entry) => entry), DEFAULT_CONFIG)).resolves.toBe(bundled)
    rmSync(bundled)
    expect(executableFor('zcode', DEFAULT_CONFIG)).toBe('zcode')
    const missing = new SubprocessExecutableNotFoundError('synthetic no native ZCode installation')
    await expect(resolveCliExecutable('zcode', backend(async () => { throw missing }), DEFAULT_CONFIG)).rejects.toBe(missing)
  })
  it('rejects a broken managed ZCode installation instead of silently switching runtimes', async () => {
    const managed = managedZCodeEntry(),
      bundled = join(state.home, 'Local/Programs/ZCode/resources/glm/zcode.cjs')
    mkdirSync(managed, { recursive: true })
    mkdirSync(dirname(bundled), { recursive: true })
    writeFileSync(bundled, '// Synthetic bundled CLI; never executed.\n')
    await expect(resolveCliExecutable('zcode', backend(async (entry) => entry), DEFAULT_CONFIG))
      .rejects.toThrow('CLI 脚本路径不是普通文件')
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

  it.each([true, false])(
    'awaits Appx metadata cleanup on cancellation and preserves unconfirmed exit (confirmed=%s)',
    async (confirmed) => {
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
      appx.mockImplementation(async (capture) => {
        await capture(['synthetic-appx-query'], state.home)
        return undefined
      })
      let settled = false
      const result = resolveCliExecutable('codex', process, DEFAULT_CONFIG, controller.signal).then(
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
