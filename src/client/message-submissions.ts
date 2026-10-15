import { useEffect, useRef, useState } from 'react'
import { active, type QueuedFollowup, type TimelineItem, type Worker } from '../shared/types.ts'
import type { RunningMessageMode } from '../shared/running-message.ts'
import { operationMessage } from './operation-error.ts'
import { value, type API, type Snapshot } from './workers.ts'

export interface MessageSubmission {
  id: string
  worker: Worker
  prompt: string
  createdAt: string
  route: 'followup' | 'running' | 'queue'
  mode: RunningMessageMode
  state: 'pending' | 'accepted' | 'failed' | 'cancelled'
  error?: string
  uncertain?: boolean
  /** Only an actual Host event or persisted outbox item confirms delivery. */
  confirmed?: boolean
  acceptedRunId?: string
  originalRunId: string
  baseline: Set<string>
  controller: AbortController
  done: Promise<void>
}

/** Local feedback only. The Host remains the owner of accepted messages and execution. */
export function useMessageSubmissions(
  api: API,
  sessionId: string,
  snapshot: Snapshot,
  restoreDraft: (workerId: string, text: string) => void,
) {
  const records = useRef<MessageSubmission[]>([])
  const [, render] = useState(0)
  const alive = useRef(true)
  const snapshots = useRef(new Map<string, Snapshot>())
  const restore = useRef(restoreDraft)
  restore.current = restoreDraft
  if (snapshot.selected) snapshots.current.set(snapshot.selected.id, snapshot)
  const update = () => {
    if (alive.current) render((n) => n + 1)
  }
  // Claim each new user event only once, including identical consecutive prompts.
  // Keep claims across revisions so one event cannot confirm a later local message.
  const claimed = useRef(new Set<string>())
  const reconcile = (current: Snapshot) => {
    const workerId = current.selected?.id
    if (!workerId) return
    for (const message of records.current) {
      if (message.worker.id !== workerId || message.confirmed) continue
      if (current.queuedFollowups?.some((item) => item.id === message.id)) {
        message.confirmed = true
        continue
      }
      // Queued messages are acknowledged by their stable outbox identity. A
      // same-text user event might belong to an earlier queued turn instead.
      if (message.mode === 'queue' && message.route !== 'followup') continue
      const event = current.timeline.find(
        (item) =>
          item.kind === 'user' &&
          item.text === message.prompt &&
          !message.baseline.has(item.id) &&
          !claimed.current.has(`${workerId}:${item.id}`) &&
          (message.route !== 'running' ||
            message.mode !== 'steer' ||
            item.id.startsWith(`${message.originalRunId}:`)) &&
          (!message.acceptedRunId || item.id.startsWith(`${message.acceptedRunId}:`)),
      )
      if (event) {
        claimed.current.add(`${workerId}:${event.id}`)
        message.confirmed = true
      }
    }
  }
  reconcile(snapshot)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      for (const message of records.current) {
        if (message.state === 'pending') message.controller.abort()
      }
    }
  }, [])

  function submit(
    worker: Worker,
    prompt: string,
    route: MessageSubmission['route'],
    mode: RunningMessageMode,
    retry?: MessageSubmission,
  ): MessageSubmission | undefined {
    if (records.current.some((item) => item.worker.id === worker.id && item.uncertain && !item.confirmed))
      return undefined
    if (retry?.state === 'pending') return undefined
    const failed =
      retry ??
      records.current.findLast(
        (item) =>
          item.worker.id === worker.id &&
          item.prompt === prompt &&
          item.state === 'failed' &&
          !item.confirmed,
      )
    if (failed?.uncertain) return undefined
    const predecessor = records.current.findLast(
      (item) =>
        item.worker.id === worker.id &&
        (item.state === 'pending' ||
          (item.state === 'accepted' &&
            !item.confirmed &&
            !!item.acceptedRunId &&
            item.worker.runId === worker.runId &&
            item.acceptedRunId !== worker.runId)),
    )
    const message: MessageSubmission = failed ?? {
      id: crypto.randomUUID(),
      worker: { ...worker },
      prompt,
      originalRunId: worker.runId,
      createdAt: new Date().toISOString(),
      route,
      mode,
      state: 'pending',
      baseline: new Set((snapshots.current.get(worker.id)?.timeline ?? []).map((item) => item.id)),
      controller: new AbortController(),
      done: Promise.resolve(),
    }
    message.controller = new AbortController()
    if (failed) {
      // Keep the stable identity for Host receipt lookup, but do not keep sending
      // a stale expected run after the selected Worker has advanced.
      const latest = snapshots.current.get(worker.id)?.selected
      if (latest) message.worker = { ...latest }
    }
    message.state = 'pending'
    message.error = undefined
    if (!failed) records.current.push(message)
    // Subsequent submissions wait for admission only, never for the whole CLI turn.
    // This also keeps native steer acknowledgements and interrupt admission ordered.
    message.done = (async () => {
      let rejectedByHost = false
      let attempted = false
      try {
        if (predecessor) {
          await predecessor.done
          message.controller.signal.throwIfAborted()
          if (predecessor.state !== 'accepted' && !predecessor.confirmed)
            throw new Error('前一条消息尚未成功发送，请确认后重试')
        }
        message.controller.signal.throwIfAborted()
        const current = snapshots.current.get(worker.id)
        const latest = current?.selected ?? worker
        const preparedRun =
          predecessor?.acceptedRunId ??
          (predecessor && predecessor.worker.runId !== worker.runId ? predecessor.worker.runId : undefined)
        if (preparedRun) {
          // The stream may be a tick behind the receipt. Use its actual run identity,
          // never issue a second ordinary followup against the old completed turn.
          const observedNewRun = latest.runId !== worker.runId
          message.worker = { ...latest, runId: observedNewRun ? latest.runId : preparedRun }
          message.route = observedNewRun && !active(latest.status) ? 'followup' : 'running'
        }
        attempted = true
        const response =
          message.route === 'followup'
            ? await api.cliworker.followup(sessionId, worker.id, prompt, message.controller.signal)
            : message.route === 'running'
              ? await api.cliworker.sendRunningMessage(
                  sessionId,
                  worker.id,
                  prompt,
                  message.worker.runId,
                  message.id,
                  message.controller.signal,
                )
              : await api.cliworker.queueFollowup(
                  sessionId,
                  worker.id,
                  prompt,
                  message.worker.runId,
                  message.id,
                  message.controller.signal,
                )
        rejectedByHost = !response.ok
        const receipt = JSON.parse(value(response)) as { runId?: string; id?: string }
        if (receipt.runId) message.acceptedRunId = receipt.runId
        if (receipt.id === message.id) message.confirmed = true
        message.state = 'accepted'
        const received = snapshots.current.get(worker.id)
        if (received) reconcile(received)
      } catch (error) {
        const received = snapshots.current.get(worker.id)
        if (received) reconcile(received)
        if (message.confirmed) message.state = 'accepted'
        else if (message.controller.signal.aborted && !/清理|cleanup/i.test(operationMessage(error))) {
          message.state = 'cancelled'
          restore.current(worker.id, prompt)
        } else {
          message.state = 'failed'
          message.uncertain = attempted && message.route === 'followup' && !rejectedByHost
          message.error = message.uncertain
            ? `发送结果待确认，请停止后重试或核对记录。${operationMessage(error)}`
            : operationMessage(error)
          if (!message.uncertain) restore.current(worker.id, prompt)
        }
      } finally {
        update()
      }
    })()
    update()
    return message
  }

  async function cancelPending(workerId: string): Promise<void> {
    const pending = records.current.filter((item) => item.worker.id === workerId && item.state === 'pending')
    for (const message of pending) message.controller.abort(new Error('用户已停止发送'))
    await Promise.all(pending.map((message) => message.done))
    const cleanupError = pending.find(
      (message) => message.state === 'failed' && /清理|cleanup/i.test(message.error ?? ''),
    )
    if (cleanupError) throw new Error(cleanupError.error)
  }
  function discard(message: MessageSubmission) {
    records.current = records.current.filter((item) => item !== message)
    update()
  }
  function confirmStopped(workerId: string, stoppedRunId: string) {
    const current = snapshots.current.get(workerId)
    if (current) reconcile(current)
    for (const message of records.current) {
      if (
        message.worker.id === workerId &&
        message.uncertain &&
        !message.confirmed &&
        message.worker.runId === stoppedRunId
      ) {
        // Host returned the original run after waiting for preparation cleanup:
        // this ordinary followup never acquired a new run.
        message.uncertain = false
        message.state = 'cancelled'
        message.error = undefined
        restore.current(workerId, message.prompt)
      }
    }
    update()
  }
  const visible = records.current.filter(
    (item) => item.worker.id === snapshot.selected?.id && !item.confirmed,
  )
  const localQueue = visible.filter((item) => item.mode === 'queue' && item.route !== 'followup')
  const localMessages = visible.filter((item) => !localQueue.includes(item))
  const optimisticTimeline: TimelineItem[] = localMessages.map((item) => ({
    id: `local-${item.id}:user`,
    kind: 'user',
    text: item.prompt,
    time: item.createdAt,
  }))
  const optimisticQueue: QueuedFollowup[] = localQueue.map((item) => ({
    id: item.id,
    prompt: item.prompt,
    createdAt: item.createdAt,
    state: item.state === 'failed' || item.state === 'cancelled' ? 'paused' : 'pending',
    pauseReason: item.state === 'failed' ? item.error : item.state === 'cancelled' ? '已停止发送' : undefined,
  }))
  return {
    submit,
    cancelPending,
    confirmStopped,
    discard,
    localMessages,
    localQueue,
    optimisticTimeline,
    optimisticQueue,
    uncertain: visible.some((item) => item.uncertain),
    pending: records.current.some(
      (item) => item.worker.id === snapshot.selected?.id && item.state === 'pending',
    ),
  }
}
