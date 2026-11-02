import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, linkSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { estimateZcodeRequestComposition, readZcodeContextInspections, unknownZcodeContextInspection, zcodeContextBinding, zcodeContextBindings, zcodeNativeTokenEstimate } from '../src/host/zcode-context-observation.mjs'
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
// Explicit synthetic native full-request fixture; no account or provider calls.
const binding = { sessionId: 'sess_SIMULATED-session', turnId: 'turn_SIMULATED', requestId: 'request_SIMULATED', traceId: 'trace_SIMULATED', model: 'SIMULATED-provider/SIMULATED-model' }
const source = () => ({ type: 'model_io', querySource: 'main_turn', ...binding, model: { providerId: 'SIMULATED-provider', modelId: 'SIMULATED-model' }, request: {
  body: { model: 'SIMULATED-model', system: [{ type: 'text', text: '模拟system' }], tools: [{ name: 'SIMULATED-read', description: '模拟工具', input_schema: { type: 'object' } }] },
  messagesKind: 'full', messageOffset: 0, messageCount: 2, messages: [{ role: 'system', content: 'DO_NOT_DOUBLE_COUNT_SYSTEM' }, { role: 'user', content: '模拟hello' }],
} })
const event = () => ({ type: 'session.updated', sessionId: binding.sessionId, turnId: binding.turnId, traceId: binding.traceId,
  payload: { type: 'model_request_started', querySource: 'main_turn', sessionId: binding.sessionId, requestId: binding.requestId, traceId: binding.traceId, providerId: 'SIMULATED-provider', modelId: 'SIMULATED-model' } })
function nativeFile(records: any[] = [source()]) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cwn-SIMULATED-zcode-context-'))); roots.push(root)
  const directory = join(root, 'storage/cli/rollout'); mkdirSync(directory, { recursive: true, mode: 0o700 })
  const path = join(directory, `model-io-${binding.sessionId}.jsonl`)
  writeFileSync(path, records.map(record => JSON.stringify(record)).join('\n') + '\n', { mode: 0o600 })
  return { root, directory, path }
}
const read = (root: string, bindings = [binding]) => readZcodeContextInspections({ nativeDirectory: root, bindings })

describe('ZCode exact native request composition', () => {
  it('uses the installed native UTF16/CJK estimator independently, never a usage denominator', () => {
    expect(zcodeNativeTokenEstimate('中文abc')).toBe(3)
    expect(zcodeNativeTokenEstimate('😀')).toBe(1)
    expect(zcodeNativeTokenEstimate('')).toBe(0)
    const record = { ...source(), usage: { total: 99999999 } }, result = estimateZcodeRequestComposition(record, binding)!
    expect(result.systemTokens).toBe(zcodeNativeTokenEstimate('模拟system'))
    expect(result.toolTokens).toBe(zcodeNativeTokenEstimate(JSON.stringify(record.request.body.tools[0])))
    expect(result.messageTokens).toBe(zcodeNativeTokenEstimate(JSON.stringify(record.request.messages[1])))
    expect(result).not.toHaveProperty('contextUsed'); expect(result).not.toHaveProperty('contextCapacity')
    expect(result).toMatchObject({ estimated: true, basis: 'zcode.estimateTokens.v1.actual-request' })
  })
  it('uses actual system text fallback only when body.system is absent, with explicit empty tools = 0', () => {
    const record = source(); delete (record.request.body as any).system; record.request.body.tools = []
    expect(estimateZcodeRequestComposition(record, binding)).toMatchObject({ systemTokens: zcodeNativeTokenEstimate('DO_NOT_DOUBLE_COUNT_SYSTEM'), toolTokens: 0 })
    delete (record.request.body as any).tools
    expect(estimateZcodeRequestComposition(record, binding)).toBeUndefined()
  })
  it.each(['sessionId', 'turnId', 'requestId', 'traceId'])('rejects a foreign %s', key => {
    expect(estimateZcodeRequestComposition({ ...source(), [key]: 'FOREIGN' }, binding)).toBeUndefined()
  })
  it('rejects model/source mismatches and delta/offset/truncated/ambiguous request sections', () => {
    expect(estimateZcodeRequestComposition({ ...source(), model: { providerId: 'FOREIGN', modelId: 'SIMULATED-model' } }, binding)).toBeUndefined()
    expect(estimateZcodeRequestComposition({ ...source(), querySource: 'title' }, binding)).toBeUndefined()
    for (const change of [{ messagesKind: 'delta' }, { messageOffset: 1 }, { messageCount: 999 }])
      expect(estimateZcodeRequestComposition({ ...source(), request: { ...source().request, ...change } }, binding)).toBeUndefined()
    const record = source(); (record.request.body.system[0] as any).type = 'image'
    expect(estimateZcodeRequestComposition(record, binding)).toBeUndefined()
  })
  it('accepts only exact native started identities and does not bind hidden auxiliary requests', () => {
    const identity = { sessionId: binding.sessionId, turnId: binding.turnId, model: binding.model }
    expect(zcodeContextBinding(event(), identity)).toEqual(binding)
    expect(zcodeContextBinding({ ...event(), traceId: 'FOREIGN' }, identity)).toBeUndefined()
    expect(zcodeContextBinding({ ...event(), turnId: 'FOREIGN' }, identity)).toBeUndefined()
    expect(zcodeContextBinding({ ...event(), payload: { ...event().payload, querySource: 'title' } }, identity)).toBeUndefined()
    expect(zcodeContextBindings([{ type: 'native', record: { method: 'session/event', params: event() } }, { method: 'session/event', params: event() }], identity)).toEqual([binding])
  })
})

