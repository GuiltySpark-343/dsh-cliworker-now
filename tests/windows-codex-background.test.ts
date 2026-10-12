import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PassThrough } from 'node:stream'
import type { SubprocessOutcome, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import type { ProcessBackend } from '../src/host/process.ts'
import { nativeProcessBackend } from '../src/host/native-process.ts'

// Synthetic descriptor and SDK streams only. These integration tests exercise
// the real hidden relay contract, without an installed CLI, account or window.
const descriptor = vi.hoisted(() => vi.fn<(
  argv: readonly string[],
  env: NodeJS.ProcessEnv | undefined,
  options: { platform: NodeJS.Platform },
) => { argv: string[]; env: NodeJS.ProcessEnv } | undefined>())
vi.mock('../src/host/windows-codex-launch.ts', () => ({ windowsCodexBackgroundLaunch: descriptor }))

const runtime = 'C:\\Synthetic\\Harness.exe'
const wrapper = 'C:\\Synthetic\\npm\\node_modules\\@openai\\codex\\bin\\codex.js'
const executable = 'D:\\Synthetic 中文 安装\\codex.exe'
const literal = ['app-server', '--stdio', '空格 & 参数', 'quote"', '', 'line\nnext']
const originalExecPath = Object.getOwnPropertyDescriptor(process, 'execPath')!
const cleanups: Array<() => Promise<void>> = []
beforeEach(() => {
  descriptor.mockReset().mockReturnValue(undefined)
  Object.defineProperty(process, 'execPath', { ...originalExecPath, value: runtime })
  vi.stubEnv('ELECTRON_RUN_AS_NODE', undefined)
})
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
  Object.defineProperty(process, 'execPath', originalExecPath)
  vi.unstubAllEnvs()
})

const request = (env?: NodeJS.ProcessEnv): SubprocessSpawnSpec => ({
  argv: [process.execPath, wrapper, ...literal],
  cwd: 'C:\\Synthetic\\project',
  env,
  stdio: { stdin: 'pipe', stdout: 'pipe', stderr: { maxBytes: 2048 } },
  graceMs: 500,
})
function fixture() {
  let finish!: (outcome: SubprocessOutcome) => void
  const inner = {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: undefined,
    control: new PassThrough(),
    collected: { stderr: { readFrom: vi.fn() } },
    done: new Promise<SubprocessOutcome>(resolve => { finish = resolve }),
    terminate: vi.fn(),
    waitForExit: vi.fn(async (_signal?: AbortSignal) => true),
  }
  const terminal = { syntheticTerminal: true }
  const raw = {
    resolveExecutable: vi.fn(async (_value: string) => wrapper),
    spawn: vi.fn((_spec: SubprocessSpawnSpec) => inner),
    spawnTerminal: vi.fn(async (_spec: unknown) => terminal),
  }
  cleanups.push(async () => {
    inner.control.destroy()
    inner.stdin.destroy()
    inner.stdout.destroy()
    finish({ exitCode: 0, signal: null })
    await inner.done
  })
  return { inner, raw, terminal, finish, backend: raw as unknown as ProcessBackend }
}

