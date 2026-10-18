import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, symlinkSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Worker } from '../src/shared/types.ts'
import { NativeSupplementalContextReader } from '../src/host/native-supplemental-context.ts'
import { syntheticNativeAcl, recordSyntheticNativePrivacy } from './fixtures/native-file-privacy.ts'
import { extractTelemetry, TelemetryReader } from '../src/host/telemetry.ts'
const roots: string[] = []
afterEach(() => roots.splice(0).forEach(p => rmSync(p, { recursive: true, force: true })))
const binding = { sessionId: 'sess_SIMULATED-session', turnId: 'turn_SIMULATED', requestId: 'request_SIMULATED', traceId: 'trace_SIMULATED', model: 'provider/model' }
function fixture(cli = 'zcode') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cwn-SIMULATED-supplement-'))); roots.push(root)
  const worker = { id: 'worker-SIMULATED', project: root, preference: { cli, model: 'TODAY/DIFFERENT' } } as Worker
  const input = { worker, runId: 'run-SIMULATED', rawPath: join(root, `${worker.id}.run-SIMULATED.raw.jsonl`), storageDirectory: root }
  const start = { method: 'session/event', params: { type: 'session.updated', sessionId: binding.sessionId, turnId: binding.turnId, traceId: binding.traceId,
    payload: { type: 'model_request_started', querySource: 'main_turn', sessionId: binding.sessionId, requestId: binding.requestId, traceId: binding.traceId, providerId: 'provider', modelId: 'model' } } }
  const file = join(root, 'native', worker.id, 'storage/cli/rollout', `model-io-${binding.sessionId}.jsonl`)
  mkdirSync(join(root, 'native', worker.id, 'storage/cli/rollout'), { recursive: true })
  const record = { type: 'model_io', querySource: 'main_turn', ...binding, model: { providerId: 'provider', modelId: 'model' }, request: {
    body: { model: 'model', system: 'SIMULATED-system', tools: [] }, messagesKind: 'full', messageOffset: 0, messageCount: 1,
    messages: [{ role: 'user', content: 'SIMULATED-message' }] } }
  const write = (rows: any[]) => writeFileSync(input.rawPath, rows.map(r => JSON.stringify({ type: 'native', record: r })).join('\n') + '\n')
  write([start]); writeFileSync(file, JSON.stringify(record) + '\n')
  return { input, root, file, start, record, write }
}
const observation = (breakdown: any) => ({ type: 'cliworker.zcode_context_observation', cli: 'zcode', source: 'zcode.native-model-io', ...binding, breakdown })
const breakdown = { systemTokens: 7, toolTokens: 0, messageTokens: 9, estimated: true, basis: 'zcode.estimateTokens.v1.actual-request' }
it('supplements exact old request using its own model, independent of current preference and pressure', () => {
  const f = fixture(), r = new NativeSupplementalContextReader().read(f.input)
  expect(r.contextBreakdown).toMatchObject({ systemTokens: 6, toolTokens: 0, estimated: true })
  expect(r).not.toHaveProperty('contextUsed'); expect(r).not.toHaveProperty('contextCapacity')
})
it('preserves raw explicit unknown and raw known composition over later disk changes', () => {
  const f = fixture(), reader = new NativeSupplementalContextReader()
  f.write([f.start, observation(null)])
  expect(reader.read(f.input)).toEqual({ contextBreakdown: undefined })
  f.write([f.start, observation(breakdown)])
  expect(reader.read(f.input).contextBreakdown).toMatchObject({ systemTokens: 7 })
})
it('invalidates cached disk composition on change and missing request, no stale old classification', () => {
  const f = fixture(), reader = new NativeSupplementalContextReader()
  expect(reader.read(f.input).contextBreakdown).toBeDefined()
  writeFileSync(f.file, '')
  expect(reader.read(f.input)).toEqual({ contextBreakdown: undefined })
  f.write([]); expect(reader.read(f.input)).toEqual({})
})
it('refuses another run raw path, unsafe symlinks, malformed and oversized raw', () => {
  const f = fixture(), reader = new NativeSupplementalContextReader()
  expect(reader.read({ ...f.input, runId: 'OTHER' })).toEqual({})
  const copy = f.input.rawPath + '.copy'; writeFileSync(copy, '{}\n'); rmSync(f.input.rawPath); symlinkSync(copy, f.input.rawPath)
  expect(reader.read(f.input)).toEqual({}); rmSync(f.input.rawPath)
  writeFileSync(f.input.rawPath, 'broken\n'); expect(reader.read(f.input)).toEqual({})
  writeFileSync(f.input.rawPath, ' '.repeat(16 * 1024 * 1024 + 1)); expect(reader.read(f.input)).toEqual({})
})
it('clears classification through actual TelemetryReader without turning classification estimates into pressure', () => {
  const f = fixture(), reader = new TelemetryReader()
  const pressure = { result: { projection: { sessionId: binding.sessionId, contextUsed: 123, contextWindow: 2000 } } }
  f.write([pressure, observation(breakdown)])
  expect(reader.read(f.input.rawPath, 'zcode', { conversationId: binding.sessionId, model: binding.model })).toMatchObject({ contextUsed: 123, contextBreakdown: { systemTokens: 7 } })
  f.write([pressure, observation(breakdown), observation(null)])
  expect(reader.read(f.input.rawPath, 'zcode', { conversationId: binding.sessionId, model: binding.model }).contextBreakdown).toBeUndefined()
  expect(extractTelemetry('zcode', [observation(breakdown)], { conversationId: binding.sessionId, model: binding.model }).contextUsed).toBeUndefined()
})
function status(project: string, tokens: number | null) { return { method: '_x.ai/session_notification', params: { sessionId: 'SIMULATED-session', update: {
  sessionUpdate: 'session_status', session_id: 'SIMULATED-session', schema_version: 1, cwd: project, workspace: { current_dir: project },
  model: { id: 'SIMULATED-model' }, context_window: { context_tokens: tokens, context_window_size: 256000 } } } } }
