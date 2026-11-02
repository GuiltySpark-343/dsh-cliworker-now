import { z } from 'zod'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ExternalTurnAnswer } from '../shared/native-turn-answer.ts'
import type { Worker, WorkerEvent } from '../shared/types.ts'
import type { HarnessConversationRecord } from './harness-conversation-types.ts'
import type { HarnessTurnObservation } from './harness-turn-usage.ts'

const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0
const uuid = z.uuid()
const terminal = new Set(['completed', 'failed', 'interrupted', 'uncertain'])
type AssistantEvent = SessionEvent<'assistant/message'>
type UserMessage = SessionEvent<'user/message'>['data']
interface Turn {
  id: number
  events: SessionEvent[]
  steps: number[]
  end?: SessionEvent<'turn/end'>
}

function continuation(message: UserMessage): boolean {
  return message.role === 'user' && message.source.kind === 'cliworker-continuation' &&
    'form' in message.source && message.source.form === 'notice' && message.content.length === 0
}

function ownedAssistant(event: AssistantEvent, workerId: string): boolean {
  const { message, interrupted } = event.data
  return !interrupted && (event.surfaceOp === undefined || event.surfaceOp === 'append') &&
    message.role === 'assistant' && typeof message.id === 'string' && message.id.length > 0 &&
    message.source.kind === 'model' && message.source.provider === 'cliworker-native' &&
    message.source.model === `worker/${workerId}` &&
    message.content.every((block) => block.type === 'text' || block.type === 'reasoning')
}

function textOf(event: AssistantEvent): string {
  return event.data.message.content.filter((block) => block.type === 'text').map((block) => block.text).join('')
}

function spliceInbox(event: SessionEvent<'agent/inbox/spliced'>, queue: UserMessage[]): UserMessage[] | undefined {
  const { start, removedCount = 0, inserted } = event.data
  if (!count(start) || !count(removedCount) || start > queue.length || start + removedCount > queue.length) return
  return queue.splice(start, removedCount, ...inserted)
}

/** Full append-only observation only: a page, replacement or broken lifecycle proves nothing. */
function turnsOf(observation: HarnessTurnObservation): Map<number, Turn> | undefined {
  const { events, inheritedEventCount } = observation
  if (!count(inheritedEventCount) || inheritedEventCount > events.length) return
  for (let index = 0; index < events.length; index++) {
    const event = events[index]!
    if (event.seq !== index || ('surfaceOp' in event && event.surfaceOp !== undefined && event.surfaceOp !== 'append')) return
  }
  const turns = new Map<number, Turn>()
  let current: Turn | undefined, step: number | undefined
  for (const event of events.slice(inheritedEventCount)) {
    if (event.type === 'turn/start') {
      if (current || !count(event.data.turn) || turns.has(event.data.turn)) return
      current = { id: event.data.turn, events: [], steps: [] }
      turns.set(current.id, current)
    }
    current?.events.push(event)
    if (event.type === 'step/start') {
      if (!current || current.id !== event.data.turn || step !== undefined || !count(event.data.step) ||
        (current.steps.length > 0 && event.data.step !== current.steps.at(-1)! + 1)) return
      step = event.data.step
      current.steps.push(step)
    } else if (event.type === 'step/end') {
      if (!current || current.id !== event.data.turn || step !== event.data.step) return
      step = undefined
    } else if (event.type === 'assistant/message' || event.type === 'assistant/attempt' || event.type === 'tool/call' || event.type === 'tool/result') {
      if (!current || current.id !== event.data.turn || step !== event.data.step) return
    } else if (event.type === 'user/message') {
      if (!current || step === undefined) return
    } else if (event.type === 'turn/end') {
      if (!current || current.id !== event.data.turn || step !== undefined) return
      current.end = event
      current = undefined
    }
  }
  return turns
}

function completedResult(runId: string, worker: Worker, events: readonly WorkerEvent[]): string | undefined {
  // Submission/outbox updates retain the then-current Worker runId, but are not CLI delivery.
  const runEvents = events.filter((event) => event.runId === runId && event.kind !== 'submission')
  const ends = runEvents.filter((event) => event.kind === 'status' && terminal.has(event.state ?? event.text))
  if (ends.length !== 1 || (ends[0]!.state ?? ends[0]!.text) !== 'completed' ||
    (worker.runId === runId && worker.status !== 'completed')) return
  const end = ends[0]!
  const result = runEvents.findLast((event) => event.kind === 'result')
  if (!result || result.seq >= end.seq || !result.text.trim() ||
    (result.state !== undefined && !['success', 'completed'].includes(result.state.toLowerCase())) ||
    runEvents.some((event) => event.seq > result.seq && !['diagnostic', 'status'].includes(event.kind)) ||
    runEvents.some((event) => event.seq > end.seq && event.kind !== 'diagnostic')) return
  return result.text
}

