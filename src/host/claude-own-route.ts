import { createConnection } from 'node:net'
import { homedir } from 'node:os'
import { join, isAbsolute, resolve } from 'node:path'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { safePiOmpAncestors } from './pi-omp-native.ts'
import { accountEmail, type AccountIdentity } from './account-identity.ts'
import {
  readFirstPartyJson,
  claudeManagedSettingsPath,
  type FirstPartyModelSource,
} from './first-party-models.ts'

const record = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v)
const literal = (v: unknown): v is string =>
  typeof v === 'string' && !!v.trim() && !/[\s\x00-\x1f{}$]/.test(v) && !v.startsWith('!')
const authOption = /ANTHROPIC|CLAUDE_CODE_(?:OAUTH|USE_|API)|AWS_|GOOGLE_|CLOUD_ML|API_KEY|BEARER_TOKEN/
const allowed = new Set(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL'])
const modelOption = /^ANTHROPIC_(?:MODEL|SMALL_FAST_MODEL|DEFAULT_(?:HAIKU|SONNET|OPUS)_MODEL(?:_NAME)?)$/
const officialBase = 'https://api.anthropic.com'
const homeOption = /^(?:CLAUDE_CONFIG_DIR|HOME|USERPROFILE|XDG_CONFIG_HOME)$/

/** Public errors never interpolate native configuration or credentials. */
export class ClaudeOwnRouteError extends Error {
  readonly code = 'CLI_OWN_ACCOUNT_REQUIRED'
  constructor(message = 'Claude 账号来源无法确认，请检查该 CLI 的配置') {
    super(message)
    this.name = 'ClaudeOwnRouteError'
  }
}
export interface ClaudeOwnRoute {
  kind: 'native' | 'proxy' | 'api'
  sourceIds: string[]
  configDirectory?: string
  /** Host-only; never project this material to Gateway. */
  source?: FirstPartyModelSource
}

/** Verified on native 2.1.296: empty settings.env unsets provider selectors for this process. */
export function claudeNativeSettingsArguments(configDirectory?: string): string[] {
  return [
    '--settings',
    JSON.stringify({
      apiKeyHelper: '',
      env: {
        ...(configDirectory ? { CLAUDE_CONFIG_DIR: configDirectory } : {}),
        CLAUDE_CODE_USE_BEDROCK: '',
        CLAUDE_CODE_USE_VERTEX: '',
        CLAUDE_CODE_USE_FOUNDRY: '',
        ANTHROPIC_AUTH_TOKEN: '',
        ANTHROPIC_API_KEY: '',
        CLAUDE_CODE_OAUTH_TOKEN: '',
        ANTHROPIC_BASE_URL: officialBase,
        ANTHROPIC_MODEL: '',
        ANTHROPIC_SMALL_FAST_MODEL: '',
        ANTHROPIC_DEFAULT_HAIKU_MODEL: '',
        ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME: '',
        ANTHROPIC_DEFAULT_SONNET_MODEL: '',
        ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: '',
        ANTHROPIC_DEFAULT_OPUS_MODEL: '',
        ANTHROPIC_DEFAULT_OPUS_MODEL_NAME: '',
      },
    }),
  ]
}

/** TCP only: a listening proxy remains selected even if its HTTP authentication fails. */
export async function claudeLoopbackAvailable(url: URL, signal: AbortSignal): Promise<boolean> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const socket = createConnection({
      host: url.hostname.replace(/^\[|\]$/g, ''),
      port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)),
    })
    let settled = false
    const done = (value?: boolean, error?: unknown) => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', abort)
      socket.destroy()
      error !== undefined ? reject(error) : resolve(value!)
    }
    const abort = () => done(undefined, signal.reason ?? new Error('查询已取消'))
    signal.addEventListener('abort', abort, { once: true })
    socket.once('connect', () => done(true))
    socket.setTimeout(1200, () => done(false))
    socket.once('error', (error: NodeJS.ErrnoException) => {
      if (['ECONNREFUSED', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH'].includes(error.code ?? '')) done(false)
      else done(undefined, new ClaudeOwnRouteError('Claude 本地代理连接状态无法确认，请检查代理'))
    })
    if (signal.aborted) abort()
  })
}

