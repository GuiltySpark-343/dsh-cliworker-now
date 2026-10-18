import type { Context } from '@deepseek-ai/cordis'
import type { InboxWireState } from '@deepseek-ai/dsh-agent/types'
import type {
  ClientSessionContext,
  InputTriggerSource,
} from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import type {
  PopupSelectController,
  SelectOption,
  TokenSegment,
} from '@deepseek-ai/dsh-client-ui-commands/client'
import {
  active,
  cliOf,
  effortLabel,
  CLI_LABELS,
  type ModelChoice,
  type Preference,
  type Worker,
} from '../shared/types.ts'
import type { WorkerPermissionState } from '../shared/worker-permissions.ts'
import { visibleModelChoices } from '../shared/model-presentation.ts'
import type { HarnessBindingRegistry, HarnessNativeBinding } from './harness-binding-registry.ts'
import { value, type API, type Snapshot } from './workers.ts'

type Command = 'model' | 'permission' | 'plan'
type OwnedBinding = HarnessNativeBinding & { workerId: string }
type CommandContext = Pick<Context, 'sessions' | 'inputTriggers' | 'commandUi'>
export const HARNESS_COMMAND_SOURCE = 'cliworker-settings'
export type HarnessCommandServices = Pick<Context, 'sessions' | 'inputTriggers'>
// Capture service faces only from the scope declaring their injection. React
// renderers may live in an outer scope that must never read those properties.
const installedSources = new WeakMap<HarnessBindingRegistry, HarnessCommandServices>()
const sourceListeners = new WeakMap<HarnessBindingRegistry, Set<() => void>>()
export const harnessNativeCommandServices = (bindings: HarnessBindingRegistry) =>
  installedSources.get(bindings)
