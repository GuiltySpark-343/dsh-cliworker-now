import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inspect } from 'node:util'
import { MimoMetadataCache, mimoMetadataKey, type MimoOwnSnapshot } from '../src/host/mimo-metadata-cache.ts'
import * as nativeLauncher from '../src/host/native-launch.mjs'
import {
  discoverFirstPartySources,
  readFirstPartyModelSources,
  type FirstPartyModelSource,
} from '../src/host/first-party-models.ts'

// All accounts, metadata subprocesses and remote responses in this file are synthetic.
const roots: string[] = []
const signal = () => new AbortController().signal
afterEach(async () => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
const native = {
  id: 'native-model',
  providerID: 'own',
  name: 'Synthetic MiMo',
  api: { id: 'upstream-model', npm: '@ai-sdk/anthropic', url: 'https://mimo.example.test/v1' },
  variants: { high: {} },
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'cwn-mimo-cache-'))
  roots.push(root)
  for (const path of ['config', 'data', 'project']) await mkdir(join(root, path))
  vi.stubEnv('MIMOCODE_HOME', root)
  vi.stubEnv('HOME', root)
  const executable = join(root, 'synthetic-mimo'),
    project = join(root, 'project')
  await writeFile(executable, 'synthetic native executable identity')
  const authPath = join(root, 'data/auth.json')
  await writeFile(authPath, JSON.stringify({ own: { type: 'api', key: 'synthetic-key-a' } }))
  const capture = vi.fn(async (argv: string[]) =>
    argv.includes('paths')
      ? `data ${join(root, 'data')}\nconfig ${join(root, 'config')}\n`
      : argv.includes('config')
        ? '{}'
        : `own/native-model\n${JSON.stringify(native)}\n`,
  )
  return {
    root,
    executable,
    project,
    authPath,
    capture,
    read: (abort = signal(), cwd = project) =>
      readFirstPartyModelSources('mimo', executable, cwd, capture, abort),
  }
}

describe('MiMo metadata reuse keeps current authorization and configuration boundaries', () => {
  it('starts native metadata only once and gives each caller independent capabilities with fresh own credentials', async () => {
    const f = await fixture(),
      first = await f.read()
    expect(f.capture).toHaveBeenCalledTimes(3)
    first[0]!.nativeModels[0]!.choice.label = 'caller mutation'
    first[0]!.credential.key = 'caller mutation'
    const next = await f.read()
    expect(f.capture).toHaveBeenCalledTimes(3)
    expect(next[0]!.credential.key).toBe('synthetic-key-a')
    expect(next[0]!.nativeModels[0]!.choice.label).toBe('Synthetic MiMo')
  })

  it.each(['account', 'configuration', 'executable', 'environment', 'project'])(
    'invalidates on %s change',
    async (kind) => {
      const f = await fixture()
      await f.read()
      if (kind === 'account')
        await writeFile(f.authPath, JSON.stringify({ own: { type: 'api', key: 'synthetic-key-b' } }))
      if (kind === 'configuration')
        await writeFile(join(f.root, 'config/mimocode.json'), '{"model":"own/another"}')
      if (kind === 'executable') await writeFile(f.executable, 'new native executable identity and size')
      if (kind === 'environment') vi.stubEnv('MIMOCODE_SYNTHETIC_CACHE_TEST', 'changed')
      let project = f.project
      if (kind === 'project') {
        project = join(f.project, 'child')
        await mkdir(project)
      }
      const next = await f.read(signal(), project)
      expect(f.capture).toHaveBeenCalledTimes(6)
      expect(next[0]!.credential.key).toBe(kind === 'account' ? 'synthetic-key-b' : 'synthetic-key-a')
    },
  )

  it('does not revive a logged-out account from cached metadata', async () => {
    const f = await fixture()
    await f.read()
    await rm(f.authPath)
    expect(await f.read()).toEqual([])
    expect(f.capture).toHaveBeenCalledTimes(5) // paths/config only; no models without own auth
  })

  it('rehydrates only current inline own credentials and invalidates their route changes', async () => {
    const f = await fixture()
    await rm(f.authPath)
    const path = join(f.root, 'config/mimocode.jsonc')
    let configuration = {
      provider: {
        own: { options: { apiKey: 'synthetic-inline-key', baseURL: 'https://own.example.test/v1' } },
      },
    }
    await writeFile(path, JSON.stringify(configuration))
    const original = f.capture.getMockImplementation()!
    f.capture.mockImplementation(async (argv) =>
      argv.includes('config') ? JSON.stringify(configuration) : original(argv),
    )
    await f.read()
    expect((await f.read())[0]).toMatchObject({
      credential: { key: 'synthetic-inline-key' },
      baseUrl: 'https://own.example.test/v1',
    })
    expect(f.capture).toHaveBeenCalledTimes(3)
    configuration.provider.own.options.baseURL = 'https://changed.example.test/v1'
    await writeFile(path, JSON.stringify(configuration))
    expect((await f.read())[0]!.baseUrl).toBe('https://changed.example.test/v1')
    expect(f.capture).toHaveBeenCalledTimes(6)
  })

  it('rechecks external references and cancellation even while the cache is warm', async () => {
    const f = await fixture()
    await f.read()
    const controller = new AbortController()
    controller.abort(new Error('Synthetic cancelled'))
    await expect(f.read(controller.signal)).rejects.toThrow('Synthetic cancelled')
    await writeFile(join(f.project, 'mimocode.json'), '{"model":"{file:/synthetic/foreign}"}')
    await expect(f.read()).rejects.toThrow('外部引用')
    expect(f.capture).toHaveBeenCalledTimes(3)
  })

  it.each(['paths', 'config', 'models'])(
    'does not continue or cache a cancelled %s probe',
    async (command) => {
      const f = await fixture(),
        controller = new AbortController(),
        original = f.capture.getMockImplementation()!
      f.capture.mockImplementation(async (argv) => {
        if (argv.includes(command)) controller.abort(new Error('Synthetic cancelled during discovery'))
        return original(argv)
      })
      await expect(f.read(controller.signal)).rejects.toThrow('Synthetic cancelled during discovery')
      const calls = ['paths', 'config', 'models'].indexOf(command) + 1
      expect(f.capture).toHaveBeenCalledTimes(calls)
      f.capture.mockImplementation(original)
      await f.read()
      expect(f.capture).toHaveBeenCalledTimes(calls + 3)
    },
  )

  it('rechecks remote model entitlement on every warm read', async () => {
    const f = await fixture()
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [{ id: 'upstream-model' }] }), { status: 200 }),
      )
      .mockResolvedValueOnce(new Response('{}', { status: 403 }))
    expect(await discoverFirstPartySources(await f.read(), signal(), { fetch })).toHaveLength(1)
    expect(await discoverFirstPartySources(await f.read(), signal(), { fetch })).toEqual([])
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(f.capture).toHaveBeenCalledTimes(3)
  })

  it('does not store failures or publish a snapshot changed during metadata discovery', async () => {
    const f = await fixture()
    f.capture.mockRejectedValueOnce(new Error('Synthetic native error'))
    await expect(f.read()).rejects.toThrow('Synthetic native error')
    const original = f.capture.getMockImplementation()!
    let changed = false
    f.capture.mockImplementation(async (argv) => {
      if (!changed && argv.includes('models')) {
        changed = true
        await writeFile(join(f.root, 'config/mimocode.json'), '{"model":"own/changed"}')
      }
      return original(argv)
    })
    await f.read()
    await f.read()
    expect(f.capture).toHaveBeenCalledTimes(7)
    await f.read()
    expect(f.capture).toHaveBeenCalledTimes(7)
  })
})

