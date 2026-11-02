import { syntheticNativeAcl, exposeSyntheticNativePath, recordSyntheticNativePrivacy } from './fixtures/native-file-privacy.ts'
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, chmodSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { grokContextStatus } from '../src/host/grok-response.mjs'
import { readGrokDurableContextAsync as readGrokDurableContext, GrokDurableContextObserver } from '../src/host/grok-durable-context.mjs'
import { runNativeGrok } from '../src/host/native-grok.mjs'

// Synthetic offline protocol fixtures. No account, model request or real user storage.
const expected = { sessionId: 'session', modelId: 'chosen', project: '/synthetic' }
const status = (used: unknown = 0) => ({ jsonrpc: '2.0', method: '_x.ai/session_notification', params: {
  sessionId: 'session', update: { sessionUpdate: 'session_status', schema_version: 1,
    session_id: 'session', cwd: '/synthetic', workspace: { current_dir: '/synthetic' },
    model: { id: 'chosen' }, context_window: { context_tokens: used, context_window_size: 500000 } },
} })
const row = (update: any, meta: any = {}) => ({ method: 'session/update', params: { sessionId: 'session', update, _meta: meta } })
const receipt = (used: unknown, promptId = 'prompt') => [
  row({ sessionUpdate: 'agent_message_chunk' }, { promptId, totalTokens: used }),
  row({ sessionUpdate: 'turn_completed', prompt_id: promptId, stop_reason: 'end_turn' }),
]
const config = { ...expected, promptId: 'prompt' }
function storage() {
  const home = mkdtempSync(join(tmpdir(), 'grok-context-mock-'))
  const root = join(home, 'sessions', encodeURIComponent(expected.project), expected.sessionId)
  mkdirSync(root, { recursive: true, mode: 0o700 })
  // recursive mkdir creates each directory private with this mode.
  writeFileSync(join(root, 'summary.json'), JSON.stringify({ info: { id: 'session', cwd: '/synthetic' }, current_model_id: 'chosen' }), { mode: 0o600 })
  const path = join(root, 'updates.jsonl')
  writeFileSync(path, '', { mode: 0o600 })
  writeFileSync(join(root, 'signals.json'), JSON.stringify({ contextTokensUsed: 1477, contextWindowTokens: 256000 }), { mode: 0o600 })
  syntheticNativeAcl([home, join(home, 'sessions'), join(home, 'sessions', encodeURIComponent(expected.project)), root,
    ...['summary.json', 'updates.jsonl', 'signals.json'].map(name => join(root, name))].map(path => ({ path })))
  const append = (records: any[]) => appendFileSync(path, records.map(r => JSON.stringify(r)).join('\n') + '\n')
  return { home, root, path, append, clear: () => rmSync(home, { recursive: true, force: true }) }
}
describe('Grok native context status', () => {
  it('preserves native zero and null without deriving from percentages or bills', () => {
    expect(grokContextStatus(status(), expected)).toMatchObject({ contextUsed: 0, contextCapacity: 500000 })
    expect(grokContextStatus(status(null), expected)).toMatchObject({ contextUsed: null })
    const missing = status(); delete (missing.params.update.context_window as any).context_tokens
    expect(grokContextStatus(missing, expected)).toMatchObject({ contextUsed: null })
    for (const invalid of [-1, 1.5, '0', Number.MAX_SAFE_INTEGER + 1])
      expect(grokContextStatus(status(invalid), expected)).toBeUndefined()
  })
  it('rejects replay, foreign identity, cwd, model and unsupported rail', () => {
    for (const mutate of [
      (s: any) => s.params.sessionId = 'other', (s: any) => s.params.update.session_id = 'other',
      (s: any) => s.params.update.model.id = 'other', (s: any) => s.params.update.cwd = '/other',
      (s: any) => s.params.update.workspace.current_dir = '/other',
      (s: any) => s.params._meta = { isReplay: true }, (s: any) => s.method = 'session/update',
      (s: any) => s.params.update.context_window.context_window_size = 0,
    ]) { const s = status(); mutate(s); expect(grokContextStatus(s, expected)).toBeUndefined() }
  })
  it('subscribes at initialize, handles model updates, keeps live status authoritative and cleans peer', async () => {
    const records: any[] = [], requests: any[] = []; let onMessage: any, closed = 0
    const peer = { request: async (method: string, params: any) => {
      requests.push({ method, params })
      if (method === 'initialize') return { protocolVersion: 1 }
      if (method === 'session/new') return { sessionId: 'session', configOptions: [{ id: 'model', currentValue: 'chosen', options: [{ value: 'chosen' }] }] }
      if (method === 'session/prompt') {
        const models = { jsonrpc: '2.0', method: '_x.ai/models/update', params: { currentModelId: 'chosen', availableModels: [{ modelId: 'chosen', _meta: { totalContextTokens: 256000 } }] } }
        onMessage(models); onMessage(status(0)); onMessage(models)
        return { stopReason: 'end_turn' }
      }
      return {}
    }, send: async () => {}, end() {}, close: async () => { closed++ } }
    await runNativeGrok({ argv: ['mock'], project: '/synthetic', preference: { model: 'chosen', effort: 'default' }, mode: 'accept-edits', prompt: 'mock' }, {
      signal: new AbortController().signal, native: (r: any) => records.push(r), session() {}, event() {}, result() {},
      openStdio: async (_argv: any, options: any) => { onMessage = options.onMessage; return peer },
    })
    expect(requests[0].params.clientCapabilities).toEqual({ _meta: { 'x.ai/statusLine': true } })
    expect(records.filter(r => r.type === 'cliworker.grok_model_context')).toHaveLength(1)
    expect(records.filter(r => r.type === 'cliworker.grok_context')).toEqual([expect.objectContaining({ contextUsed: 0, contextCapacity: 500000 })])
    expect(closed).toBe(1)
  })
})
describe('Grok exact durable context receipt', () => {
  it('reads exact completed prompt count and only matching native signals capacity', async () => {
    const s = storage()
    try {
      s.append(receipt(1477))
      expect((await readGrokDurableContext({ ...config, home: s.home }))).toMatchObject({ contextUsed: 1477, contextCapacity: 256000 })
      expect((await readGrokDurableContext({ ...config, home: s.home, promptId: 'other' }))).toBeUndefined()
      expect((await readGrokDurableContext({ ...config, home: s.home, modelId: 'other' }))).toBeUndefined()
      writeFileSync(join(s.root, 'signals.json'), JSON.stringify({ contextTokensUsed: 1, contextWindowTokens: 500000 }))
      expect((await readGrokDurableContext({ ...config, home: s.home }))).not.toHaveProperty('contextCapacity')
    } finally { s.clear() }
  })
  it('rejects incomplete/null receipts, later prompts, symlinks and public files', async () => {
    for (const kind of ['null', 'incomplete', 'newer', 'public', 'symlink']) {
      const s = storage()
      try {
        s.append(receipt(kind === 'null' ? null : 1477).slice(0, kind === 'incomplete' ? 1 : 2))
        if (kind === 'newer') s.append(receipt(2, 'newer'))
        if (kind === 'public') exposeSyntheticNativePath(s.path)
        if (kind === 'symlink') { const target = join(s.root, 'other'); writeFileSync(target, '', { mode: 0o600 }); rmSync(s.path); symlinkSync(target, s.path) }
        expect((await readGrokDurableContext({ ...config, home: s.home }))).toBeUndefined()
      } finally { s.clear() }
    }
  })
  it('ignores unchanged pre-run receipts, accepts delayed append, and rejects mismatched terminal identity', async () => {
    const s = storage(), output: any[] = []
    const result = { stopReason: 'end_turn', _meta: { sessionId: 'session', modelId: 'chosen', promptId: 'prompt' } }
    const io = { native: (r: any) => output.push(r), signal: new AbortController().signal }
    try {
      s.append(receipt(1477))
      const observer = new GrokDurableContextObserver({ ...config, home: s.home, preference: { model: 'chosen' } })
      await observer.prepare('session')
      await observer.finish(result, 'session', io)
      expect(output).toEqual([])
      await observer.prepare('session')
      const append = setTimeout(() => s.append(receipt(2)), 30)
      try { await observer.finish(result, 'session', io) } finally { clearTimeout(append) }
      expect(output).toEqual([expect.objectContaining({ contextUsed: 2 })])
      await observer.prepare('session'); s.append(receipt(3))
      await observer.finish({ ...result, _meta: { ...result._meta, modelId: 'other' } }, 'session', io)
      expect(output).toHaveLength(1)
    } finally { s.clear() }
  })
  it('requires bytes appended after prepare and drops cancelled or repeated finish', async () => {
    const s = storage(), output: any[] = []
    const result = { stopReason: 'end_turn', _meta: { sessionId: 'session', modelId: 'chosen', promptId: 'prompt' } }
    try {
      s.append(receipt(1477))
      const observer = new GrokDurableContextObserver({ ...config, home: s.home, preference: { model: 'chosen' } })
      await observer.prepare('session')
      const cancelled = new AbortController(); cancelled.abort()
      s.append(receipt(0))
      await observer.finish(result, 'session', { native: (r: any) => output.push(r), signal: cancelled.signal })
      expect(output).toEqual([])
      await observer.prepare('session'); s.append(receipt(0))
      await observer.finish(result, 'session', { native: (r: any) => output.push(r), signal: new AbortController().signal })
      expect(output).toEqual([expect.objectContaining({ contextUsed: 0 })])
      await observer.finish(result, 'session', { native: (r: any) => output.push(r) })
      expect(output).toHaveLength(1)
    } finally { s.clear() }
  })
})

afterEach(() => recordSyntheticNativePrivacy('grok-status'))
