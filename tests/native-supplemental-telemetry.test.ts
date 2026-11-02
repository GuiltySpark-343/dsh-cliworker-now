import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { extractTelemetry, TelemetryReader } from '../src/host/telemetry.ts'
import { nativeTelemetryProjections } from '../src/client/harness-telemetry-data.ts'
import { nativeUsageReport } from '../src/shared/native-usage-report.ts'
import { captureLastRunUsageSnapshot, withConversationTelemetry } from '../src/host/conversation-telemetry.ts'
import type { Worker } from '../src/shared/types.ts'

// Explicitly simulated native receipts; these tests do not call any model.
const identity = { conversationId: 'SIMULATED-session', model: 'SIMULATED-model' }
const kimi = { type: 'cliworker.kimi_usage', source: 'kimi.durable.main-wire', sessionId: identity.conversationId,
  model: identity.model, turnId: 'turn-1', scope: 'run', usage: { inputOther: 12, output: 8, inputCacheRead: 20, inputCacheCreation: 3 } }
const hermes = { type: 'cliworker.hermes_observation', source: 'hermes.observer.post_api_request',
  nativeRunId: 'run-1', sessionId: identity.conversationId, model: identity.model, provider: 'SIMULATED-provider', turnId: 'turn-1', requestId: 'api-1',
  usageBasis: 'cli-normalized', usage: { total: 43, input: 35, output: 8, cacheRead: 20, cacheWrite: 3, reasoning: 5 },
  context: { used: 35, capacity: 1000, basis: 'provider-prompt' } }
const summary = { type: 'cliworker.hermes_observer_summary', source: 'hermes.observer.summary',
  nativeRunId: 'run-1', sessionId: identity.conversationId, usageBasis: 'cli-normalized', requestCount: 1, responseCount: 1,
  errorCount: 0, coverageComplete: true, usageComplete: true, usage: hermes.usage }