it('uses exact Grok raw official status including native zero and explicit null; refuses foreign cwd', () => {
  const f = fixture('grok'), reader = new NativeSupplementalContextReader()
  f.write([status(f.root, 0)])
  expect(reader.read(f.input)).toMatchObject({ contextUsed: 0, contextCapacity: 256000 })
  f.write([status(f.root, null)]); expect(reader.read(f.input)).toHaveProperty('contextUsed', undefined)
  f.write([status('FOREIGN', 22)]); expect(reader.read(f.input)).toEqual({})
})
it('raw Grok status survives numeric-only TelemetryReader cache and wins over durable/capacity fallback', () => {
  const f = fixture('grok'); f.write([status(f.root, null), { type: 'cliworker.grok_context', source: 'grok.durable.updates', sessionId: 'SIMULATED-session', modelId: 'SIMULATED-model', contextUsed: 999, basis: 'native-estimate' },
    { type: 'cliworker.grok_model_context', sessionId: 'SIMULATED-session', modelId: 'SIMULATED-model', contextCapacity: 1000000 }])
  const t = new TelemetryReader().read(f.input.rawPath, 'grok', { conversationId: 'SIMULATED-session', model: 'SIMULATED-model', project: f.root })
  expect(t.contextUsed).toBeUndefined(); expect(t.contextCapacity).toBe(256000)
})

