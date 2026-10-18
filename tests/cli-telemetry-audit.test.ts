import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { extractTelemetry, TelemetryReader, type TelemetryIdentity } from '../src/host/telemetry.ts'
import type { CliId } from '../src/shared/types.ts'

// Offline synthetic protocol receipts; no account, model or user history is accessed.
const roots: string[] = []
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))
const identity = { conversationId: 'session', model: 'provider/model' }
function read(cli: CliId, records: unknown[], id: TelemetryIdentity = identity) {
  const result = extractTelemetry(cli, records, id)
  const root = mkdtempSync(join(tmpdir(), 'cwn-cli-telemetry-audit-')); roots.push(root)
  const path = join(root, 'synthetic.raw.jsonl')
  writeFileSync(path, records.map((record) => JSON.stringify(record)).join('\n') + '\n')
  expect(new TelemetryReader().read(path, cli, id)).toEqual(result)
  expect(JSON.stringify(result)).not.toContain('SYNTHETIC_PRIVATE')
  return result
}
const native = (record: unknown) => ({ type: 'native', record })
const grokUsage = { inputTokens: 33, outputTokens: 5, totalTokens: 38, cachedReadTokens: 10, cacheCreationTokens: 3, reasoningTokens: 2 }
const split = { input: 10, output: 2, reasoning: 3, cache: { read: 5, write: 7 }, total: 27 }
const message = (id: string, tokens = split, extra: Record<string, unknown> = {}) => ({ type: 'message.updated',
  properties: { info: { id, sessionID: 'session', parentID: 'synthetic-prompt', role: 'assistant', providerID: 'provider', modelID: 'model',
    time: { completed: 100 }, tokens, ...extra } } })