/** Restore only the location of a proven legacy answer, without rewriting any Session or CLI data. */
export function projectExternalTurnAnswer(
  record: HarnessConversationRecord | undefined,
  worker: Worker,
  workerEvents: readonly WorkerEvent[],
  observation: HarnessTurnObservation,
): ExternalTurnAnswer {
  const result: Record<string, { answerSeq: number; answerStep: number; messageId: string; turnEndSeq: number }> = {}
  if (!record || record.workerId !== worker.id || record.parentSessionId !== worker.parentSessionId ||
    record.sessionId !== worker.harnessConversation?.sessionId ||
    worker.harnessConversation.parentSessionId !== record.parentSessionId || worker.harnessConversation.mode !== 'continuable' ||
    observation.header.id !== record.sessionId || observation.header.parentSession !== record.parentSessionId ||
    observation.header.origin !== 'subagent') return result
  // Host storage supplies complete Worker history. A truncated page cannot establish run settlement.
  if (workerEvents.some((event, index) => event.seq !== index + 1)) return result
  const turns = turnsOf(observation)
  if (!turns) return result
  const groups = new Map<number, Set<string>>(), runTurns = new Map<string, Set<number>>()
  for (const { turn, runId } of record.turnRuns ?? []) {
    if (!count(turn) || !uuid.safeParse(runId).success) return result
    const runs = groups.get(turn) ?? new Set<string>()
    runs.add(runId); groups.set(turn, runs)
    const mappedTurns = runTurns.get(runId) ?? new Set<number>()
    mappedTurns.add(turn); runTurns.set(runId, mappedTurns)
  }
  for (const [turnId, runs] of groups) {
    if (runs.size !== 1) continue
    const runId = [...runs][0]!
    if (runTurns.get(runId)?.size !== 1) continue
    const turn = turns.get(turnId), expected = completedResult(runId, worker, workerEvents)
    if (!turn?.end || turn.end.data.reason.kind !== 'completed' || expected === undefined) continue
    const messages = turn.events.filter((event): event is AssistantEvent => event.type === 'assistant/message')
    const answer = messages.findLast((event) => textOf(event).trim() !== '')
    if (!answer || answer.data.step === turn.steps.at(-1) || !ownedAssistant(answer, worker.id) || textOf(answer) !== expected ||
      observation.events.filter((event) => event.type === 'assistant/message' && event.data.message.id === answer.data.message.id).length !== 1) continue
    // Every later step must be the old bridge's own empty continuation, with no real new input or work.
    const laterSteps = turn.steps.filter((step) => step > answer.data.step)
    const continuationSteps = new Set<number>(), assistantSteps = new Set<number>()
    let step: number | undefined = answer.data.step, valid = true
    const queued: UserMessage[] = [], claimed: UserMessage[] = []
    for (const event of turn.events.filter((event) => event.seq <= answer.seq)) {
      if (event.type === 'agent/inbox/spliced' && event.data.target === 'next-step' && !spliceInbox(event, queued)) { valid = false; break }
    }
    if (!valid || !queued.every(continuation)) continue
    for (const event of turn.events.filter((event) => event.seq > answer.seq)) {
      if (event.type === 'step/start') step = event.data.step
      else if (event.type === 'step/end') step = undefined
      else if (event.type === 'turn/end') continue
      else if (event.type === 'assistant/message') {
        if (!ownedAssistant(event, worker.id) || event.data.step <= answer.data.step ||
          !event.data.message.content.every((block) => block.type === 'reasoning') || assistantSteps.has(event.data.step)) { valid = false; break }
        assistantSteps.add(event.data.step)
      } else if (event.type === 'user/message') {
        if (!continuation(event.data) || step === undefined || step <= answer.data.step || continuationSteps.has(step) ||
          claimed.shift()?.id !== event.data.id) { valid = false; break }
        continuationSteps.add(step)
      } else if (event.type === 'agent/inbox/spliced') {
        if (event.data.target !== 'next-step' || event.data.outcome !== undefined || !event.data.inserted.every(continuation)) { valid = false; break }
        const removed = spliceInbox(event, queued)
        if (!removed || !removed.every(continuation)) { valid = false; break }
        claimed.push(...removed)
      } else { valid = false; break }
    }
    if (!valid || queued.length || claimed.length || laterSteps.some((step) => !continuationSteps.has(step) || !assistantSteps.has(step))) continue
    result[String(turnId)] = { answerSeq: answer.seq, answerStep: answer.data.step,
      messageId: answer.data.message.id!, turnEndSeq: turn.end.seq }
  }
  return result
}
