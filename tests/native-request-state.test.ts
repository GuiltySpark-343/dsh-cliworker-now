import { describe, it, expect } from 'vitest'
import { BridgeProtocol } from '../src/host/bridge-protocol.ts'
import { projectRequestState } from '../src/host/native-request-state.ts'
import { nativeTelemetryProjections } from '../src/client/harness-telemetry-data.ts'
import type { Worker, WorkerEvent } from '../src/shared/types.ts'

// Synthetic official-hook frames. No CLI, model or user state is modified.
function fixture() {
  const events: WorkerEvent[] = []
  const protocol = new BridgeProtocol((event) => events.push({ ...event, runId: 'worker-run', seq: events.length + 1, time: '2026-10-17T00:00:00Z' }), () => {}, 10000)
  const send = (value: unknown) => protocol.feed(JSON.stringify(value) + '\n')
  send({ type: 'session', id: 'session' })
  const state = (sequence: number, phase = 'requesting', extra = {}) => send({ type: 'native', record: {
    type: 'hermes.request-state', sessionId: 'session', runId: 'native-run', sequence, phase, ...extra,
  } })
  const worker = { runId: 'worker-run', status: 'running' } as Worker
  return { events, state, worker }
}
describe('observed request lifecycle through the native session data contract', () => {
  it('publishes requests and failures without manufacturing model/tool/usage events', () => {
    const f = fixture()
    f.state(2)
    f.state(3, 'failed', { statusCode: 429, reason: 'upstream_rate_limit', retryCount: 0, retryable: true, message: 'SECRET', delayMs: 30000 })
    const projected = projectRequestState(f.worker, f.events)
    expect(projected).toEqual({ runId: 'worker-run', sequence: 3, phase: 'failed', statusCode: 429, reason: 'upstream_rate_limit', retryCount: 0, retryable: true })
    expect(f.events.every((event) => event.kind === 'status')).toBe(true)
    expect(JSON.stringify(f.events)).not.toMatch(/SECRET|delayMs/)
    f.state(4, 'requesting', { retryCount: 0 }) // Real outer recovery may reset retry count.
    expect(projectRequestState(f.worker, f.events)?.phase).toBe('requesting')
    f.state(5, 'completed')
    expect(projectRequestState(f.worker, f.events)).toBeUndefined()
  })
  it('ignores stale occurrences and foreign identities, clears previous runs and terminal state', () => {
    const f = fixture()
    f.state(2)
    f.state(2, 'failed')
    f.state(3, 'failed', { sessionId: 'other' })
    f.state(4, 'failed', { runId: 'other' })
    expect(projectRequestState(f.worker, f.events)?.sequence).toBe(2)
    expect(projectRequestState({ ...f.worker, runId: 'next' }, f.events)).toBeUndefined()
    expect(projectRequestState({ ...f.worker, status: 'completed' }, f.events)).toBeUndefined()
  })
  it('keeps first-run statistics explicitly unknown, retains receipts and binds live state to its run', () => {
    const f = fixture(); f.state(2)
    const request = projectRequestState(f.worker, f.events)
    const first = nativeTelemetryProjections('hermes', undefined, undefined, 'worker-run', { busy: true, externalRequestState: request })
    expect(first.telemetryAvailability).toEqual(Object.fromEntries(['statistics', 'tokenUsage', 'context'].map((key) => [key, { state: 'pending', reason: 'awaiting-data' }])))
    expect(first.tokenUsage).toBeUndefined()
    expect(first.contextPressure).toBeUndefined()
    expect(first.externalRequestState).toEqual(request)
    expect(nativeTelemetryProjections('hermes', undefined, undefined, 'next', { busy: true, externalRequestState: request }).externalRequestState).toBeUndefined()
    const done = nativeTelemetryProjections('hermes', undefined, undefined, 'worker-run', { busy: false, externalRequestState: request })
    expect(done.externalRequestState).toBeUndefined()
    expect(done.telemetryAvailability?.tokenUsage).toEqual({ state: 'unavailable', reason: 'not-reported' })
  })
})
