import { expect, it } from 'vitest'
import { CodexRunUsage, codexUsageSnapshot } from '../src/host/codex-run-usage.mjs'
import { runNativeCodex } from '../src/host/native-codex.mjs'
import { extractTelemetry } from '../src/host/telemetry.ts'

// Explicitly synthetic app-server protocol records; no real CLI/account/model.
const sessionId = 'synthetic-thread', oldTurn = 'synthetic-history', activeTurn = 'synthetic-active'
const baseline = { inputTokens: 100, outputTokens: 30, totalTokens: 130, cachedInputTokens: 40, cacheWriteInputTokens: 10, reasoningOutputTokens: 5 }
const final = { inputTokens: 150, outputTokens: 50, totalTokens: 200, cachedInputTokens: 60, cacheWriteInputTokens: 15, reasoningOutputTokens: 10 }
const delta = { inputTokens: 50, outputTokens: 20, totalTokens: 70, cachedInputTokens: 20, cacheWriteInputTokens: 5, reasoningOutputTokens: 5 }
const notice = (turnId: string, total: any, threadId = sessionId) => ({ threadId, turnId, tokenUsage: { total, last: { inputTokens: 999999, outputTokens: 999999, totalTokens: 1999998 } } })
const metadata = { thread: { id: sessionId, status: { type: 'idle' } } }
const latest = { data: [{ id: oldTurn, status: 'completed', items: [], itemsView: 'notLoaded' }] }
function resumed() {
  const tracker = new CodexRunUsage(sessionId)
  tracker.beforeStart('thread/tokenUsage/updated', notice(oldTurn, baseline))
  tracker.prepare(sessionId, false, metadata, latest)
  tracker.start()
  return tracker
}

it('subtracts a verified completed-history replay and never uses native last usage', () => {
  const tracker = resumed()
  tracker.active(notice(activeTurn, final))
  expect(tracker.finish(activeTurn)).toEqual(delta)
  expect(tracker.finish('foreign-turn')).toBeUndefined()
})

it('starts an explicitly new thread from zero without fabricating a historical baseline', () => {
  const tracker = new CodexRunUsage()
  tracker.prepare(sessionId, true)
  tracker.start()
  tracker.active(notice(activeTurn, final))
  expect(tracker.finish(activeTurn)).toEqual(final)
})

it('does not turn an unchanged session replay into settled zero run usage', () => {
  const tracker = resumed()
  tracker.active(notice(activeTurn, baseline))
  expect(tracker.finish(activeTurn)).toBeUndefined()
})

it('ignores legacy derived zero after interruption while retaining native session totals and explicit native zero', () => {
  const zero = { inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, reasoningOutputTokens: 0 }
  const telemetry = extractTelemetry('codex', [
    { method: 'thread/tokenUsage/updated', params: notice(activeTurn, baseline) },
    { method: 'turn/completed', params: { threadId: sessionId, turn: { id: activeTurn, status: 'interrupted' } } },
    { type: 'cliworker.codex_run_usage', sessionId, turnId: activeTurn, usage: zero },
  ], { conversationId: sessionId })
  expect(telemetry.runUsage).toBeUndefined()
  expect(telemetry.unsettledRunUsage).toBe(true)
  expect(telemetry.usage).toMatchObject({ total: baseline.totalTokens, scope: 'session' })
  const native = extractTelemetry('codex', [{ type: 'turn.completed', usage: {
    input_tokens: 0, output_tokens: 0, total_tokens: 0, cached_input_tokens: 0,
    cache_write_tokens: 0, reasoning_output_tokens: 0,
  } }])
  expect(native.runUsage).toMatchObject({ total: 0, input: 0, output: 0, scope: 'run' })
  expect(native.unsettledRunUsage).toBeUndefined()
  expect(codexUsageSnapshot(zero)).toEqual(zero)
  const settled = extractTelemetry('codex', [
    { type: 'cliworker.codex_run_usage', sessionId, turnId: activeTurn, usage: zero },
    { type: 'cliworker.codex_run_usage', sessionId, turnId: activeTurn, usage: delta },
  ], { conversationId: sessionId })
  expect(settled.runUsage?.total).toBe(delta.totalTokens)
  expect(settled.unsettledRunUsage).toBeUndefined()
})

it.each(['missing-replay', 'late-replay', 'foreign-replay', 'wrong-history', 'active-history', 'not-idle', 'raced'])('keeps %s baseline unknown', (scenario) => {
  const tracker = new CodexRunUsage(sessionId)
  if (!['missing-replay', 'late-replay'].includes(scenario)) tracker.beforeStart('thread/tokenUsage/updated', notice(oldTurn, baseline, scenario === 'foreign-replay' ? 'other-thread' : sessionId))
  if (scenario === 'raced') tracker.beforeStart('turn/started', { threadId: sessionId, turn: { id: 'concurrent-turn' } })
  tracker.prepare(sessionId, false, scenario === 'not-idle' ? { thread: { id: sessionId, status: { type: 'active' } } } : metadata,
    scenario === 'wrong-history' ? { data: [{ id: 'other-turn', status: 'completed' }] } : scenario === 'active-history' ? { data: [{ id: oldTurn, status: 'inProgress' }] } : latest)
  tracker.start()
  if (scenario === 'late-replay') tracker.beforeStart('thread/tokenUsage/updated', notice(oldTurn, baseline))
  tracker.active(notice(activeTurn, final))
  expect(tracker.finish(activeTurn)).toBeUndefined()
})

