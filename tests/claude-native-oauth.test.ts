import { describe, expect, it, vi } from 'vitest'
import { PassThrough, Writable } from 'node:stream'
import type { SubprocessHandle, SubprocessOutcome } from '@deepseek-ai/dsh-subprocess'
import { DEFAULT_CONFIG, ProcessCleanupUnconfirmedError, type ProcessBackend } from '../src/host/process.ts'
import {
  ClaudeNativeOAuthError,
  discoverClaudeNativeOAuth,
  parseClaudeNativeOAuthCatalog,
} from '../src/host/claude-native-oauth.ts'

// All accounts, native controls and quota responses here are synthetic. No native login or HTTP.
const now = Date.parse('2026-10-10T12:00:00Z')
const reset = '2099-01-01T00:00:00Z'
const initialize = () => ({
  account: {
    apiProvider: 'firstParty',
    tokenSource: 'claude.ai',
    email: 'synthetic@example.invalid',
    organization: 'Synthetic org',
  },
  models: [
    {
      value: 'sonnet',
      resolvedModel: 'claude-sonnet-synthetic',
      displayName: 'Synthetic Sonnet',
      supportsEffort: true,
      supportedEffortLevels: ['low', 'high', 'invented'],
    },
    { value: 'haiku', resolvedModel: 'claude-haiku-synthetic', supportsEffort: false },
  ],
})
const usage = () => ({
  subscription_type: 'pro',
  rate_limits_available: true,
  rate_limits: {
    five_hour: { utilization: 15, resets_at: reset },
    seven_day: { utilization: 50, resets_at: reset },
    limits: [],
    model_scoped: [],
  },
  session: { total_cost_usd: 0, model_usage: {} },
  behaviors: null,
})
const prefixArgs = [
  '--settings',
  JSON.stringify({
    env: { ANTHROPIC_AUTH_TOKEN: '', ANTHROPIC_API_KEY: '', ANTHROPIC_BASE_URL: 'https://api.anthropic.com' },
  }),
]

function fixture(
  options: {
    initialize?: any
    usage?: any
    stall?: boolean
    cleanup?: boolean
    badResponse?: any
    stderr?: string
    split?: boolean
    failDone?: boolean
  } = {},
) {
  const stdout = new PassThrough(),
    stderr = new PassThrough(),
    messages: any[] = []
  let settle!: (outcome: SubprocessOutcome) => void, reject!: (error: Error) => void
  const done = new Promise<SubprocessOutcome>((resolve, fail) => {
    settle = resolve
    reject = fail
  })
  const child: SubprocessHandle = {
    stdin: new Writable({
      write(chunk, _encoding, callback) {
        const message = JSON.parse(String(chunk))
        messages.push(message)
        callback()
        if (options.stderr) stderr.write(options.stderr)
        if (options.failDone) {
          reject(new Error('synthetic private credential must not escape'))
          stdout.end()
          return
        }
        if (options.stall) return
        const data = options.badResponse ?? {
          type: 'control_response',
          response: {
            subtype: 'success',
            request_id: message.request_id,
            response:
              message.request.subtype === 'initialize'
                ? (options.initialize ?? initialize())
                : (options.usage ?? usage()),
          },
        }
        const encoded = Buffer.from(JSON.stringify(data) + '\n')
        if (options.split) {
          stdout.write(encoded.subarray(0, 31))
          stdout.write(encoded.subarray(31))
        } else stdout.write(encoded)
      },
    }),
    stdout,
    stderr,
    done,
    control: undefined,
    collected: {},
    terminate: vi.fn(() => {
      stdout.end()
      stderr.end()
      settle({ exitCode: 0, signal: null })
    }),
    waitForExit: vi.fn(async () => options.cleanup !== false),
  }
  const backend: ProcessBackend = { resolveExecutable: vi.fn(), spawn: vi.fn(() => child) }
  return {
    child,
    backend,
    messages,
    run: (signal = new AbortController().signal, maxRunBytes = DEFAULT_CONFIG.maxRunBytes) =>
      discoverClaudeNativeOAuth(
        backend,
        { ...DEFAULT_CONFIG, maxRunBytes },
        '/synthetic/claude',
        '/synthetic/project',
        signal,
        prefixArgs,
      ),
  }
}