it('reads Grok exact completed RPC prompt under only selected Worker home, never billed raw fallback', async () => {
  const f = fixture('grok'), reader = new NativeSupplementalContextReader()
  const sessionId = 'SIMULATED-session', modelId = 'SIMULATED-model', promptId = 'SIMULATED-prompt'
  const home = join(f.root, 'native', f.input.worker.id, 'grok', createHash('sha256').update(f.root).digest('hex'), 'home')
  let dir = home
  for (const part of ['', 'sessions', encodeURIComponent(f.root), sessionId]) {
    if (part) dir = join(dir, part)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
  }
  const write = (name: string, value: any) => writeFileSync(join(dir, name), typeof value === 'string' ? value : JSON.stringify(value), { mode: 0o600 })
  write('summary.json', { info: { id: sessionId, cwd: f.root }, current_model_id: modelId })
  write('signals.json', { contextTokensUsed: 1477, contextWindowTokens: 256000 })
  write('updates.jsonl', [
    { method: 'session/update', params: { sessionId, _meta: { promptId, totalTokens: 1477 }, update: { sessionUpdate: 'agent_message_chunk' } } },
    { method: 'session/update', params: { sessionId, update: { sessionUpdate: 'turn_completed', prompt_id: promptId, stop_reason: 'end_turn' } } },
  ].map(r => JSON.stringify(r)).join('\n') + '\n')
  f.write([{ type: 'session', id: sessionId, model: modelId },
    { method: 'session/update', params: { sessionId, _meta: { totalTokens: 14223 } } },
    { id: 'rpc', result: { stopReason: 'end_turn', _meta: { sessionId, modelId, promptId } } }])
  syntheticNativeAcl([home, join(home, 'sessions'), join(home, 'sessions', encodeURIComponent(f.root)), dir,
    ...['summary.json', 'updates.jsonl', 'signals.json'].map(name => join(dir, name))].map(path => ({ path })))
  await vi.waitFor(() => expect(reader.read(f.input)).toMatchObject({ contextUsed: 1477, contextCapacity: 256000 }), { timeout: 12000 })
  f.write([{ type: 'session', id: sessionId, model: modelId }, { id: 'rpc', result: { stopReason: 'end_turn', _meta: { sessionId, modelId, promptId: 'FOREIGN-prompt' } } }])
  expect(reader.read(f.input)).toEqual({})
  reader.clear()
})
it('selected model switch invalidates current raw A while historical A remains bound to its own request', () => {
  const f = fixture(), reader = new NativeSupplementalContextReader()
  const identityA = { conversationId: binding.sessionId, model: binding.model }
  const currentA = { ...f.input, currentIdentity: identityA }
  expect(reader.read(currentA).contextBreakdown).toBeDefined()
  // This is an actual same-reader selection transition, not a second instance:
  // unchanged raw/native files must not reuse the A cache for B.
  f.input.worker.preference.model = 'provider/model-B'
  const b = reader.read({ ...f.input, currentIdentity: { ...identityA, model: 'provider/model-B' } })
  for (const field of ['contextUsed','contextCapacity','contextBreakdown','contextSource'])
    expect(b).toHaveProperty(field, undefined)
  expect(reader.read(f.input).contextBreakdown).toBeDefined() // historical run
  expect(reader.read(currentA).contextBreakdown).toBeDefined() // A identity cache remains independent
})
it('missing/foreign current identity is unknown and cannot resurrect raw classification on cold restore', () => {
  const f = fixture()
  for (const currentIdentity of [{}, { conversationId: 'sess_FOREIGN', model: binding.model }, { conversationId: binding.sessionId }]) {
    const r = new NativeSupplementalContextReader().read({ ...f.input, currentIdentity })
    expect(r).toHaveProperty('contextBreakdown', undefined)
    expect(r).toHaveProperty('contextUsed', undefined)
  }
})
it('Grok current model mismatch clears the old native status; historical prompt remains readable', () => {
  const f = fixture('grok'), reader = new NativeSupplementalContextReader()
  f.write([status(f.root, 1477)])
  expect(reader.read(f.input).contextUsed).toBe(1477)
  expect(reader.read({ ...f.input, currentIdentity: { conversationId: 'SIMULATED-session', model: 'OTHER-model' } })).toHaveProperty('contextUsed', undefined)
  expect(reader.read({ ...f.input, currentIdentity: { conversationId: 'SIMULATED-session', model: 'SIMULATED-model' } }).contextUsed).toBe(1477)
})
it('absence of supplemental request evidence preserves valid native projection under explicit current identity', () => {
  const f = fixture(), reader = new NativeSupplementalContextReader()
  const projection = { result: { projection: { sessionId: binding.sessionId, contextUsed: 123, contextWindow: 2000, currentTurnId: 'known-turn', turnCount: 1 } } }
  f.write([{ type: 'session', id: binding.sessionId, model: binding.model }, projection])
  const input = { ...f.input, currentIdentity: { conversationId: binding.sessionId, model: binding.model } }
  const primary = new TelemetryReader().read(f.input.rawPath, 'zcode', input.currentIdentity)
  expect(reader.read(input)).toEqual({})
  expect({ ...primary, ...reader.read(input) }).toMatchObject({ contextUsed: 123, contextCapacity: 2000 })
  // The same no-start boundary must preserve a verified previous checkpoint too.
  f.write([])
  expect(reader.read(input)).toEqual({})
  rmSync(f.input.rawPath)
  expect(reader.read(input)).toEqual({})
})
it('session declarations or malformed starts alone do not constitute a mismatched supplemental observation', () => {
  const f = fixture(), reader = new NativeSupplementalContextReader()
  const malformed = structuredClone(f.start); delete (malformed.params as any).turnId
  f.write([malformed])
  expect(reader.read({ ...f.input, currentIdentity: { conversationId: binding.sessionId, model: 'provider/new-selection' } })).toEqual({})
  const g = fixture('grok')
  g.write([{ type: 'session', id: 'SIMULATED-session', model: 'OLD-model' }])
  expect(reader.read({ ...g.input, currentIdentity: { conversationId: 'SIMULATED-session', model: 'NEW-model' } })).toEqual({})
  expect(reader.read({ ...g.input, currentIdentity: {} })).toEqual({})
})

afterEach(() => recordSyntheticNativePrivacy('history'))
