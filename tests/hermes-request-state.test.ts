import { afterEach, describe, expect, it, vi } from 'vitest'
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { hermesObservedRequestState, prepareHermesObserver } from '../src/host/hermes-observer.mjs'

// All lifecycle events, Hermes modules and files are explicit offline fixtures.
const roots: string[] = []
afterEach(() => roots.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })))
function root() {
  const path = realpathSync(mkdtempSync(join(tmpdir(), 'cwn-hermes-state-SIMULATED-')))
  chmodSync(path, 0o700); roots.push(path); return path
}
const start = { phase: 'request', session_id: 'synthetic-session', task_id: 'synthetic-session',
  turn_id: 'synthetic-turn', api_request_id: 'synthetic-request', api_call_count: 1,
  provider: 'synthetic', model: 'synthetic-model', api_mode: 'chat_completions', retry_count: 0 }
const error = { ...start, phase: 'error', status_code: 429, reason: 'upstream_rate_limit',
  retryable: true, max_retries: 3, error: { message: 'SYNTHETIC_SECRET', type: 'RateLimitError' } }
const requestState = (value: object) => hermesObservedRequestState({ seq: 12, ...value }, 'synthetic-run', start.session_id)
async function fixture() {
  const capture = await prepareHermesObserver(root(), { provider: start.provider, model: start.model })
  await capture.bind(start.session_id); capture.bindRun('synthetic-run')
  const path = join(capture.env.CLIWORKER_HERMES_OBSERVER_DIR, 'events.jsonl')
  let sequence = 0
  const put = (value: object) => appendFileSync(path, JSON.stringify({ v: 1,
    nonce: capture.env.CLIWORKER_HERMES_OBSERVER_NONCE, seq: ++sequence, ...value }) + '\n')
  put({ phase: 'ready' })
  return { capture, path, put }
}

describe('Hermes actual observer occurrence status schema', () => {
  it('retains only safe native error fields and does not create retry scheduling', () => {
    expect(requestState({ ...error, request: { key: 'SYNTHETIC_SECRET' }, delayMs: 30000 }))
      .toEqual({ type: 'hermes.request-state', runId: 'synthetic-run', sessionId: start.session_id,
        sequence: 12, phase: 'failed', statusCode: 429, reason: 'upstream_rate_limit', retryCount: 0,
        maxRetries: 3, retryable: true })
    expect(requestState(start)).toEqual({ type: 'hermes.request-state', runId: 'synthetic-run',
      sessionId: start.session_id, sequence: 12, phase: 'requesting', retryCount: 0 })
    expect(requestState({ ...start, phase: 'response' })).toMatchObject({ phase: 'completed', sequence: 12 })
  })
  it('never infers error cause from HTTP 429 or accepts unrecognized text', () => {
    const value = requestState({ ...error, reason: 'SYNTHETIC_SECRET', status_code: 999,
      retry_count: -1, max_retries: 1.5, retryable: 'true' })!
    expect(value).toEqual({ type: 'hermes.request-state', runId: 'synthetic-run', sessionId: start.session_id,
      sequence: 12, phase: 'failed' })
  })
  it.each([{ seq: 0 }, { seq: 1.5 }, { session_id: 'foreign' }, { task_id: 'foreign' }, { phase: 'unknown' }])
    ('rejects unbound or invalid occurrence fields %j', patch => {
      expect(requestState({ ...start, ...patch })).toBeUndefined()
    })
  it('does not publish a request before its native run has been accepted', async () => {
    const capture = await prepareHermesObserver(root(), { provider: start.provider, model: start.model })
    try {
      await capture.bind(start.session_id)
      expect(() => capture.startPolling(() => {})).toThrow(/lifecycle/)
    } finally { await capture.close() }
  })
})