export function subscribeHarnessNativeCommands(bindings: HarnessBindingRegistry, listener: () => void) {
  let listeners = sourceListeners.get(bindings)
  if (!listeners) sourceListeners.set(bindings, (listeners = new Set()))
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
function publishCommandServices(bindings: HarnessBindingRegistry, services?: HarnessCommandServices) {
  if (services) installedSources.set(bindings, services)
  else installedSources.delete(bindings)
  for (const listener of sourceListeners.get(bindings) ?? []) listener()
}
const commands = [
  { name: 'model', label: '模型', description: '选择当前 CLI 的模型和思考强度' },
  { name: 'permission', label: '权限', description: '选择当前 CLI 的权限模式' },
  { name: 'plan', label: '计划', description: '切换当前 CLI 的规划模式' },
] as const
const commandOf = (text: string) =>
  commands.find((command) => command.name === text || command.label === text)
const sameBinding = (left: HarnessNativeBinding | undefined, right: OwnedBinding) =>
  left?.sessionId === right.sessionId &&
  left.parentSessionId === right.parentSessionId &&
  left.workerId === right.workerId

/** One bounded read through the same Gateway stream used by the Worker view. */
async function snapshotFor(api: API, binding: OwnedBinding, signal: AbortSignal): Promise<Snapshot> {
  signal.throwIfAborted()
  const stream = api.$stream<string>({
    name: `CLI Worker command ${binding.workerId}`,
    open: (lifetime) => api.cliworker.watch(binding.parentSessionId, binding.workerId, lifetime),
    ended: () => new Error('任务连接已结束'),
  })
  const abort = () => {
    void stream.dispose().catch(() => undefined)
  }
  signal.addEventListener('abort', abort, { once: true })
  try {
    for await (const item of stream) {
      signal.throwIfAborted()
      const snapshot = JSON.parse(item.value) as Snapshot
      item.accept()
      return snapshot
    }
    throw new Error('未收到当前任务的记录')
  } finally {
    signal.removeEventListener('abort', abort)
    await stream.dispose()
  }
}

function ownedWorker(snapshot: Snapshot, binding: OwnedBinding): Worker {
  const worker = snapshot.selected
  if (
    !worker ||
    worker.id !== binding.workerId ||
    worker.parentSessionId !== binding.parentSessionId ||
    worker.harnessConversation?.sessionId !== binding.sessionId ||
    worker.harnessConversation.parentSessionId !== binding.parentSessionId
  )
    throw new Error('收到不匹配的 CLI 子会话记录')
  if (snapshot.selectedBusy || active(worker.status) || snapshot.configuring)
    throw new Error('请等待本轮结束后再修改设置')
  if (snapshot.queuedFollowups?.length) throw new Error('请发送或移除待发消息后再修改设置')
  if (snapshot.resumeBlockedReason) throw new Error(snapshot.resumeBlockedReason)
  return worker
}

/**
 * Data-only source for owned CLI children. DSH owns trigger detection, menu,
 * PopupSelectView, keyboard, token CAS and focus through its existing session
 * controller. No original source, command contribution or component is replaced.
 */
export function installHarnessNativeCommands(
  ctx: CommandContext,
  bindings: HarnessBindingRegistry,
  api: API,
): () => void {
  let disposed = false
  const openings = new Map<string, { binding: OwnedBinding; command: Command; close: () => void }>()
  const owned = (session: ClientSessionContext): OwnedBinding | undefined => {
    if (disposed) return
    const binding = bindings.get(session.sessionId)
    if (!binding?.workerId || binding.parentSessionId === session.sessionId) return
    const address = ctx.sessions.subagentAddress(session.sessionId)
    if (address?.parentSessionId !== binding.parentSessionId || address.childSessionId !== session.sessionId)
      return
    if (!ctx.sessions.binding(session.sessionId)) return
    return binding as OwnedBinding
  }
  const open = (session: ClientSessionContext, command: Command, segment: TokenSegment) => {
    const binding = owned(session)
    if (!binding || !binding.capabilities[command]) throw new Error('当前 CLI 子会话不支持此设置')
    const scope = ctx.sessions.binding(session.sessionId)!
    const popup: PopupSelectController<ClientSessionContext> = ctx.commandUi.popupFor(scope.ctx)
    openings.get(session.sessionId)?.close()
    const lifetime = new AbortController()
    let popupSignal: AbortSignal | undefined
    let releaseScope: (() => void) | undefined
    let releaseState: (() => void) | undefined
    let closed = false
    const finish = () => {
      if (closed) return
      closed = true
      lifetime.abort()
      popupSignal?.removeEventListener('abort', finish)
      releaseState?.()
      releaseScope?.()
      if (openings.get(session.sessionId)?.close === close) openings.delete(session.sessionId)
    }
    const close = () => {
      if (closed) return
      finish()
      popup.dismiss()
    }
    openings.set(session.sessionId, { binding, command, close })
    releaseScope = scope.ctx.effect(() => () => close(), 'cliworker: native command opening')
    releaseState = popup.state.subscribe(() => {
      if (!popup.state.getSnapshot().open) finish()
    })
    const check = () => {
      lifetime.signal.throwIfAborted()
      if (
        !sameBinding(owned(session), binding) ||
        !owned(session)?.capabilities[command] ||
        ctx.sessions.binding(session.sessionId) !== scope
      )
        throw new Error('会话已切换，请重新打开设置')
      const state = scope.session.getSnapshot()
      const inbox = scope.session.projections.faceOf('inbox').getSnapshot() as InboxWireState | undefined
      if (state.openState !== 'open') throw new Error('原生会话尚未就绪')
      if (
        state.running ||
        state.pendingSubmissions.length ||
        inbox?.['next-turn']?.length ||
        inbox?.['next-step']?.length
      )
        throw new Error('请等待原生对话结束，并发送或移除待发消息后再修改设置')
    }
    let worker: Worker | undefined
    let selections = new Map<string, Preference>()
    let modes = new Set<string>()
    popup.open(
      command,
      {
        searchMode: command === 'model' ? 'fuzzy-label' : 'substring',
        options: async (_session, signal) => {
          popupSignal = signal
          signal.addEventListener('abort', finish, { once: true })
          if (signal.aborted) finish()
          check()
          worker = ownedWorker(await snapshotFor(api, binding, lifetime.signal), binding)
          check()
          if (command === 'model') {
            const cli = cliOf(worker.preference)
            const catalog = JSON.parse(
              value(
                await api.cliworker.catalogForWorker(
                  binding.parentSessionId,
                  binding.workerId,
                  lifetime.signal,
                ),
              ),
            ) as { cli: string; models: ModelChoice[]; notice?: string }
            check()
            if (catalog.cli !== cli || !Array.isArray(catalog.models))
              throw new Error('收到不匹配的 CLI 模型目录')
            const current = worker.preference
            selections = new Map()
            const options: SelectOption[] = []
            for (const model of visibleModelChoices(catalog.models, current.model)) {
              for (const effort of model.efforts ?? []) {
                const id = JSON.stringify([cli, model.id, effort])
                if (selections.has(id)) continue
                selections.set(id, { cli, model: model.id, effort })
                options.push({
                  id,
                  label: `${model.label} · ${effortLabel(effort)}`,
                  detail: model.id,
                  group: { name: cli, label: CLI_LABELS[cli] },
                  active:
                    (model.id === current.model ||
                      Object.values(model.variants ?? {}).includes(current.model)) &&
                    effort === current.effort,
                })
              }
            }
            if (!options.length) throw new Error(catalog.notice || '当前 CLI 未返回可用的模型和思考强度')
            return options
          }
          if (!api.cliworker.permissionForWorker || !api.cliworker.configureWorkerPermission)
            throw new Error('Host 尚未提供 CLI 权限设置')
          const permission = JSON.parse(
            value(
              await api.cliworker.permissionForWorker(
                binding.parentSessionId,
                binding.workerId,
                lifetime.signal,
              ),
            ),
          ) as WorkerPermissionState
          check()
          if (!permission.writable) throw new Error(permission.reason || '当前任务暂不可修改权限')
          if (command === 'plan' && !permission.options.some((option) => option.value === 'plan'))
            throw new Error('当前 CLI 不支持规划模式')
          modes = new Set(permission.options.map((option) => option.value))
          return permission.options.map((option) => ({
            id: option.value,
            label: option.name,
            detail: option.description,
            active: option.value === permission.currentValue,
          }))
        },
        onSelect: async (option) => {
          check()
          const current = ownedWorker(await snapshotFor(api, binding, lifetime.signal), binding)
          check()
          if (
            !worker ||
            cliOf(current.preference) !== cliOf(worker.preference) ||
            current.conversationId !== worker.conversationId
          )
            throw new Error('任务身份已改变，请重新打开设置')
          let saved: Worker
          if (command === 'model') {
            const preference = selections.get(option.id)
            if (!preference || cliOf(preference) !== cliOf(current.preference))
              throw new Error('只能选择当前 CLI 真实目录中的模型和思考强度')
            saved = JSON.parse(
              value(
                await api.cliworker.configureWorker(
                  binding.parentSessionId,
                  binding.workerId,
                  JSON.stringify(preference),
                  lifetime.signal,
                ),
              ),
            ) as Worker
          } else {
            if (
              !modes.has(option.id) ||
              (option.id !== 'plan' && option.id !== 'accept-edits') ||
              !api.cliworker.configureWorkerPermission
            )
              throw new Error('当前 CLI 不支持此权限模式')
            saved = JSON.parse(
              value(
                await api.cliworker.configureWorkerPermission(
                  binding.parentSessionId,
                  binding.workerId,
                  option.id,
                  lifetime.signal,
                ),
              ),
            ) as Worker
          }
          check()
          if (
            saved.id !== binding.workerId ||
            saved.parentSessionId !== binding.parentSessionId ||
            saved.harnessConversation?.sessionId !== binding.sessionId ||
            cliOf(saved.preference) !== cliOf(current.preference) ||
            saved.conversationId !== current.conversationId
          )
            throw new Error('收到不匹配的 Worker 设置')
        },
      },
      session,
      segment,
    )
  }
  const source: InputTriggerSource = {
    trigger: '/',
    name: HARNESS_COMMAND_SOURCE,
    showGroupTitle: false,
    candidates: async (session, req) => {
      req.signal.throwIfAborted()
      const binding = owned(session)
      if (!binding) return []
      const query = req.query.toLowerCase()
      return commands.filter(
        (command) =>
          binding.capabilities[command.name] &&
          (!query || command.name.includes(query) || command.label.includes(query)),
      )
    },
    onPick: (pick) => {
      if (!owned(pick.session)) return
      const command = commandOf(pick.candidate.name)
      if (!command) return
      open(pick.session, command.name, { via: 'menu', span: pick.span })
      return 'handled'
    },
    matchEnter: async (session, line, signal, envelope) => {
      if (!owned(session)) return
      const [token, ...args] = line.trim().split(/\s+/u)
      if (!token?.startsWith('/')) return
      const command = commandOf(token.slice(1))
      if (!command) return
      signal.throwIfAborted()
      if (args.length) throw new Error(`请通过 /${command.name} 的原生选项修改设置`)
      if (envelope.attachments) throw new Error('设置命令不接受附件，请保留附件并单独打开设置')
      open(session, command.name, { via: 'enter', token })
      return 'handled'
    },
  }
  const unregister = ctx.inputTriggers.registerSource(source)
  publishCommandServices(bindings, { sessions: ctx.sessions, inputTriggers: ctx.inputTriggers })
  const unsubscribe = bindings.subscribe(() => {
    for (const { binding, command, close } of openings.values()) {
      if (
        !sameBinding(bindings.get(binding.sessionId), binding) ||
        !bindings.get(binding.sessionId)?.capabilities[command]
      )
        close()
    }
  })
  return () => {
    if (disposed) return
    disposed = true
    publishCommandServices(bindings)
    unregister()
    unsubscribe()
    for (const opening of [...openings.values()]) opening.close()
  }
}
