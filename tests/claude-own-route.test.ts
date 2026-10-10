import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile, rm, stat, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import {
  readClaudeOwnRoute,
  claudeNativeSettingsArguments,
  claudeRouteStatusArguments,
  claudeRouteIdentity,
  prepareClaudeWorkerLaunch,
} from '../src/host/claude-own-route.ts'
import { discoverFirstPartySources } from '../src/host/first-party-models.ts'

// Synthetic own settings, loopback availability, and HTTP only. No native login/model is invoked.
let root: string, home: string, project: string
const control = () => new AbortController().signal
const write = (value: unknown) =>
  writeFile(join(home, 'settings.json'), JSON.stringify(value), { mode: 0o600 })
const proxy = {
  env: {
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:15721',
    ANTHROPIC_AUTH_TOKEN: 'synthetic-proxy-key',
    ANTHROPIC_DEFAULT_SONNET_MODEL: 'synthetic-proxy-model',
  },
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'cwn-claude-route-'))
  home = join(root, 'home')
  project = join(root, 'project')
  await mkdir(home)
  await mkdir(project)
  vi.stubEnv('CLAUDE_CONFIG_DIR', home)
  for (const key of Object.keys(process.env))
    if (/ANTHROPIC|CLAUDE_CODE_(?:OAUTH|USE_|API)|AWS_|GOOGLE_|CLOUD_ML|API_KEY|BEARER_TOKEN/.test(key))
      vi.stubEnv(key, '')
})
afterEach(async () => {
  vi.unstubAllEnvs()
  await rm(root, { recursive: true, force: true })
})
it('selects a listening own proxy without treating its bearer as subscription OAuth', async () => {
  await write(proxy)
  const available = vi.fn(async () => true)
  const route = await readClaudeOwnRoute(project, control(), { available })
  expect(route).toMatchObject({ kind: 'proxy', source: { anthropicAuth: 'bearer' } })
  const status = claudeRouteIdentity(
    route,
    JSON.stringify({ loggedIn: true, authMethod: 'oauth_token', email: 'unrelated@example.test' }),
    0,
  )
  expect(status).toMatchObject({
    authMethod: 'api',
    logins: [{ providerLabel: 'Claude 本地代理', authMethod: 'api' }],
  })
  expect(status.accountLabel).toBeUndefined()
  expect(JSON.stringify(status)).not.toMatch(/synthetic-proxy-key|127\.0|unrelated/)
  expect(claudeRouteStatusArguments('claude', route)).toEqual(['claude', 'auth', 'status', '--json'])
})
it('selects official native login only when own loopback is unavailable, without rewriting configuration', async () => {
  await write(proxy)
  const before = await readFile(join(home, 'settings.json'), 'utf8')
  const route = await readClaudeOwnRoute(project, control(), { available: async () => false })
  expect(route.kind).toBe('native')
  expect(route.source).toBeUndefined()
  const argv = claudeRouteStatusArguments('claude', route)
  const env = JSON.parse(argv[2]!).env
  expect(env.CLAUDE_CONFIG_DIR).toBe(home)
  expect(JSON.parse(argv[2]!).apiKeyHelper).toBe('')
  expect(env.CLAUDE_CODE_USE_BEDROCK).toBe('')
  expect(env.CLAUDE_CODE_USE_VERTEX).toBe('')
  expect(env.CLAUDE_CODE_USE_FOUNDRY).toBe('')
  expect(env.ANTHROPIC_AUTH_TOKEN).toBe('')
  expect(env.ANTHROPIC_API_KEY).toBe('')
  expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('')
  expect(env.ANTHROPIC_BASE_URL).toBe('https://api.anthropic.com')
  expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('')
  expect(
    claudeRouteIdentity(route, JSON.stringify({ loggedIn: false, authMethod: 'none' }), 1),
  ).toMatchObject({ state: 'unconfigured', summary: 'Claude 官方账号未登录' })
  expect(await readFile(join(home, 'settings.json'), 'utf8')).toBe(before)
})
it('does not silently switch to native when a reachable proxy rejects authentication', async () => {
  await write(proxy)
  const available = vi.fn(async () => true)
  const route = await readClaudeOwnRoute(project, control(), { available })
  const fetch = vi.fn(async () => new Response('{}', { status: 401 }))
  await expect(discoverFirstPartySources([route.source!], control(), { fetch })).rejects.toThrow(
    '本地代理认证失败',
  )
  expect(available).toHaveBeenCalledOnce()
  expect(fetch).toHaveBeenCalledOnce()
  expect(route.kind).toBe('proxy')
})
it('does not silently switch to native for unavailable proxy model metadata', async () => {
  await write(proxy)
  const route = await readClaudeOwnRoute(project, control(), { available: async () => true })
  const fetch = vi.fn(async () => {
    throw new Error('synthetic backend failure')
  })
  await expect(discoverFirstPartySources([route.source!], control(), { fetch })).rejects.toThrow(
    '本地代理模型目录无法确认',
  )
})
it('preserves explicit remote own API route without testing or falling back to native', async () => {
  await write({ env: { ANTHROPIC_API_KEY: 'synthetic-own', ANTHROPIC_BASE_URL: 'https://own.example.test' } })
  const available = vi.fn(async () => false)
  expect((await readClaudeOwnRoute(project, control(), { available })).kind).toBe('api')
  expect(available).not.toHaveBeenCalled()
})
it.each(['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK'])(
  'rejects ambient %s before selecting a route',
  async (name) => {
    await write(proxy)
    vi.stubEnv(name, 'synthetic-ambient')
    const available = vi.fn(async () => false)
    await expect(readClaudeOwnRoute(project, control(), { available })).rejects.toThrow('环境账号覆盖')
    expect(available).not.toHaveBeenCalled()
  },
)
it('does not reuse a prior route after own credential changes or logout', async () => {
  await write(proxy)
  const first = await readClaudeOwnRoute(project, control(), { available: async () => true })
  await write({ env: { ...proxy.env, ANTHROPIC_AUTH_TOKEN: 'synthetic-second' } })
  const second = await readClaudeOwnRoute(project, control(), { available: async () => true })
  expect(second.source?.credential).not.toEqual(first.source?.credential)
  await write({})
  expect((await readClaudeOwnRoute(project, control())).kind).toBe('native')
})
it('keeps an admitted proxy route fixed in a private temporary file and removes it after cleanup', async () => {
  await write(proxy)
  const route = await readClaudeOwnRoute(project, control(), { available: async () => true })
  // The user's config changes after selection: the admitted launch still retains the selected route.
  await write({
    env: { ANTHROPIC_AUTH_TOKEN: 'synthetic-other', ANTHROPIC_BASE_URL: 'https://other.example.test' },
  })
  const launch = await prepareClaudeWorkerLaunch(
    route,
    ['claude', '--print', 'synthetic-task'],
    join(root, 'state'),
    control(),
  )
  expect(launch.argv.slice(0, 2)).toEqual(['claude', '--settings'])
  expect(JSON.stringify(launch.argv)).not.toMatch(/synthetic-proxy-key|synthetic-other|127\.0/)
  const path = launch.argv[2]!
  expect(JSON.parse(await readFile(path, 'utf8')).env).toMatchObject({
    ANTHROPIC_AUTH_TOKEN: 'synthetic-proxy-key',
    ANTHROPIC_API_KEY: '',
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:15721',
  })
  if (process.platform !== 'win32') {
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect((await stat(dirname(path))).mode & 0o777).toBe(0o700)
  }
  expect('cleanup' in launch).toBe(true)
  if ('cleanup' in launch) await launch.cleanup!()
  expect(await readdir(join(root, 'state', 'claude-route'))).toEqual([])
  expect(await readFile(join(home, 'settings.json'), 'utf8')).toContain('synthetic-other')
})
it('pins native official launch to the verified process overlay with no temporary credential file', async () => {
  const route = await readClaudeOwnRoute(project, control())
  const launch = await prepareClaudeWorkerLaunch(
    route,
    ['claude', '--print', 'task'],
    join(root, 'state'),
    control(),
  )
  expect(launch.argv).toEqual([
    'claude',
    ...claudeNativeSettingsArguments(route.configDirectory),
    '--print',
    'task',
  ])
  expect('cleanup' in launch).toBe(false)
})
it('cancellation cannot fall through to a different account route', async () => {
  await write(proxy)
  const abort = new AbortController()
  const available = vi.fn(async () => {
    abort.abort()
    return false
  })
  await expect(readClaudeOwnRoute(project, abort.signal, { available })).rejects.toThrow()
  expect(available).toHaveBeenCalledOnce()
})
it('rejects a configured proxy credential whose native auth source disagrees', async () => {
  await write(proxy)
  const route = await readClaudeOwnRoute(project, control(), { available: async () => true })
  expect(() =>
    claudeRouteIdentity(
      route,
      JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: 'other@example.test' }),
      0,
    ),
  ).toThrow('来源无法确认')
})
it('does not project credential-shaped values as official account email', async () => {
  const route = await readClaudeOwnRoute(project, control())
  const identity = claudeRouteIdentity(
    route,
    JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: 'sk-secret@example.test' }),
    0,
  )
  expect(identity.accountLabel).toBeUndefined()
  expect(JSON.stringify(identity)).not.toContain('sk-secret')
})