export async function readClaudeOwnRoute(
  project: string,
  signal: AbortSignal,
  options: { available?: typeof claudeLoopbackAvailable } = {},
): Promise<ClaudeOwnRoute> {
  signal.throwIfAborted()
  const root = process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), '.claude')
  if (!isAbsolute(root)) throw new ClaudeOwnRouteError('Claude 账号目录必须使用绝对路径')
  const paths = [
    join(root, 'settings.json'),
    join(project, '.claude/settings.json'),
    join(project, '.claude/settings.local.json'),
  ]
  const configured: Record<string, any> = Object.create(null),
    env: Record<string, any> = Object.create(null)
  for (const path of paths) {
    const settings = await readFirstPartyJson(path)
    signal.throwIfAborted()
    Object.assign(configured, settings)
    if (record(settings.env)) Object.assign(env, settings.env)
  }
  const managed = await readFirstPartyJson(claudeManagedSettingsPath())
  signal.throwIfAborted()
  if (
    Object.entries(process.env).some(
      ([key, value]) => value && authOption.test(key) && !modelOption.test(key),
    )
  )
    throw new ClaudeOwnRouteError('Claude 检测到环境账号覆盖，请先在该 CLI 自身设置中明确账号来源')
  if (
    configured.apiKeyHelper ||
    managed.apiKeyHelper ||
    (record(managed.env) &&
      Object.entries(managed.env).some(
        ([key, value]) => value && (authOption.test(key) || homeOption.test(key)),
      ))
  )
    throw new ClaudeOwnRouteError()
  if (
    Object.entries(env).some(
      ([key, value]) =>
        value &&
        (homeOption.test(key) || (authOption.test(key) && !allowed.has(key) && !modelOption.test(key))),
    )
  )
    throw new ClaudeOwnRouteError()
  const key = env.ANTHROPIC_API_KEY,
    bearer = env.ANTHROPIC_AUTH_TOKEN
  if (key && bearer) throw new ClaudeOwnRouteError('Claude 同时配置两种令牌，请先明确一种登录来源')
  if ((key && !literal(key)) || (bearer && !literal(bearer))) throw new ClaudeOwnRouteError()
  let url: URL
  try {
    url = new URL(env.ANTHROPIC_BASE_URL || officialBase)
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
      throw new Error()
  } catch {
    throw new ClaudeOwnRouteError('Claude 服务地址无效，请检查该 CLI 的配置')
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname.toLowerCase())
  if (loopback && !(await (options.available ?? claudeLoopbackAvailable)(url, signal))) {
    signal.throwIfAborted()
    return { kind: 'native', configDirectory: root, sourceIds: [root, 'native:claude-official-login'] }
  }
  signal.throwIfAborted()
  if (!key && !bearer) {
    if (loopback || url.href.replace(/\/$/, '') !== officialBase)
      throw new ClaudeOwnRouteError('Claude 服务已配置，但无法确认该服务的自身凭据')
    return { kind: 'native', configDirectory: root, sourceIds: [root, 'native:claude-official-login'] }
  }
  return {
    kind: loopback ? 'proxy' : 'api',
    configDirectory: root,
    sourceIds: paths,
    source: {
      provider: 'anthropic',
      credential: { type: 'api', key: bearer || key },
      baseUrl: url.href.replace(/\/$/, ''),
      apiType: 'anthropic-messages',
      ...(bearer ? { anthropicAuth: 'bearer' as const } : {}),
      sourceIds: paths,
      nativeModels: [],
      nativeFullModelIds: true,
      claudeRoute: loopback ? 'proxy' : 'api',
    },
  }
}

