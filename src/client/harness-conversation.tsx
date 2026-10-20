import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionReference } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HarnessConversationBinding, HarnessConversationFeature, Worker } from '../shared/types.ts'
import { value, type API } from './workers.ts'
import type { HarnessBindingRegistry, HarnessNativeBinding } from './harness-binding-registry.ts'

declare module '@deepseek-ai/dsh-api-session-controller/client' {
  interface SessionReferenceSourceMap {
    cliworkerConversation: unknown
  }
}

type NativeServices = Pick<Context, 'sessions'>
interface HarnessConversationProps {
  services: NativeServices
  bindings: HarnessBindingRegistry
  api: API
  parentSessionId: string
  worker: Worker
  renderConversation: (reference: SessionReference) => ReactNode
  attachProjections?: (reference: SessionReference, binding: HarnessNativeBinding) => () => void
}

const featureLabels: Record<HarnessConversationFeature, string> = {
  send: '发送',
  queue: '原生排队',
  steer: '原生引导',
  stop: '原生停止',
  model: '模型与强度',
  permission: '权限',
  plan: '规划模式',
  attachments: '附件',
  fork: '分支',
  forkEarlier: '从较早消息分支',
  goal: '目标',
  feedback: '反馈',
  skills: '技能共享',
  tools: '工具共享',
}
const bridgedFeatures = new Set<HarnessConversationFeature>(['goal', 'feedback', 'forkEarlier'])
const fallbackReason = '当前 CLI 的此项原生操作尚未接通，操作已禁用。'
const composerHolds = new WeakMap<
  object,
  Map<string, { owners: Map<symbol, string>; previous: unknown; current: unknown }>
>()

/** Independent occurrences may hold the same child; releasing one must not unlock another. */
export function retainHarnessComposerBlock(
  conversation: Context['conversation'],
  sessionId: string,
  reason?: string,
): () => void {
  if (!reason) return () => {}
  const blocks = conversation.blocks
  const snapshot = () => blocks.storeFor(sessionId as SessionId).getSnapshot()
  const sessions = composerHolds.get(blocks) ?? new Map()
  composerHolds.set(blocks, sessions)
  const state = sessions.get(sessionId) ?? {
    owners: new Map<symbol, string>(),
    previous: snapshot(),
    current: undefined,
  }
  sessions.set(sessionId, state)
  const token = Symbol()
  state.owners.set(token, reason)
  const publish = () => {
    state.current = { reason: [...state.owners.values()].at(-1)! }
    blocks.set(sessionId as SessionId, state.current as { reason: string })
  }
  publish()
  let released = false
  return () => {
    if (released) return
    released = true
    state.owners.delete(token)
    if (snapshot() === state.current) {
      if (state.owners.size) publish()
      else blocks.set(sessionId as SessionId, state.previous as { reason: string } | undefined)
    }
    if (!state.owners.size) sessions.delete(sessionId)
  }
}

/** Validate only a Host-issued Harness identity; CLI conversation ids are never substituted. */
export function readHarnessConversationBinding(
  raw: unknown,
  parentSessionId: string,
): HarnessConversationBinding {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('原生会话绑定无效')
  const candidate = raw as Partial<HarnessConversationBinding>
  if (
    typeof candidate.sessionId !== 'string' ||
    !candidate.sessionId.trim() ||
    candidate.parentSessionId !== parentSessionId ||
    candidate.sessionId === parentSessionId ||
    candidate.mode !== 'continuable' ||
    !candidate.capabilities ||
    Object.keys(featureLabels).some(
      (feature) =>
        !bridgedFeatures.has(feature as HarnessConversationFeature) &&
        typeof candidate.capabilities?.[feature as HarnessConversationFeature] !== 'boolean',
    )
  )
    throw new Error('原生会话身份或能力与当前子 Agent 不一致')
  if (
    candidate.reasons &&
    (typeof candidate.reasons !== 'object' ||
      Array.isArray(candidate.reasons) ||
      Object.values(candidate.reasons).some((reason) => typeof reason !== 'string'))
  )
    throw new Error('原生会话能力说明无效')
  // An older Host omits the bridged features; treat them as unavailable rather than invalid.
  const capabilities = { ...candidate.capabilities } as HarnessConversationBinding['capabilities']
  for (const feature of bridgedFeatures) capabilities[feature as HarnessConversationFeature] ||= false
  return { ...candidate, capabilities } as HarnessConversationBinding
}