describe('Windows Codex background descriptor integration (synthetic)', () => {
  it('routes native argv through the existing relay while preserving environment deletion, streams and range cleanup', async () => {
    const f = fixture()
    const env = { SYNTHETIC_KEEP: 'unchanged', electron_run_as_node: undefined }
    vi.stubEnv('ELECTRON_RUN_AS_NODE', 'ambient-runtime-only')
    const selectedEnv = {
      ...env,
      Path: 'D:\\Synthetic\\vendor\\path;C:\\Synthetic\\bin',
      CODEX_MANAGED_BY_NPM: '1',
      CODEX_MANAGED_BY_BUN: undefined,
    }
    descriptor.mockReturnValue({ argv: [executable, ...literal], env: selectedEnv })
    const spec = request(env)
    const controller = new AbortController()
    const handle = nativeProcessBackend(f.backend, 'win32', { electron: true })
      .spawn({ ...spec, signal: controller.signal })

    expect(descriptor).toHaveBeenCalledExactlyOnceWith(spec.argv, env, { platform: 'win32' })
    expect(env).toEqual({ SYNTHETIC_KEEP: 'unchanged', electron_run_as_node: undefined })
    const launched = f.raw.spawn.mock.calls[0]![0]
    expect(launched.argv[0]).toBe(runtime)
    expect(launched.argv[1]).toMatch(/windows-hidden-launch\.mjs$/)
    expect(JSON.parse(launched.argv[2]!)).toEqual({ nodeEnv: null })
    expect(launched.argv.slice(3)).toEqual([executable, ...literal])
    expect(launched.env).toEqual({ ...selectedEnv, ELECTRON_RUN_AS_NODE: '1' })
    expect(Object.hasOwn(launched.env!, 'CODEX_MANAGED_BY_BUN')).toBe(true)
    expect(launched.cwd).toBe(spec.cwd)
    expect(launched.signal).toBe(controller.signal)
    expect(launched.stdio).toEqual({ ...spec.stdio, control: 'pipe' })
    expect(handle.stdin).toBe(f.inner.stdin)
    expect(handle.stdout).toBe(f.inner.stdout)
    expect(handle.collected).toBe(f.inner.collected)
    expect(handle.control).toBeUndefined()

    // The native exit is reported before the relay/descendant range exits.
    f.inner.control.end(JSON.stringify({ kind: 'exit', exitCode: 3221225477, signal: null }))
    await expect(handle.done).resolves.toEqual({ exitCode: 3221225477, signal: null })
    f.inner.waitForExit.mockResolvedValueOnce(false)
    await expect(handle.waitForExit(controller.signal)).resolves.toBe(false)
    expect(f.inner.waitForExit).toHaveBeenCalledWith(controller.signal)
    handle.terminate()
    expect(f.inner.terminate).toHaveBeenCalledOnce()
    f.finish({ exitCode: 1, signal: null })
    await expect(handle.waitForExit()).resolves.toBe(true)
  })

  it.each([undefined, 'explicit-original-value'])('does not inject helper Node mode into the native target (original=%s)', async (original) => {
    const f = fixture()
    const env = original === undefined ? {} : { ELECTRON_RUN_AS_NODE: original }
    descriptor.mockImplementation((_argv, supplied) => ({ argv: [executable, ...literal], env: { ...supplied } }))
    const handle = nativeProcessBackend(f.backend, 'win32', { electron: true }).spawn(request(env))
    expect(descriptor.mock.calls[0]![1]).toEqual(env)
    const launched = f.raw.spawn.mock.calls[0]![0]
    expect(JSON.parse(launched.argv[2]!)).toEqual({ nodeEnv: original ?? null })
    expect(launched.env?.ELECTRON_RUN_AS_NODE).toBe('1')
    f.inner.control.end(JSON.stringify({ kind: 'exit', exitCode: 0, signal: null }))
    f.finish({ exitCode: 0, signal: null })
    await expect(handle.done).resolves.toEqual({ exitCode: 0, signal: null })
  })

  it('keeps the wrapper and original terminal contract without consulting the background descriptor', async () => {
    const f = fixture()
    const spec = {
      argv: [runtime, wrapper, 'login'], cwd: 'C:\\Synthetic\\project',
      env: { SYNTHETIC_KEEP: 'terminal' }, rows: 24, cols: 80, terminalType: 'xterm', graceMs: 500,
    }
    const backend = nativeProcessBackend(f.backend, 'win32', { electron: true })
    await expect(backend.spawnTerminal!(spec)).resolves.toBe(f.terminal)
    expect(descriptor).not.toHaveBeenCalled()
    expect(f.raw.spawn).not.toHaveBeenCalled()
    expect(f.raw.spawnTerminal).toHaveBeenCalledExactlyOnceWith({
      ...spec, env: { ...spec.env, ELECTRON_RUN_AS_NODE: '1' },
    })
  })

  it('preserves the resolved wrapper path used for persistence instead of replacing it with the native target', async () => {
    const f = fixture()
    descriptor.mockReturnValue({ argv: [executable], env: {} })
    const backend = nativeProcessBackend(f.backend, 'win32', { electron: true })
    await expect(backend.resolveExecutable('codex')).resolves.toBe(wrapper)
    expect(f.raw.resolveExecutable).toHaveBeenCalledExactlyOnceWith('codex')
    expect(descriptor).not.toHaveBeenCalled()
    expect(f.raw.spawn).not.toHaveBeenCalled()
  })

  it('does not consult the Windows descriptor on macOS', () => {
    const f = fixture()
    Object.defineProperty(process, 'execPath', originalExecPath)
    const spec = request({ SYNTHETIC_KEEP: 'mac' })
    const handle = nativeProcessBackend(f.backend, 'darwin', { electron: true }).spawn(spec)
    expect(descriptor).not.toHaveBeenCalled()
    expect(handle).toBe(f.inner)
    expect(f.raw.spawn).toHaveBeenCalledExactlyOnceWith({
      ...spec, env: { ...spec.env, ELECTRON_RUN_AS_NODE: '1' },
    })
  })

  it('keeps an unknown wrapper on its existing GUI runtime path when no descriptor is available', () => {
    const f = fixture()
    descriptor.mockReturnValue(undefined)
    const spec = request({ SYNTHETIC_KEEP: 'unknown-wrapper' })
    const handle = nativeProcessBackend(f.backend, 'win32', { electron: true }).spawn(spec)
    expect(descriptor).toHaveBeenCalledOnce()
    expect(handle).toBe(f.inner)
    expect(f.raw.spawn).toHaveBeenCalledExactlyOnceWith({
      ...spec, env: { ...spec.env, ELECTRON_RUN_AS_NODE: '1' },
    })
    expect(f.raw.spawn.mock.calls[0]![0].stdio.control).toBeUndefined()
  })

  it('does not launch another target when descriptor validation throws', () => {
    const f = fixture()
    const error = new Error('Synthetic invalid installation')
    descriptor.mockImplementation(() => { throw error })
    expect(() => nativeProcessBackend(f.backend, 'win32', { electron: true }).spawn(request()))
      .toThrow(error)
    expect(f.raw.spawn).not.toHaveBeenCalled()
    expect(f.raw.spawnTerminal).not.toHaveBeenCalled()
  })

  it.each(['terminate', 'abort'] as const)('preserves SDK cancellation and confirmed range cleanup on %s', async (method) => {
    const f = fixture(), controller = new AbortController()
    descriptor.mockReturnValue({ argv: [executable, ...literal], env: {} })
    const handle = nativeProcessBackend(f.backend, 'win32', { electron: true })
      .spawn({ ...request(), signal: controller.signal })
    expect(f.raw.spawn.mock.calls[0]![0].signal).toBe(controller.signal)
    if (method === 'terminate') handle.terminate()
    else { controller.abort(); f.inner.control.destroy() }
    f.finish({ exitCode: 1, signal: null })
    await expect(handle.done).resolves.toEqual({ exitCode: 1, signal: null })
    await expect(handle.waitForExit()).resolves.toBe(true)
    expect(f.inner.waitForExit).toHaveBeenCalledOnce()
    if (method === 'terminate') expect(f.inner.terminate).toHaveBeenCalledOnce()
  })
})
