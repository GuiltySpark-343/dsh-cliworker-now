import { afterEach, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prepareNativeWorker } from '../src/host/native-worker.ts'
import { DEFAULT_CONFIG } from '../src/host/process.ts'

// Simulated Windows Codex launch: the verified-wrapper descriptor is replaced by
// a stand-in that keeps the caller's env and adds the package-manager marker,
// as the real one does. No CLI, account, credential or Windows host is used.
const descriptor = vi.hoisted(() =>
  vi.fn((argv: readonly string[], env?: NodeJS.ProcessEnv) => ({
    argv: ['C:\\Synthetic\\codex.exe', ...argv.slice(2)],
    env: { ...env, CODEX_MANAGED_BY_NPM: '1' } as NodeJS.ProcessEnv,
  })),
)
vi.mock('../src/host/windows-codex-launch.ts', () => ({ windowsCodexBackgroundLaunch: descriptor }))
vi.mock('../src/host/native-launch.mjs', async (original) => ({
  ...(await original<typeof import('../src/host/native-launch.mjs')>()),
  nativeLaunchArgv: (argv: readonly string[]) => [...argv],
}))

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
const roots: string[] = []
afterEach(() => {
  Object.defineProperty(process, 'platform', platform)
  vi.unstubAllEnvs()
  descriptor.mockClear()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

it('does not copy unrelated Host secrets into the Windows Codex child environment', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cwn-windows-env-SIMULATED-')))
  roots.push(root)
  const stateDirectory = join(root, 'state')
  mkdirSync(stateDirectory, { mode: 0o700 })
  // Ambient values a Host backend would scrub before spawning.
  vi.stubEnv('SYNTHETIC_PROVIDER_API_KEY', 'simulated-key')
  vi.stubEnv('SYNTHETIC_GITHUB_TOKEN', 'simulated-token')
  vi.stubEnv('SYNTHETIC_CLIENT_SECRET', 'simulated-secret')
  vi.stubEnv('DSH_SYNTHETIC_PRIVATE', 'simulated-dsh')
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
  const launch = await prepareNativeWorker(
    {
      argv: [process.execPath, 'C:\\Synthetic\\codex.js', 'exec', '--json', '任务：\nsynthetic task'],
      env: { CODEX_HOME: 'C:\\Synthetic\\codex-home' },
    },
    {
      cli: 'codex',
      project: root,
      preference: { cli: 'codex', model: 'synthetic-model', effort: 'low' },
      mode: 'plan',
      prompt: 'synthetic task',
      stateDirectory,
    },
    DEFAULT_CONFIG,
  )
  Object.defineProperty(process, 'platform', platform)
  try {
    expect(descriptor).toHaveBeenCalledTimes(1)
    expect(descriptor.mock.calls[0]![1]).toEqual({ CODEX_HOME: 'C:\\Synthetic\\codex-home' })
    expect(launch.env).toMatchObject({ CODEX_HOME: 'C:\\Synthetic\\codex-home', CODEX_MANAGED_BY_NPM: '1' })
    const leaked = Object.keys(launch.env).filter((key) => key.startsWith('SYNTHETIC_') || key.startsWith('DSH_'))
    expect(leaked).toEqual([])
    const values = JSON.stringify(launch.env) + readFileSync(launch.argv.at(-1)!, 'utf8')
    for (const secret of ['simulated-key', 'simulated-token', 'simulated-secret', 'simulated-dsh'])
      expect(values).not.toContain(secret)
    expect(JSON.parse(readFileSync(launch.argv.at(-1)!, 'utf8')).nativeExecutable).toBe('C:\\Synthetic\\codex.exe')
  } finally {
    await launch.cleanup()
  }
})
