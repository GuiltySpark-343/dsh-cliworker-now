import { describe, expect, it } from 'vitest'
import { projectExternalTurnAnswer } from '../src/host/harness-turn-answer.ts'
import type { HarnessConversationRecord } from '../src/host/harness-conversation-types.ts'
import type { HarnessTurnObservation } from '../src/host/harness-turn-usage.ts'
import type { Worker, WorkerEvent } from '../src/shared/types.ts'

const WORKER = '11111111-1111-4111-8111-111111111111'
const RUN = '22222222-2222-4222-8222-222222222222'
const OTHER_RUN = '33333333-3333-4333-8333-333333333333'
const ANSWER = '44444444-4444-4444-8444-444444444444'
const TEXT = 'SIMULATED 你好！'
const notice = (id: string) => ({ role: 'user', id, content: [],
  source: { kind: 'cliworker-continuation', form: 'notice', summary: 'SIMULATED continuation' } })

/** Explicitly simulated replay of text -> late public reasoning -> empty cleanup step. */
function fixture() {
  const record: HarnessConversationRecord = { workerId: WORKER, parentSessionId: 'SIMULATED-parent',
    sessionId: 'SIMULATED-child', turnRuns: [{ turn: 1, runId: RUN }] }
  const worker = { id: WORKER, parentSessionId: record.parentSessionId, runId: RUN, status: 'completed',
    preference: { cli: 'hermes', model: 'SIMULATED-model', effort: 'default' },
    harnessConversation: { sessionId: record.sessionId, parentSessionId: record.parentSessionId, mode: 'continuable', capabilities: {} },
  } as Worker
  const events: any[] = []
  const event = (type: string, data: any) => {
    const value = { type, seq: events.length, time: events.length, data }
    events.push(value)
    return value
  }
  const assistant = (step: number, content: any[], id: string) => event('assistant/message', { turn: 1, step,
    message: { role: 'assistant', id, content, source: { kind: 'model', provider: 'cliworker-native', model: `worker/${WORKER}` } },
    stream: [] })
  event('subagent/descriptor', { kind: 'SIMULATED' })
  event('turn/start', { turn: 1 })
  event('step/start', { turn: 1, step: 1 })
  event('user/message', { role: 'user', id: 'SIMULATED-prompt', source: { kind: 'user' }, content: [{ type: 'text', text: 'SIMULATED say hello' }] })
  event('agent/inbox/spliced', { target: 'next-step', start: 0, inserted: [notice('SIMULATED-notice-2')] })
  const answer = assistant(1, [{ type: 'text', text: TEXT }], ANSWER)
  event('step/end', { turn: 1, step: 1 })
  event('agent/inbox/spliced', { target: 'next-step', start: 0, removedCount: 1, inserted: [] })
  event('step/start', { turn: 1, step: 2 })
  const continuation = event('user/message', notice('SIMULATED-notice-2'))
  event('agent/inbox/spliced', { target: 'next-step', start: 0, inserted: [notice('SIMULATED-notice-3')] })
  const reasoning = assistant(2, [{ type: 'reasoning', text: 'SIMULATED public reasoning' }], 'SIMULATED-reasoning')
  event('step/end', { turn: 1, step: 2 })
  event('agent/inbox/spliced', { target: 'next-step', start: 0, removedCount: 1, inserted: [] })
  event('step/start', { turn: 1, step: 3 })
  event('user/message', notice('SIMULATED-notice-3'))
  const empty = assistant(3, [], 'SIMULATED-empty')
  event('step/end', { turn: 1, step: 3 })
  const end = event('turn/end', { turn: 1, reason: { kind: 'completed' } })
  const workerEvents: WorkerEvent[] = [
    { seq: 1, runId: RUN, time: 'SIMULATED', kind: 'user', text: 'SIMULATED say hello' },
    { seq: 2, runId: RUN, time: 'SIMULATED', kind: 'assistant', text: TEXT },
    { seq: 3, runId: RUN, time: 'SIMULATED', kind: 'reasoning', text: 'SIMULATED public reasoning' },
    { seq: 4, runId: RUN, time: 'SIMULATED', kind: 'result', text: TEXT, state: 'SUCCESS', resultScope: 'response' },
    { seq: 5, runId: RUN, time: 'SIMULATED', kind: 'diagnostic', text: 'SIMULATED process cleanup' },
    { seq: 6, runId: RUN, time: 'SIMULATED', kind: 'status', text: 'completed', state: 'completed' },
  ]
  const observation = { header: { id: record.sessionId, parentSession: record.parentSessionId, origin: 'subagent' },
    inheritedEventCount: 0, events } as HarnessTurnObservation
  const project = () => projectExternalTurnAnswer(record, worker, workerEvents, observation)
  return { record, worker, workerEvents, observation, events, answer, reasoning, continuation, empty, end, event, project }
}

