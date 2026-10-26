import { useEffect, useRef, useState } from 'react'
import { active, type QueuedFollowup, type TimelineItem, type Worker } from '../shared/types.ts'
import type { RunningMessageMode } from '../shared/running-message.ts'
import { operationMessage } from './operation-error.ts'
import { value, type API, type Snapshot } from './workers.ts'
import { t } from './i18n.ts'

/** Cancelling an undispatched request must not wait for an older cleanup gate. */
async function waitForAdmission(done: Promise<void>, signal: AbortSignal) {
  signal.throwIfAborted()
  let abort!: () => void
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
  })
  try {
    await Promise.race([done, cancelled])
  } finally {
    signal.removeEventListener('abort', abort)
  }
}

export interface MessageSubmission {
  id: string
  worker: Worker
  prompt: string
  createdAt: string
  route: 'followup' | 'running' | 'queue' | 'interrupt'
  mode: RunningMessageMode
  /** Frozen at the click. RPC admission and later preferences never reclassify this view. */
  intent: 'direct' | 'running'
  presentation: 'bubble' | 'queue'
  sequence: number
  receiptRevision?: number
  admitted?: boolean
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
  /** The original queue RPC may finish later, but no longer owns this message. */
  redirected?: boolean
  deliveryState?: TimelineItem['deliveryState']
  admissionSettled?: boolean
  priorityRevision?: number
  superseded?: boolean
  stopped?: boolean
  /** The Host confirmed this steer's native run exited; its unknown history remains local. */
  runEnded?: boolean
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
  const source = useRef({ id: crypto.randomUUID(), sequence: 0 })
  const stopBarriers = useRef(new Map<string, { done: Promise<void>; release: () => void }>())
  const [, render] = useState(0)
  const alive = useRef(true)
  const snapshots = useRef(new Map<string, Snapshot>())
  const restore = useRef(restoreDraft)
  restore.current = restoreDraft
  if (snapshot.selected) snapshots.current.set(snapshot.selected.id, snapshot)
  const update = () => {
    if (alive.current) render((n) => n + 1)
  }
  const reconcile = (current: Snapshot) => {
    const workerId = current.selected?.id
    if (!workerId) return
    for (const event of current.timeline) {
      if (
        event.kind !== 'user' ||
        !event.queuedFollowupId ||
        !['pending', 'admitted'].includes(event.deliveryState ?? '')
      )
        continue
      if (
        records.current.some(
          (item) =>
            item.worker.id === workerId && item.route === 'interrupt' && item.id === event.queuedFollowupId,
        )
      )
        continue
      let releaseAdmission!: () => void
      const done = new Promise<void>((resolve) => {
        releaseAdmission = resolve
      })
      records.current.push({
        id: event.queuedFollowupId,
        worker: { ...current.selected! },
        prompt: event.text,
        createdAt: event.time,
        route: 'interrupt',
        mode: 'interrupt',
        intent: 'running',
        presentation: 'bubble',
        sequence: event.submissionSequence ?? 0,
        state: 'accepted',
        deliveryState: event.deliveryState,
        confirmed: true,
        originalRunId: current.selected!.runId,
        baseline: new Set(),
        controller: new AbortController(),
        done,
        releaseAdmission,
        acceptedRunId: event.admittedRunId,
      })
    }
    for (const message of records.current) {
      if (message.worker.id !== workerId) continue
      if (message.redirected) continue
      if (
        message.route === 'running' &&
        message.mode === 'steer' &&
        current.selected!.runId !== message.originalRunId
      ) {
        message.runEnded = true
        if (message.uncertain && !message.error?.startsWith(t('原轮已结束，引导结果仍待核查；不会转发到新轮。')))
          message.error = `${t('原轮已结束，引导结果仍待核查；不会转发到新轮。')}${message.error ?? ''}`
      }
      if (message.route === 'interrupt') {
        const event = current.timeline.find(
          (item) => item.kind === 'user' && item.queuedFollowupId === message.id && item.deliveryState,
        )
        if (event) {
          message.confirmed = true
          message.priorityRevision ??= current.revision
          // A stale pending snapshot cannot undo a later local priority click.
          if (
            !(message.superseded || message.stopped) ||
            !['pending', 'admitted'].includes(event.deliveryState!)
          ) {
            applyPriorityState(message, event.deliveryState!, event.deliveryError, event.admittedRunId)
          }
        } else if (
          !message.admissionSettled &&
          current.truncated &&
          message.priorityRevision !== undefined &&
          current.revision >= message.priorityRevision
        ) {
          message.state = 'failed'
          message.confirmed = false
          message.uncertain = true
          message.deliveryState = 'failed'
          message.error = t('插队结果待确认，较早记录已不在当前窗口。请核对历史记录或停止后确认。')
          message.admissionSettled = true
          message.releaseAdmission?.()
        }
        continue
      }
      const user = current.timeline.find(
        (item) => item.kind === 'user' && item.queuedFollowupId === message.id,
      )
      if (user) {
        message.confirmed = true
        message.admitted = true
        message.state = 'accepted'
        message.uncertain = false
        message.error = undefined
        message.acceptedRunId = user.admittedRunId ?? message.acceptedRunId
        continue
      }
      if (message.confirmed) continue
      if (current.queuedFollowups?.some((item) => item.id === message.id)) {
        message.confirmed = true
        message.state = 'accepted'
        message.uncertain = false
        message.error = undefined
        continue
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
        // Ordinary submissions also belong to their Worker after the click.
        // Closing a view is not an explicit stop and must not revoke them.
      }
    }
  }, [])

  function applyPriorityState(
    message: MessageSubmission,
    state: NonNullable<TimelineItem['deliveryState']>,
    error?: string,
    runId?: string,
  ) {
    message.deliveryState = state
    message.uncertain = false
    message.error = error
    message.state =
      state === 'failed' ? 'failed' : ['superseded', 'cancelled'].includes(state) ? 'cancelled' : 'accepted'
    if (runId) message.acceptedRunId = runId
    if (!['pending', 'admitted'].includes(state) && (state !== 'running' || !!message.acceptedRunId)) {
      message.admissionSettled = true
      message.releaseAdmission?.()
    }
  }

  function interruptMessage(
    worker: Worker,
    prompt: string,
    id: string = crypto.randomUUID(),
  ): MessageSubmission {
    const existing = records.current.find(
      (item) => item.worker.id === worker.id && item.id === id && item.route === 'interrupt',
    )
    if (existing) return existing
    for (const old of records.current) {
      if (old.worker.id !== worker.id) continue
      if (old.id === id && old.route !== 'interrupt') old.redirected = true
      if (
        old.route === 'interrupt' &&
        (old.uncertain ||
          !['running', 'completed', 'superseded', 'cancelled', 'failed'].includes(
            old.deliveryState ?? 'pending',
          ))
      ) {
        old.superseded = true
        applyPriorityState(old, 'superseded')
      }
    }
    const message: MessageSubmission = {
      id,
      worker: { ...worker },
      prompt,
      createdAt: new Date().toISOString(),
      route: 'interrupt',
      mode: 'interrupt',
      intent: 'running',
      presentation: 'bubble',
      sequence: ++source.current.sequence,
      state: 'pending',
      deliveryState: 'pending',
      originalRunId: worker.runId,
      baseline: new Set(),
      controller: new AbortController(),
      done: Promise.resolve(),
    }
    const admission = new Promise<void>((resolve) => {
      message.releaseAdmission = resolve
    })
    records.current.push(message)
    const stopBarrier = stopBarriers.current.get(worker.id)
    message.done = admission
    void (async () => {
      let rejectedByHost = false
      try {
        if (stopBarrier) await waitForAdmission(stopBarrier.done, message.controller.signal)
        // A later explicit Stop cancels requests still waiting for its predecessor
        // to be confirmed. Releasing that barrier must not dispatch cancelled text.
        if (message.stopped) return
        const response = await api.cliworker.submitMessage(
          sessionId,
          worker.id,
          JSON.stringify({
            id,
            prompt,
            clientId: source.current.id,
            sequence: message.sequence,
            mode: message.mode,
            intent: message.intent,
            expectedRunId: message.originalRunId,
          }),
          message.controller.signal,
        )
        rejectedByHost =
          !response.ok &&
          (response.error.details as { deliveryUnknown?: boolean } | undefined)?.deliveryUnknown !== true
        const receipt = JSON.parse(value(response)) as {
          messageId: string
          revision: number
          state: NonNullable<TimelineItem['deliveryState']>
        }
        if (
          receipt.messageId !== id ||
          !Number.isSafeInteger(receipt.revision) ||
          !['pending', 'admitted', 'running', 'superseded', 'cancelled', 'failed', 'completed'].includes(
            receipt.state,
          )
        )
          throw new Error(t('插队回执无法核对，请停止后确认消息状态'))
        message.priorityRevision = receipt.revision
        if (!message.superseded && !message.stopped && !message.confirmed) {
          applyPriorityState(message, receipt.state)
        }
        const current = snapshots.current.get(worker.id)
        if (current) reconcile(current)
        update()
      } catch (error) {
        const current = snapshots.current.get(worker.id)
        if (current) reconcile(current)
        if (!message.superseded && !message.stopped && !message.confirmed) {
          message.state = 'failed'
          message.uncertain = !rejectedByHost && !message.controller.signal.aborted
          message.error = message.uncertain
            ? `${t('发送结果待确认，请停止后重试或核对记录。')}${operationMessage(error)}`
            : operationMessage(error)
          message.deliveryState = message.controller.signal.aborted ? 'cancelled' : 'failed'
          if (message.controller.signal.aborted) message.state = 'cancelled'
        }
        if (!message.confirmed || message.superseded || message.stopped) {
          message.admissionSettled = true
          message.releaseAdmission?.()
        }
      } finally {
        update()
      }
    })()
    update()
    return message
  }

  function submit(
    worker: Worker,
    prompt: string,
    route: MessageSubmission['route'],
    mode: RunningMessageMode,
    retry?: MessageSubmission,
  ): MessageSubmission | undefined {
    if (route === 'interrupt' || (route === 'running' && mode === 'interrupt'))
      return interruptMessage(worker, prompt)
    if (route === 'running' && mode === 'steer') return steerMessage(worker, prompt, retry)
    if (
      records.current.some(
        (item) => item.worker.id === worker.id && item.uncertain && !item.redirected && !item.runEnded,
      )
    )
      return undefined
    if (retry?.state === 'pending') return undefined
    const failed = retry
    if (failed?.uncertain) return undefined
    let predecessor = records.current.findLast(
      (item) =>
        item.worker.id === worker.id &&
        !(item.route === 'running' && item.mode === 'steer') &&
        !item.stopped &&
        !item.redirected &&
        (item.state === 'pending' ||
          (item.route === 'interrupt' && !item.admissionSettled) ||
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
      intent: route === 'followup' ? 'direct' : 'running',
      presentation: route !== 'followup' && mode === 'queue' ? 'queue' : 'bubble',
      sequence: ++source.current.sequence,
      state: 'pending',
      baseline: new Set((snapshots.current.get(worker.id)?.timeline ?? []).map((item) => item.id)),
      controller: new AbortController(),
      done: Promise.resolve(),
    }
    message.controller = new AbortController()
    if (failed) {
      // A retry keeps the original route and identity. A different current run
      // cannot silently turn an earlier steer into a new request.
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
          while (true) {
            await waitForAdmission(predecessor.done, message.controller.signal)
            message.controller.signal.throwIfAborted()
            const latestPriority = records.current.findLast(
              (item) => item.worker.id === worker.id && item.route === 'interrupt',
            )
            if (predecessor.route === 'interrupt' && latestPriority && latestPriority !== predecessor) {
              predecessor = latestPriority
              continue
            }
            break
          }
          if (
            predecessor.state !== 'accepted' &&
            (!predecessor.confirmed || ['failed', 'cancelled'].includes(predecessor.state))
          )
            throw new Error(t('前一条消息尚未成功发送，请确认后重试'))
        }
        if (message.redirected) return
        message.controller.signal.throwIfAborted()
        const stopBarrier = stopBarriers.current.get(worker.id)
        if (stopBarrier) await waitForAdmission(stopBarrier.done, message.controller.signal)
        message.controller.signal.throwIfAborted()
        attempted = true
        const response = await api.cliworker.submitMessage(
          sessionId,
          worker.id,
          JSON.stringify({
            id: message.id,
            prompt,
            clientId: source.current.id,
            sequence: message.sequence,
            mode: message.mode,
            intent: message.intent,
            expectedRunId: message.originalRunId,
          }),
          message.controller.signal,
        )
        rejectedByHost =
          !response.ok &&
          (response.error.details as { deliveryUnknown?: boolean } | undefined)?.deliveryUnknown !== true
        if (message.redirected) return
        const raw = value(response)
        if (typeof raw !== 'string') throw new Error(t('发送回执无法核对，请停止后确认消息状态'))
        const receipt = JSON.parse(raw) as {
          runId?: string
          id?: string
          queuedId?: string
          revision?: number
        }
        if (receipt.runId) message.acceptedRunId = receipt.runId
        if (Number.isSafeInteger(receipt.revision)) message.receiptRevision = receipt.revision
        message.state = 'accepted'
        const received = snapshots.current.get(worker.id)
        if (received) reconcile(received)
      } catch (error) {
        if (message.redirected) return
        const received = snapshots.current.get(worker.id)
        if (received) reconcile(received)
        if (message.confirmed) message.state = 'accepted'
        else if (message.controller.signal.aborted && !/清理|clean ?up/i.test(operationMessage(error))) {
          message.state = 'cancelled'
          if (
            !records.current.some((item) => item.worker.id === worker.id && item.sequence > message.sequence)
          )
            restore.current(worker.id, prompt)
        } else {
          message.state = 'failed'
          message.uncertain = attempted && !rejectedByHost
          message.error = message.uncertain
            ? `${t('发送结果待确认，请停止后重试或核对记录。')}${operationMessage(error)}`
            : operationMessage(error)
          if (
            !message.uncertain &&
            !records.current.some((item) => item.worker.id === worker.id && item.sequence > message.sequence)
          )
            restore.current(worker.id, prompt)
        }
      } finally {
        update()
      }
    })()
    update()
    return message
  }

  /** A steer belongs only to the current native run and waits only for its own ACK. */
  function steerMessage(
    worker: Worker,
    prompt: string,
    retry?: MessageSubmission,
  ): MessageSubmission | undefined {
    if (
      !canSteer(worker.id) ||
      retry?.state === 'pending' ||
      records.current.some(
        (item) => item.worker.id === worker.id && item.uncertain && !item.redirected && !item.runEnded,
      )
    )
      return undefined
    const message: MessageSubmission = retry ?? {
      id: crypto.randomUUID(),
      worker: { ...worker },
      prompt,
      originalRunId: worker.runId,
      createdAt: new Date().toISOString(),
      route: 'running',
      mode: 'steer',
      intent: 'running',
      presentation: 'bubble',
      sequence: ++source.current.sequence,
      state: 'pending',
      baseline: new Set(),
      controller: new AbortController(),
      done: Promise.resolve(),
    }
    if (snapshots.current.get(worker.id)?.selected?.runId !== message.originalRunId) return undefined
    message.controller = new AbortController()
    message.state = 'pending'
    message.error = undefined
    if (!retry) records.current.push(message)
    message.done = (async () => {
      let attempted = false
      let rejectedByHost = false
      try {
        message.controller.signal.throwIfAborted()
        attempted = true
        const response = await api.cliworker.steerMessage(
          sessionId,
          worker.id,
          prompt,
          message.originalRunId,
          message.id,
          message.controller.signal,
        )
        rejectedByHost =
          !response.ok &&
          (response.error.details as { deliveryUnknown?: boolean } | undefined)?.deliveryUnknown !== true
        const receipt = JSON.parse(value(response)) as {
          accepted: boolean
          requestId: string
          runId: string
          queued?: { id: string }
          revision?: number
        }
        if (
          receipt.accepted !== true ||
          receipt.requestId !== message.id ||
          receipt.runId !== message.originalRunId
        )
          throw new Error(t('引导回执无法核对，请停止后确认消息状态'))
        if (receipt.queued?.id === message.id) {
          // The account changed during this run: the Host queued it for the next turn,
          // where it appears with the other queued messages instead of as a steer.
          discard(message)
          const current = snapshots.current.get(worker.id)
          if (current) reconcile(current)
          return
        }
        message.acceptedRunId = receipt.runId
        if (Number.isSafeInteger(receipt.revision)) message.receiptRevision = receipt.revision
        message.state = 'accepted'
        message.uncertain = false
        message.error = undefined
        const current = snapshots.current.get(worker.id)
        if (current) reconcile(current)
      } catch (error) {
        const current = snapshots.current.get(worker.id)
        if (current) reconcile(current)
        if (message.confirmed) message.state = 'accepted'
        else if (message.controller.signal.aborted) message.state = 'cancelled'
        else {
          message.state = 'failed'
          message.uncertain = attempted && !rejectedByHost
          message.error = message.uncertain
            ? `${t('发送结果待确认，请停止后重试或核对记录。')}${operationMessage(error)}`
            : operationMessage(error)
          if (message.runEnded && message.uncertain)
            message.error = `${t('原轮已结束，引导结果仍待核查；不会转发到新轮。')}${operationMessage(error)}`
        }
        if (
          !message.confirmed &&
          !message.runEnded &&
          !message.uncertain &&
          !records.current.some((item) => item.worker.id === worker.id && item.sequence > message.sequence)
        )
          restore.current(worker.id, prompt)
      } finally {
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
        !item.redirected &&
        !item.runEnded &&
        (item.state === 'pending' || (item.route === 'interrupt' && !item.admissionSettled)),
    )
    for (const message of pending) {
      message.stopped = true
      if (message.route === 'interrupt') {
        applyPriorityState(message, 'cancelled')
      }
      message.controller.abort(new Error(t('用户已停止发送')))
    }
    await Promise.all(pending.map((message) => message.done))
    const cleanupError = pending.find(
      (message) => message.state === 'failed' && /清理|clean ?up/i.test(message.error ?? ''),
    )
    if (cleanupError) throw new Error(cleanupError.error)
  }
  function discard(message: MessageSubmission) {
    records.current = records.current.filter((item) => item !== message)
    update()
  }
  function confirmStopped(workerId: string, stoppedRunId: string, scope: ReadonlySet<MessageSubmission>) {
    const current = snapshots.current.get(workerId)
    if (current) reconcile(current)
    for (const message of records.current) {
      if (!scope.has(message) || message.redirected) continue
      if (
        message.worker.id === workerId &&
        message.route === 'running' &&
        message.mode === 'steer' &&
        message.originalRunId === stoppedRunId &&
        message.uncertain
      ) {
        message.runEnded = true
        if (!message.error?.startsWith(t('原轮已结束，引导结果仍待核查；不会转发到新轮。')))
          message.error = `${t('原轮已结束，引导结果仍待核查；不会转发到新轮。')}${message.error ?? ''}`
        continue
      }
      if (message.worker.id === workerId && message.route === 'interrupt') {
        if (
          !['running', 'completed', 'superseded', 'failed'].includes(message.deliveryState ?? 'pending') ||
          message.uncertain
        ) {
          message.stopped = true
          applyPriorityState(message, 'cancelled')
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
        message.releaseAdmission?.()
        if (
          message.route !== 'interrupt' &&
          !records.current.some((item) => item.worker.id === workerId && item.sequence > message.sequence)
        )
          restore.current(workerId, message.prompt)
      }
    }
    update()
  }
  const visible = records.current.filter(
    (item) =>
      item.worker.id === snapshot.selected?.id &&
      !item.confirmed &&
      !item.redirected &&
      (item.state !== 'cancelled' || item.presentation === 'bubble'),
  )
  const localQueue = visible.filter((item) => item.presentation === 'queue')
  const localMessages = visible.filter((item) => !localQueue.includes(item))
  const optimisticTimeline: TimelineItem[] = localMessages.map((item) => ({
    id: `local-${item.id}:user`,
    kind: 'user',
    queuedFollowupId: item.id,
    text: item.prompt,
    time: item.createdAt,
    deliveryState: item.deliveryState,
    deliveryError: item.error,
  }))
  const optimisticQueue: QueuedFollowup[] = localQueue.map((item) => ({
    id: item.id,
    prompt: item.prompt,
    createdAt: item.createdAt,
    state: item.state === 'failed' || item.state === 'cancelled' ? 'paused' : 'pending',
    pauseReason: item.state === 'failed' ? item.error : undefined,
  }))
  function busyFor(workerId: string): boolean {
    const current = snapshots.current.get(workerId)
    return (
      !!current?.selectedBusy ||
      !!(current?.selected && active(current.selected.status)) ||
      stopBarriers.current.has(workerId) ||
      records.current.some(
        (item) =>
          item.worker.id === workerId &&
          !item.redirected &&
          !item.stopped &&
          !item.runEnded &&
          (item.state === 'pending' ||
            (item.route === 'interrupt' && !item.admissionSettled) ||
            (item.state === 'accepted' &&
              !item.confirmed &&
              (item.acceptedRunId
                ? item.acceptedRunId !== current?.selected?.runId &&
                  (!current?.selected || current.selected.runId === item.originalRunId)
                : item.receiptRevision !== undefined
                  ? current?.revision === undefined || current.revision < item.receiptRevision
                  : true))),
      )
    )
  }
  function canSteer(workerId: string): boolean {
    const current = snapshots.current.get(workerId)
    return (
      current?.selected?.status === 'running' &&
      !['accepting', 'preparing', 'queued', 'stopping', 'priority'].includes(
        current.selectedBusyReason ?? '',
      ) &&
      !stopBarriers.current.has(workerId) &&
      !records.current.some(
        (item) =>
          item.worker.id === workerId &&
          !item.redirected &&
          !item.stopped &&
          ((item.route === 'interrupt' && !item.admissionSettled) ||
            (item.intent === 'direct' && item.state === 'pending')),
      )
    )
  }
  return {
    busyFor,
    canSteer,
    submit,
    steerMessage,
    interruptQueued: (worker: Worker, item: QueuedFollowup) => interruptMessage(worker, item.prompt, item.id),
    cancelPending,
    confirmStopped,
    waitForStop: (workerId: string, stopping: Promise<unknown>) => {
      let barrier = stopBarriers.current.get(workerId)
      if (!barrier) {
        let release!: () => void
        const done = new Promise<void>((resolve) => {
          release = resolve
        })
        barrier = { done, release }
        stopBarriers.current.set(workerId, barrier)
      }
      const current = barrier
      void stopping.then(
        () => {
          if (stopBarriers.current.get(workerId) === current) {
            stopBarriers.current.delete(workerId)
            current.release()
          }
        },
        () => {
          // A lost stop receipt is not cleanup confirmation. Keep the same gate
          // until a subsequent explicit Stop succeeds; the Panel reports the error.
        },
      )
    },
    stopUnconfirmed: stopBarriers.current.has(snapshot.selected?.id ?? ''),
    stopScope: (workerId: string) => new Set(records.current.filter((item) => item.worker.id === workerId)),
    discard,
    recover: (message: MessageSubmission) => restore.current(message.worker.id, message.prompt),
    localMessages,
    localQueue,
    optimisticTimeline,
    optimisticQueue,
    hostTimeline: snapshot.timeline.map((item) => {
      const message = records.current.find(
        (entry) =>
          entry.worker.id === snapshot.selected?.id &&
          entry.route === 'interrupt' &&
          entry.id === item.queuedFollowupId,
      )
      return message &&
        (message.superseded || message.stopped || message.uncertain) &&
        ['pending', 'admitted'].includes(item.deliveryState ?? '')
        ? { ...item, deliveryState: message.deliveryState, deliveryError: message.error }
        : item
    }),
    hostQueue: (snapshot.queuedFollowups ?? []).filter(
      (item) =>
        !records.current.some(
          (message) =>
            message.worker.id === snapshot.selected?.id &&
            (message.route === 'interrupt' || message.admitted) &&
            message.id === item.id,
        ),
    ),
    interrupting: records.current.some(
      (item) =>
        item.worker.id === snapshot.selected?.id &&
        item.route === 'interrupt' &&
        (!item.admissionSettled || item.uncertain),
    ),
    uncertain: records.current.some(
      (item) =>
        item.worker.id === snapshot.selected?.id && !item.redirected && !item.runEnded && item.uncertain,
    ),
    pending: records.current.some(
      (item) =>
        item.worker.id === snapshot.selected?.id &&
        !item.redirected &&
        !item.runEnded &&
        (item.state === 'pending' || (item.route === 'interrupt' && !item.admissionSettled)),
    ),
  }
}