it('ignores foreign-thread final counters, rejects rollback and does not resurrect invalid usage', () => {
  const foreign = resumed()
  foreign.active(notice(activeTurn, final, 'other-thread'))
  expect(foreign.finish(activeTurn)).toBeUndefined()
  const tracker = resumed()
  tracker.active(notice(activeTurn, final))
  tracker.active(notice(activeTurn, baseline))
  tracker.active(notice(activeTurn, final))
  expect(tracker.finish(activeTurn)).toBeUndefined()
})

it('rejects inconsistent buckets, invalid numbers and unknown required fields', () => {
  for (const value of [{ ...final, totalTokens: 201 }, { ...final, cachedInputTokens: 200 }, { ...final, reasoningOutputTokens: 100 }, { ...final, inputTokens: -1 }, { ...final, totalTokens: Infinity }, { ...final, outputTokens: undefined }]) {
    expect(codexUsageSnapshot(value)).toBeUndefined()
  }
  const { cacheWriteInputTokens: _unknown, ...withoutWrite } = final
  expect(codexUsageSnapshot(withoutWrite)).toEqual(withoutWrite)
})

async function native(scenario: 'resume' | 'fresh' | 'late-replay' | 'no-baseline' | 'rollback' | 'interrupted-unsettled') {
  const frames: any[] = [], requests: any[] = []
  const waiters: { predicate: (value: any) => boolean; resolve: (value: any) => void }[] = []
  let listener: (value: any) => void = () => {}
  const deliver = (value: any) => {
    listener(value)
    for (const waiter of [...waiters]) if (waiter.predicate(value)) {
      waiters.splice(waiters.indexOf(waiter), 1)
      waiter.resolve(value)
    }
  }
  const peer = {
    onMessage(callback: typeof listener) { listener = callback; return () => {} },
    waitFor(predicate: (value: any) => boolean) { return new Promise((resolve) => waiters.push({ predicate, resolve })) },
    send() {}, end() {}, close: async () => {}, done: Promise.resolve({ exitCode: 0 }),
    request(method: string, params: any) {
      requests.push({ method, params })
      if (method === 'initialize') return {}
      if (method === 'thread/resume' || method === 'thread/start') {
        if (scenario === 'resume' || scenario === 'rollback' || scenario === 'interrupted-unsettled') deliver({ method: 'thread/tokenUsage/updated', params: notice(oldTurn, baseline) })
        return { ...metadata, model: 'synthetic-model', cwd: '/tmp', approvalPolicy: 'never', sandbox: { type: 'workspaceWrite', networkAccess: false } }
      }
      if (method === 'thread/read') return metadata
      if (method === 'thread/turns/list') return latest
      if (method === 'turn/start') {
        if (scenario === 'late-replay') deliver({ method: 'thread/tokenUsage/updated', params: notice(oldTurn, baseline) })
        deliver({ method: 'turn/started', params: { threadId: sessionId, turn: { id: activeTurn } } })
        if (scenario === 'interrupted-unsettled') deliver({ method: 'item/agentMessage/delta', params: { threadId: sessionId, turnId: activeTurn, itemId: 'synthetic-stream', delta: 'Synthetic partial public response' } })
        deliver({ method: 'thread/tokenUsage/updated', params: notice(activeTurn, scenario === 'interrupted-unsettled' ? baseline : final) })
        if (scenario === 'rollback') deliver({ method: 'thread/tokenUsage/updated', params: notice(activeTurn, baseline) })
        deliver({ method: 'turn/completed', params: { threadId: sessionId, turn: { id: activeTurn, status: scenario === 'interrupted-unsettled' ? 'interrupted' : 'completed', items: [] } } })
        return { turn: { id: activeTurn } }
      }
      throw new Error('Unexpected synthetic metadata request')
    },
  }
  const conversationId = scenario === 'fresh' ? undefined : sessionId
  await runNativeCodex({ argv: ['synthetic', 'exec', ...(conversationId ? ['resume', conversationId] : []), '--json', '--model', 'synthetic-model', '任务：\nsynthetic'], conversationId, preference: { model: 'synthetic-model', effort: 'default' }, mode: 'accept-edits', project: '/tmp', prompt: 'synthetic', timeoutMs: 1000 }, {
    openStdio: async () => peer, native: (record: any) => frames.push(record), event() {}, session() {}, result() {},
  })
  return { frames, requests }
}

it.each(['resume', 'fresh'] as const)('native producer emits proven %s run aggregate without fabricating response usage', async (scenario) => {
  const output = await native(scenario)
  const receipts = output.frames.filter((frame) => frame.type === 'cliworker.codex_run_usage')
  expect(receipts).toEqual([{ type: 'cliworker.codex_run_usage', sessionId, turnId: activeTurn, usage: scenario === 'resume' ? delta : final }])
  if (scenario === 'resume') {
    expect(output.requests.find((request) => request.method === 'thread/read')?.params).toEqual({ threadId: sessionId, includeTurns: false })
    expect(output.requests.find((request) => request.method === 'thread/turns/list')?.params).toEqual({ threadId: sessionId, limit: 1, sortDirection: 'desc', itemsView: 'notLoaded' })
  }
  expect(output.requests.filter((request) => request.method === 'turn/start')).toHaveLength(1)
})

it.each(['late-replay', 'no-baseline', 'rollback', 'interrupted-unsettled'] as const)('native producer leaves %s aggregate unknown', async (scenario) => {
  const output = await native(scenario)
  expect(output.frames.some((frame) => frame.type === 'cliworker.codex_run_usage')).toBe(false)
})