it.each(['CLAUDE_CONFIG_DIR', 'HOME', 'USERPROFILE', 'XDG_CONFIG_HOME'])(
  'rejects own settings.env %s that could redirect the credential store',
  async (key) => {
    await write({ env: { ...proxy.env, [key]: join(root, 'another-account') } })
    await expect(readClaudeOwnRoute(project, control(), { available: async () => false })).rejects.toThrow(
      '来源无法确认',
    )
  },
)
it('does not let JSON prototype fields supply an own credential', async () => {
  await write(JSON.parse('{"env":{"__proto__":{"ANTHROPIC_AUTH_TOKEN":"synthetic-foreign"}}}'))
  expect((await readClaudeOwnRoute(project, control())).kind).toBe('native')
})
it('rejects native status from a different config root or cloud provider', async () => {
  const route = await readClaudeOwnRoute(project, control())
  const status = { loggedIn: true, authMethod: 'claude.ai', email: 'synthetic@example.test' }
  expect(() =>
    claudeRouteIdentity(route, JSON.stringify({ ...status, configDirectory: join(root, 'other') }), 0),
  ).toThrow('目录与选定来源不一致')
  expect(() => claudeRouteIdentity(route, JSON.stringify({ ...status, apiProvider: 'bedrock' }), 0)).toThrow(
    '来源无法确认',
  )
})
