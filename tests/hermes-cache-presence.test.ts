import { afterEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TelemetryReader, extractTelemetry } from '../src/host/telemetry.ts'
import { hermesSessionTelemetry } from '../src/host/hermes-session-telemetry.ts'
import { captureConversationTelemetry, captureLastRunUsageSnapshot, withConversationTelemetry } from '../src/host/conversation-telemetry.ts'
import { projectExternalTurnUsage } from '../src/host/harness-turn-usage.ts'
import { WorkerStorage } from '../src/host/storage.ts'
import { nativeTelemetryProjections } from '../src/client/harness-telemetry-data.ts'
import { nativeTokenUsage } from '../src/shared/native-token-usage.ts'
import type { Worker } from '../src/shared/types.ts'

// Explicitly simulated official protocol receipts. No CLI, account or user data.
const roots: string[] = []
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }) })
function temporary() { const path = mkdtempSync(join(tmpdir(), 'cwn-hermes-cache-SIMULATED-')); roots.push(path); return path }
const identity = { conversationId: 'SIMULATED-session', model: 'SIMULATED-model' }
const official = { type: 'hermes.run', session_id: identity.conversationId, run_id: 'SIMULATED-native-run',
  usage: { input_tokens: 4063, output_tokens: 8, total_tokens: 4071, cache_read_tokens: 0, cache_write_tokens: 0 } }
const observation = { type: 'cliworker.hermes_observation', source: 'hermes.observer.post_api_request',
  usageBasis: 'cli-normalized', sessionId: identity.conversationId, nativeRunId: official.run_id,
  turnId: 'SIMULATED-turn', requestId: 'SIMULATED-request', model: identity.model, provider: 'SIMULATED-provider',
  usage: { input: 4063, output: 8, total: 4071 } }
const summary = { type: 'cliworker.hermes_observer_summary', source: 'hermes.observer.summary',
  usageBasis: 'cli-normalized', sessionId: identity.conversationId, nativeRunId: official.run_id,
  requestCount: 10, responseCount: 1, errorCount: 9, coverageComplete: true, usageComplete: false }
const expected = { input: 4063, output: 8, total: 4071, scope: 'run' }

describe('Hermes normalized cache presence', () => {
  it.each([{ supplement: [] }, { supplement: [observation, summary] }])('keeps the official total without manufacturing cache zeros (supplement=$supplement)', ({ supplement }) => {
    const result = extractTelemetry('hermes', [...supplement, official], identity)
    expect(result.usage).toEqual(expected)
    expect(result.runUsage).toEqual(expected)
    expect(nativeTokenUsage('hermes', result.runUsage)).toBeUndefined()
    expect(nativeTelemetryProjections('hermes', result).tokenUsage).toMatchObject({
      externalUsage: { totalTokens: 4071, inputTokens: 4063, outputTokens: 8, inputBasis: 'inclusive' },
    })
  })
  it('replays the existing wire shape cold, deduplicates terminal snapshots and publishes partial turn usage', () => {
    const directory = temporary(), path = join(directory, 'SIMULATED.raw.jsonl')
    const records = [observation, summary, { ...official, type: undefined, event: 'run.completed' }, official]
    writeFileSync(path, records.map(record => JSON.stringify({ type: 'native', record })).join('\n') + '\n')
    const before = readFileSync(path)
    for (let index = 0; index < 2; index++) {
      const receipt = new TelemetryReader().read(path, 'hermes', identity).runUsage
      expect(receipt).toEqual(expected)
      const worker = { id: randomUUID(), parentSessionId: 'SIMULATED-parent', runId: randomUUID(), status: 'completed',
        preference: { cli: 'hermes' }, harnessConversation: { sessionId: 'SIMULATED-child', parentSessionId: 'SIMULATED-parent' } } as Worker
      const projected = projectExternalTurnUsage({ workerId: worker.id, parentSessionId: worker.parentSessionId,
        sessionId: worker.harnessConversation!.sessionId, turnRuns: [{ turn: 1, runId: worker.runId }] }, worker, false, [], () => receipt)
      expect(projected['1']).toEqual({ basis: 'external-run', label: 'CLI 运行合计', runIds: [worker.runId], externalUsage: {
        totalTokens: 4071, inputTokens: 4063, outputTokens: 8, inputBasis: 'inclusive',
      } })
      expect(projected['1']).not.toHaveProperty('usage')
    }
    expect(readFileSync(path)).toEqual(before)
  })
  it('keeps positive normalized counters but does not mistake explicit canonical zero for raw presence', () => {
    const result = extractTelemetry('hermes', [{ ...official,
      usage: { ...official.usage, cache_read_tokens: 200, cache_write_tokens: 3 } }], identity)
    expect(result.runUsage).toEqual({ ...expected, cacheRead: 200, cacheWrite: 3 })
    expect(nativeTokenUsage('hermes', result.runUsage)).toEqual({ uncachedInputTokens: 3860,
      outputTokens: 8, cacheReadTokens: 200, cacheWriteTokens: 3 })
    const partial = extractTelemetry('hermes', [{ ...official,
      usage: { ...official.usage, cache_read_tokens: 200 } }], identity)
    expect(partial.usage).toEqual({ ...expected, cacheRead: 200 })
    expect(nativeTokenUsage('hermes', partial.usage)).toBeUndefined()
  })
  it('treats canonical observer zeros the same way and keeps incomplete observations reported only', () => {
    const result = extractTelemetry('hermes', [{ ...observation, usage: { ...observation.usage, cacheRead: 0, cacheWrite: 0 } }, summary], identity)
    expect(result.usage).toEqual({ ...expected, scope: 'reported' })
    expect(result.runUsage).toBeUndefined()
  })
  it('preserves legacy inclusive prompt accounting before dropping normalized cache zeros', () => {
    const result = extractTelemetry('hermes', [{ type: 'result', session_id: identity.conversationId,
      tokens: { input: 3863, output: 8, total: 4071, cache_read: 200, cache_write: 0 } }], identity)
    expect(result.usage).toEqual({ ...expected, cacheRead: 200 })
    expect(result.runUsage).toEqual({ ...expected, cacheRead: 200 })
  })
  it('does not change explicit original zero counters in other protocols', () => {
    const result = extractTelemetry('claude', [{ type: 'result', session_id: identity.conversationId,
      usage: { input_tokens: 4063, output_tokens: 8, total_tokens: 4071, cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0 } }], identity)
    expect(result.runUsage).toEqual({ ...expected, cacheRead: 0, cacheWrite: 0 })
    expect(nativeTokenUsage('claude', result.runUsage)).toEqual({ uncachedInputTokens: 4063,
      outputTokens: 8, cacheReadTokens: 0, cacheWriteTokens: 0 })
  })
})

