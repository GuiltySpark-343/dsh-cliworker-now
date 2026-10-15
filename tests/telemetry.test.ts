import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { attachTelemetry, extractTelemetry, TelemetryReader } from '../src/host/telemetry.ts'
import { compactTokens, messageClock } from '../src/shared/telemetry.ts'
import { foldEvents, type WorkerEvent } from '../src/shared/types.ts'

// Synthetic protocol fixtures; values/shapes match public CLI receipts, not new inference.
const step = (input: number) => ({
  event: 'step_update',
  step_update: {
    step_index: 2,
    step_type: 'agent_response',
    usage: { input_tokens: input, output_tokens: 5, total_tokens: input + 5, cache_read_tokens: 40 },
  },
})
const final = {
  event: 'result',
  result: { usage: { input_tokens: 400, output_tokens: 10, total_tokens: 410 } },
}
describe('CLI telemetry without invented accounting', () => {
  it('keeps empty-step receipts and durations distinct from cumulative AGY totals across runs', () => {
    const receipt = {
      ...step(25),
      step_update: { ...step(25).step_update, state: 'DONE', text_delta: '', duration_seconds: 7.3332851 },
    }
    const aggregate = { ...final, result: { ...final.result, duration_seconds: 1350.3886868 } }
    const t = extractTelemetry('antigravity', [receipt, receipt, aggregate, aggregate])
    const rows = foldEvents([
      { runId: 'a', kind: 'user', text: 'synthetic turn', time: '2026-10-15T00:00:00Z', seq: 1 },
      { runId: 'a', kind: 'assistant', step: 2, state: 'DONE', text: '  ', time: '2026-10-15T00:00:01Z', seq: 2 },
      { runId: 'a', kind: 'status', text: 'failed', state: 'failed', time: '2026-10-15T00:00:08Z', seq: 3 },
      { runId: 'b', kind: 'assistant', step: 2, text: 'other run', time: '2026-10-15T00:00:10Z', seq: 4 },
    ])
    attachTelemetry(rows, 'a', t)
    expect(t.usage).toEqual({ total: 410, input: 400, output: 10, cacheRead: undefined, scope: 'session' })
    expect(rows[1]).toMatchObject({
      text: '  ', usage: { total: 30, scope: 'response' }, durationSeconds: 7.3332851,
      sessionDurationSeconds: 1350.3886868,
      runStartedAt: '2026-10-15T00:00:00Z', runEndedAt: '2026-10-15T00:00:08Z',
    })
    expect(rows.slice(1, 2)[0]?.durationSeconds).toBe(7.3332851)
    expect(rows[3]?.usage).toBeUndefined()
    expect(rows[3]?.durationSeconds).toBeUndefined()
    expect(rows[3]?.sessionDurationSeconds).toBeUndefined()
  })
  it('reads duration-only AGY steps from private raw logs without inventing usage', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cwn-telemetry-duration-'))
    const path = join(dir, 'synthetic.raw.jsonl')
    try {
      writeFileSync(path, [
        { event: 'step_update', step_update: { step_index: 2, step_type: 'agent_response', duration_seconds: 0 } },
        { event: 'step_update', step_update: { step_index: 2, step_type: 'agent_response', duration_seconds: 3.5 } },
        { event: 'step_update', step_update: { step_index: 2, step_type: 'agent_response', duration_seconds: -1 } },
        { event: 'result', result: { duration_seconds: 40.5 } },
      ].map((v) => JSON.stringify(v)).join('\n') + '\n')
      const reader = new TelemetryReader()
      const result = reader.read(path, 'antigravity')
      expect(result).toMatchObject({ replies: {}, replyDurations: { '2': 3.5 }, sessionDurationSeconds: 40.5 })
      expect(result.usage).toBeUndefined()
      expect(reader.read(path, 'antigravity')).toEqual(result)
      expect(extractTelemetry('antigravity', [
        { event: 'result', result: { duration_seconds: Infinity } },
        { event: 'result', result: { duration_seconds: '40' } },
      ]).sessionDurationSeconds).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
  it('separates response snapshots from session totals, deduplicates step updates', () => {
    const t = extractTelemetry('antigravity', [step(20), step(25), final])
    expect(t.replies['2']?.total).toBe(30)
    expect(t.usage).toMatchObject({ total: 410, scope: 'session' })
    expect(t.contextUsed).toBeUndefined()
    expect(t.contextCapacity).toBeUndefined()
  })
  it('never adds Codex cached input twice or claims a per-reply total', () => {
    const t = extractTelemetry('codex', [
      { type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 80, output_tokens: 3 } },
    ])
    expect(t.usage).toMatchObject({ total: 103, cacheRead: 80, scope: 'reported' })
  })
  it('includes separate Claude cache buckets but does not mistake cumulative input for context', () => {
    const t = extractTelemetry('claude', [
      {
        type: 'result',
        usage: {
          input_tokens: 10,
          output_tokens: 2,
          cache_read_input_tokens: 80,
          cache_creation_input_tokens: 8,
        },
        modelUsage: { m: { contextWindow: 1000 } },
      },
    ])
    expect(t.usage?.total).toBe(100)
    expect(t.contextCapacity).toBe(1000)
    expect(t.contextUsed).toBeUndefined()
  })
  it('only accepts explicit valid context fields, zero is known usage', () => {
    expect(extractTelemetry('kimi', [{ context_usage: { used_tokens: 0, max_tokens: 100 } }])).toMatchObject({
      contextUsed: 0,
      contextCapacity: 100,
    })
    expect(
      extractTelemetry('antigravity', [{ event: 'result', result: { usage: { total_tokens: -1 } } }]).usage,
    ).toBeUndefined()
    expect(extractTelemetry('kimi', []).usage).toBeUndefined()
  })
  it('deduplicates MiMo step receipts and sums within the run only', () => {
    const s = {
      type: 'step_finish',
      part: { id: 's', tokens: { total: 100, input: 30, output: 5, cache: { read: 65 } } },
    }
    expect(extractTelemetry('mimo', [s, s]).usage?.total).toBe(100)
  })
  it('attaches telemetry before pagination, keeps distinct runs separate', () => {
    const events = [
      { runId: 'a', kind: 'assistant', step: 2, text: 'hello', time: '2026-10-04T00:00:00Z', seq: 1 },
      { runId: 'b', kind: 'assistant', step: 2, text: 'world', time: '2026-10-05T00:00:00Z', seq: 2 },
    ] as WorkerEvent[]
    const rows = foldEvents(events)
    attachTelemetry(rows, 'a', extractTelemetry('antigravity', [step(25), final]))
    expect(rows[0]?.usage?.total).toBe(30)
    expect(rows[1]?.usage).toBeUndefined()
  })
  it('recovers old logs read-only, handles append/torn line and missing files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cwn-telemetry-')),
      path = join(dir, 'run.raw.jsonl')
    try {
      const reader = new TelemetryReader()
      expect(reader.read(path, 'antigravity')).toEqual({ replies: {} })
      writeFileSync(path, JSON.stringify(step(20)) + '\n' + JSON.stringify(final).slice(0, 12))
      expect(reader.read(path, 'antigravity').replies['2']?.total).toBe(25)
      appendFileSync(path, JSON.stringify(final).slice(12) + '\n')
      expect(reader.read(path, 'antigravity').usage?.total).toBe(410)
      expect(reader.read(path, 'antigravity').usage?.total).toBe(410)
      writeFileSync(path, 'bad-json\n')
      expect(reader.read(path, 'antigravity')).toEqual({ replies: {} })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
  it('matches native compact numbers and day/year-aware clocks', () => {
    expect(compactTokens(31549)).toBe('31.5K')
    expect(compactTokens(0)).toBe('0')
    const now = new Date(2026, 9, 5, 12)
    expect(messageClock(new Date(2026, 9, 5, 9, 7).toISOString(), now)).toBe('09:07')
    expect(messageClock(new Date(2026, 9, 4, 22, 19).toISOString(), now)).toBe('10月4日 22:19')
    expect(messageClock(new Date(2025, 9, 4, 22, 19).toISOString(), now)).toBe('2025年 10月4日 22:19')
  })
})
