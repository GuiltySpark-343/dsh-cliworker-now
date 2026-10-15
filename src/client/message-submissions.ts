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
  route: 'followup' | 'running' | 'queue' | 'interrupt'
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
  queueSource?: QueuedFollowup
  queueHidden?: boolean
  priorityRevision?: number
  releaseAdmission?: () => void
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
      if (message.worker.id !== workerId) continue
      if (message.route === 'interrupt') {
        const event = current.timeline.find(
          (item) =>
            item.kind === 'user' && item.queuedFollowupId === message.id && !message.baseline.has(item.id),
        )
        if (event) {
          claimed.current.add(`${workerId}:${event.id}`)
          message.priorityRevision ??= current.revision
          message.confirmed = true
          message.acceptedRunId = event.id.split(':')[0]
          message.releaseAdmission?.()
        }
        const queued = current.queuedFollowups?.find((item) => item.id === message.id)
        if (
          message.priorityRevision !== undefined &&
          current.revision >= message.priorityRevision &&
          queued?.state === 'paused'
        ) {
          // The normal stop phase also pauses the queue. Only snapshots at or
          // after the Host's promotion watermark describe this priority attempt.
          message.queueHidden = false
          message.state = 'failed'
          message.error = queued.pauseReason || '插队未完成，请确认后重试'
          message.uncertain = false
          message.releaseAdmission?.()
        }
        if (
          !message.confirmed &&
          message.queueHidden &&
          current.truncated &&
          !queued &&
          message.priorityRevision !== undefined &&
          current.revision >= message.priorityRevision
        ) {
          // Switching away can miss the exact admission row once the live window
          // is truncated. Do not infer delivery from matching text or wait forever.
          message.state = 'failed'
          message.uncertain = true
          message.error = '插队结果待确认，较早记录已不在当前窗口。请核对历史记录或停止后确认。'
          message.releaseAdmission?.()
        }
        continue
      }
      if (message.confirmed) continue
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
          (!item.queuedFollowupId || item.queuedFollowupId === message.id) &&
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
        // A persisted priority request belongs to the Host once submitted.
        // Closing this view only releases local waiters; explicit Stop cancels it.
        if (message.route === 'interrupt') message.releaseAdmission?.()
        else if (message.state === 'pending') message.controller.abort()
      }
    }
  }, [])

  function submit(
    worker: Worker,
    prompt: string,
    route: MessageSubmission['route'],
    mode: RunningMessageMode,
    retry?: MessageSubmission,
    queueSource?: QueuedFollowup,
  ): MessageSubmission | undefined {
    if (records.current.some((item) => item.worker.id === worker.id && item.uncertain && !item.confirmed))
      return undefined
    if (retry?.state === 'pending') return undefined
    if (
      route === 'interrupt' &&
      records.current.some(
        (item) =>
          item.worker.id === worker.id &&
          item.route === 'interrupt' &&
          item.queueHidden &&
          !item.confirmed &&
          ['pending', 'accepted'].includes(item.state),
      )
    )
      return undefined
    const failed =
      retry ??
      records.current.findLast(
        (item) =>
          item.worker.id === worker.id &&
          item.prompt === prompt &&
          item.state === 'failed' &&
          item.route !== 'interrupt' &&
          !item.confirmed,
      )
    if (failed?.uncertain) return undefined
    const predecessor = records.current.findLast(
      (item) =>
        item.worker.id === worker.id &&
        (item.state === 'pending' ||
          (item.route === 'interrupt' && item.state === 'accepted' && !item.confirmed) ||
          (item.state === 'accepted' &&
            !item.confirmed &&
            !!item.acceptedRunId &&
            item.worker.runId === worker.runId &&
            item.acceptedRunId !== worker.runId)),
    )
    const message: MessageSubmission = failed ?? {
      id: queueSource?.id ?? crypto.randomUUID(),
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
      queueSource,
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
    if (route === 'interrupt') {
      message.queueHidden = true
      message.confirmed = false
      message.priorityRevision = undefined
      message.acceptedRunId = undefined
      message.baseline = new Set((snapshots.current.get(worker.id)?.timeline ?? []).map((item) => item.id))
    }
    if (!failed) records.current.push(message)
    // Subsequent submissions wait for admission only, never for the whole CLI turn.
    // This also keeps native steer acknowledgements and interrupt admission ordered.
    message.done = (async () => {
      let rejectedByHost = false
      let attempted = false
      let releaseAdmission: (() => void) | undefined
      const abortAdmission = () => releaseAdmission?.()
      const admission =
        message.route === 'interrupt'
          ? new Promise<void>((resolve) => {
              releaseAdmission = resolve
              message.releaseAdmission = resolve
              message.controller.signal.addEventListener('abort', abortAdmission, { once: true })
            })
          : undefined
      try {
        if (predecessor && message.route !== 'interrupt') {
          await predecessor.done
          message.controller.signal.throwIfAborted()
          if (
            predecessor.state !== 'accepted' &&
            (!predecessor.confirmed || ['failed', 'cancelled'].includes(predecessor.state))
          )
            throw new Error('前一条消息尚未成功发送，请确认后重试')
        }
        message.controller.signal.throwIfAborted()
        const current = snapshots.current.get(worker.id)
        const latest = current?.selected ?? worker
        const preparedRun =
          predecessor?.acceptedRunId ??
          (predecessor && predecessor.worker.runId !== worker.runId ? predecessor.worker.runId : undefined)
        if (preparedRun && message.route !== 'interrupt') {
          // The stream may be a tick behind the receipt. Use its actual run identity,
          // never issue a second ordinary followup against the old completed turn.
          const observedNewRun = latest.runId !== worker.runId
          message.worker = { ...latest, runId: observedNewRun ? latest.runId : preparedRun }
          message.route = observedNewRun && !active(latest.status) ? 'followup' : 'running'
        }
        attempted = true
        const response =
          message.route === 'interrupt'
            ? await api.cliworker.interruptQueuedFollowup(
                sessionId,
                worker.id,
                message.id,
                message.worker.runId,
                message.controller.signal,
              )
            : message.route === 'followup'
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
        const raw = value<string | void>(response)
        if (typeof raw !== 'string') throw new Error('发送回执无法核对，请停止后确认消息状态')
        const receipt = JSON.parse(raw) as {
          runId?: string
          id?: string
          queuedId?: string
          revision?: number
        }
        if (message.route === 'interrupt') {
          if (receipt.queuedId !== message.id || !Number.isSafeInteger(receipt.revision))
            throw new Error('插队回执无法核对，请停止后确认消息状态')
          message.priorityRevision = receipt.revision
        }
        if (receipt.runId) message.acceptedRunId = receipt.runId
        if (receipt.id === message.id) message.confirmed = true
        message.state = 'accepted'
        const received = snapshots.current.get(worker.id)
        if (received) reconcile(received)
        if (admission) {
          update()
          await admission
          message.controller.signal.throwIfAborted()
        }
      } catch (error) {
        const received = snapshots.current.get(worker.id)
        if (received) reconcile(received)
        if (message.confirmed) message.state = 'accepted'
        else if (message.controller.signal.aborted && !/清理|cleanup/i.test(operationMessage(error))) {
          message.state = 'cancelled'
          message.queueHidden = false
          if (message.route !== 'interrupt') restore.current(worker.id, prompt)
        } else {
          message.state = 'failed'
          message.uncertain =
            attempted && (message.route === 'followup' || message.route === 'interrupt') && !rejectedByHost
          message.error = message.uncertain
            ? `发送结果待确认，请停止后重试或核对记录。${operationMessage(error)}`
            : operationMessage(error)
          if (!message.uncertain) {
            if (message.route === 'interrupt') message.queueHidden = false
            else restore.current(worker.id, prompt)
          }
        }
      } finally {
        if (releaseAdmission) message.controller.signal.removeEventListener('abort', abortAdmission)
        update()
      }
    })()
    update()
    return message
  }

  async function cancelPending(workerId: string): Promise<void> {
    const pending = records.current.filter(
      (item) =>
        item.worker.id === workerId &&
        (item.state === 'pending' ||
          (item.route === 'interrupt' && item.state === 'accepted' && !item.confirmed)),
    )
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
      if (message.worker.id === workerId && message.route === 'interrupt') {
        message.queueHidden = false
        message.releaseAdmission?.()
        if (!message.confirmed) {
          message.uncertain = false
          message.state = 'cancelled'
          message.error = undefined
        }
        continue
      }
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
        message.queueHidden = false
        message.releaseAdmission?.()
        if (message.route !== 'interrupt') restore.current(workerId, message.prompt)
      }
    }
    update()
  }
  const visible = records.current.filter(
    (item) => item.worker.id === snapshot.selected?.id && !item.confirmed,
  )
  const localQueue = visible.filter((item) => item.mode === 'queue' && item.route !== 'followup')
  const localMessages = visible.filter(
    (item) => !localQueue.includes(item) && (item.route !== 'interrupt' || item.queueHidden),
  )
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
    interruptQueued: (worker: Worker, item: QueuedFollowup) => {
      const previous = records.current.findLast(
        (entry) => entry.worker.id === worker.id && entry.id === item.id && entry.route === 'interrupt',
      )
      return submit(worker, item.prompt, 'interrupt', 'interrupt', previous, item)
    },
    cancelPending,
    confirmStopped,
    discard,
    localMessages,
    localQueue,
    optimisticTimeline,
    optimisticQueue,
    hostQueue: (snapshot.queuedFollowups ?? []).filter(
      (item) =>
        !records.current.some(
          (message) =>
            message.worker.id === snapshot.selected?.id &&
            message.route === 'interrupt' &&
            message.id === item.id &&
            message.queueHidden,
        ),
    ),
    queueErrors: new Map(
      records.current
        .filter(
          (message) =>
            message.worker.id === snapshot.selected?.id &&
            message.route === 'interrupt' &&
            !message.queueHidden &&
            message.error,
        )
        .map((message) => [message.id, message.error!]),
    ),
    interrupting: records.current.some(
      (item) =>
        item.worker.id === snapshot.selected?.id &&
        item.route === 'interrupt' &&
        item.queueHidden &&
        !item.confirmed &&
        (['pending', 'accepted'].includes(item.state) || item.uncertain),
    ),
    uncertain: visible.some((item) => item.uncertain),
    pending: records.current.some(
      (item) =>
        item.worker.id === snapshot.selected?.id &&
        (item.state === 'pending' ||
          (item.route === 'interrupt' && item.state === 'accepted' && !item.confirmed)),
    ),
  }
}
