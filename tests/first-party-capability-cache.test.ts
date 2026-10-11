import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inspect } from 'node:util'
import { NativeCapabilityCache, metadataFileFingerprint } from '../src/host/native-capability-cache.ts'
import { discoverFirstPartySources, readFirstPartyModelSources } from '../src/host/first-party-models.ts'

// Synthetic executable identities, account files, CLI outputs, and remote responses only.
const roots: string[] = []
const signal = () => new AbortController().signal
afterEach(async () => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
async function fixture(cli: 'kimi' | 'claude') {
  const root = await mkdtemp(join(tmpdir(), 'cwn-capability-cache-'))
  roots.push(root)
  const project = join(root, 'project'),
    home = join(root, 'home'),
    executable = join(root, `synthetic-${cli}`)
  await mkdir(project)
  await mkdir(home)
  await writeFile(executable, 'synthetic native entry')
  if (cli === 'kimi') {
    vi.stubEnv('KIMI_CODE_HOME', home)
    for (const name of [
      'KIMI_CODE_BASE_URL',
      'KIMI_CODE_OAUTH_HOST',
      'KIMI_OAUTH_HOST',
      'KIMI_CODE_CUSTOM_HEADERS',
    ])
      vi.stubEnv(name, '')
    await mkdir(join(home, 'credentials'))
  } else {
    vi.stubEnv('CLAUDE_CONFIG_DIR', home)
    for (const name of Object.keys(process.env))
      if (/ANTHROPIC|CLAUDE_CODE_(?:OAUTH|USE_|API)|AWS_|GOOGLE_|CLOUD_ML|API_KEY|BEARER_TOKEN/.test(name))
        vi.stubEnv(name, '')
  }
  return { root, project, home, executable }
}
async function kimi() {
  const f = await fixture('kimi'),
    expires = Math.floor(Date.now() / 1000) + 3600
  const token = {
    access_token: `synthetic.${Buffer.from(JSON.stringify({ iss: 'kimi-auth', sub: 'synthetic-account-a' })).toString('base64url')}.signature`,
    refresh_token: 'synthetic-private-refresh-token',
    expires_at: expires,
  }
  const tokenPath = join(f.home, 'credentials/kimi-code.json'),
    configPath = join(f.home, 'config.toml')
  await writeFile(tokenPath, JSON.stringify(token))
  await writeFile(configPath, '# synthetic config')
  const raw = {
    providers: {
      'managed:kimi-code': {
        type: 'kimi',
        baseUrl: 'https://api.kimi.com/coding/v1',
        oauth: { storage: 'file', key: 'oauth/kimi-code' },
      },
    },
    models: { 'kimi-code/k3': { provider: 'managed:kimi-code', model: 'k3', displayName: 'Synthetic K3' } },
  }
  const capture = vi.fn(async () => JSON.stringify(raw))
  return {
    ...f,
    tokenPath,
    configPath,
    token,
    raw,
    capture,
    read: (control = signal(), cwd = f.project) =>
      readFirstPartyModelSources('kimi', f.executable, cwd, capture, control),
  }
}
async function claude() {
  const f = await fixture('claude'),
    configPath = join(f.home, 'settings.json')
  const config = {
    env: { ANTHROPIC_API_KEY: 'synthetic-own-api-key', ANTHROPIC_BASE_URL: 'https://anthropic.example.test' },
  }
  await writeFile(configPath, JSON.stringify(config))
  const capture = vi.fn(async (argv: string[]) =>
    argv.includes('--help')
      ? '--model --output-format --settings'
      : JSON.stringify({ loggedIn: true, authMethod: 'api_key', apiKeySource: 'ANTHROPIC_API_KEY' }),
  )
  return {
    ...f,
    config,
    configPath,
    capture,
    read: (control = signal()) =>
      readFirstPartyModelSources('claude', f.executable, f.project, capture, control),
  }
}

describe('Kimi managed native capability reuse', () => {
  it('reuses only metadata with fresh own token reads and independent returned objects', async () => {
    const f = await kimi(),
      first = await f.read()
    first[0]!.credential.access = 'caller mutation'
    first[0]!.nativeModels[0]!.choice.label = 'caller mutation'
    const next = await f.read()
    expect(f.capture).toHaveBeenCalledOnce()
    expect(next[0]!.credential.access).toBe(f.token.access_token)
    expect(next[0]!.nativeModels[0]!.choice.label).toBe('Synthetic K3')
    expect(JSON.stringify(next)).not.toContain(f.token.refresh_token)
  })
  it.each(['account', 'configuration', 'executable', 'environment', 'project'] as const)(
    'invalidates %s changes',
    async (kind) => {
      const f = await kimi()
      await f.read()
      let cwd = f.project
      if (kind === 'account')
        await writeFile(f.tokenPath, JSON.stringify({ ...f.token, refresh_token: 'changed-private-token' }))
      if (kind === 'configuration') await writeFile(f.configPath, '# changed synthetic config')
      if (kind === 'executable') await writeFile(f.executable, 'changed synthetic executable identity')
      if (kind === 'environment') vi.stubEnv('KIMI_SYNTHETIC_CONFIG', 'changed')
      if (kind === 'project') {
        cwd = join(f.project, 'child')
        await mkdir(cwd)
      }
      await f.read(signal(), cwd)
      expect(f.capture).toHaveBeenCalledTimes(2)
    },
  )
  it('never revives a logout or an expired cached account', async () => {
    const f = await kimi()
    f.token.expires_at = Math.floor(Date.now() / 1000) + 40
    await writeFile(f.tokenPath, JSON.stringify(f.token))
    await f.read()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 15_000)
    await expect(f.read()).rejects.toThrow('即将过期')
    expect(f.capture).toHaveBeenCalledOnce() // metadata is still warm; live expiry rejects it
    clock.mockRestore()
    await rm(f.tokenPath)
    await expect(f.read()).rejects.toThrow('尚未登录或已退出')
  })
  it('keeps remote model/usage requests live and refuses newly revoked access', async () => {
    const f = await kimi()
    const fetch = vi.fn(
      async (url: unknown) =>
        new Response(
          JSON.stringify(
            String(url).endsWith('/usages')
              ? { usages: { limit_5h: { used_ratio: 0.1 } } }
              : { data: [{ id: 'k3', context_length: 262144 }] },
          ),
        ),
    )
    expect(await discoverFirstPartySources(await f.read(), signal(), { fetch })).toHaveLength(1)
    fetch.mockImplementation(async () => new Response('{}', { status: 401 }))
    await expect(discoverFirstPartySources(await f.read(), signal(), { fetch })).rejects.toThrow('授权未通过')
    expect(f.capture).toHaveBeenCalledOnce()
    expect(fetch).toHaveBeenCalledTimes(4)
  })
  it('does not retain a failed, cancelled, or secret-bearing metadata result', async () => {
    const f = await kimi()
    f.capture.mockRejectedValueOnce(new Error('synthetic failed metadata'))
    await expect(f.read()).rejects.toThrow('synthetic failed metadata')
    const control = new AbortController()
    f.capture.mockImplementationOnce(async () => {
      control.abort(new Error('synthetic cancellation'))
      return JSON.stringify(f.raw)
    })
    await expect(f.read(control.signal)).rejects.toThrow('synthetic cancellation')
    f.raw.models['kimi-code/k3'].displayName = f.token.refresh_token
    await f.read()
    await f.read()
    expect(f.capture).toHaveBeenCalledTimes(4)
  })
  it('keeps API providers on native discovery rather than caching derived secrets', async () => {
    const f = await kimi()
    const raw = {
      providers: {
        own: { type: 'openai', baseUrl: 'https://own.example.test', apiKey: 'synthetic-api-key' },
      },
      models: { own: { provider: 'own', model: 'own-model' } },
    }
    f.capture.mockImplementation(async () => JSON.stringify(raw))
    await f.read()
    await f.read()
    expect(f.capture).toHaveBeenCalledTimes(2)
  })
  it('does not publish under a snapshot changed during native discovery or reuse a missing executable', async () => {
    const f = await kimi()
    f.capture.mockImplementationOnce(async () => {
      await writeFile(f.configPath, '# synthetic concurrent configuration change')
      return JSON.stringify(f.raw)
    })
    await f.read()
    await f.read()
    expect(f.capture).toHaveBeenCalledTimes(2)
    await rm(f.executable)
    f.capture.mockRejectedValueOnce(new Error('synthetic executable missing'))
    await expect(f.read()).rejects.toThrow('executable missing')
    await writeFile(f.executable, 'synthetic replacement executable')
    await f.read()
    expect(f.capture).toHaveBeenCalledTimes(4)
  })
})