it('invalidates when the actual launch runtime or script changes behind an unchanged shim', async () => {
  const f = await fixture(),
    runtime = join(f.root, 'synthetic-runtime'),
    script = join(f.root, 'synthetic-script'),
    own: MimoOwnSnapshot = { authPath: f.authPath, auth: {}, configurations: [] }
  await writeFile(runtime, 'synthetic runtime')
  await writeFile(script, 'synthetic entry')
  const resolve = vi.spyOn(nativeLauncher, 'nativeLaunchArgv').mockReturnValue([runtime, script])
  const key = () => mimoMetadataKey(f.executable, f.project, own, signal())
  const first = await key()
  expect(first).toMatch(/^[a-f0-9]{64}$/)
  await writeFile(script, 'synthetic updated entry')
  const second = await key()
  expect(second).not.toBe(first)
  await writeFile(runtime, 'synthetic updated runtime')
  expect(await key()).not.toBe(second)
  resolve.mockImplementation(() => {
    throw new Error('Synthetic unsupported launcher')
  })
  expect(await key()).toBeUndefined()
})

it('expires and bounds only credential-free metadata; a stale key cannot restore credentials', () => {
  const now = vi.spyOn(Date, 'now').mockReturnValue(1000)
  const cache = new MimoMetadataCache(100, 1)
  const own: MimoOwnSnapshot = {
    authPath: '/synthetic/auth.json',
    auth: { own: { type: 'api', key: 'synthetic-secret' } },
    configurations: [],
  }
  const source: FirstPartyModelSource = {
    provider: 'own',
    credential: { type: 'api', key: 'synthetic-secret' },
    baseUrl: 'https://mimo.example.test/v1',
    apiType: 'anthropic-messages',
    sourceIds: [own.authPath, 'provider:own'],
    nativeModels: [],
  }
  cache.set('a', [source], own)
  expect(inspect(cache, { depth: null })).not.toContain('synthetic-secret')
  expect(cache.get('a', own)?.[0]!.credential.key).toBe('synthetic-secret')
  expect(cache.get('a', { ...own, auth: {} })).toBeUndefined()
  cache.set('a', [source], own)
  cache.set('b', [source], own)
  expect(cache.get('a', own)).toBeUndefined()
  now.mockReturnValue(1100)
  expect(cache.get('b', own)).toBeUndefined()
  source.baseUrl = 'https://mimo.example.test/v1?api_key=synthetic-secret'
  cache.set('c', [source], own)
  expect(cache.get('c', own)).toBeUndefined()
  source.baseUrl = 'https://mimo.example.test/v1'
  source.nativeModels = [
    { remoteId: 'synthetic', choice: { id: 'synthetic', label: 'synthetic-secret', efforts: ['default'] } },
  ]
  cache.set('d', [source], own)
  expect(cache.get('d', own)).toBeUndefined()
  expect(inspect(cache, { depth: null })).not.toContain('synthetic-secret')
})
