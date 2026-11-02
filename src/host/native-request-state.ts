import type { NativeRequestState, ExternalRequestState } from '../shared/native-request-state.ts'
import type { Worker, WorkerEvent } from '../shared/types.ts'

/** Only the isolated Hermes observer publishes these metadata frames. */
export function parseRequestState(value: Record<string, unknown>, sessionId: string | undefined): NativeRequestState | undefined {
  const count = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0
  if (value.type !== 'hermes.request-state' || !sessionId || value.sessionId !== sessionId ||
    typeof value.runId !== 'string' || !/^[\w-]{1,256}$/.test(value.runId) ||
    !count(value.sequence) || value.sequence === 0 ||
    !['requesting', 'failed', 'completed'].includes(value.phase as string)) return
  return {
    nativeRunId: value.runId, sequence: value.sequence,
    phase: value.phase as NativeRequestState['phase'],
    ...(count(value.statusCode) && value.statusCode >= 100 && value.statusCode <= 599 ? { statusCode: value.statusCode } : {}),
    ...(typeof value.reason === 'string' && /^[a-z_]{1,80}$/.test(value.reason) ? { reason: value.reason } : {}),
    ...(count(value.retryCount) ? { retryCount: value.retryCount } : {}),
    ...(typeof value.retryable === 'boolean' ? { retryable: value.retryable } : {}),
  }
}

/** Terminal, previous-run and completed requests cannot leave a stale live badge. */
export function projectRequestState(worker: Worker, events: readonly WorkerEvent[]): ExternalRequestState | undefined {
  if (worker.status !== 'running') return
  const event = events.findLast((item) => item.runId === worker.runId && item.requestState)
  const state = event?.requestState
  if (!state || state.phase === 'completed') return
  const { nativeRunId: _nativeRunId, ...rest } = state
  return { ...rest, phase: state.phase, runId: worker.runId }
}