describe('supplemental official data sources', () => {
  it('keeps Kimi run totals separate from session totals and refuses guessed response attachment', () => {
    const result = extractTelemetry('kimi', [kimi, kimi], identity)
    expect(result.runUsage).toEqual({ total: 43, input: 12, output: 8, cacheRead: 20, cacheWrite: 3, scope: 'run' })
    expect(result.replies).toEqual({})
    expect(extractTelemetry('kimi', [{ ...kimi, scope: 'reported' }], identity).runUsage).toBeUndefined()
    expect(extractTelemetry('kimi', [{ ...kimi, sessionId: 'other' }], identity).usage).toBeUndefined()
    expect(extractTelemetry('kimi', [{ ...kimi, model: 'other' }], identity).usage).toBeUndefined()
  })
  it('clears invalid Kimi receipts and refuses all-zero normalized missing usage', () => {
    expect(extractTelemetry('kimi', [kimi, { ...kimi, usage: { ...kimi.usage, output: -1 } }], identity).usage).toBeUndefined()
    expect(extractTelemetry('kimi', [{ ...kimi, usage: { inputOther: 0, output: 0, inputCacheRead: 0, inputCacheCreation: 0 } }], identity).usage).toBeUndefined()
  })
  it('deduplicates Hermes logical requests, preserves known context and promotes only full observer coverage', () => {
    const result = extractTelemetry('hermes', [hermes, hermes], identity)
    expect(result.usage).toEqual({ ...hermes.usage, scope: 'reported' })
    expect(result.runUsage).toBeUndefined()
    expect(extractTelemetry('hermes', [hermes], { ...identity, model: JSON.stringify([hermes.provider, hermes.model]) }).contextUsed).toBe(35)
    expect(extractTelemetry('hermes', [hermes], { ...identity, model: JSON.stringify(['other-provider', hermes.model]) }).contextUsed).toBeUndefined()
    expect(result).toMatchObject({ contextUsed: 35, contextCapacity: 1000, contextEstimated: false })
    expect(extractTelemetry('hermes', [hermes, summary], identity).runUsage).toEqual({ ...hermes.usage, scope: 'run' })
    expect(extractTelemetry('hermes', [hermes, { ...summary, errorCount: 1 }], identity).runUsage).toBeUndefined()
    expect(extractTelemetry('hermes', [hermes, { ...summary, coverageComplete: false }], identity).runUsage).toBeUndefined()
  })
  it('does not mark a partial set of Hermes native runs as a complete invocation', () => {
    const result = extractTelemetry('hermes', [hermes, summary, { ...hermes, nativeRunId: 'run-2' }], identity)
    expect(result.usage).toMatchObject({ total: 86, scope: 'reported' })
    expect(result.runUsage).toBeUndefined()
  })
  it('does not borrow another Hermes session or model and leaves missing context unknown', () => {
    expect(extractTelemetry('hermes', [{ ...hermes, sessionId: 'other' }], identity).usage).toBeUndefined()
    expect(extractTelemetry('hermes', [{ ...hermes, model: 'other' }], identity).usage).toBeUndefined()
    expect(extractTelemetry('hermes', [{ ...hermes, context: { ...hermes.context, used: 36 } }], identity).contextUsed).toBeUndefined()
  })
  it('lets the official HTTP run receipt outrank observed response aggregation', () => {
    const official = { type: 'hermes.run', session_id: identity.conversationId, run_id: 'run-1',
      usage: { total_tokens: 90, input_tokens: 80, output_tokens: 10, cache_read_tokens: 20, cache_write_tokens: 0 } }
    expect(extractTelemetry('hermes', [hermes, summary, official], identity).runUsage).toMatchObject({ total: 90, scope: 'run' })
  })
  it('keeps Hermes request composition estimated and partial without changing provider-exact pressure', () => {
    const breakdown = { systemTokens: 60, messageTokens: 10, estimated: true, basis: 'hermes-native-request-estimate' }
    const record = { ...hermes, context: { ...hermes.context, breakdown } }
    const result = extractTelemetry('hermes', [record], identity)
    expect(result).toMatchObject({ contextUsed: 35, contextEstimated: false,
      contextBreakdown: { systemTokens: 60, messageTokens: 10, estimated: true, source: 'Hermes 官方请求分类估算' } })
    expect(result.contextBreakdown?.toolTokens).toBeUndefined()
    const projection = nativeTelemetryProjections('hermes', result)
    expect(projection.contextBreakdown).toBeUndefined()
    expect(projection.contextPressure?.externalContext?.breakdown).toEqual({ systemTokens: 60, messageTokens: 10,
      estimated: true, source: 'Hermes 官方请求分类估算' })
    const complete = { ...record, context: { ...record.context, breakdown: { ...breakdown, toolTokens: 0 } } }
    expect(nativeTelemetryProjections('hermes', extractTelemetry('hermes', [complete], identity)).contextBreakdown)
      .toEqual({ systemTokens: 60, toolsTokens: 0, messageTokens: 10 })
    expect(extractTelemetry('hermes', [record, { ...hermes, requestId: 'api-2' }], identity).contextBreakdown).toBeUndefined()
    for (const context of [undefined, { ...hermes.context, used: 36 }, { ...hermes.context, capacity: 0 }]) {
      const next = extractTelemetry('hermes', [record, { ...hermes, requestId: 'api-2', context }], identity)
      expect(next.contextUsed).toBeUndefined()
      expect(next.contextBreakdown).toBeUndefined()
      expect(next.contextCapacity).toBe(1000)
    }
    const root = mkdtempSync(join(tmpdir(), 'cwn-SIMULATED-context-'))
    try {
      const path = join(root, 'native.jsonl')
      writeFileSync(path, JSON.stringify({ type: 'native', record }) + '\n')
      expect(new TelemetryReader().read(path, 'hermes', identity)).toEqual(result)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
  it('rejects malformed Hermes composition while preserving independent known totals', () => {
    for (const breakdown of [
      { systemTokens: 0, estimated: true, basis: 'another-estimate' },
      { systemTokens: 0, estimated: false, basis: 'hermes-native-request-estimate' },
      { systemTokens: 0, toolTokens: -1, estimated: true, basis: 'hermes-native-request-estimate' },
      { systemTokens: 0, messageTokens: Number.NaN, estimated: true, basis: 'hermes-native-request-estimate' },
      { estimated: true, basis: 'hermes-native-request-estimate' },
    ]) {
      const result = extractTelemetry('hermes', [{ ...hermes, context: { ...hermes.context, breakdown } }], identity)
      expect(result.contextUsed).toBe(35)
      expect(result.contextBreakdown).toBeUndefined()
    }
  })
  it('uses original OMP categories and never fills missing message/system categories', () => {
    const record = { type: 'cliworker.context_inspection', cli: 'omp', source: 'omp.native-context', sessionId: identity.conversationId,
      contextUsed: 100, contextCapacity: 1000, categories: [{ name: 'Skills', tokens: 15, kind: 'used' }, { name: 'Free', tokens: 900, kind: 'free' }] }
    const result = extractTelemetry('omp', [record], identity)
    expect(result.contextBreakdown).toEqual({ categories: record.categories, estimated: true, source: 'OMP 原生 /context 分类估算' })
    const projections = nativeTelemetryProjections('omp', result)
    expect(projections.contextPressure?.externalContext?.categories).toEqual(record.categories)
    expect(projections.contextBreakdown).toBeUndefined()
  })
  it('replaces OpenCode retained-session totals after rollback while keeping current-run accounting distinct', () => {
    const record = { type: 'cliworker.session_usage', cli: 'opencode', source: 'opencode.session.get', sessionId: identity.conversationId,
      usage: { total: 43, input: 12, output: 3, reasoning: 5, cacheRead: 20, cacheWrite: 3 } }
    expect(extractTelemetry('opencode', [record, { ...record, usage: { ...record.usage, total: 33, input: 2 } }], identity).usage)
      .toMatchObject({ total: 33, scope: 'session' })
    expect(extractTelemetry('opencode', [record], identity).runUsage).toBeUndefined()
  })
  it('preserves the same data through the bounded raw-log whitelist', () => {
    const root = mkdtempSync(join(tmpdir(), 'cwn-SIMULATED-supplemental-'))
    try {
      const path = join(root, 'native.jsonl')
      for (const [cli, records] of [['hermes', [hermes, summary]], ['kimi', [kimi]]] as const) {
        writeFileSync(path, records.map((record) => JSON.stringify({ type: 'native', record })).join('\n') + '\n')
        expect(new TelemetryReader().read(path, cli, identity)).toEqual(extractTelemetry(cli, records, identity))
      }
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})

describe('native partial billing details', () => {
  it('shows authoritative totals without inventing unknown Hermes cache counts', () => {
    const usage = { total: 43, input: 35, output: 8, scope: 'run' as const }
    expect(nativeTelemetryProjections('hermes', { usage }, undefined, 'run-1').tokenUsage).toEqual({
      externalUsage: { totalTokens: 43, inputTokens: 35, inputBasis: 'inclusive', outputTokens: 8 },
      externalScope: 'run', externalRunId: 'run-1', externalIsPrevious: false,
    })
  })
  it('shows only explicit OMP extra charges and rejects inconsistent billing', () => {
    const usage = { total: 45, input: 12, output: 8, cacheRead: 20, cacheWrite: 3, orchestration: { input: 2 }, scope: 'run' as const }
    expect(nativeUsageReport('omp', usage)).toMatchObject({ totalTokens: 45, orchestration: { input: 2 } })
    expect(nativeTelemetryProjections('omp', { usage }).tokenUsage).toHaveProperty('externalUsage')
    expect(nativeUsageReport('omp', { ...usage, total: 43 })).toBeUndefined()
    expect(nativeUsageReport('grok', { total: 1, input: 99, scope: 'reported' })).toBeUndefined()
    expect(nativeUsageReport('kimi', { total: 1, reasoning: 99, scope: 'reported' })).toBeUndefined()
    expect(nativeUsageReport('omp', { ...usage, orchestration: { output: -1 } })).toBeUndefined()
    expect(nativeUsageReport('hermes', { ...usage, input: 35 })).toBeUndefined()
  })
  it('retains known run totals while a new run is thinking, with explicit previous-run attribution', () => {
    const worker = { conversationId: identity.conversationId, preference: { cli: 'hermes' }, runId: randomUUID() } as Worker
    const receipt = { total: 43, input: 35, output: 8, scope: 'run' as const }
    worker.lastRunUsageSnapshot = captureLastRunUsageSnapshot(worker, { replies: {}, runUsage: receipt })
    const next = { ...worker, runId: randomUUID() }
    const current = withConversationTelemetry(next, { replies: {} })
    expect(current.usage).toEqual(receipt)
    expect(nativeTelemetryProjections('hermes', current, undefined, next.runId).tokenUsage)
      .toMatchObject({ externalUsage: { totalTokens: 43 }, externalIsPrevious: true, externalRunId: worker.runId })
  })
})
