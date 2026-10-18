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
const message = (id: string, tokens: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  type: 'message.updated',
  properties: { info: { id, sessionID: 'synthetic-session', role: 'assistant', tokens, ...extra } },
})
const splitTokens = { input: 10, output: 2, reasoning: 3, cache: { read: 5, write: 7 } }
describe('CLI telemetry without invented accounting', () => {
  it('attaches AGY response usage by explicit response identity while retaining old row compatibility', () => {
    const rows = foldEvents([
      { runId: 'a', kind: 'assistant', text: 'native AGY text', seq: 1, time: '2026-10-16T00:00:00Z',
        response: { id: 'agy:2', blockId: 'text', index: 0 } },
      { runId: 'a', kind: 'assistant', step: 3, text: 'legacy AGY text', seq: 2, time: '2026-10-16T00:00:01Z' },
      { runId: 'a', kind: 'assistant', text: 'different CLI response', seq: 3, time: '2026-10-16T00:00:02Z',
        response: { id: 'other:2', blockId: 'text', index: 0 } },
    ])
    const receipt = { total: 30, input: 25, output: 5, scope: 'response' as const }
    attachTelemetry(rows, 'a', { replies: { '2': receipt, '3': receipt }, replyDurations: { '2': 1, '3': 2 } })
    expect(rows[0]?.id).toBe('a:response:["agy:2","text"]')
    expect(rows[0]).toMatchObject({ usage: receipt, durationSeconds: 1 })
    expect(rows[1]).toMatchObject({ usage: receipt, durationSeconds: 2 })
    expect(rows[2]?.usage).toBeUndefined()
    expect(rows[2]?.durationSeconds).toBeUndefined()
  })

  it('preserves and checks AGY identities through incremental private raw reads, including rejected suffixes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cwn-telemetry-agy-identity-'))
    const path = join(dir, 'synthetic.raw.jsonl')
    const good = { ...final, result: { ...final.result, conversation_id: 'expected-session', status: 'ERROR' } }
    const bad = {
      event: 'result',
      result: { conversation_id: 'other-session', usage: { input_tokens: 900, output_tokens: 9, total_tokens: 909 } },
    }
    const line = (value: unknown) => `${JSON.stringify(value)}\n`
    try {
      writeFileSync(path, line({ event: 'init', conversation_id: 'expected-session' }) + line(good))
      const reader = new TelemetryReader()
      const identity = { conversationId: 'expected-session' }
      expect(reader.read(path, 'antigravity', identity).usage?.total).toBe(410)
      // A valid failed receipt still contains authoritative accounting. The
      // following mismatched record and any unprocessed suffix must not replace it.
      appendFileSync(path, line(bad) + line({ ...good, result: { ...good.result, usage: { total_tokens: 999 } } }))
      expect(reader.read(path, 'antigravity', identity).usage?.total).toBe(410)
      expect(new TelemetryReader().read(path, 'antigravity', identity).usage?.total).toBe(410)
      expect(new TelemetryReader().read(path, 'antigravity', { conversationId: 'other-session' }).usage)
        .toBeUndefined()
      // The same safety applies when historical callers have no explicit expected ID.
      expect(new TelemetryReader().read(path, 'antigravity').usage?.total).toBe(410)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it.each(['envelope', 'step', 'result', 'invalid', 'missing-result'] as const)(
    'rejects mismatched AGY %s identity before using usage, duration or later raw records', (where) => {
      const bad: Record<string, any> = where === 'step' ? step(900) : {
        ...final, result: { ...final.result, conversation_id: 'expected-session' },
      }
      if (where === 'step') bad.step_update = { ...bad.step_update, conversation_id: 'other-session' }
      else if (where === 'result') bad.result.conversation_id = 'other-session'
      else if (where !== 'missing-result') bad.conversation_id = where === 'invalid' ? 123 : 'other-session'
      else delete bad.result.conversation_id
      const dir = mkdtempSync(join(tmpdir(), 'cwn-telemetry-agy-mismatch-'))
      const path = join(dir, 'synthetic.raw.jsonl')
      try {
        writeFileSync(path, [bad, final].map((value) => JSON.stringify(value)).join('\n') + '\n')
        const result = new TelemetryReader().read(path, 'antigravity', { conversationId: 'expected-session' })
        expect(result).toEqual({ replies: {} })
        expect(extractTelemetry('antigravity', [bad, final], { conversationId: 'expected-session' }))
          .toEqual(result)
      } finally { rmSync(dir, { recursive: true, force: true }) }
    },
  )

  it('keeps empty-step receipts and durations distinct from cumulative AGY totals across runs', () => {
    const receipt = {
      ...step(25),
      step_update: { ...step(25).step_update, state: 'DONE', text_delta: '', duration_seconds: 7.3332851 },
    }
    const aggregate = { ...final, result: { ...final.result, duration_seconds: 1350.3886868 } }
    const t = extractTelemetry('antigravity', [receipt, receipt, aggregate, aggregate])
    const rows = foldEvents([
      { runId: 'a', kind: 'user', text: 'synthetic turn', time: '2026-10-15T00:00:00Z', seq: 1 },
      {
        runId: 'a',
        kind: 'assistant',
        step: 2,
        state: 'DONE',
        text: '  ',
        time: '2026-10-15T00:00:01Z',
        seq: 2,
      },
      { runId: 'a', kind: 'status', text: 'failed', state: 'failed', time: '2026-10-15T00:00:08Z', seq: 3 },
      { runId: 'b', kind: 'assistant', step: 2, text: 'other run', time: '2026-10-15T00:00:10Z', seq: 4 },
    ])
    attachTelemetry(rows, 'a', t)
    expect(t.usage).toEqual({ total: 410, input: 400, output: 10, cacheRead: undefined, scope: 'session' })
    expect(rows[1]).toMatchObject({
      text: '  ',
      usage: { total: 30, scope: 'response' },
      durationSeconds: 7.3332851,
      sessionDurationSeconds: 1350.3886868,
      runStartedAt: '2026-10-15T00:00:00Z',
      runEndedAt: '2026-10-15T00:00:08Z',
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
      writeFileSync(
        path,
        [
          {
            event: 'step_update',
            step_update: { step_index: 2, step_type: 'agent_response', duration_seconds: 0 },
          },
          {
            event: 'step_update',
            step_update: { step_index: 2, step_type: 'agent_response', duration_seconds: 3.5 },
          },
          {
            event: 'step_update',
            step_update: { step_index: 2, step_type: 'agent_response', duration_seconds: -1 },
          },
          { event: 'result', result: { duration_seconds: 40.5 } },
        ]
          .map((v) => JSON.stringify(v))
          .join('\n') + '\n',
      )
      const reader = new TelemetryReader()
      const result = reader.read(path, 'antigravity')
      expect(result).toMatchObject({
        replies: {},
        replyDurations: { '2': 3.5 },
        sessionDurationSeconds: 40.5,
      })
      expect(result.usage).toBeUndefined()
      expect(reader.read(path, 'antigravity')).toEqual(result)
      expect(
        extractTelemetry('antigravity', [
          { event: 'result', result: { duration_seconds: Infinity } },
          { event: 'result', result: { duration_seconds: '40' } },
        ]).sessionDurationSeconds,
      ).toBeUndefined()
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
    expect(t.usage).toMatchObject({ total: 103, cacheRead: 80, scope: 'run' })
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
  it.each(['mimo', 'opencode'] as const)(
    'aggregates latest %s message snapshots without recounting step or completion receipts',
    (cli) => {
      const latest = message('one', { ...splitTokens, total: 90 })
      const t = extractTelemetry(cli, [
        message('one', splitTokens),
        { type: 'step_finish', part: { id: 'step', tokens: { ...splitTokens, total: 90 } } },
        { type: 'native', record: latest },
        latest,
        message('two', { input: 2, output: 3, reasoning: 4, cache: { read: 5, write: 6 } }),
        message('user', { total: 1000 }, { role: 'user' }),
      ])
      expect(t.usage).toEqual({
        total: 110,
        input: 12,
        output: 5,
        cacheRead: 10,
        cacheWrite: 13,
        reasoning: 7,
        scope: 'run',
      })
      expect(t.finalReply).toBeUndefined()
      expect(t.replies).toEqual({})
      expect(t.contextUsed).toBe(cli === 'mimo' ? 7 : 13)
      expect(t.contextCapacity).toBeUndefined()
    },
  )
  it.each(['mimo', 'opencode'] as const)(
    'only derives %s total from all five valid buckets, with explicit totals authoritative',
    (cli) => {
      for (const tokens of [
        { input: 10, output: 2 },
        { ...splitTokens, reasoning: undefined },
        { ...splitTokens, cache: { read: 5 } },
        { ...splitTokens, total: -1 },
        { ...splitTokens, total: '27' },
        { ...splitTokens, input: Number.MAX_SAFE_INTEGER },
      ])
        expect(extractTelemetry(cli, [message('one', tokens)]).usage).toBeUndefined()
      expect(extractTelemetry(cli, [message('one', splitTokens)]).usage?.total).toBe(27)
      expect(extractTelemetry(cli, [message('one', { total: 0 })]).usage).toEqual({ total: 0, scope: 'run' })
      expect(extractTelemetry(cli, [message('one', { ...splitTokens, total: 9 })]).usage?.total).toBe(9)
    },
  )
  it('keeps message identity scoped to the session and never infers omitted subcounts', () => {
    const t = extractTelemetry('opencode', [
      message('same', { total: 5, input: 4, output: 1 }),
      message('same', { total: 7 }, { sessionID: 'another-synthetic-session' }),
      message('', { total: 1000 }),
      message('missing-session', { total: 1000 }, { sessionID: undefined }),
    ])
    expect(t.usage).toEqual({ total: 12, scope: 'run' })
    expect(
      extractTelemetry('opencode', [
        message('one', { total: Number.MAX_SAFE_INTEGER }),
        message('two', { total: 1 }),
      ]).usage,
    ).toBeUndefined()
  })
  it('counts Hermes run totals once and preserves its already included cache subset', () => {
    const usage = {
      input_tokens: 100,
      output_tokens: 10,
      total_tokens: 110,
      cache_read_tokens: 80,
      cache_write_tokens: 5,
    }
    const t = extractTelemetry('hermes', [
      { event: 'run.completed', run_id: 'one', usage: { ...usage, total_tokens: 105 } },
      { type: 'native', record: { type: 'hermes.run', run_id: 'one', usage } },
      { type: 'hermes.run', run_id: 'one', usage },
      {
        event: 'run.failed',
        run_id: 'two',
        usage: {
          input_tokens: 5,
          output_tokens: 2,
          total_tokens: 7,
          cache_read_tokens: 2,
          cache_write_tokens: 1,
        },
      },
    ])
    expect(t.usage).toEqual({
      total: 117,
      input: 105,
      output: 12,
      cacheRead: 82,
      cacheWrite: 6,
      scope: 'run',
    })
    expect(t.finalReply).toBeUndefined()
    expect(t.contextUsed).toBeUndefined()
    expect(t.contextCapacity).toBeUndefined()
  })
  it('requires a stable Hermes run and an observed valid total, retaining legacy result support', () => {
    for (const receipt of [
      { type: 'hermes.run', usage: { total_tokens: 10 } },
      { type: 'hermes.run', run_id: 'one', usage: { input_tokens: 10, output_tokens: 2 } },
      { type: 'hermes.run', run_id: 'one', usage: { total_tokens: -1 } },
    ])
      expect(extractTelemetry('hermes', [receipt]).usage).toBeUndefined()
    expect(
      extractTelemetry('hermes', [{ type: 'hermes.run', run_id: 'one', usage: { total_tokens: 0 } }]).usage,
    ).toEqual({ total: 0, scope: 'run' })
    expect(
      extractTelemetry('hermes', [
        { type: 'result', tokens: { total: 20, input: 10, output: 2, cache_read: 8, cache_write: 0 } },
      ]).usage,
    ).toEqual({ total: 20, input: 18, output: 2, cacheRead: 8, scope: 'run' })
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
  it.each(['mimo', 'opencode'] as const)(
    'incrementally reads native %s usage while keeping invalid counts invalid',
    (cli) => {
      const dir = mkdtempSync(join(tmpdir(), 'cwn-native-telemetry-')),
        path = join(dir, 'synthetic.raw.jsonl')
      try {
        const reader = new TelemetryReader()
        const record = message('one', { total: 2 }, { content: 'synthetic private response' })
        writeFileSync(path, JSON.stringify({ type: 'native', record }) + '\n')
        expect(reader.read(path, cli).usage).toEqual({ total: 2, scope: 'run' })
        appendFileSync(
          path,
          [
            message('one', { ...splitTokens, total: 10 }),
            message('two', splitTokens),
            message('invalid', { ...splitTokens, total: 'synthetic invalid total' }),
            message('incomplete', { ...splitTokens, cache: { read: 5 } }),
          ]
            .map((record) => JSON.stringify({ type: 'native', record }))
            .join('\n') + '\n',
        )
        const result = reader.read(path, cli)
        expect(result.usage).toEqual({
          total: 37,
          input: 20,
          output: 4,
          cacheRead: 10,
          cacheWrite: 14,
          reasoning: 6,
          scope: 'run',
        })
        expect(reader.read(path, cli)).toEqual(result)
        expect(result.contextUsed).toBe(cli === 'mimo' ? 15 : 22)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
  )
  it('recovers native Hermes final and terminal snapshots from raw logs without counting both', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cwn-hermes-telemetry-')),
      path = join(dir, 'synthetic.raw.jsonl')
    try {
      const usage = {
        total_tokens: 13,
        input_tokens: 10,
        output_tokens: 3,
        cache_read_tokens: 8,
        cache_write_tokens: 1,
      }
      writeFileSync(
        path,
        [
          { event: 'run.completed', run_id: 'one', usage },
          { type: 'hermes.run', run_id: 'one', usage, output: 'synthetic private response' },
        ]
          .map((record) => JSON.stringify({ type: 'native', record }))
          .join('\n') + '\n',
      )
      expect(new TelemetryReader().read(path, 'hermes').usage).toEqual({
        total: 13,
        input: 10,
        output: 3,
        cacheRead: 8,
        cacheWrite: 1,
        scope: 'run',
      })
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
