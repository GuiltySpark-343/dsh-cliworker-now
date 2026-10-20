import { describe, expect, it } from 'vitest'
import { nativeTelemetryFromSnapshot, nativeTelemetryProjections, nativeTokenUsage } from '../src/client/harness-telemetry-data.ts'
import type { HarnessConversationBinding, WorkerSnapshot } from '../src/shared/types.ts'

// Synthetic CLI receipts test numeric contracts only; no CLI or model is called.
const binding: HarnessConversationBinding & { workerId: string } = {
  sessionId: 'cli-child',
  parentSessionId: 'parent',
  workerId: 'worker',
  mode: 'continuable',
  capabilities: {} as HarnessConversationBinding['capabilities'],
}
const usage = { total: 110, input: 100, output: 10, cacheRead: 80, scope: 'session' as const }
function snapshot(): WorkerSnapshot {
  return {
    selected: {
      id: 'worker',
      parentSessionId: 'parent',
      harnessConversation: binding,
      preference: { cli: 'codex', model: 'reported-model', effort: 'default' },
    } as WorkerSnapshot['selected'],
    workers: [],
    timeline: [],
    revision: 1,
    truncated: false,
    telemetry: {
      usage,
      contextUsed: 250,
      contextCapacity: 1000,
      contextBreakdown: { systemTokens: 20, toolTokens: 30, messageTokens: 200 },
    },
  }
}

describe('faithful CLI statistics in native projection contracts', () => {
  it('keeps Qoder credit billing explicit even while credits are missing or zero', () => {
    for (const providerCredits of [undefined, 0, 0.252595]) {
      const projection = nativeTelemetryProjections('qoder', { providerCredits }, undefined)
      expect(projection.telemetryAvailability?.usageUnit).toBe('credits')
      if (providerCredits === undefined) expect(projection.tokenUsage).toBeUndefined()
      else expect(projection.tokenUsage).toMatchObject({ externalCredits: providerCredits })
    }
    expect(nativeTelemetryProjections('hermes', { providerCredits: 1 }).telemetryAvailability?.usageUnit).toBeUndefined()
  })
  it('normalizes Codex aggregate input without counting its cache twice', () => {
    expect(nativeTokenUsage('codex', usage)).toEqual({
      uncachedInputTokens: 20,
      outputTokens: 10,
      cacheReadTokens: 80,
      cacheWriteTokens: 0,
    })
    expect(nativeTokenUsage('codex', { ...usage, scope: 'run' })).toEqual(nativeTokenUsage('codex', usage))
    expect(nativeTokenUsage('codex', { ...usage, cacheRead: undefined })).toBeUndefined()
  })
  it.each(['claude', 'kimi', 'pi', 'omp'] as const)('keeps %s disjoint input and cache buckets', (cli) => {
    expect(nativeTokenUsage(cli, { ...usage, input: 10, cacheWrite: 10 })).toEqual({
      uncachedInputTokens: 10,
      outputTokens: 10,
      cacheReadTokens: 80,
      cacheWriteTokens: 10,
    })
    expect(nativeTokenUsage(cli, { ...usage, input: 10 })).toBeUndefined()
  })
  it.each(['mimo', 'opencode'] as const)(
    'joins only the separately reported %s reasoning into output',
    (cli) => {
      expect(
        nativeTokenUsage(cli, {
          total: 27,
          input: 10,
          output: 2,
          reasoning: 3,
          cacheRead: 5,
          cacheWrite: 7,
          scope: 'run',
        }),
      ).toEqual({ uncachedInputTokens: 10, outputTokens: 5, cacheReadTokens: 5, cacheWriteTokens: 7 })
      expect(
        nativeTokenUsage(cli, {
          total: 27,
          input: 10,
          output: 2,
          cacheRead: 5,
          cacheWrite: 7,
          scope: 'run',
        }),
      ).toBeUndefined()
    },
  )
  it('keeps AGY uncached input distinct from cache reads and validates its own reported total', () => {
    // Synthetic counters with the verified AGY receipt shape: cached reads
    // may exceed input and are excluded from the CLI's reported total.
    const agy = { total: 1423, input: 1400, output: 23, cacheRead: 1900, scope: 'session' as const }
    const native = nativeTokenUsage('antigravity', agy)
    expect(native).toEqual({
      uncachedInputTokens: 1400,
      outputTokens: 23,
      cacheReadTokens: 1900,
      cacheWriteTokens: 0,
    })
    expect(Object.values(native!).reduce((total, value) => total + value, 0)).toBe(3323)
    expect(nativeTokenUsage('antigravity', { ...agy, scope: 'response' })).toEqual(native)
    expect(nativeTokenUsage('antigravity', { ...agy, cacheWrite: 0 })).toEqual(native)
    expect(nativeTokenUsage('antigravity', { ...agy, cacheWrite: 1 })).toBeUndefined()
    expect(nativeTokenUsage('antigravity', { ...agy, cacheWrite: null } as any)).toBeUndefined()
    expect(nativeTokenUsage('antigravity', { ...agy, total: 3323 })).toBeUndefined()
    expect(nativeTokenUsage('antigravity', { ...agy, cacheRead: undefined })).toBeUndefined()
    expect(nativeTokenUsage('antigravity', { ...agy, input: undefined })).toBeUndefined()
    expect(nativeTokenUsage('antigravity', { ...agy, output: -1 })).toBeUndefined()
    expect(nativeTokenUsage('antigravity', { ...agy, cacheRead: Number.MAX_SAFE_INTEGER })).toBeUndefined()
  })
  it.each(['hermes', 'zcode'] as const)(
    'subtracts only explicit cache buckets from %s aggregate input',
    (cli) => {
      expect(nativeTokenUsage(cli, { ...usage, cacheWrite: 5 })).toEqual({
        uncachedInputTokens: 15,
        outputTokens: 10,
        cacheReadTokens: 80,
        cacheWriteTokens: 5,
      })
      expect(nativeTokenUsage(cli, usage)).toBeUndefined()
    },
  )
  it('rejects impossible totals, invalid counts and unsupported accounting without inventing zeros', () => {
    for (const corrupt of [
      { total: 111 },
      { cacheRead: 101 },
      { output: -1 },
      { output: NaN },
      { input: Number.MAX_SAFE_INTEGER + 1 },
      { input: undefined },
      { cacheWrite: null },
    ])
      expect(nativeTokenUsage('codex', { ...usage, ...corrupt } as any)).toBeUndefined()
    expect(nativeTokenUsage('kimi', { ...usage, cacheWrite: 0 })).toBeUndefined()
    expect(nativeTokenUsage('codex', { total: 0, input: 0, output: 0, cacheRead: 0, scope: 'run' })).toEqual({
      uncachedInputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    })
  })
  it('keeps explicit context occupancy independent from cumulative billing and partial composition unknown', () => {
    expect(nativeTelemetryProjections('codex', snapshot().telemetry)).toMatchObject({
      contextPressure: { pressureTokens: 250, contextWindow: 1000 },
      contextBreakdown: { systemTokens: 20, toolsTokens: 30, messageTokens: 200 },
    })
    expect(nativeTelemetryProjections('codex', { usage })).toMatchObject({
      contextPressure: undefined,
      contextBreakdown: undefined,
    })
    expect(
      nativeTelemetryProjections('codex', {
        contextUsed: 0,
        contextCapacity: 0,
        contextBreakdown: { systemTokens: 0 },
      }),
    ).toMatchObject({
      contextPressure: { pressureTokens: 0, externalContext: { breakdown: { systemTokens: 0 } } },
      contextBreakdown: undefined,
    })
  })
  it('accepts only the exact selected Worker, parent, child and mode', () => {
    expect(nativeTelemetryFromSnapshot(binding, snapshot())).toEqual({
      cli: 'codex',
      telemetry: snapshot().telemetry,
      lifecycle: { busy: false, externalRequestState: undefined },
    })
    for (const update of [
      { id: 'other' },
      { parentSessionId: 'other' },
      { harnessConversation: undefined },
      { harnessConversation: { ...binding, sessionId: 'other' } },
      { harnessConversation: { ...binding, parentSessionId: 'other' } },
      { harnessConversation: { ...binding, mode: 'different' } },
    ])
      expect(
        nativeTelemetryFromSnapshot(binding, {
          ...snapshot(),
          selected: { ...snapshot().selected, ...update } as any,
        }),
      ).toBeUndefined()
    expect(nativeTelemetryFromSnapshot({ ...binding, sessionId: 'parent' }, snapshot())).toBeUndefined()
    expect(nativeTelemetryFromSnapshot({ ...binding, workerId: undefined }, snapshot())).toBeUndefined()
  })
})