describe('Claude own native OAuth catalog', () => {
  it('combines native models and exact effort support with same-process own OAuth quota', () => {
    const result = parseClaudeNativeOAuthCatalog(initialize(), usage(), now)
    expect(result).toEqual({
      account: { email: 'synthetic@example.invalid', organization: 'Synthetic org' },
      models: [
        { id: 'sonnet', label: 'Synthetic Sonnet', efforts: ['default', 'low', 'high'] },
        { id: 'haiku', label: 'haiku', efforts: ['default'] },
      ],
    })
    expect(JSON.stringify(result)).not.toContain('rate_limits')
  })
  it.each([
    { tokenSource: 'none' },
    { tokenSource: 'CLAUDE_CODE_OAUTH_TOKEN' },
    { apiProvider: 'gateway' },
    { apiKeySource: 'apiKeyHelper' },
    { email: undefined },
    { email: 'not-an-email' },
    { email: 'Bearer-sk-test@example.invalid' },
    { email: '<synthetic@example.invalid>' },
  ])('rejects anonymous, ambient or another provider account despite native model metadata: %j', (change) => {
    const data = initialize()
    Object.assign(data.account, change)
    expect(() => parseClaudeNativeOAuthCatalog(data, usage(), now)).toThrow(ClaudeNativeOAuthError)
  })
  it.each([
    { rate_limits_available: false },
    { subscription_type: null },
    { subscription_type: 'api' },
    { rate_limits: null },
    { rate_limits: {} },
  ])('requires actual plan quota and ignores API billing metadata: %j', (change) => {
    expect(() => parseClaudeNativeOAuthCatalog(initialize(), { ...usage(), ...change }, now)).toThrow(/额度/)
  })
  it('rejects native failure fallback snapshots which lack the original server limits array', () => {
    const value: any = usage()
    delete value.rate_limits.limits
    expect(() => parseClaudeNativeOAuthCatalog(initialize(), value, now)).toThrow(/额度/)
  })
  it.each([
    null,
    undefined,
    {},
    { utilization: '1', resets_at: reset },
    { utilization: -1, resets_at: reset },
    { utilization: Infinity, resets_at: reset },
    { utilization: 0, resets_at: '2020-01-01' },
  ])('rejects unknown/malformed/stale general quota: %j', (window) => {
    const value: any = usage()
    value.rate_limits.five_hour = window
    expect(() => parseClaudeNativeOAuthCatalog(initialize(), value, now)).toThrow(/额度/)
  })
  it.each(['five_hour', 'seven_day', 'seven_day_oauth_apps', 'seven_day_opus', 'seven_day_sonnet'])(
    'blocks a depleted %s window even with extra paid usage enabled',
    (key) => {
      const value: any = usage()
      value.rate_limits[key] = { utilization: 100, resets_at: reset }
      value.rate_limits.extra_usage = { is_enabled: true, utilization: 0, monthly_limit: 100 }
      expect(() => parseClaudeNativeOAuthCatalog(initialize(), value, now)).toThrow(/限额/)
    },
  )
  it('requires valid returned model-specific quota and refuses active server limit rows at capacity', () => {
    const value: any = usage()
    value.rate_limits.model_scoped = [{ utilization: null, resets_at: reset }]
    expect(() => parseClaudeNativeOAuthCatalog(initialize(), value, now)).toThrow(/额度/)
    value.rate_limits.model_scoped = []
    value.rate_limits.limits = [{ percent: 100, is_active: true }]
    expect(() => parseClaudeNativeOAuthCatalog(initialize(), value, now)).toThrow(/限额/)
    value.rate_limits.limits[0].is_active = false
    expect(parseClaudeNativeOAuthCatalog(initialize(), value, now).models).toHaveLength(2)
  })
  it('does not invent resolved models and excludes hidden/disabled/non-entitled native entries', () => {
    const data: any = initialize()
    data.models.push(
      { value: 'guessed' },
      ...['disabled', 'hidden'].map((key) => ({ value: key, resolvedModel: key, [key]: true })),
      { value: 'denied', resolvedModel: 'denied', entitled: false },
    )
    expect(parseClaudeNativeOAuthCatalog(data, usage(), now).models).toHaveLength(2)
    data.models.push(data.models[0])
    expect(() => parseClaudeNativeOAuthCatalog(data, usage(), now)).toThrow(/重复/)
  })
  it('sends only initialize/get_usage controls and suppresses hooks, MCP and session persistence for metadata', async () => {
    const f = fixture({ split: true })
    const result = await f.run()
    expect(result.models).toHaveLength(2)
    expect(f.messages.map((message) => [message.type, message.request.subtype])).toEqual([
      ['control_request', 'initialize'],
      ['control_request', 'get_usage'],
    ])
    expect(f.messages[1].request).toEqual({ subtype: 'get_usage', skip_behaviors: true })
    const spec = vi.mocked(f.backend.spawn).mock.calls[0]![0]
    expect(spec.argv).toContain('--no-session-persistence')
    expect(spec.argv).toContain('--strict-mcp-config')
    expect(spec.argv).not.toContain('--bare')
    expect(JSON.parse(spec.argv[2]!)).toMatchObject({
      disableAllHooks: true,
      env: { ANTHROPIC_BASE_URL: 'https://api.anthropic.com' },
    })
    expect(f.child.terminate).toHaveBeenCalledOnce()
    expect(f.child.waitForExit).toHaveBeenCalledOnce()
  })
  it('stops after initialize when native login is missing', async () => {
    const data = initialize()
    data.account.tokenSource = 'none'
    const f = fixture({ initialize: data })
    await expect(f.run()).rejects.toThrow(/登录/)
    expect(f.messages).toHaveLength(1)
    expect(f.child.terminate).toHaveBeenCalledOnce()
  })
  it.each([
    { type: 'assistant', message: { content: 'unexpected' } },
    { type: 'control_request', request: { subtype: 'can_use_tool' } },
    { type: 'control_response', response: { request_id: 'wrong', subtype: 'success', response: {} } },
    {
      type: 'control_response',
      response: {
        request_id: 'native-initialize',
        subtype: 'error',
        error: 'private credential must not escape',
      },
    },
  ])('fails safely on unexpected native protocol messages: %j', async (badResponse) => {
    const f = fixture({ badResponse })
    const error = await f.run().catch((error) => error)
    expect(error).toBeInstanceOf(ClaudeNativeOAuthError)
    expect(error.message).not.toContain('private credential')
    expect(f.child.terminate).toHaveBeenCalledOnce()
  })
  it('cancels a stalled metadata process and confirms its full process cleanup', async () => {
    const controller = new AbortController(),
      f = fixture({ stall: true })
    const pending = f.run(controller.signal)
    controller.abort()
    await expect(pending).rejects.toThrow(/取消/)
    expect(f.child.terminate).toHaveBeenCalledOnce()
    expect(f.child.waitForExit).toHaveBeenCalledOnce()
  })
  it('bounds combined stderr/stdout without surfacing captured private output', async () => {
    const f = fixture({ stderr: 'private credentials '.repeat(100) })
    const error = await f.run(undefined, 50).catch((error) => error)
    expect(error).toBeInstanceOf(ClaudeNativeOAuthError)
    expect(error.message).not.toContain('private')
    expect(f.child.terminate).toHaveBeenCalledOnce()
  })
  it('preserves cleanup failure as a reservation-blocking error', async () => {
    const f = fixture({ cleanup: false })
    await expect(f.run()).rejects.toBeInstanceOf(ProcessCleanupUnconfirmedError)
  })
  it('does not surface raw process errors or keep a failed child alive', async () => {
    const f = fixture({ failDone: true })
    const error = await f.run().catch((error) => error)
    expect(error).toBeInstanceOf(ClaudeNativeOAuthError)
    expect(error.message).not.toContain('private')
    expect(f.child.terminate).toHaveBeenCalledOnce()
  })
  it('rejects malformed route args before spawning any process', async () => {
    const f = fixture()
    await expect(
      discoverClaudeNativeOAuth(
        f.backend,
        DEFAULT_CONFIG,
        '/synthetic',
        '/synthetic',
        new AbortController().signal,
        [],
      ),
    ).rejects.toBeInstanceOf(ClaudeNativeOAuthError)
    expect(f.backend.spawn).not.toHaveBeenCalled()
  })
})