describe('cold legacy Hermes snapshots and DB counters', () => {
  it.each(['lastRunUsageSnapshot', 'conversationTelemetry'] as const)('disambiguates old %s without rewriting persisted bytes', field => {
    const directory = temporary(), scope = field === 'lastRunUsageSnapshot' ? 'run' : 'session'
    const worker = { id: randomUUID(), parentSessionId: 'SIMULATED-parent', runId: randomUUID(), project: directory,
      title: 'SIMULATED', agentName: 'SIMULATED', agentNameOrigin: 'custom', mode: 'accept-edits', status: 'completed', conversationId: identity.conversationId,
      preference: { cli: 'hermes', model: identity.model, effort: 'default' }, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() } as Worker
    const checkpoint = { policy: 1, cli: 'hermes', conversationId: worker.conversationId, runId: worker.runId,
      usage: { ...expected, scope, cacheRead: 0, cacheWrite: 0 } }
    Object.assign(worker, { [field]: checkpoint })
    const store = new WorkerStorage(directory); store.save(worker); store.close()
    const workerPath = join(directory, `${worker.id}.worker.json`), before = readFileSync(workerPath)
    const reopened = new WorkerStorage(directory)
    try {
      const loaded = reopened.workers.get(worker.id)!
      const projected = withConversationTelemetry(loaded, { replies: {} })
      expect(projected.usage).toEqual({ ...expected, scope })
      expect(nativeTokenUsage('hermes', projected.usage)).toBeUndefined()
      expect(loaded[field]?.usage).toMatchObject({ cacheRead: 0, cacheWrite: 0 })
      expect(readFileSync(workerPath)).toEqual(before)
    } finally { reopened.close() }
  })
  it('sanitizes newly captured run/session snapshots and preserves positive cache fields', () => {
    const worker = { conversationId: identity.conversationId, runId: randomUUID(), preference: { cli: 'hermes' } } as Worker
    const runUsage = { ...expected, scope: 'run' as const, cacheRead: 200, cacheWrite: 0 }
    expect(captureLastRunUsageSnapshot(worker, { replies: {}, runUsage })?.usage).toEqual({ ...expected, cacheRead: 200 })
    expect(captureConversationTelemetry(worker, { replies: {}, usage: { ...runUsage, scope: 'session' } })?.usage)
      .toEqual({ ...expected, cacheRead: 200, scope: 'session' })
    expect(runUsage.cacheWrite).toBe(0)
  })
  it('keeps the session DB canonical totals and positive cache but leaves canonical zero unknown', () => {
    const result = hermesSessionTelemetry({ input_tokens: 3863, output_tokens: 8, cache_read_tokens: 200, cache_write_tokens: 0 })
    expect(result?.usage).toEqual({ ...expected, cacheRead: 200, scope: 'session' })
    expect(nativeTokenUsage('hermes', result?.usage)).toBeUndefined()
  })
})