it('retains partial native context categories without turning missing counts into zero', () => {
  const values = nativeTelemetryProjections('hermes', { contextUsed: 4091, contextCapacity: 1048576,
    contextEstimated: false, contextSource: 'Hermes request',
    contextBreakdown: { systemTokens: 2900, messageTokens: 100, estimated: true, source: 'Hermes native estimate' } })
  expect(values.contextPressure).toEqual({ pressureTokens: 4091, contextWindow: 1048576,
    externalContext: { estimated: false, source: 'Hermes request', breakdown: {
      systemTokens: 2900, messageTokens: 100, estimated: true, source: 'Hermes native estimate',
    } } })
  expect(values.contextBreakdown).toBeUndefined()
  const changed = nativeTelemetryProjections('hermes', { contextUsed: 4120, contextCapacity: 1048576 })
  expect(changed.contextPressure?.externalContext).toEqual({})
  expect(changed.contextBreakdown).toBeUndefined()
})

it('keeps a true zero category and rejects invalid counts without losing other valid categories', () => {
  const values = nativeTelemetryProjections('antigravity', { contextUsed: 200, contextCapacity: 10000,
    contextBreakdown: { systemTokens: 0, toolTokens: NaN, messageTokens: 180 } })
  expect(values.contextPressure?.externalContext?.breakdown).toEqual({ systemTokens: 0, messageTokens: 180 })
  expect(values.contextBreakdown).toBeUndefined()
})


it('describes a retained run receipt without converting it to session usage', () => {
  const values = nativeTelemetryProjections('hermes', {
    usageRunId: 'old-run', usage: { input: 3897, output: 4, cacheRead: 224, cacheWrite: 0, total: 3901, scope: 'run' },
  }, undefined, 'new-run')
  expect(values.tokenUsage).toEqual({ uncachedInputTokens: 3673, outputTokens: 4, cacheReadTokens: 224,
    cacheWriteTokens: 0, externalScope: 'run', externalRunId: 'old-run', externalIsPrevious: true })
  expect(values.contextPressure).toBeUndefined()
})