describe('selected-worker native rollout read boundary', () => {
  it('reads exact numeric composition without leaking messages, schemas, headers or provider response', () => {
    const { root } = nativeFile([{ ...source(), response: { reasoningText: 'PRIVATE_REASONING' }, requestHeaders: { authorization: 'PRIVATE_KEY' } }])
    const [observation] = read(root)
    expect(observation.breakdown).toMatchObject({ estimated: true })
    expect(JSON.stringify(observation)).not.toMatch(/DO_NOT_DOUBLE_COUNT_SYSTEM|PRIVATE_REASONING|PRIVATE_KEY|input_schema|SIMULATED-read/)
    expect(observation).toMatchObject({ ...binding, source: 'zcode.native-model-io' })
  })
  it('makes unknown newer requests explicit while preserving binding order', () => {
    const { root } = nativeFile(), next = { ...binding, requestId: 'request_SIMULATED-next' }
    const rows = read(root, [binding, next])
    expect(rows[0].breakdown).not.toBeNull(); expect(rows[1].breakdown).toBeNull()
    expect(rows[1]).toEqual(unknownZcodeContextInspection(next))
  })
  it('rejects duplicates, malformed JSON, torn lines and oversized files/records', () => {
    const { root, path } = nativeFile([source(), source()]); expect(read(root)[0].breakdown).toBeNull()
    for (const raw of ['{broken}\n', JSON.stringify(source()), ' '.repeat(8 * 1024 * 1024 + 1), JSON.stringify({ ...source(), privatePadding: 'x'.repeat(2 * 1024 * 1024) }) + '\n', '{}\n'.repeat(4097)]) {
      writeFileSync(path, raw); expect(read(root)[0].breakdown).toBeNull()
    }
  })
  it('rejects symlink files/directories and hard-linked native request files', () => {
    const first = nativeFile(), second = nativeFile()
    rmSync(first.path); symlinkSync(second.path, first.path); expect(read(first.root)[0].breakdown).toBeNull()
    rmSync(first.path); linkSync(second.path, first.path); expect(read(first.root)[0].breakdown).toBeNull()
    rmSync(first.path); rmSync(first.directory, { recursive: true }); symlinkSync(second.directory, first.directory); expect(read(first.root)[0].breakdown).toBeNull()
    const rootAlias = join(first.root, 'alias'); symlinkSync(second.root, rootAlias); expect(read(rootAlias)[0].breakdown).toBeNull()
  })
  it('cannot select another session/path through malformed bindings', () => {
    const { root } = nativeFile()
    expect(read(root, [{ ...binding, sessionId: '../FOREIGN' }])).toEqual([])
    expect(read(root, [binding, { ...binding, sessionId: 'sess_FOREIGN' }])).toEqual([])
    expect(read(root, [binding, { ...binding, model: 'FOREIGN/model' }])).toEqual([])
    expect(readZcodeContextInspections({ nativeDirectory: 'relative', bindings: [binding] })[0].breakdown).toBeNull()
  })
})