describe('read-only historical CLI answer proof', () => {
  it('identifies the exact existing text before legacy reasoning and empty cleanup, without copying content or mutating evidence', () => {
    const f = fixture(), before = structuredClone({ record: f.record, worker: f.worker, workerEvents: f.workerEvents, observation: f.observation })
    expect(f.project()).toEqual({ '1': { answerSeq: f.answer.seq, answerStep: 1, messageId: ANSWER, turnEndSeq: f.end.seq } })
    expect({ record: f.record, worker: f.worker, workerEvents: f.workerEvents, observation: f.observation }).toEqual(before)
    expect(JSON.stringify(f.project())).not.toContain(TEXT)
  })

  it('preserves verified old turns when a different run is active and its native turn is still open', () => {
    const f = fixture(); f.worker.runId = OTHER_RUN; f.worker.status = 'running'
    f.record.turnRuns!.push({ turn: 2, runId: OTHER_RUN })
    f.workerEvents.push({ seq: 7, runId: OTHER_RUN, time: 'SIMULATED', kind: 'status', text: 'running', state: 'running' })
    f.event('turn/start', { turn: 2 }); f.event('step/start', { turn: 2, step: 1 })
    expect(f.project()).toEqual({ '1': { answerSeq: f.answer.seq, answerStep: 1, messageId: ANSWER, turnEndSeq: f.end.seq } })
  })

  it('does not confuse a later undelivered outbox update with CLI activity in the settled run', () => {
    const f = fixture()
    f.workerEvents.push({ seq: 7, runId: RUN, time: 'SIMULATED', kind: 'submission', text: 'SIMULATED queued followup', deliveryState: 'pending' })
    expect(f.project()).toHaveProperty('1')
    f.workerEvents[6]!.kind = 'user'
    expect(f.project()).toEqual({})
  })

  it.each([
    ['record worker', (f: ReturnType<typeof fixture>) => { f.record.workerId = OTHER_RUN }],
    ['record parent', (f: ReturnType<typeof fixture>) => { f.record.parentSessionId = 'other-parent' }],
    ['record child', (f: ReturnType<typeof fixture>) => { f.record.sessionId = 'other-child' }],
    ['binding parent', (f: ReturnType<typeof fixture>) => { f.worker.harnessConversation!.parentSessionId = 'other-parent' }],
    ['header child', (f: ReturnType<typeof fixture>) => { f.observation.header.id = 'other-child' as any }],
    ['header parent', (f: ReturnType<typeof fixture>) => { f.observation.header.parentSession = 'other-parent' as any }],
    ['ordinary origin', (f: ReturnType<typeof fixture>) => { f.observation.header.origin = 'user' as any }],
    ['missing child', (f: ReturnType<typeof fixture>) => { f.worker.harnessConversation = undefined }],
  ] as const)('rejects wrong %s ownership', (_name, mutate) => {
    const f = fixture(); mutate(f); expect(f.project()).toEqual({})
  })

  it.each([
    ['missing mapping', (f: ReturnType<typeof fixture>) => { f.record.turnRuns = undefined }],
    ['multiple runs', (f: ReturnType<typeof fixture>) => { f.record.turnRuns!.push({ turn: 1, runId: OTHER_RUN }) }],
    ['run reused in another turn', (f: ReturnType<typeof fixture>) => { f.record.turnRuns!.push({ turn: 2, runId: RUN }) }],
    ['invalid run', (f: ReturnType<typeof fixture>) => { f.record.turnRuns![0]!.runId = 'guessed-run' }],
    ['missing run receipt', (f: ReturnType<typeof fixture>) => { f.workerEvents.forEach((event) => { event.runId = OTHER_RUN }) }],
    ['open worker', (f: ReturnType<typeof fixture>) => { f.worker.status = 'running' }],
    ['interrupted run', (f: ReturnType<typeof fixture>) => { f.workerEvents.at(-1)!.state = 'interrupted' }],
    ['failed result', (f: ReturnType<typeof fixture>) => { f.workerEvents[3]!.state = 'ERROR' }],
    ['wrong result', (f: ReturnType<typeof fixture>) => { f.workerEvents[3]!.text = 'SIMULATED different result' }],
    ['only worker lastResult', (f: ReturnType<typeof fixture>) => { f.worker.lastResult = TEXT; f.workerEvents[3]!.kind = 'diagnostic' }],
    ['open native turn', (f: ReturnType<typeof fixture>) => { f.events.pop() }],
    ['interrupted native turn', (f: ReturnType<typeof fixture>) => { f.end.data.reason.kind = 'interrupted' }],
  ] as const)('rejects %s rather than guessing an answer', (_name, mutate) => {
    const f = fixture(); mutate(f); expect(f.project()).toEqual({})
  })

  it.each([
    ['a real tool', (f: ReturnType<typeof fixture>) => { f.reasoning.type = 'tool/call'; f.reasoning.data = { turn: 1, step: 2, callId: 'SIMULATED', name: 'SIMULATED', arguments: '{}' } }],
    ['another user', (f: ReturnType<typeof fixture>) => { f.continuation.data.source.kind = 'user' }],
    ['a nonempty notice', (f: ReturnType<typeof fixture>) => { f.continuation.data.content = [{ type: 'text', text: 'SIMULATED steer' }] }],
    ['another inbox target', (f: ReturnType<typeof fixture>) => { f.events[10]!.data.target = 'next-turn' }],
    ['another inbox message', (f: ReturnType<typeof fixture>) => { f.events[10]!.data.inserted[0].source.kind = 'user' }],
    ['unproven inbox removal', (f: ReturnType<typeof fixture>) => { f.events[7]!.data.removedCount = 2 }],
    ['a queued real input', (f: ReturnType<typeof fixture>) => { f.events[4]!.data.inserted[0].source.kind = 'user' }],
    ['a substituted notice', (f: ReturnType<typeof fixture>) => { f.continuation.data.id = 'SIMULATED-other-notice' }],
    ['an assistant attempt', (f: ReturnType<typeof fixture>) => { f.reasoning.type = 'assistant/attempt'; f.reasoning.data = { turn: 1, step: 2, stream: [] } }],
    ['another provider', (f: ReturnType<typeof fixture>) => { f.reasoning.data.message.source.provider = 'other-provider' }],
    ['another worker', (f: ReturnType<typeof fixture>) => { f.answer.data.message.source.model = `worker/${OTHER_RUN}` }],
    ['interrupted assistant', (f: ReturnType<typeof fixture>) => { f.answer.data.interrupted = true }],
    ['unknown later event', (f: ReturnType<typeof fixture>) => { f.reasoning.type = 'SIMULATED/future-event' }],
  ] as const)('refuses recovery across %s', (_name, mutate) => {
    const f = fixture(); mutate(f); expect(f.project()).toEqual({})
  })

  it('does not project normal final-step answers or choose an earlier matching answer over a later reply', () => {
    const f = fixture(); f.empty.data.message.content = [{ type: 'text', text: TEXT }]
    expect(f.project()).toEqual({})
    f.empty.data.message.content = []
    f.reasoning.data.message.content = [{ type: 'text', text: 'SIMULATED different reply' }]
    expect(f.project()).toEqual({})
  })

  it.each([
    ['a native page', (f: ReturnType<typeof fixture>) => { f.events.shift() }],
    ['a native gap', (f: ReturnType<typeof fixture>) => { f.events.splice(2, 1) }],
    ['a Worker page', (f: ReturnType<typeof fixture>) => { f.workerEvents.shift() }],
    ['a Worker gap', (f: ReturnType<typeof fixture>) => { f.workerEvents.splice(2, 1) }],
    ['a negative inherited count', (f: ReturnType<typeof fixture>) => { f.observation.inheritedEventCount = -1 }],
    ['an inherited turn', (f: ReturnType<typeof fixture>) => { f.observation.inheritedEventCount = f.events.length }],
    ['a broken step end', (f: ReturnType<typeof fixture>) => { f.events[6]!.data.step = 7 }],
    ['a replacement', (f: ReturnType<typeof fixture>) => { f.answer.surfaceOp = { op: 'replace', startSeq: 3, endSeq: 3 } }],
    ['a duplicated message identity', (f: ReturnType<typeof fixture>) => { f.reasoning.data.message.id = ANSWER }],
  ] as const)('rejects %s instead of recovering from incomplete or ambiguous history', (_name, mutate) => {
    const f = fixture(); mutate(f); expect(f.project()).toEqual({})
  })
})