export function claudeRouteStatusArguments(executable: string, route: ClaudeOwnRoute): string[] {
  return [
    executable,
    ...(route.kind === 'native' ? claudeNativeSettingsArguments(route.configDirectory) : []),
    'auth',
    'status',
    '--json',
  ]
}
export function claudeRouteIdentity(
  route: ClaudeOwnRoute,
  raw: string,
  exitCode: number | null,
): AccountIdentity {
  let status: any
  try {
    status = JSON.parse(raw)
  } catch {
    throw new ClaudeOwnRouteError('Claude 登录状态响应无法确认，请刷新')
  }
  if (!record(status)) throw new ClaudeOwnRouteError('Claude 登录状态响应无法确认，请刷新')
  if (status.apiProvider !== undefined && status.apiProvider !== 'firstParty') throw new ClaudeOwnRouteError()
  if (route.configDirectory && status.configDirectory !== undefined) {
    const normalized = (path: string) =>
      process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path)
    if (
      typeof status.configDirectory !== 'string' ||
      !isAbsolute(status.configDirectory) ||
      normalized(status.configDirectory) !== normalized(route.configDirectory)
    )
      throw new ClaudeOwnRouteError('Claude 原生账号目录与选定来源不一致')
  }
  if (route.kind === 'native') {
    if ([0, 1].includes(exitCode ?? -1) && status.loggedIn === false)
      return { state: 'unconfigured', summary: 'Claude 官方账号未登录', verification: 'cli' }
    if (exitCode !== 0 || status.loggedIn !== true || status.authMethod !== 'claude.ai')
      throw new ClaudeOwnRouteError('Claude 官方登录来源无法确认，请使用原生登录')
    const email = accountEmail(status.email)
    return {
      state: 'authenticated',
      summary: 'Claude 官方账号登录',
      authMethod: 'oauth',
      accountLabel: email,
      logins: [{ providerLabel: 'Claude 官方', authMethod: 'oauth', accountLabel: email }],
      verification: 'cli',
    }
  }
  const expected = route.source?.anthropicAuth === 'bearer' ? 'oauth_token' : 'api_key'
  if (exitCode !== 0 || status.loggedIn !== true || status.authMethod !== expected)
    throw new ClaudeOwnRouteError()
  const label = route.kind === 'proxy' ? 'Claude 本地代理' : 'Claude 自身配置'
  return {
    state: 'authenticated',
    summary: `${label} API 登录`,
    authMethod: 'api',
    logins: [{ providerLabel: label, authMethod: 'api' }],
    verification: 'cli',
  }
}

/** Pin one route before spawning; secrets are in a private temporary file, never argv. */
export async function prepareClaudeWorkerLaunch(
  route: ClaudeOwnRoute,
  argv: string[],
  stateDirectory: string,
  signal: AbortSignal,
) {
  signal.throwIfAborted()
  if (route.kind === 'native')
    return {
      argv: [argv[0]!, ...claudeNativeSettingsArguments(route.configDirectory), ...argv.slice(1)],
      env: {},
    }
  if (!route.source) throw new ClaudeOwnRouteError()
  const parent = join(stateDirectory, 'claude-route')
  await safePiOmpAncestors(parent)
  await mkdir(parent, { recursive: true, mode: 0o700 })
  await safePiOmpAncestors(parent)
  const directory = await mkdtemp(join(parent, 'run-'))
  try {
    const path = join(directory, 'settings.json')
    await writeFile(
      path,
      JSON.stringify({
        apiKeyHelper: '',
        env: {
          ...(route.configDirectory ? { CLAUDE_CONFIG_DIR: route.configDirectory } : {}),
          CLAUDE_CODE_USE_BEDROCK: '',
          CLAUDE_CODE_USE_VERTEX: '',
          CLAUDE_CODE_USE_FOUNDRY: '',
          ANTHROPIC_BASE_URL: route.source.baseUrl,
          ANTHROPIC_AUTH_TOKEN: route.source.anthropicAuth === 'bearer' ? route.source.credential.key : '',
          ANTHROPIC_API_KEY: route.source.anthropicAuth === 'bearer' ? '' : route.source.credential.key,
          CLAUDE_CODE_OAUTH_TOKEN: '',
        },
      }),
      { mode: 0o600, flag: 'wx' },
    )
    signal.throwIfAborted()
    return {
      argv: [argv[0]!, '--settings', path, ...argv.slice(1)],
      env: {},
      cleanup: () => rm(directory, { recursive: true, force: true }),
    }
  } catch (error) {
    await rm(directory, { recursive: true, force: true })
    throw error
  }
}