const claude = (type: string, fields: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({
  type: 'stream_event', session_id: 'session', parent_tool_use_id: null, event: { type, ...fields }, ...extra })

describe('CLI run accounting audit: run, session, response and context remain distinct', () => {
  it('normalizes Grok prompt inclusive input and legacy end disjoint input identically', () => {
    const canonical = native({ type: 'cliworker.grok_prompt_usage', sessionId: 'session', usage: grokUsage, usageIsIncomplete: false, signature: 'SYNTHETIC_PRIVATE' })
    const end = { type: 'end', sessionId: 'session', usage: { input_tokens: 20, output_tokens: 5, total_tokens: 38,
      cache_read_input_tokens: 10, cache_creation_input_tokens: 3, reasoning_tokens: 2 } }
    const expected = { total: 38, input: 33, output: 5, cacheRead: 10, cacheWrite: 3, reasoning: 2, scope: 'run' }
    expect(read('grok', [canonical]).runUsage).toEqual(expected)
    expect(read('grok', [end]).runUsage).toEqual(expected)
    expect(read('grok', [canonical, native({ ...canonical.record, usageIsIncomplete: true })]).runUsage).toBeUndefined()
    expect(read('grok', [{ ...end, usage_is_incomplete: true }]).runUsage).toBeUndefined()
    expect(read('grok', [{ ...end, sessionId: 'foreign' }]).runUsage).toBeUndefined()
    expect(read('grok', [{ ...end, usage: { ...end.usage, total_tokens: 999 } }]).runUsage).toBeUndefined()
  })

  it('keeps Grok explicit native context estimates independent of billing and unknown capacity', () => {
    const result = read('grok', [native({ method: 'session/update', params: { sessionId: 'session',
      update: { sessionUpdate: 'agent_message_chunk', content: { text: 'SYNTHETIC_PRIVATE' } }, _meta: { totalTokens: 17 } } })])
    expect(result.contextUsed).toBe(17)
    expect(result.contextCapacity).toBeUndefined()
    expect(result.runUsage).toBeUndefined()
  })

  it('separates Codex legacy turn totals from native session compatibility frames and accepts proven native deltas', () => {
    const legacy = { type: 'turn.completed', usage: { input_tokens: 33, output_tokens: 5, total_tokens: 38,
      cached_input_tokens: 10, cache_write_input_tokens: 3 } }
    expect(read('codex', [legacy]).runUsage).toMatchObject({ total: 38, input: 33, cacheWrite: 3, scope: 'run' })
    const cumulative = native({ method: 'thread/tokenUsage/updated', params: { threadId: 'session', tokenUsage: {
      total: { inputTokens: 100, outputTokens: 10, totalTokens: 110, cachedInputTokens: 20 },
      last: { inputTokens: 33, outputTokens: 5, totalTokens: 38 }, modelContextWindow: 1000 } } })
    expect(read('codex', [legacy, cumulative]).runUsage).toBeUndefined()
    const proven = native({ type: 'cliworker.codex_run_usage', sessionId: 'session', turnId: 'turn',
      usage: { inputTokens: 33, outputTokens: 5, totalTokens: 38, cachedInputTokens: 10, cacheWriteInputTokens: 3, reasoningOutputTokens: 2 } })
    const result = read('codex', [legacy, cumulative, proven])
    expect(result.runUsage?.total).toBe(38)
    expect(result.usage).toMatchObject({ total: 110, scope: 'session' })
    expect(result.finalReply).toBeUndefined()
  })

  it('reads only a finalized main Claude response for context and never uses result totals as occupancy', () => {
    const records = [
      claude('message_start', { message: { id: 'response', model: 'provider/model', usage: { input_tokens: 20, output_tokens: 1, cache_read_input_tokens: 10, cache_creation_input_tokens: 3 } } }),
      claude('message_delta', { usage: { output_tokens: 5 } }),
      claude('message_stop'),
      { type: 'assistant', session_id: 'session', message: { id: 'response', model: 'provider/model', usage: { input_tokens: 1, cache_read_input_tokens: 1, cache_creation_input_tokens: 1 } } },
      { type: 'result', session_id: 'session', usage: { input_tokens: 200, output_tokens: 50, cache_read_input_tokens: 100, cache_creation_input_tokens: 30 } },
    ]
    const result = read('claude', records)
    expect(result.contextUsed).toBe(33)
    expect(result.runUsage).toMatchObject({ total: 380, scope: 'run' })
    expect(result.finalReply).toBeUndefined()
    expect(read('claude', records.slice(0, 1)).contextUsed).toBeUndefined()
    expect(read('claude', [records[0], claude('message_delta', { usage: { output_tokens: 0 } }), records[2]]).contextUsed).toBeUndefined()
    expect(read('claude', records.slice(0, 3).map((row) => ({ ...row, parent_tool_use_id: 'nested' }))).contextUsed).toBeUndefined()
  })

  it.each(['mimo', 'opencode'] as const)('%s aggregates completed own-prompt HTTP messages once without a fake finalReply', (cli) => {
    const records = [message('one'), message('one'), message('foreign', split, { sessionID: 'foreign' }), message('two')]
    const result = read(cli, records)
    expect(result.runUsage).toMatchObject({ total: 54, input: 20, output: 4, reasoning: 6, cacheRead: 10, cacheWrite: 14, scope: 'run' })
    expect(result.finalReply).toBeUndefined()
    expect(result.contextUsed).toBe(cli === 'mimo' ? 15 : 22)
    expect(read(cli, [message('one', split, { time: {} })]).runUsage).toBeUndefined()
    expect(read(cli, [message('one', { ...split, total: 999 })]).runUsage).toBeUndefined()
  })

  it.each(['mimo', 'opencode'] as const)('%s retains exact legacy step identity and actual input/cache occupancy', (cli) => {
    const row = { type: 'step_finish', sessionID: 'session', part: { id: 'step', sessionID: 'session', messageID: 'message', tokens: split } }
    const result = read(cli, [row, row])
    expect(result.runUsage?.total).toBe(27)
    expect(result.contextUsed).toBe(cli === 'mimo' ? 15 : 22)
    expect(read(cli, [{ ...row, sessionID: 'foreign' }]).usage).toBeUndefined()
    expect(read(cli, [{ ...row, sessionID: null }]).runUsage).toBeUndefined()
  })

  it.each(['mimo', 'opencode'] as const)('%s distinguishes initial zero placeholders, real zero and a missing final receipt through the private reader', (cli) => {
    const capacity = { type: 'cliworker.model_context', source: `${cli}.provider.limit.context`,
      providerID: 'provider', modelID: 'model', contextCapacity: 1000 }
    const known = message('previous', split, { finish: 'stop' })
    const zeros = { total: 0, input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
    const initial = message('next', zeros, { time: {} })
    const result = read(cli, [capacity, known, initial])
    expect(result.contextUsed).toBe(cli === 'mimo' ? 15 : 22)
    expect(read(cli, [initial]).contextUsed).toBeUndefined()
    expect(read(cli, [known, message('zero', zeros, { finish: 'stop' })]).contextUsed).toBe(0)
    const missing = message('next', split, { finish: 'stop', tokens: { output: 2 } })
    const invalidated = read(cli, [capacity, known, missing])
    expect(invalidated.contextUsed).toBeUndefined()
    expect(invalidated.contextCapacity).toBe(1000)
    expect(read(cli, [known, { type: 'step_finish', sessionID: 'session',
      part: { id: 'missing', sessionID: 'session', messageID: 'message', tokens: { output: 2 } } }]).contextUsed).toBeUndefined()
    expect(read(cli, [known, message('error', zeros, { error: { message: 'Synthetic failed before receipt' } })]).contextUsed)
      .toBe(cli === 'mimo' ? 15 : 22)
  })

  it.each(['pi', 'omp'] as const)('%s deduplicates response usage but does not mistake observed calls or session stats for a complete run', (cli) => {
    const response = { type: 'cliworker.rpc_response', cli, source: `${cli}.message_end`, sessionId: 'session', responseId: 'response',
      usage: { input: 20, output: 5, cacheRead: 10, cacheWrite: 3, reasoning: 2, total: 38 } }
    const result = read(cli, [response, response])
    expect(result.usage).toMatchObject({ total: 38, scope: 'reported' })
    expect(result.runUsage).toBeUndefined()
    const stats = { type: 'cliworker.rpc_usage', cli, source: `${cli}.get_session_stats`, sessionId: 'session', usage: { total: 1000 } }
    expect(read(cli, [response, stats]).usage).toMatchObject({ total: 1000, scope: cli === 'omp' ? 'reported' : 'session' })
    expect(read(cli, [response, stats]).runUsage).toBeUndefined()
    expect(read(cli, [{ ...response, usage: { ...response.usage, total: 999 } }]).usage).toBeUndefined()
  })

  it('keeps Hermes legacy canonical input/cache accounting in a full run receipt only', () => {
    const row = { type: 'result', session_id: 'session', tokens: { total: 38, input: 20, output: 5, cache_read: 10, cache_write: 3 } }
    const result = read('hermes', [row])
    expect(result.runUsage).toMatchObject({ total: 38, input: 33, cacheRead: 10, cacheWrite: 3, scope: 'run' })
    expect(result.finalReply).toBeUndefined()
    expect(read('hermes', [{ ...row, tokens: { ...row.tokens, total: 999 } }]).runUsage).toBeUndefined()
  })

  it('reads ZCode legacy turn usage under its actual session while retaining inclusive cache accounting', () => {
    const row = { type: 'turn.completed', sessionId: 'session', payload: { usage: { inputTokens: 33, outputTokens: 5,
      totalTokens: 38, cacheReadTokens: 10, cacheWriteTokens: 3, reasoningTokens: 2 } } }
    expect(read('zcode', [row]).runUsage).toMatchObject({ total: 38, input: 33, scope: 'run' })
    expect(read('zcode', [{ ...row, sessionId: 'foreign' }]).runUsage).toBeUndefined()
  })
})
