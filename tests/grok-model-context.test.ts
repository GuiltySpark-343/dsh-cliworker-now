import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { grokModelContext } from '../src/host/grok-response.mjs'
import { runNativeGrok } from '../src/host/native-grok.mjs'
import { extractTelemetry, TelemetryReader } from '../src/host/telemetry.ts'

// Offline synthetic ACP metadata: never starts Grok or accesses an account.
const selected = { modelId: 'chosen', _meta: { totalContextTokens: 200, contextWindows: [200, 400] } }
const state = (model = selected, currentModelId = 'chosen') => ({ models: { currentModelId, availableModels: [model] } })
describe('Grok exact model context metadata', () => {
  it('uses only the exact active model and its advertised current window', () => {
    expect(grokModelContext(state(), 'chosen')).toBe(200)
    expect(grokModelContext(state({ ...selected, _meta: { ...selected._meta, contextWindow: 400 } }), 'chosen')).toBe(400)
    expect(grokModelContext({ _meta: { modelState: state().models } }, 'chosen')).toBe(200)
    expect(grokModelContext(state(), 'other')).toBeUndefined()
    expect(grokModelContext(state(selected, 'old'), 'chosen')).toBeUndefined()
    expect(grokModelContext({ models: { ...state().models, availableModels: [selected, selected] } }, 'chosen')).toBeUndefined()
    expect(grokModelContext({ ...state(), _meta: { modelState: state().models } }, 'chosen')).toBeUndefined()
  })
  it.each([undefined, null, 0, -1, 1.5, '400', 999, Number.MAX_SAFE_INTEGER + 1])('keeps present invalid/unsupported override %s unknown', (contextWindow) => {
    expect(grokModelContext(state({ ...selected, _meta: { ...selected._meta, contextWindow } } as any), 'chosen')).toBeUndefined()
  })
  it('keeps absent or invalid capacity unknown', () => {
    for (const totalContextTokens of [undefined, null, 0, -1, '200', Number.MAX_SAFE_INTEGER + 1])
      expect(grokModelContext(state({ ...selected, _meta: { totalContextTokens } } as any), 'chosen')).toBeUndefined()
  })
  it('emits an identity scoped observation only after model confirmation and reads it independently of bills', async () => {
    const records: any[] = []
    const nativeState = { ...state(), sessionId: 'session', configOptions: [
      { id: 'model', currentValue: 'chosen', options: [{ value: 'chosen' }] },
    ] }
    const peer = { request: async (method: string) => method === 'initialize' ? { protocolVersion: 1 } :
      method === 'session/new' ? nativeState : { stopReason: 'end_turn' },
    send: async () => {}, end() {}, close: async () => {} }
    await runNativeGrok({ argv: ['synthetic'], project: '/synthetic', preference: { model: 'chosen', effort: 'default' },
      mode: 'accept-edits', prompt: 'synthetic' }, {
      signal: new AbortController().signal, native: (record: any) => records.push(record),
      session() {}, event() {}, result() {}, openStdio: async () => peer,
    })
    expect(records).toEqual([{ type: 'cliworker.grok_model_context', sessionId: 'session', modelId: 'chosen', contextCapacity: 200 }])
    const id = { conversationId: 'session', model: 'chosen' }
    expect(extractTelemetry('grok', records, id)).toMatchObject({ contextCapacity: 200 })
    expect(extractTelemetry('grok', records, id).runUsage).toBeUndefined()
    const root = mkdtempSync(join(tmpdir(), 'grok-context-synthetic-'))
    try {
      const path = join(root, 'synthetic.jsonl')
      writeFileSync(path, records.map((record) => JSON.stringify({ type: 'native', record })).join('\n') + '\n')
      expect(new TelemetryReader().read(path, 'grok', id)).toEqual(extractTelemetry('grok', records, id))
    } finally { rmSync(root, { recursive: true, force: true }) }
    for (const wrong of [{ conversationId: 'other', model: 'chosen' }, { conversationId: 'session', model: 'other' }, {}])
      expect(extractTelemetry('grok', records, wrong).contextCapacity).toBeUndefined()
  })
})