describe('Hermes serial observer polling without SSE traffic', () => {
  it('publishes requesting/error immediately while no stream event arrives', async () => {
    const f = await fixture(), records: any[] = [], controller = new AbortController()
    const stop = f.capture.startPolling((value: any) => records.push(value), { intervalMs: 10, signal: controller.signal })
    try {
      f.put(start)
      await vi.waitFor(() => expect(records).toHaveLength(1), { interval: 10, timeout: 1000 })
      f.put(error)
      await vi.waitFor(() => expect(records).toHaveLength(2), { interval: 10, timeout: 1000 })
      expect(records.map(value => [value.sequence, value.phase])).toEqual([[2, 'requesting'], [3, 'failed']])
      controller.abort(); await stop()
      f.put(start)
      await new Promise(resolve => setTimeout(resolve, 30))
      expect(records).toHaveLength(2)
      expect(JSON.stringify(records)).not.toMatch(/SYNTHETIC_SECRET|delayMs|llm\/retry/)
    } finally { await f.capture.close() }
    expect(existsSync(f.path)).toBe(false)
  })
  it('does not deduplicate real occurrences when logical request and retry count reset', async () => {
    const f = await fixture(), records: any[] = []
    try {
      f.put(start); f.put(error)
      f.put({ ...start, retry_count: 1 }); f.put({ ...error, retry_count: 1 })
      f.put(start); f.put(error)
      await Promise.all(Array.from({ length: 12 }, () => f.capture.read((value: any) => records.push(value))))
      expect(records.map(value => value.sequence)).toEqual([2, 3, 4, 5, 6, 7])
      expect(records.map(value => value.phase)).toEqual(['requesting', 'failed', 'requesting', 'failed', 'requesting', 'failed'])
      await f.capture.finish((value: any) => records.push(value))
      expect(records.at(-1)).toMatchObject({ requestCount: 3, errorCount: 3, usageComplete: false })
    } finally { await f.capture.close() }
  })
  it('emits completed for an actual post even when its usage cannot be billed', async () => {
    const f = await fixture(), records: any[] = []
    try {
      // The installed post_api_request does not include retry_count, even
      // though its preceding pre_api_request and api_request_error do.
      const { retry_count: _retry, ...post } = start
      f.put(start); f.put({ ...post, phase: 'response', usage: {} })
      await f.capture.read((value: any) => records.push(value))
      expect(records.map(value => value.phase)).toEqual(['requesting', 'completed'])
      expect(records.some(value => value.type === 'cliworker.hermes_observation')).toBe(false)
    } finally { await f.capture.close() }
  })
  it.each(['session_id', 'task_id', 'model', 'provider', 'turn_id', 'retry_count'])
    ('refuses a mismatched error %s', async key => {
      const f = await fixture(), records: any[] = []
      try {
        f.put(start); f.put({ ...error, [key]: key === 'retry_count' ? 9 : 'foreign' })
        expect(await f.capture.read((value: any) => records.push(value))).toBe(false)
        expect(records.map(value => value.phase)).toEqual(['requesting'])
      } finally { await f.capture.close() }
    })
  it('serializes polling, concurrent reads and finish without duplicate states or summaries', async () => {
    const f = await fixture(), records: any[] = []
    f.capture.startPolling((value: any) => records.push(value), { intervalMs: 10 })
    try {
      f.put(start); f.put(error)
      await Promise.all([f.capture.read((value: any) => records.push(value)),
        f.capture.read((value: any) => records.push(value)),
        f.capture.finish((value: any) => records.push(value)),
        f.capture.finish((value: any) => records.push(value))])
      expect(records.filter(value => value.type === 'hermes.request-state').map(value => value.sequence)).toEqual([2, 3])
      expect(records.filter(value => value.type === 'cliworker.hermes_observer_summary')).toHaveLength(1)
      expect(await f.capture.read((value: any) => records.push(value))).toBe(false)
    } finally { await f.capture.close() }
  })
  it('waits for an in-flight read before closing and never emits after close resolves', async () => {
    const f = await fixture(), records: any[] = []
    f.put(start); f.put(error)
    const pending = f.capture.read((value: any) => records.push(value))
    await Promise.all([pending, f.capture.close(), f.capture.close()])
    const size = records.length
    expect(await f.capture.read((value: any) => records.push(value))).toBe(false)
    await f.capture.finish((value: any) => records.push(value))
    expect(records).toHaveLength(size)
    expect(existsSync(f.path)).toBe(false)
  })
  it('closes an active poll and removes its wait timer without a late read', async () => {
    const f = await fixture(), records: any[] = []
    f.capture.startPolling((value: any) => records.push(value), { intervalMs: 10 })
    f.put(start)
    await vi.waitFor(() => expect(records).toHaveLength(1), { interval: 10, timeout: 1000 })
    await f.capture.close()
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(records).toHaveLength(1)
    expect(existsSync(f.path)).toBe(false)
  })
  it('never polls or emits for an already-cancelled run', async () => {
    const f = await fixture(), records: any[] = [], controller = new AbortController()
    controller.abort(); f.put(start)
    const stop = f.capture.startPolling((value: any) => records.push(value), { signal: controller.signal })
    await stop(); await f.capture.close()
    expect(records).toEqual([])
  })
})