export function harnessComposerBlock(binding: HarnessConversationBinding): string | undefined {
  if (!binding.capabilities.send) return binding.reasons?.send || '原生消息发送尚未接通。'
  return undefined
}

/** Displayed inside the existing Worker details menu, never as extra composer controls. */
export function HarnessCapabilityNotes({ binding }: { binding: HarnessConversationBinding }) {
  const unavailable = (Object.keys(featureLabels) as HarnessConversationFeature[]).filter(
    (feature) => !binding.capabilities[feature],
  )
  return (
    <div className="cwn-native-capabilities" aria-label="原生功能支持范围">
      <p>对话使用 DSH 原生输入、队列和停止操作；实际回复由当前 CLI Agent 生成。</p>
      {binding.capabilities.steer && binding.reasons?.steer && <p>{binding.reasons.steer}</p>}
      <p>共享工具、MCP 与技能以当前子 Agent 获准的目录及 CLI 接入能力为准。</p>
      <dl>
        {unavailable.map((feature) => {
          const reason = binding.reasons?.[feature] || fallbackReason
          return (
            <div key={feature}>
              <dt>{featureLabels[feature]}</dt>
              <dd>{reason}</dd>
            </div>
          )
        })}
      </dl>
    </div>
  )
}

/** Retain the exact child inside the right sidebar's native Conversation occurrence. */
export function HarnessConversation({
  services,
  bindings,
  api,
  parentSessionId,
  worker,
  renderConversation,
  attachProjections,
}: HarnessConversationProps) {
  const key = `${parentSessionId}:${worker.id}`
  const [attempt, setAttempt] = useState(0)
  const [repairing, setRepairing] = useState(false)
  const [repair, setRepair] = useState<{
    key: string
    previousSessionId: string
    binding: HarnessConversationBinding
  }>()
  const repairRequest = useRef<AbortController>()
  const [state, setState] = useState<{
    key: string
    binding?: HarnessConversationBinding
    reference?: SessionReference
    baseline?: HarnessConversationBinding
    error?: string
    historyFailure?: boolean
  }>({ key })
  const stored = worker.harnessConversation
  const latestStored = useRef(stored)
  latestStored.current = stored
  const repairBinding =
    repair?.key === key &&
    (!stored ||
      stored.sessionId === repair.previousSessionId ||
      stored.sessionId === repair.binding.sessionId)
      ? repair.binding
      : undefined
  useEffect(() => () => repairRequest.current?.abort(), [key])
  useEffect(() => {
    let current = true
    const controller = new AbortController()
    let reference: SessionReference | undefined
    let stopObserving: (() => void) | undefined
    let detachProjections: (() => void) | undefined
    const release = () => {
      stopObserving?.()
      stopObserving = undefined
      const held = reference
      reference = undefined
      const detach = detachProjections
      detachProjections = undefined
      try { detach?.() } finally { held?.release() }
    }
    setState({ key })
    void (async () => {
      let stage: 'binding' | 'history' | 'sources' = 'binding'
      try {
        const raw =
          repairBinding ??
          (api.cliworker.ensureHarnessConversation
            ? JSON.parse(value(await api.cliworker.ensureHarnessConversation(parentSessionId, worker.id)))
            : (stored ??
              (() => {
                throw new Error('当前 Host 尚未提供原生会话入口，请更新插件后重开。')
              })()))
        const binding = readHarnessConversationBinding(raw, parentSessionId)
        if (!current) return
        reference = services.sessions.retain(
          {
            parentSessionId: binding.parentSessionId as SessionId,
            childSessionId: binding.sessionId as SessionId,
            mode: binding.mode,
          },
          { source: 'cliworkerConversation', signal: controller.signal },
        )
        if (reference.sessionId !== binding.sessionId) throw new Error('原生会话引用与 Host 绑定不一致')
        stage = 'history'
        const opened = await reference.ready
        if (opened.sessionId !== binding.sessionId) throw new Error('原生会话读取返回了其他身份')
        if (!current) return
        stage = 'sources'
        bindings.publish(binding, worker)
        detachProjections = attachProjections?.(reference, { ...binding, workerId: worker.id })
        const baseline = latestStored.current
        // ready settles even when opening the history failed. Observe the
        // official Session face for both that failure and later stream errors.
        const publish = () => {
          if (!current) return
          const snapshot = opened.session.getSnapshot()
          const error =
            snapshot.openState === 'error'
              ? snapshot.openError
                ? `${snapshot.openError.message} (${snapshot.openError.code})`
                : '原生会话历史读取失败。'
              : undefined
          setState((previous) =>
            previous.key === key &&
            previous.binding === binding &&
            previous.reference === reference &&
            previous.error === error
              ? previous
              : { key, binding, reference, error, baseline, historyFailure: error !== undefined },
          )
        }
        stopObserving = opened.session.subscribe(publish)
        publish()
      } catch (error) {
        release()
        if (current) setState({ key, error: error instanceof Error ? error.message : '无法打开原生会话', historyFailure: stage === 'history' })
      }
    })()
    return () => {
      current = false
      controller.abort()
      release()
    }
    // A later Worker snapshot confirming this same binding must not release the
    // active input generation or remount its draft. Host identity changes require reopening.
  }, [services.sessions, api, bindings, attachProjections, parentSessionId, worker.id, key, attempt, repairBinding?.sessionId])

  const current = state.key === key ? state : undefined
  useEffect(() => {
    if (
      stored &&
      current?.binding &&
      stored.sessionId !== current.binding.sessionId &&
      stored.sessionId !== repair?.previousSessionId
    )
      setAttempt((value) => value + 1)
  }, [stored?.sessionId, current?.binding?.sessionId, repair?.previousSessionId])
  let binding = current?.binding
  let bindingError: string | undefined
  if (binding && stored !== current?.baseline && stored?.sessionId === binding.sessionId) {
    try {
      binding = readHarnessConversationBinding(stored, parentSessionId)
    } catch (error) {
      binding = undefined
      bindingError = error instanceof Error ? error.message : '原生会话绑定无效'
    }
  }
  if (
    binding &&
    stored &&
    stored.sessionId !== binding.sessionId &&
    stored.sessionId !== repair?.previousSessionId
  ) {
    binding = undefined
    bindingError = 'Host 原生会话绑定已改变，请重新打开确认。'
  }
  useLayoutEffect(() => {
    if (!binding || current?.error || bindingError) return
    bindings.publish(binding, worker)
  }, [
    bindings,
    binding,
    current?.error,
    bindingError,
    worker.preference?.model,
    worker.preference?.effort,
    worker.observedModel,
  ])

  let body: ReactNode
  const failedSessionId = current?.binding?.sessionId ?? stored?.sessionId
  const canRepairHistory = current?.historyFailure === true && !bindingError
  if (current?.error || bindingError)
    body = (
      <div role="alert" className="cwn-notice">
        <p>{current?.error || bindingError}</p>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={repairing}
          onClick={() => {
            const recover = api.cliworker.repairHarnessConversation
            if (!canRepairHistory || !failedSessionId || !recover) {
              setAttempt((value) => value + 1)
              return
            }
            const controller = new AbortController()
            repairRequest.current?.abort()
            repairRequest.current = controller
            setRepairing(true)
            void recover(parentSessionId, worker.id, failedSessionId, controller.signal)
              .then((response) => {
                controller.signal.throwIfAborted()
                const next = readHarnessConversationBinding(JSON.parse(value(response)), parentSessionId)
                setRepair({ key, previousSessionId: failedSessionId, binding: next })
              })
              .catch((error) => {
                if (!controller.signal.aborted)
                  setState({ key, error: error instanceof Error ? error.message : '显示会话修复失败', historyFailure: true })
              })
              .finally(() => {
                if (repairRequest.current === controller) {
                  repairRequest.current = undefined
                  if (!controller.signal.aborted) setRepairing(false)
                }
              })
          }}
        >
          {repairing
            ? '正在修复…'
            : canRepairHistory && failedSessionId && api.cliworker.repairHarnessConversation
              ? '修复显示会话'
              : '重新打开'}
        </Button>
      </div>
    )
  else if (binding && current?.reference)
    body = renderConversation(current.reference)
  else
    body = (
      <p className="cwn-notice" role="status">
        正在打开原生子会话…
      </p>
    )
  return (
    <div className="cwn-harness-conversation" data-cliworker-native-sidebar={worker.id}>
      {body}
    </div>
  )
}
