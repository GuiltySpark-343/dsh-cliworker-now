import { afterEach, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG, type ProcessBackend } from '../src/host/process.ts'
const capture = vi.hoisted(() => vi.fn())
vi.mock('../src/host/adapters.ts', () => ({ captureCatalogMetadata: capture }))
import {
  nativeAgyAccountIdentity,
  projectWindowsAgyAccount,
  readWindowsAgyAccount,
  withWindowsAgyAccountSnapshot,
} from '../src/host/agy-windows-account.ts'
import { discoverAgyAccountModels } from '../src/host/agy-models.ts'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  capture.mockReset()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
const backend = {} as ProcessBackend
const signal = () => new AbortController().signal
it('projects only safe status/email and a private stable subject digest (synthetic credential metadata)', () => {
  const result = projectWindowsAgyAccount(
    JSON.stringify({
      state: 'authenticated',
      email: 'own@example.test',
      principalHash: 'a'.repeat(64),
      access_token: 'SECRET',
      refresh_token: 'SECRET',
      profile: { token: 'SECRET' },
    }),
  )
  expect(result.identity).toEqual({
    state: 'authenticated',
    authMethod: 'oauth',
    verification: 'local',
    summary: '已登录 Antigravity',
    accountLabel: 'own@example.test',
  })
  expect(result.principalHash).toBe('a'.repeat(64))
  expect(JSON.stringify(result)).not.toContain('SECRET')
})
it.each(['unconfigured', 'unauthenticated', 'unknown', 'unavailable'])(
  'keeps %s native state without a stale principal',
  (state) => {
    const result = projectWindowsAgyAccount(
      JSON.stringify({ state, email: 'old@example.test', principalHash: 'a'.repeat(64) }),
    )
    expect(result.identity.state).toBe(state)
    expect(result.identity.accountLabel).toBeUndefined()
    expect(result.principalHash).toBeUndefined()
  },
)
it.each(['not json', 'null', '[]', '{"state":"authenticated"}'.repeat(200)])(
  'fails closed for malformed/bounded projection',
  (raw) => {
    expect(projectWindowsAgyAccount(raw).identity.state).toBe('unavailable')
  },
)
it('keeps the email label of an AGY 1.4.x credential that has no ID token subject (synthetic)', () => {
  const result = projectWindowsAgyAccount(JSON.stringify({ state: 'authenticated', email: 'own@example.test' }))
  expect(result.identity).toMatchObject({ state: 'authenticated', accountLabel: 'own@example.test' })
  expect(result.principalHash).toBeUndefined()
})
it('does not accept unsafe email or an arbitrary principal identifier', () => {
  const result = projectWindowsAgyAccount(
    JSON.stringify({ state: 'authenticated', email: '<script>@example.test', principalHash: 'SECRET' }),
  )
  expect(result.identity.accountLabel).toBeUndefined()
  expect(result.principalHash).toBeUndefined()
})
it('reads only the fixed native helper on every request and clears logout immediately', async () => {
  capture
    .mockResolvedValueOnce(JSON.stringify({ state: 'authenticated', principalHash: 'a'.repeat(64) }))
    .mockResolvedValueOnce('{"state":"unconfigured"}')
  expect((await readWindowsAgyAccount(backend, DEFAULT_CONFIG, signal())).principalHash).toBe('a'.repeat(64))
  expect((await readWindowsAgyAccount(backend, DEFAULT_CONFIG, signal())).identity.state).toBe('unconfigured')
  expect(capture).toHaveBeenCalledTimes(2)
  const argv = capture.mock.calls[0]![2]
  expect(argv.slice(1, 5)).toEqual(['-NoLogo', '-NoProfile', '-NonInteractive', '-File'])
  expect(argv[5]).toMatch(/windows-agy-account\.ps1$/)
  expect(argv.join(' ')).not.toMatch(/cmd\.exe|CredEnumerate|token/)
})
it('discards a projection returned after cancellation', async () => {
  const c = new AbortController()
  capture.mockImplementationOnce(async () => {
    c.abort()
    return '{"state":"authenticated"}'
  })
  await expect(readWindowsAgyAccount(backend, DEFAULT_CONFIG, c.signal)).rejects.toThrow()
})
it('shares only a safe projection in one operation and isolates consumer mutations', async () => {
  const current = signal()
  capture.mockResolvedValue(
    JSON.stringify({ state: 'authenticated', principalHash: 'a'.repeat(64), token: 'SECRET' }),
  )
  await withWindowsAgyAccountSnapshot(backend, DEFAULT_CONFIG, current, async () => {
    const first = await readWindowsAgyAccount(backend, DEFAULT_CONFIG, current)
    first.identity.state = 'unconfigured'
    first.principalHash = 'b'.repeat(64)
    const second = await readWindowsAgyAccount(backend, DEFAULT_CONFIG, current)
    expect(second.identity.state).toBe('authenticated')
    expect(second.principalHash).toBe('a'.repeat(64))
    expect(JSON.stringify(second)).not.toContain('SECRET')
    expect(capture).toHaveBeenCalledOnce()
  })
  await readWindowsAgyAccount(backend, DEFAULT_CONFIG, current)
  expect(capture).toHaveBeenCalledTimes(2)
})
it('never shares a projection across backend, configuration or cancellation scope', async () => {
  const current = signal()
  capture.mockResolvedValue('{"state":"unconfigured"}')
  await withWindowsAgyAccountSnapshot(backend, DEFAULT_CONFIG, current, async () => {
    await readWindowsAgyAccount(backend, DEFAULT_CONFIG, current)
    await readWindowsAgyAccount({} as ProcessBackend, DEFAULT_CONFIG, current)
    await readWindowsAgyAccount(backend, { ...DEFAULT_CONFIG }, current)
    await readWindowsAgyAccount(backend, DEFAULT_CONFIG, signal())
    await readWindowsAgyAccount(backend, DEFAULT_CONFIG, current)
  })
  expect(capture).toHaveBeenCalledTimes(4)
})
it('does not cache failures or return a cached projection after cancellation', async () => {
  const controller = new AbortController()
  const failure = new Error('Synthetic native failure')
  capture.mockRejectedValueOnce(failure).mockResolvedValue('{"state":"unconfigured"}')
  await withWindowsAgyAccountSnapshot(backend, DEFAULT_CONFIG, controller.signal, async () => {
    await expect(readWindowsAgyAccount(backend, DEFAULT_CONFIG, controller.signal)).rejects.toBe(failure)
    await readWindowsAgyAccount(backend, DEFAULT_CONFIG, controller.signal)
    controller.abort(new Error('Synthetic cancellation'))
    await expect(readWindowsAgyAccount(backend, DEFAULT_CONFIG, controller.signal)).rejects.toThrow(
      'Synthetic cancellation',
    )
  })
  expect(capture).toHaveBeenCalledTimes(2)
})
it('invalidates the scope for an async descendant that outlives its operation', async () => {
  const current = signal()
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let late!: Promise<unknown>
  capture.mockResolvedValue('{"state":"unconfigured"}')
  await withWindowsAgyAccountSnapshot(backend, DEFAULT_CONFIG, current, async () => {
    await readWindowsAgyAccount(backend, DEFAULT_CONFIG, current)
    late = gate.then(() => readWindowsAgyAccount(backend, DEFAULT_CONFIG, current))
  })
  release()
  await late
  expect(capture).toHaveBeenCalledTimes(2)
})
it('uses Windows native metadata without requiring a plaintext auth file', async () => {
  const home = await mkdtemp(join(tmpdir(), 'cwn-agy-win-'))
  roots.push(home)
  await mkdir(join(home, '.gemini/antigravity-cli'), { recursive: true })
  capture.mockResolvedValue(JSON.stringify({ state: 'authenticated', principalHash: 'a'.repeat(64) }))
  const models = await discoverAgyAccountModels(
    async () => 'synthetic-model\tSynthetic',
    signal(),
    home,
    nativeAgyAccountIdentity(backend, DEFAULT_CONFIG, 'win32'),
  )
  expect(models[0]?.id).toBe('synthetic-model')
  capture.mockResolvedValue('{"state":"unconfigured"}')
  await expect(
    discoverAgyAccountModels(
      async () => 'old-model\tOld',
      signal(),
      home,
      nativeAgyAccountIdentity(backend, DEFAULT_CONFIG, 'win32'),
    ),
  ).rejects.toThrow('请先登录')
})
