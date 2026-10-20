import { describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { nativeModelDisplay } from '../src/shared/native-model-display.ts'
import { projectExternalTurnUsage } from '../src/host/harness-turn-usage.ts'
import { attachTelemetry } from '../src/host/telemetry.ts'
import type { Worker, WorkerEvent, TimelineItem } from '../src/shared/types.ts'
import type { HarnessConversationRecord } from '../src/host/harness-conversation-types.ts'

// Simulated settled runs and CLI receipts; no account or model is used.
function fixture(cli: 'qoder' | 'omp' = 'qoder') {
  const worker = { id: randomUUID(), runId: randomUUID(), parentSessionId: 'SIMULATED-parent', status: 'completed',
    preference: { cli, model: 'CURRENT-MODEL-MUST-NOT-LEAK', effort: 'default' },
    harnessConversation: { sessionId: 'SIMULATED-child', parentSessionId: 'SIMULATED-parent' } } as Worker
  const record: HarnessConversationRecord = { workerId: worker.id, parentSessionId: worker.parentSessionId,
    sessionId: worker.harnessConversation!.sessionId, turnRuns: [{ turn: 1, runId: worker.runId }] }
  const event = (runId: string, observedModel?: string): WorkerEvent => ({ runId, seq: 1, time: '', kind: 'status',
    state: 'completed', text: '', ...(observedModel ? { observedModel } : {}) })
  return { worker, record, event }
}
describe('run-local credits and model display', () => {
  it('binds credits to each settled turn, deduplicates runs and keeps explicit zero', () => {
    const { worker, record, event } = fixture(), prior = randomUUID()
    record.turnRuns!.push({ turn: 1, runId: worker.runId }, { turn: 2, runId: prior })
    const project = () => projectExternalTurnUsage(record, worker, false, [event(prior)], () => undefined,
      id => id === prior ? 0 : 0.252595)
    expect(project()).toEqual({
      '1': { basis: 'external-run', runIds: [worker.runId], label: 'CLI 运行合计', usageUnit: 'credits', credits: 0.252595 },
      '2': { basis: 'external-run', runIds: [prior], label: 'CLI 运行合计', usageUnit: 'credits', credits: 0 },
    })
    expect(project()).toEqual(project())
  })
  it.each([undefined, -1, NaN, Infinity])('keeps invalid or unavailable credits unknown: %s', value => {
    const { worker, record } = fixture()
    const entry = projectExternalTurnUsage(record, worker, false, [], () => undefined, () => value)['1']
    expect(entry).toMatchObject({ usageUnit: 'credits' })
    expect(entry).not.toHaveProperty('credits')
    expect(entry).not.toHaveProperty('usage')
  })
  it('refuses a partial sum, busy run, conflicting turn and unrelated child', () => {
    const { worker, record, event } = fixture(), prior = randomUUID()
    record.turnRuns!.push({ turn: 1, runId: prior })
    const read = (id: string) => id === prior ? undefined : 9
    expect(projectExternalTurnUsage(record, worker, false, [event(prior)], () => undefined, read)['1']).not.toHaveProperty('credits')
    expect(projectExternalTurnUsage(record, worker, true, [event(prior)], () => undefined, () => 9)['1']).not.toHaveProperty('credits')
    expect(projectExternalTurnUsage({ ...record, sessionId: 'OTHER' }, worker, false, [], () => undefined, () => 9)).toEqual({})
    record.turnRuns!.push({ turn: 2, runId: prior })
    expect(projectExternalTurnUsage(record, worker, false, [event(prior)], () => undefined, () => 9)).toEqual({ '1': null, '2': null })
  })
  it('retains native response accounting with only the exact observed model display', () => {
    const { worker, record, event } = fixture('omp')
    const result = projectExternalTurnUsage(record, worker, false, [event(worker.runId, 'zhipu-coding-plan/glm-5.3-flash'),
      event(randomUUID(), 'UNRELATED/model')], () => undefined)
    expect(result['1']).toMatchObject({ nativeUsage: true, displayRoutes: ['omp/zhipu-coding-plan/glm-5.3-flash'] })
    expect(JSON.stringify(result)).not.toContain('CURRENT-MODEL')
    expect(result['1']).not.toHaveProperty('usage')
  })
  it('keeps credits independent from hidden or contradictory token receipts', () => {
    const { worker, record } = fixture()
    expect(projectExternalTurnUsage(record, worker, false, [], () => ({ scope: 'run', total: 0, input: 0, output: 0 }), () => 0.3)['1'])
      .toMatchObject({ usageUnit: 'credits', credits: 0.3 })
  })
  it('puts fallback run credits only on the last reply in the same run', () => {
    const rows = [{ id: 'RUN:assistant:1', kind: 'assistant' }, { id: 'OTHER:assistant:1', kind: 'assistant' },
      { id: 'RUN:assistant:2', kind: 'assistant' }] as TimelineItem[]
    attachTelemetry(rows, 'RUN', { replies: {}, providerCredits: 0.25 })
    expect(rows.map(row => row.providerCredits)).toEqual([undefined, undefined, 0.25])
  })
})
describe('confirmed CLI model identities', () => {
  it.each(['omp', 'pi', 'zcode', 'opencode', 'mimo'] as const)('preserves %s provider and slash-containing model IDs', cli => {
    expect(nativeModelDisplay(cli, 'provider/family/model')).toBe(`${cli}/provider/family/model`)
  })
  it('uses the actual Hermes pair and leaves undisclosed providers explicit', () => {
    expect(nativeModelDisplay('hermes', '["nous","poolside/laguna-s-2.1:free"]')).toBe('hermes/nous/poolside/laguna-s-2.1:free')
    expect(nativeModelDisplay('qoder', 'qfmodel')).toBe('qoder/未公开/qfmodel')
    expect(nativeModelDisplay('claude', 'model')).toBe('claude/未公开/model')
    for (const value of [undefined, '', 'bad\nmodel', 'x'.repeat(1025)]) expect(nativeModelDisplay('omp', value)).toBeUndefined()
  })
})