it.skipIf(process.platform === 'win32')('Python official hook bridge copies safe failure enums, not provider payloads (simulated API)', () => {
  const base = root(), python = join(base, 'hermes_cli'), directory = join(base, 'capture')
  mkdirSync(python); mkdirSync(directory, { mode: 0o700 })
  writeFileSync(join(python, '__init__.py'), '')
  writeFileSync(join(python, 'plugins.py'), `# SIMULATED public plugin API, no model calls\ncallbacks={}\nclass PluginManifest:\n def __init__(self, **kw): pass\nclass Handle:\n def __init__(self, key): self.key=key\n def dispose(self): callbacks.pop(self.key,None)\nclass PluginContext:\n def __init__(self, *args): pass\n def register_hook(self, name, callback): callbacks[name]=callback;return Handle(name)\ndef get_plugin_manager(): return object()\n`)
  writeFileSync(join(directory, 'events.jsonl'), '', { mode: 0o600 })
  const nonce = 'b'.repeat(64)
  writeFileSync(join(directory, 'identity.json'), JSON.stringify({ nonce, sessionId: start.session_id,
    provider: start.provider, model: start.model }), { mode: 0o600 })
  const script = `import sys,runpy,json\nsys.path.insert(0,sys.argv[1])\ndispose=runpy.run_path(sys.argv[2])['install_observer']()\nfrom hermes_cli.plugins import callbacks\npayload=json.loads(sys.argv[3])\ncallbacks['pre_api_request'](**payload)\npayload.update(json.loads(sys.argv[4]))\ncallbacks['api_request_error'](**payload)\npayload.update(reason='SYNTHETIC_SECRET',status_code=999,retryable='true',max_retries=-1)\ncallbacks['pre_api_request'](**payload)\ncallbacks['api_request_error'](**payload)\ndispose();assert not callbacks\n`
  execFileSync('/usr/bin/python3', ['-B', '-I', '-c', script, base, resolve('src/host/hermes-observer.py'),
    JSON.stringify({ ...start, platform: 'api_server', request: 'SYNTHETIC_SECRET', base_url: 'SYNTHETIC_SECRET' }),
    JSON.stringify(error)], { env: { HOME: base, HERMES_HOME: base, HERMES_SAFE_MODE: '1',
      CLIWORKER_HERMES_OBSERVER_DIR: directory, CLIWORKER_HERMES_OBSERVER_NONCE: nonce } })
  const text = readFileSync(join(directory, 'events.jsonl'), 'utf8')
  expect(text).not.toContain('SYNTHETIC_SECRET')
  const errors = text.trim().split('\n').map(line => JSON.parse(line)).filter(value => value.phase === 'error')
  expect(errors[0]).toMatchObject({ status_code: 429, reason: 'upstream_rate_limit', retry_count: 0, max_retries: 3, retryable: true })
  expect(errors[1]).not.toHaveProperty('reason')
  expect(errors[1]).not.toHaveProperty('status_code')
  expect(errors[1]).not.toHaveProperty('retryable')
  expect(errors[1]).not.toHaveProperty('max_retries')
})