describe('Claude capability checks keep authentication live', () => {
  it('caches only the supported-help fact and still queries current native auth each time', async () => {
    const f = await claude()
    await f.read()
    await f.read()
    expect(f.capture.mock.calls.filter(([argv]) => argv.includes('--help'))).toHaveLength(1)
    expect(f.capture.mock.calls.filter(([argv]) => argv.includes('status'))).toHaveLength(2)
    f.capture.mockImplementation(async () => {
      throw new Error('synthetic current authentication failure')
    })
    await expect(f.read()).rejects.toThrow('current authentication failure')
  })
  it.each(['account', 'configuration', 'executable', 'environment'] as const)(
    'invalidates %s changes',
    async (kind) => {
      const f = await claude()
      await f.read()
      if (kind === 'account')
        await writeFile(
          f.configPath,
          JSON.stringify({ env: { ...f.config.env, ANTHROPIC_API_KEY: 'changed-key' } }),
        )
      if (kind === 'configuration')
        await writeFile(f.configPath, JSON.stringify({ ...f.config, theme: 'synthetic-other' }))
      if (kind === 'executable') await writeFile(f.executable, 'changed synthetic binary identity')
      if (kind === 'environment') vi.stubEnv('CLAUDE_SYNTHETIC_CONFIG', 'changed')
      await f.read()
      expect(f.capture.mock.calls.filter(([argv]) => argv.includes('--help'))).toHaveLength(2)
    },
  )
  it('does not cache unsupported help or cancellation', async () => {
    const f = await claude()
    f.capture.mockImplementation(async (argv) =>
      argv.includes('--help') ? 'unsupported' : JSON.stringify({ loggedIn: true, authMethod: 'api_key' }),
    )
    await expect(f.read()).rejects.toThrow('版本不支持')
    await expect(f.read()).rejects.toThrow('版本不支持')
    expect(f.capture.mock.calls.filter(([argv]) => argv.includes('--help'))).toHaveLength(2)
    const control = new AbortController()
    control.abort(new Error('synthetic cancelled'))
    await expect(f.read(control.signal)).rejects.toThrow('synthetic cancelled')
    expect(f.capture).toHaveBeenCalledTimes(4)
  })
  it('does not admit help when cancelled during the native probe', async () => {
    const f = await claude(),
      control = new AbortController()
    f.capture.mockImplementationOnce(async () => JSON.stringify({ loggedIn: true, authMethod: 'api_key' }))
    f.capture.mockImplementationOnce(async () => {
      control.abort(new Error('synthetic interrupted help'))
      return '--model --output-format --settings'
    })
    await expect(f.read(control.signal)).rejects.toThrow('interrupted help')
    await f.read()
    expect(f.capture.mock.calls.filter(([argv]) => argv.includes('--help'))).toHaveLength(2)
  })
})

it('bounds successful metadata by count/time and hashes current files without holding secrets', async () => {
  const f = await kimi(),
    cache = new NativeCapabilityCache<true>(30_000, 2)
  const digest = await metadataFileFingerprint(f.tokenPath, signal())
  expect(digest).toMatch(/^[a-f0-9]{64}$/)
  cache.set(digest, true)
  cache.set('second', true)
  cache.set('third', true)
  expect(cache.get(digest)).toBeUndefined()
  expect(inspect(cache, { depth: 6 })).not.toMatch(/synthetic-private-refresh-token|access_token/)
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 31_000)
  expect(cache.get('third')).toBeUndefined()
})
