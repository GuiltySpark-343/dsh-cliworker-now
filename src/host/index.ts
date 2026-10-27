import { readCliAccountBinding } from './cli-account-binding.ts'
import { SettingsCatalogCache } from './settings-catalog-cache.ts'
import { resolveModel } from '../shared/models.ts'
import { visibleModelChoices } from '../shared/model-presentation.ts'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { z as validate } from 'zod'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import type { SettingsCacheMetadata } from '../shared/settings-cache.ts'
import { createHarnessConversationBridge } from './harness-conversation.ts'
import { workerGoalCommand } from './harness-conversation-commands.ts'
import { HarnessConversationStore } from './harness-conversation-store.ts'
import {
  projectExternalTurnUsage,
  recoverHarnessTurnRuns,
  type HarnessTurnObservation,
} from './harness-turn-usage.ts'
import { projectExternalTurnAnswer } from './harness-turn-answer.ts'
import { projectRequestState } from './native-request-state.ts'
import type { HarnessConversationApi, HarnessConversationRecord } from './harness-conversation-types.ts'
import {
  classifyHarnessTool,
  adoptNativeHarnessLease,
  createNativeHarnessTools,
  type NativeHarnessSkill,
} from './native-harness-tools.ts'
import { nativeHarnessToolCapability, nativeHarnessExecutionReady } from './native-harness-injection.mjs'
import { installHarnessModelGuard, withinCliTool } from './harness-model-guard.ts'
import { resolveHarnessAttachments } from './harness-attachments.ts'
import type { NativeAttachment } from './native-attachments.mjs'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-jobs'
import type {} from '@deepseek-ai/dsh-subprocess'
import { SubprocessExecutableNotFoundError } from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/dsh-user-questions'
import type { AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions/types'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '@deepseek-ai/dsh-plan-mode'
import {
  CLI_IDS,
  CLI_LABELS,
  active,
  cliOf,
  workerName,
  effortLabel,
  isUserInterrupted,
  LEGACY_ACCOUNT_RECORD_NOTICE,
  EFFORTS,
  type CliId,
  type Preference,
  type TaskMode,
  type RoleSnapshot,
  type RosterEntry,
  type Worker,
} from '../shared/types.ts'
import {
  agentNameSchema,
  readRoleAnswer,
  roleQuestion,
  roleSnapshot,
  roleSnapshotSchema,
} from './roles.ts'
import {
  DEFAULT_CONFIG,
  projectDirectory,
  ProcessCleanupUnconfirmedError,
  type ProcessBackend,
  type RuntimeConfig,
} from './process.ts'
import { nativeProcessBackend } from './native-process.ts'
import { validatePreference, configuredCliExecutable, resolveCliExecutable } from './adapters.ts'
import { CliExecutablePathStore } from './cli-executable-paths.ts'
import type { CliExecutablePathStatus } from '../shared/cli-settings.ts'
import { RUNNING_MESSAGE_MODES } from '../shared/running-message.ts'
import { workerPermissionOptions, type WorkerPermissionState } from '../shared/worker-permissions.ts'
import { WindowsCliInstallationError, WindowsCliNotFoundError } from './windows-cli-installation.ts'
import { ACCOUNT_CHANGED, authorizedCatalog, authorizeSelection } from './authorized-catalog.ts'
import { WorkerStorage, type DispatchSetup } from './storage.ts'
import { WorkerRuntime, type Submission } from './runtime.ts'
import { AccountManager } from './accounts.ts'
import {
  CLI_DELEGATION_GUIDANCE,
  CLI_NAME_GUIDANCE,
  registerCliRouting,
  requireCliName,
  resolveCliName,
  isGenericQoderName,
  resolveAvailableCliName,
} from './routing.ts'

export type {
  Preference,
  Worker,
  WorkerSnapshot,
  ModelChoice,
  TimelineItem,
  TaskMode,
  Effort,
  WorkerStatus,
  RolePreset,
  RoleSnapshot,
} from '../shared/types.ts'

/** Deployment settings; all values are resolved by the plugin schema. */
export interface Config {
  /** CLI binary or absolute path (default agy). */
  executable?: string
  /** Codex CLI executable. */
  codexExecutable?: string
  /** Claude Code executable. */
  claudeExecutable?: string
  /** Kimi Code executable. */
  kimiExecutable?: string
  /** Official Xiaomi MiMo Code executable. */
  mimoExecutable?: string
  zcodeExecutable?: string
  grokExecutable?: string
  ompExecutable?: string
  piExecutable?: string
  hermesExecutable?: string
  hermesHome?: string
  opencodeExecutable?: string
  qoderExecutable?: string
  qodercnExecutable?: string
  zcodeAuthDirectory?: string
  zcodeBuiltinConfig?: string
  /** @deprecated Accepted for old deployments only; never read or forwarded. */
  zaiCredentialRef?: string
  /** Optional private state directory; defaults to DSH_HOME/cliworker-now. */
  stateDirectory?: string
  /** Maximum concurrent processes (default 2). */
  maxConcurrent?: number
  /** Maximum turn duration in milliseconds (default 1800000). */
  timeoutMs?: number
  /** Process termination grace in milliseconds (default 5000). */
  graceMs?: number
  /** Maximum NDJSON line bytes (default 1048576). */
  maxLineBytes?: number
  /** Maximum output bytes per run (default 16777216). */
  maxRunBytes?: number
  /** Maximum logical timeline rows in one live view (default 1000). */
  maxTimelineItems?: number
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** CLI worker lifecycle and browser API. */ cliworker: CliWorkerService
  }
}
declare module '@deepseek-ai/dsh-jobs' {
  interface JobKindMap {
    cliworker: 'cliworker'
  }
}
declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** CLI worker operation could not proceed; unknown delivery must not be resent. */ 'cliworker/unavailable': {
      reason: string
      deliveryUnknown?: boolean
    }
  }
}

const preferenceSchema = validate.object({
  cli: validate.enum(CLI_IDS).optional(),
  model: validate.string().min(1),
  effort: validate.enum(EFFORTS),
})
const messageSubmissionSchema = validate
  .object({
    id: validate.uuid(),
    clientId: validate.uuid(),
    sequence: validate.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    prompt: validate
      .string()
      .min(1)
      .max(100_000)
      .refine((text) => !!text.trim()),
    mode: validate.enum(RUNNING_MESSAGE_MODES),
    intent: validate.enum(['direct', 'running']),
    expectedRunId: validate.string().min(1).max(128),
  })
  .strict()
const failure = (error: unknown) =>
  new RemoteError('cliworker/unavailable', String(error), {
    reason: String(error),
    ...(error && typeof error === 'object' && 'code' in error && error.code === 'STEER_UNKNOWN'
      ? { deliveryUnknown: true }
      : {}),
  })

/** Cancel a question/wait independently; late answers cannot commit a selection. */
function waitForInput<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  return new Promise<T>((resolve, reject) => {
    const aborted = () => {
      signal.removeEventListener('abort', aborted)
      reject(signal.reason ?? new Error('选择已取消'))
    }
    signal.addEventListener('abort', aborted, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted))
  })
}

/** Host owner of CLI conversations, model tools and Remote streams. */
export class CliWorkerService extends TypertRemoteService {
  static inject = [
    'agents',
    'tools',
    'systemPrompt',
    'jobs',
    'subprocess',
    'userQuestions',
    'sandboxPolicy',
    'typert',
  ]
  static Config: z<Config> = z.object({
    executable: z.string().min(1).default(DEFAULT_CONFIG.executable),
    codexExecutable: z.string().min(1).default('codex'),
    claudeExecutable: z.string().min(1).default('claude'),
    kimiExecutable: z.string().min(1).default('kimi'),
    mimoExecutable: z.string().min(1).default('mimo'),
    zcodeExecutable: z.string(),
    grokExecutable: z.string(),
    ompExecutable: z.string(),
    piExecutable: z.string(),
    hermesExecutable: z.string(),
    hermesHome: z.string(),
    opencodeExecutable: z.string(),
    qoderExecutable: z.string().min(1).default('qoder'),
    qodercnExecutable: z.string().min(1).default('qodercn'),
    zcodeAuthDirectory: z.string(),
    zcodeBuiltinConfig: z.string(),
    zaiCredentialRef: z.string(),
    stateDirectory: z.string(),
    maxConcurrent: z.natural().min(1).max(8).default(DEFAULT_CONFIG.maxConcurrent),
    timeoutMs: z.natural().min(1000).max(86400000).default(DEFAULT_CONFIG.timeoutMs),
    graceMs: z.natural().min(100).max(30000).default(DEFAULT_CONFIG.graceMs),
    maxLineBytes: z.natural().min(1024).default(DEFAULT_CONFIG.maxLineBytes),
    maxRunBytes: z.natural().min(1024).default(DEFAULT_CONFIG.maxRunBytes),
    maxTimelineItems: z.natural().min(10).default(DEFAULT_CONFIG.maxTimelineItems),
  })
  private runtime: WorkerRuntime
  private accounts: AccountManager
  private accountParents = new Map<string, () => Promise<void>>()
  private options: RuntimeConfig
  private backend: ProcessBackend
  private pending = new Map<string, number>()
  private dispatchWaits = new Map<string, Promise<void>>()
  private messageSubmissions = new Map<string, { request: string; done: Promise<string> }>()
  private selectionBindings = new WeakMap<Preference, string>()
  private selectionProjects = new WeakMap<Preference, string>()
  private displayedBindings = new Map<string, string>()
  private settingsCatalogs?: SettingsCatalogCache
  private settingsInstance?: string
  private settingsSourceRevisions?: Map<CliId, number>
  private disposed = new AbortController()
  private harnessConversation?: HarnessConversationApi
  private harnessConversationStore?: HarnessConversationStore
  private nativeRunDone = new Map<string, Promise<Worker>>()
  private repairingDisplays = new Set<string>()

  /** @param ctx - Harness services. @param config - Validated deployment options. */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'cliworker', { namespace: 'cliworker' })
    this.options = {
      ...DEFAULT_CONFIG,
      ...config,
    }
    const stateDirectory =
      config.stateDirectory ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'cliworker-now')
    this.options.cliExecutablePaths = new CliExecutablePathStore(stateDirectory)
    this.backend = nativeProcessBackend(ctx.subprocess)
    this.accounts = new AccountManager(this.backend, this.options, undefined, (cli, error) =>
      this.runtime.blockCatalogOnCleanup(cli, error),
    )
    this.runtime = new WorkerRuntime(
      new WorkerStorage(
        config.stateDirectory ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'cliworker-now'),
      ),
      this.backend,
      this.options,
    )
    this.ctx.inject(['sessionController', 'subagents', 'llm'], (scope) => {
      const records = new HarnessConversationStore(this.runtime.storage.directory)
      this.harnessConversationStore = records
      const bridge = createHarnessConversationBridge(scope, {
        bindings: () => records.list(),
        bind: async (record) => {
          const worker = this.runtime.get(record.parentSessionId, record.workerId)
          // Public capability metadata is derived by the bridge, never used as authority.
          const publicBinding = worker.harnessConversation
          if (publicBinding && publicBinding.sessionId !== record.sessionId)
            throw new Error('Worker 原生会话身份不匹配')
          records.save(record)
          this.runtime.changed()
        },
        unbind: async (record) => {
          records.remove(record)
          const worker = this.runtime.get(record.parentSessionId, record.workerId)
          if (worker.harnessConversation?.sessionId === record.sessionId) {
            delete worker.harnessConversation
            this.runtime.storage.save(worker)
            this.runtime.changed()
          }
        },
        replaceBinding: async (previous, next) => {
          const worker = this.runtime.get(previous.parentSessionId, previous.workerId)
          if (worker.harnessConversation?.sessionId !== previous.sessionId)
            throw new Error('Worker 原生会话替换的当前身份不匹配')
          records.replace(previous, next)
          // The private CAS is authoritative. Publish only after its atomic commit.
          const previousBinding = worker.harnessConversation
          worker.harnessConversation = {
            ...previousBinding,
            sessionId: next.sessionId,
          }
          try {
            this.runtime.storage.save(worker)
          } catch (error) {
            worker.harnessConversation = previousBinding
            const rollback = {
              ...previous,
              retiredSessionIds: [...(previous.retiredSessionIds ?? []), next.sessionId],
            }
            try {
              records.replace(next, rollback)
            } catch (cleanup) {
              throw new AggregateError([error, cleanup], '原生会话绑定替换及回滚未完成')
            }
            throw error
          }
          this.runtime.changed()
        },
        getWorker: (parent, id) => this.runtime.get(parent, id),
        busy: (record) => {
          const snapshot = this.runtime.snapshot(record.parentSessionId, record.workerId)
          return (
            !!snapshot.selectedBusy &&
            !(this.repairingDisplays.has(record.workerId) && snapshot.selectedBusyReason === 'preparing')
          )
        },
        events: (record, runId, afterSeq) =>
          this.runtime.storage
            .history(record.workerId)
            .filter((event) => event.runId === runId && event.seq > afterSeq),
        subscribe: (listener) => this.runtime.subscribe(listener),
        receipt: (record, prompt, requestId) =>
          !!this.runtime.directMessageReceipt(record.parentSessionId, record.workerId, prompt, requestId),
        admitted: (record, batchId) => this.runtime.storage.history(record.workerId)
          .some((event) => event.kind === 'user' && event.queuedFollowupId === batchId),
        steering: (record) => this.runtime.nativeSteeringState(record.parentSessionId, record.workerId),
        steer: async (record, prompt, runId, requestId, signal) => {
          await this.steerMessage(record.parentSessionId, record.workerId, prompt, runId, requestId, signal)
        },
        fork: async (record, signal) => {
          const result = JSON.parse(await this.forkWorker(record.parentSessionId, record.workerId, '', signal)) as { childSessionId: string }
          return `已创建 CLI 会话分支：${result.childSessionId}`
        },
        goal: async (record, input, signal) => {
          const worker = this.runtime.get(record.parentSessionId, record.workerId)
          if (worker.harnessConversation?.sessionId !== record.sessionId)
            throw new Error('CLI 子会话绑定已改变，未修改目标')
          signal.throwIfAborted()
          return workerGoalCommand(worker, input, {
            set: async (objective, revision) => JSON.parse(await this.setWorkerGoal(record.parentSessionId, record.workerId, objective, revision, signal)),
            status: (status, revision) => this.setWorkerGoalStatus(record.parentSessionId, record.workerId, status, revision, signal),
            clear: (revision) => this.clearWorkerGoal(record.parentSessionId, record.workerId, revision, signal),
          })
        },
        permission: async (record, mode, signal) => {
          const worker = this.runtime.get(record.parentSessionId, record.workerId)
          if (worker.harnessConversation?.sessionId !== record.sessionId)
            throw new Error('CLI 子会话绑定已改变，未修改权限')
          if (mode !== undefined) {
            const saved = JSON.parse(await this.configureWorkerPermission(record.parentSessionId, record.workerId, mode, signal)) as Worker
            return `当前 CLI 权限：${workerPermissionOptions(saved).find((option) => option.value === saved.mode)?.name ?? saved.mode}`
          }
          const state = JSON.parse(await this.permissionForWorker(record.parentSessionId, record.workerId, signal)) as WorkerPermissionState
          return `当前 CLI 权限：${state.currentValue}。可用模式：${state.options.map((option) => `${option.value}（${option.name}）`).join('、')}${state.reason ? `。${state.reason}` : ''}`
        },
        run: async (record, prompt, requestId, signal, messages = []) => {
          const parent = await this.parent(record.parentSessionId)
          signal.throwIfAborted()
          const worker = this.runtime.get(parent.id, record.workerId)
          if (worker.harnessConversation?.sessionId !== record.sessionId)
            throw new Error('CLI 子会话绑定已改变，未启动任务')
          const previous = this.runtime.directMessageReceipt(parent.id, worker.id, prompt, requestId)
          if (previous?.runId)
            return { runId: previous.runId, done: this.waitHarnessRun(record, previous.runId) }
          const child = this.ctx.agents.get(record.sessionId as Agent['id'])
          if (!child) throw new Error('CLI 子会话已失效，未读取附件')
          const attachments = resolveHarnessAttachments(child.ctx, messages)
          // The native Agent has claimed this message. Reuse the same launch
          // checks and process lifetime, without a second conversation queue.
          const receipt = JSON.parse(
            await this.launch(
              parent,
              worker.title,
              prompt,
              worker.preference,
              worker.mode,
              worker.id,
              undefined,
              signal,
              undefined,
              undefined,
              undefined,
              requestId,
              attachments,
            ),
          ) as { runId: string }
          return { runId: receipt.runId, done: this.waitHarnessRun(record, receipt.runId) }
        },
        wait: (record, runId) => this.waitHarnessRun(record, runId),
        stop: async (record, runId) => {
          const current = this.runtime.get(record.parentSessionId, record.workerId)
          // A late projection from the previous run cannot cancel a new turn.
          if (current.runId === runId) await this.runtime.stop(record.parentSessionId, record.workerId)
        },
      })
      this.harnessConversation = bridge
      this.releaseArchivedHarnessSessions()
      const removeModelGuard = installHarnessModelGuard(scope)
      const removePreparation = this.runtime.setHarnessPreparation(async (worker, signal, input) => {
        const parent = await this.parent(worker.parentSessionId)
        const binding = await bridge.ensure(parent, worker, {
          nativeSubmissionId: input.submissionId,
          initialRunId: worker.runId,
          projectRun: true,
          signal,
        })
        // Runtime owns this exact mutable Worker for the duration of the run.
        worker.harnessConversation = binding
        this.runtime.storage.save(worker)
        this.runtime.changed()
        const cli = cliOf(worker.preference)
        const child = this.ctx.agents.get(binding.sessionId as Agent['id'])
        if (!child) throw new Error('原生子 Agent 尚未就绪，未启动 CLI 工具桥')
        setSandboxMode(
          child.session,
          worker.mode === 'plan'
            ? 'read-only'
            : parent.ctx.get('sandboxPolicy')!.resolve({ session: parent.session }).mode,
        )
        child.ctx.get('planMode')?.set(child, worker.mode === 'plan')
        const support = nativeHarnessToolCapability(cli)
        if (!support.transport) {
          worker.harnessConversation = {
            ...binding,
            reasons: {
              ...binding.reasons,
              tools: support.reason,
              skills: support.reason,
            },
          }
          this.runtime.storage.save(worker)
          this.runtime.changed()
          return undefined
        }
        // Public scoped presentation affects only this internal child. Tool policy
        // and inherited restrictions still run inside tools.execute.
        const resetPresentation = child.ctx.tools.presentAs('native')
        let lease: Awaited<ReturnType<typeof createNativeHarnessTools>>
        try {
          // The real child scope owns its tool/MCP catalog. Refresh for every
          // bridge operation so an old grant cannot outlive a policy change.
          const tools = () => {
            const schemas = child.ctx.tools.schemas(child)
            return schemas.map((tool) => ({
              name: tool.name,
              description: tool.description,
              inputSchema: tool.parameters,
              execution: classifyHarnessTool(tool.name, schemas),
            }))
          }
          const skills = child.ctx.get('skills') as
            | {
                list(options: { cwd: string; scope: Agent; signal: AbortSignal }): Promise<
                  Array<{
                    name: string
                    description: string
                    invocation: { modelInvocable: boolean }
                  }>
                >
                get(
                  name: string,
                  options: { cwd: string; scope: Agent; signal: AbortSignal },
                ): Promise<
                  | (NativeHarnessSkill & {
                      invocation: { modelInvocable: boolean }
                    })
                  | undefined
                >
              }
            | undefined
          const skillOptions = (control: AbortSignal) => ({
            cwd: worker.project,
            scope: child,
            signal: control,
          })
          lease = await createNativeHarnessTools({
            binding: {
              parentSessionId: parent.id,
              harnessSessionId: binding.sessionId,
              workerId: worker.id,
              runId: worker.runId,
              cli,
            },
            tools,
            signal,
            executionReady: nativeHarnessExecutionReady(cli),
            authorize: async (identity) => {
              signal.throwIfAborted()
              const current = this.runtime.get(parent.id, worker.id)
              if (
                current.runId !== identity.runId ||
                current.harnessConversation?.sessionId !== identity.harnessSessionId ||
                this.ctx.agents.get(binding.sessionId as Agent['id']) !== child ||
                !['queued', 'running'].includes(current.status)
              )
                throw new Error('工具桥运行身份已失效')
              this.assertExecution(parent)
              if (this.project(parent) !== worker.project) throw new Error('工具桥项目已变更')
              this.runtime.assertCliEnabled(cli)
            },
            execute: async (call) =>
              withinCliTool(worker.runId, async () =>
                child.ctx.tools.execute({
                  callId: ToolCallId(`cliworker:${call.callId}`),
                  name: call.name,
                  arguments: call.arguments,
                  agent: child,
                  signal: call.signal,
                }),
              ),
            ...(skills
              ? {
                  skills: {
                    list: async (control: AbortSignal) =>
                      (await skills.list(skillOptions(control)))
                        .filter((skill) => skill.invocation.modelInvocable)
                        .map(({ name, description }) => ({
                          name,
                          description,
                        })),
                    get: async (name: string, control: AbortSignal) => {
                      const skill = await skills.get(name, skillOptions(control))
                      return skill?.invocation.modelInvocable ? skill : undefined
                    },
                  },
                }
              : {}),
          })
        } catch (error) {
          resetPresentation()
          throw error
        }
        const owned = lease
        return adoptNativeHarnessLease(owned, resetPresentation, () => {
          if (worker.harnessConversation) {
            worker.harnessConversation = {
              ...worker.harnessConversation,
              capabilities: {
                ...worker.harnessConversation.capabilities,
                tools: owned.capabilities.ready && owned.capabilities.toolCount > 0,
                skills: owned.capabilities.ready && owned.capabilities.skills,
              },
              reasons: {
                ...worker.harnessConversation.reasons,
                tools: owned.capabilities.ready
                  ? '共享当前子 Agent 获准的 DSH 工具与 MCP；每次执行仍走宿主权限和审批链，未接通的模型辅助与递归派遣不可用'
                  : owned.capabilities.reason,
                skills: owned.capabilities.ready
                  ? '当前子 Agent 没有可供模型读取的 DSH 技能'
                  : owned.capabilities.reason,
              },
            }
            this.runtime.storage.save(worker)
          }
          this.runtime.changed()
        })
      })
      scope.effect(() => async () => {
        removePreparation()
        if (this.harnessConversation === bridge) this.harnessConversation = undefined
        if (this.harnessConversationStore === records) this.harnessConversationStore = undefined
        try {
          await bridge.dispose()
        } finally {
          removeModelGuard()
        }
      })
    })
    this.runtime.setFollowupLauncher(async (worker, item, admission, signal) => {
      const agent = await this.parent(worker.parentSessionId)
      const control = AbortSignal.any([signal, this.disposed.signal])
      control.throwIfAborted()
      await this.launch(
        agent,
        worker.title,
        item.prompt,
        worker.preference,
        worker.mode,
        worker.id,
        undefined,
        control,
        undefined,
        admission,
      )
    })
    this.runtime.setQueuedExecutionGuard((worker) => {
      const agent = this.ctx.agents.get(worker.parentSessionId as Agent['id'])
      if (!agent) throw new Error('父会话已关闭，请重新打开后继续发送')
      this.assertExecution(agent)
      if (this.project(agent) !== worker.project) throw new Error('项目已变更，请在原项目继续')
      this.runtime.assertCliEnabled(cliOf(worker.preference))
      if (this.accounts.isBusy(cliOf(worker.preference))) throw new Error('请先关闭账号终端')
    })
    ctx.effect(
      () => () => {
        this.disposed.abort()
        return Promise.all([
          this.runtime.close(),
          this.accounts.close(),
          ...[...this.accountParents.values()].map((dispose) => dispose()),
        ])
      },
      'cliworker:lifetime',
    )
    this.registerTools()
    registerCliRouting(ctx)
    ctx.effect(
      () =>
        ctx.systemPrompt.section({
          name: 'cliworker:delegation',
          order: 80,
          text: CLI_DELEGATION_GUIDANCE,
        }),
      'cliworker:guidance',
    )
    // Local patch: a session roster is advertised by its existence only. The full
    // list stays behind cliworker_status so this prefix never grows with entries.
    ctx.effect(
      () =>
        ctx.systemPrompt.section({
          name: 'cliworker:roster',
          order: 81,
          interpolate: false,
          text: (assemble) => {
            const parent = assemble.agent?.id
            if (!parent) return ''
            try {
              if (!this.runtime.storage.roster(parent).length) return ''
            } catch {
              return ''
            }
            return '本会话已配置可用智能体模板（角色 + CLI + 模型 + 思考强度的固定组合）。派遣前先调用 cliworker_status 查看模板与已有实例；派遣时用 cliworker_start 的 template 参数，宿主会自动创建带编号的新实例（同一模板可多次创建），续聊用 cliworker_followup。'
          },
        }),
      'cliworker:roster',
    )
  }
  private async parent(id: string): Promise<Agent> {
    // Use the same composition-owned resolution policy as native Remote Agent parameters.
    await this.ctx.typert.lookups.get('agent')?.resolve(id)
    const agent = this.ctx.agents.get(id as Agent['id'])
    if (!agent) throw new Error('请先在主对话发送一条消息以激活会话，然后重试')
    return agent
  }
  private project(agent: Agent): string {
    if (!agent.session.header.cwd) throw new Error('此主对话没有工作目录，请先选择项目')
    return projectDirectory(agent.session.header.cwd)
  }
  /** Local patch: resolve a session-scoped roster entry by its stable title. */
  private rosterEntry(parent: string, title: string): RosterEntry | undefined {
    const wanted = title.trim().toLocaleLowerCase()
    if (!wanted) return undefined
    return this.runtime.storage
      .roster(parent)
      .find((entry) => entry.title.toLocaleLowerCase() === wanted)
  }
  /** Follow the source card while it exists; fall back to the last snapshot once deleted. */
  private rosterRole(entry: RosterEntry): RoleSnapshot {
    if (entry.roleSource !== 'preset' || !entry.presetId) return entry.role
    const preset = this.runtime.storage.rolePresets().find((item) => item.id === entry.presetId)
    return preset ? roleSnapshot(preset) : entry.role
  }
  private assertExecution(agent: Agent): void {
    if (agent.session.header.origin === 'subagent') throw new Error('MVP 只支持主对话下的直接 CLI 子 Agent')
    // agy's terminal sandbox cannot implement Harness's whole-process read-only
    // policy (its native state is writable). Refuse rather than silently weaken it.
    if (agent.ctx.get('planMode')?.get(agent).active)
      throw new Error('请先退出 Harness 规划模式，再运行外部 CLI；本插件不会绕过规划边界')
    if (agent.ctx.get('sandboxPolicy')!.resolve({ session: agent.session }).mode === 'read-only')
      throw new Error('Harness 当前为只读权限；外部 CLI 需要可写运行状态，请先明确切换项目权限')
  }
  private async queryCatalog(...args: Parameters<typeof authorizedCatalog>) {
    try {
      return await authorizedCatalog(...args)
    } catch (error) {
      if (error instanceof ProcessCleanupUnconfirmedError) this.runtime.blockCatalogOnCleanup(args[0], error)
      throw error
    }
  }
  private async querySelection(...args: Parameters<typeof authorizeSelection>) {
    try {
      return await authorizeSelection(...args)
    } catch (error) {
      if (error instanceof ProcessCleanupUnconfirmedError)
        this.runtime.blockCatalogOnCleanup(cliOf(args[0]), error)
      throw error
    }
  }
  /** Read installation paths without saving discovery or opening a native account/model process. */
  private async resolveDispatchName(name: string, signal: AbortSignal) {
    return resolveAvailableCliName(name, async (cli) => {
      signal.throwIfAborted()
      const saved = this.options.cliExecutablePaths?.read(cli)
      const config = {
        ...this.options,
        cliExecutablePaths: undefined,
        ...(saved?.mode === 'manual' ? { [`${cli}Executable`]: saved.path } : {}),
      }
      try {
        await resolveCliExecutable(cli, this.backend, config, signal)
        signal.throwIfAborted()
        return true
      } catch (error) {
        if (error instanceof ProcessCleanupUnconfirmedError) {
          this.runtime.blockCatalogOnCleanup(cli, error)
          throw error
        }
        signal.throwIfAborted()
        // A missing manually configured entry is a broken selection, not absence.
        if (!saved || saved.mode !== 'manual') {
          if (
            !configuredCliExecutable(cli, config) &&
            (error instanceof WindowsCliNotFoundError ||
              error instanceof SubprocessExecutableNotFoundError ||
              ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException)?.code ?? ''))
          )
            return false
        }
        throw error
      }
    })
  }
  private async chooseQoderVariant(agent: Agent, callerSignal: AbortSignal, name: string) {
    const signal = AbortSignal.any([callerSignal, this.disposed.signal])
    signal.throwIfAborted()
    const project = this.project(agent)
    const key = JSON.stringify([agent.id, project, 'qoder-variant'])
    const waits = (this.dispatchWaits ??= new Map())
    const previous = waits.get(key) ?? Promise.resolve()
    let release!: () => void
    const owned = new Promise<void>((resolve) => {
      release = resolve
    })
    const tail = previous.then(() => owned)
    waits.set(key, tail)
    void tail.then(() => {
      if (waits.get(key) === tail) waits.delete(key)
    })
    this.pending.set(agent.id, (this.pending.get(agent.id) ?? 0) + 1)
    this.runtime.changed()
    try {
      await waitForInput(previous, signal)
      this.assertExecution(agent)
      const resolution = await this.resolveDispatchName(name, signal)
      signal.throwIfAborted()
      let cli: 'qoder' | 'qodercn'
      if (resolution.status === 'resolved' && (resolution.cli === 'qoder' || resolution.cli === 'qodercn'))
        cli = resolution.cli
      else if (resolution.status === 'ambiguous') {
        const response = await waitForInput(
          agent.ctx.get('userQuestions')!.ask({
            agent,
            signal,
            questions: [
              {
                id: 'cliworker_qoder_variant',
                header: 'Qoder 版本',
                question: '检测到 Qoder 和 Qoder CN，请选择本次使用的版本',
                options: [{ label: 'Qoder' }, { label: 'Qoder CN' }],
              },
            ],
          }),
          signal,
        )
        signal.throwIfAborted()
        const answer = response.answers.find((item) => item.id === 'cliworker_qoder_variant')
        if (
          answer?.custom !== undefined ||
          answer?.selected.length !== 1 ||
          !['Qoder', 'Qoder CN'].includes(answer.selected[0]!)
        )
          throw new Error('请选择 Qoder 或 Qoder CN；任务尚未启动')
        cli = answer.selected[0] === 'Qoder' ? 'qoder' : 'qodercn'
      } else throw new Error('未找到 Qoder 或 Qoder CN 安装，请先安装或配置 CLI 路径；任务尚未启动')
      signal.throwIfAborted()
      this.assertExecution(agent)
      if (this.project(agent) !== project) throw new Error('项目已变更，请重新选择')
      this.runtime.assertCliEnabled(cli)
      return cli
    } finally {
      release()
      const pending = (this.pending.get(agent.id) ?? 1) - 1
      if (pending) this.pending.set(agent.id, pending)
      else this.pending.delete(agent.id)
      this.runtime.changed()
    }
  }
  /** Serialize only this conversation's selection; a cancelled waiter never owns the question. */
  private async chooseDispatch(
    agent: Agent,
    callerSignal: AbortSignal,
    cli: CliId,
    overrides?: {
      model?: string
      effort?: string
      role?: string
      roleSnapshot?: RoleSnapshot
      pinned?: boolean
      label?: string
    },
  ): Promise<DispatchSetup> {
    const signal = AbortSignal.any([callerSignal, this.disposed.signal])
    signal.throwIfAborted()
    this.runtime.assertCliEnabled(cli)
    const project = this.project(agent)
    const key = JSON.stringify([agent.id, project, cli])
    const waits = (this.dispatchWaits ??= new Map())
    const previous = waits.get(key) ?? Promise.resolve()
    let release!: () => void
    const owned = new Promise<void>((resolve) => {
      release = resolve
    })
    const tail = previous.then(() => owned)
    waits.set(key, tail)
    void tail.then(() => {
      if (waits.get(key) === tail) waits.delete(key)
    })
    this.pending.set(agent.id, (this.pending.get(agent.id) ?? 0) + 1)
    this.runtime.changed()
    try {
      await waitForInput(previous, signal)
      signal.throwIfAborted()
      this.assertExecution(agent)
      this.runtime.assertCliEnabled(cli)
      this.settingsCatalogs ??= new SettingsCatalogCache(this.runtime.storage.directory)
      const catalogRevision = this.settingsCatalogs.revision(cli)
      const { catalog, binding } = await this.queryCatalog(cli, this.backend, this.options, project, signal)
      signal.throwIfAborted()
      this.runtime.assertCliEnabled(cli)
      this.settingsCatalogs.remember(project, { catalog, binding }, catalogRevision)
      const models = catalog.models
      const valid = (setup: DispatchSetup | undefined): setup is DispatchSetup => {
        if (!setup || setup.binding !== binding || cliOf(setup.preference) !== cli) return false
        try {
          validatePreference(setup.preference, catalog)
          return resolveModel(setup.preference, models).model === setup.preference.model
        } catch {
          return false
        }
      }
      const ask = async (questions: AskUserQuestionItem[]) => {
        signal.throwIfAborted()
        const response = await waitForInput(
          agent.ctx.get('userQuestions')!.ask({ agent, signal, questions }),
          signal,
        )
        signal.throwIfAborted()
        this.runtime.assertCliEnabled(cli)
        return response
      }
      const current = this.runtime.storage.conversationSetup(agent.id, project, cli)
      let setup: DispatchSetup | undefined = valid(current) ? current : undefined
      let selected = false
      // Local patch: a roster entry already fixes CLI/model/effort/role, so this path
      // opens no question card. A pinned choice that no longer resolves fails loudly.
      if (overrides?.pinned) {
        const label = overrides.label ?? '可用智能体'
        const choices = visibleModelChoices(models)
        const wanted = (overrides.model ?? '').trim()
        const target = choices.find(
          (model) =>
            model.id === wanted ||
            model.label === wanted ||
            Object.values(model.variants ?? {}).includes(wanted),
        )
        if (!target?.efforts?.length)
          throw new Error(
            `可用智能体「${label}」固定的模型当前不可用：${wanted}；请在可用智能体里重新选择模型`,
          )
        const wantedEffort = (overrides.effort ?? '').trim()
        if (wantedEffort && !target.efforts.includes(wantedEffort as (typeof EFFORTS)[number]))
          throw new Error(
            `可用智能体「${label}」固定的思考强度 ${effortLabel(wantedEffort)} 不被模型 ${target.label} 支持；可选：${target.efforts.map(effortLabel).join('、')}`,
          )
        setup = {
          preference: resolveModel(
            preferenceSchema.parse({
              cli,
              model: target.id,
              effort: (wantedEffort || target.efforts[0]) as (typeof EFFORTS)[number],
            }),
            models,
          ),
          role: overrides.roleSnapshot ?? null,
          binding,
        }
      }
      // Local patch: a new conversation silently reuses the saved setup instead of
      // asking "沿用?" every time. Set CLIWORKER_NO_REUSE_PROMPT=0 to restore the card.
      const autoReuse = (process.env.CLIWORKER_NO_REUSE_PROMPT || '').trim() !== '0'
      if (!overrides?.pinned && !current) {
        const saved = this.runtime.storage.dispatchSetup(project, cli)
        if (valid(saved)) {
          if (autoReuse) setup = saved
          else {
            const modelLabel =
              models.find(
                (model) =>
                  model.id === saved.preference.model ||
                  Object.values(model.variants ?? {}).includes(saved.preference.model),
              )?.label ?? saved.preference.model
            const response = await ask([
              {
                id: 'cliworker_reuse',
                header: '沿用设定',
                question: `是否沿用 ${modelLabel} · ${effortLabel(saved.preference.effort)} · ${saved.role?.name ?? '不使用角色预设'}？`,
                options: [{ label: '沿用' }, { label: '重新选择' }],
              },
            ])
            const answer = response.answers.find((item) => item.id === 'cliworker_reuse')
            if (
              answer?.custom !== undefined ||
              answer?.selected.length !== 1 ||
              !['沿用', '重新选择'].includes(answer.selected[0]!)
            )
              throw new Error('请选择沿用或重新选择；任务尚未启动')
            if (answer.selected[0] === '沿用') setup = saved
          }
        }
      }
      if (!overrides?.pinned && !setup) {
        const choices = visibleModelChoices(models)
        const response = await ask([
          {
            id: 'cliworker_model',
            header: `${CLI_LABELS[cli]} 模型`,
            question: '选择模型',
            options: choices.map((model) => ({ label: model.label })),
          },
        ])
        const answer = response.answers.find((item) => item.id === 'cliworker_model')
        const chosen =
          answer?.custom === undefined && answer?.selected.length === 1
            ? choices.find((model) => model.label === answer.selected[0])
            : undefined
        if (!chosen?.efforts?.length) throw new Error('请选择列表中的模型')
        const offered = structuredClone(this.runtime.storage.rolePresets())
        const questions: AskUserQuestionItem[] = []
        if (chosen.efforts.length > 1)
          questions.push({
            id: 'cliworker_effort',
            header: '思考强度',
            question: `选择 ${chosen.label} 的思考强度`,
            options: chosen.efforts.map((effort) => ({ label: effortLabel(effort) })),
          })
        questions.push(roleQuestion(offered))
        const selection = await ask(questions)
        const effortAnswer = selection.answers.find((item) => item.id === 'cliworker_effort')
        const effort =
          chosen.efforts.length === 1
            ? chosen.efforts[0]
            : effortAnswer?.custom === undefined && effortAnswer?.selected.length === 1
              ? chosen.efforts.find((effort) => effortLabel(effort) === effortAnswer.selected[0])
              : undefined
        const preference = resolveModel(preferenceSchema.parse({ cli, model: chosen.id, effort }), models)
        setup = { preference, role: readRoleAnswer(offered, selection) ?? null, binding }
        selected = true
      }
      // Local patch: per-call overrides. model/effort/role let the parent Agent pick a
      // worker's setup without opening a question card. role accepts a preset name,
      // a literal role prompt, or "none".
      if (
        !overrides?.pinned &&
        overrides &&
        (overrides.model !== undefined || overrides.effort !== undefined || overrides.role !== undefined)
      ) {
        if (!setup) throw new Error('尚未完成选型')
        const base = setup
        const choices = visibleModelChoices(models)
        const wantedModel = typeof overrides.model === 'string' ? overrides.model.trim() : ''
        let chosen = wantedModel
          ? (choices.find((model) => model.label === wantedModel) ??
            choices.find((model) => model.id === wantedModel))
          : undefined
        if (!chosen && !wantedModel)
          chosen =
            choices.find(
              (model) =>
                model.id === base.preference.model ||
                Object.values(model.variants ?? {}).includes(base.preference.model),
            ) ?? choices[0]
        if (!chosen?.efforts?.length)
          throw new Error(`指定模型不可用：${wantedModel || base.preference.model}`)
        let effort = base.preference.effort
        const wantedEffort = typeof overrides.effort === 'string' ? overrides.effort.trim() : ''
        if (wantedEffort) {
          const matched =
            chosen.efforts.find((item) => item === wantedEffort) ??
            chosen.efforts.find((item) => effortLabel(item).toLowerCase() === wantedEffort.toLowerCase())
          if (!matched) throw new Error(`模型 ${chosen.label} 不支持思考强度：${wantedEffort}`)
          effort = matched
        } else if (!chosen.efforts.includes(effort)) effort = chosen.efforts[0]!
        let role = base.role ?? null
        if (typeof overrides.role === 'string') {
          const wanted = overrides.role.trim()
          if (!wanted || wanted.toLowerCase() === 'none') role = null
          else {
            const preset = this.runtime.storage.rolePresets().find((item) => item.name === wanted)
            role = preset
              ? roleSnapshot(preset)
              : roleSnapshotSchema.parse({
                  name: '临时角色',
                  summary: '本次派遣自定义的角色提示词',
                  prompt: wanted,
                })
          }
        }
        setup = {
          preference: resolveModel(preferenceSchema.parse({ cli, model: chosen.id, effort }), models),
          role,
          binding,
        }
        selected = true
      }
      // A remembered answer is never execution authority. Detect changes during any question.
      if (!setup) throw new Error('尚未完成选型')
      const checked = await this.querySelection(
        setup.preference,
        this.backend,
        this.options,
        project,
        signal,
        binding,
      )
      if (checked.preference.model !== setup.preference.model)
        throw new Error('模型与思考强度已变更，请重新选择')
      signal.throwIfAborted()
      this.assertExecution(agent)
      this.runtime.assertCliEnabled(cli)
      if (this.project(agent) !== project) throw new Error('项目已变更，请重新选择')
      if (selected) this.runtime.storage.setDispatchSetup(project, setup)
      if (current !== setup) this.runtime.storage.setConversationSetup(agent.id, project, setup)
      ;(this.selectionBindings ??= new WeakMap()).set(setup.preference, binding)
      ;(this.selectionProjects ??= new WeakMap()).set(setup.preference, project)
      return setup
    } finally {
      release()
      const pending = (this.pending.get(agent.id) ?? 1) - 1
      if (pending) this.pending.set(agent.id, pending)
      else this.pending.delete(agent.id)
      this.runtime.changed()
    }
  }
  private async launch(
    agent: Agent,
    title: string,
    prompt: string,
    preference: Preference,
    mode: TaskMode,
    workerId?: string,
    identity?: { agentName?: string; role?: RoleSnapshot; parallelWrite?: boolean },
    signal: AbortSignal = this.disposed.signal,
    restartSourceId?: string,
    queuedAdmission?: { id: string; expectedRunId: string; priority?: boolean },
    preparationId?: string,
    submissionId?: string,
    attachments?: readonly NativeAttachment[],
  ): Promise<string> {
    if (workerId && !preparationId)
      return this.runtime.prepareFollowup(
        agent.id,
        workerId,
        signal,
        (control, id) =>
          this.launch(
            agent,
            title,
            prompt,
            preference,
            mode,
            workerId,
            identity,
            control,
            restartSourceId,
            queuedAdmission,
            id,
            submissionId,
            attachments,
          ),
        queuedAdmission?.priority ? queuedAdmission.id : undefined,
      )
    this.assertExecution(agent)
    this.runtime.assertCliEnabled(cliOf(preference))
    if (this.accounts.isBusy(cliOf(preference)))
      throw new Error('此 CLI 正在管理账号，请先关闭账号终端再启动任务')
    const project = this.project(agent)
    const selectedProject = this.selectionProjects?.get(preference)
    if (!workerId && selectedProject && selectedProject !== project) throw new Error('项目已变更，请重新选择')
    const expected = workerId
      ? this.runtime.storage.accountBinding(workerId)
      : this.selectionBindings?.get(preference)
    if (workerId && !expected) {
      const worker = this.runtime.get(agent.id, workerId)
      if (worker.conversationId || !isUserInterrupted(worker)) throw new Error(LEGACY_ACCOUNT_RECORD_NOTICE)
    }
    const { binding, preference: authorizedPreference } = await this.querySelection(
      preference,
      this.backend,
      this.options,
      project,
      signal,
      expected,
    )
    if (authorizedPreference.model !== preference.model) throw new Error('模型与思考强度不匹配，请重新选择')
    signal.throwIfAborted()
    this.assertExecution(agent)
    this.runtime.assertCliEnabled(cliOf(preference))
    if (this.accounts.isBusy(cliOf(preference))) throw new Error('请先关闭账号终端')
    if (this.project(agent) !== project) throw new Error('项目已变更，请重新选择')
    if (restartSourceId) this.runtime.assertLegacyRestart(agent.id, restartSourceId)
    let submission: Submission | undefined
    const id = agent.ctx.get('jobs')!.start({
      kind: 'cliworker',
      owner: agent.id,
      label: `${CLI_LABELS[cliOf(preference)]} · ${title} · ${workerId ? '续聊' : '新任务'}：${prompt.replace(/\s+/g, ' ').slice(0, 100)}`,
      outputLimitBytes: 12000,
      run: () => {
        const submitted = this.runtime.submit(
          agent.id,
          project,
          title,
          prompt,
          preference,
          mode,
          workerId,
          identity,
          binding,
          queuedAdmission,
          preparationId,
          submissionId,
          attachments,
        )
        submission = submitted
        return {
          cancel: submitted.cancel,
          done: submitted.done.then((worker) => ({
            status:
              worker.status === 'completed'
                ? ('completed' as const)
                : worker.status === 'interrupted'
                  ? ('killed' as const)
                  : ('failed' as const),
            detail: worker.error,
            result: JSON.stringify({
              cli: cliOf(worker.preference),
              workerId: worker.id,
              agentName: workerName(worker),
              runId: worker.runId,
              task: prompt.slice(0, 300),
              status: worker.status,
              response: worker.lastResult,
              error: worker.error,
              guidance:
                worker.status === 'uncertain'
                  ? '结果待核实；请先核查本轮输出和实际产物，不要自动重试。'
                  : undefined,
            }),
          })),
        }
      },
    })
    if (!submission) throw new Error('Harness did not publish the worker job')
    this.nativeRunDone.set(submission.worker.runId, submission.done)
    const runId = submission.worker.runId
    void submission.done.then(
      () => {
        this.nativeRunDone.delete(runId)
      },
      () => {
        this.nativeRunDone.delete(runId)
      },
    )
    try {
      this.runtime.attachJob(submission.worker, id)
    } catch (error) {
      // Admission already happened. Do not leave a process running without a
      // receipt when the job binding cannot be persisted.
      const admitted = submission
      const outcomes = await Promise.allSettled([
        Promise.resolve().then(() => admitted.cancel()),
        admitted.done,
      ])
      const failures = outcomes.filter((item): item is PromiseRejectedResult => item.status === 'rejected')
      if (failures.length)
        throw new AggregateError([error, ...failures.map((item) => item.reason)], '任务登记失败；取消或清理报告异常')
      throw error
    }
    return JSON.stringify({
      cli: cliOf(submission.worker.preference),
      workerId: submission.worker.id,
      agentName: workerName(submission.worker),
      runId: submission.worker.runId,
      jobId: id,
      status: submission.worker.status,
      model: submission.worker.preference.model,
      effort: submission.worker.preference.effort,
    })
  }
  private waitHarnessRun(record: HarnessConversationRecord, runId: string): Promise<Worker> {
    const running = this.nativeRunDone.get(runId)
    if (running) return running.then((worker) => structuredClone(worker))
    const worker = this.runtime.get(record.parentSessionId, record.workerId)
    if (worker.runId !== runId) return Promise.reject(new Error('原生会话目标轮次已变化，未重放任务'))
    if (['queued', 'running', 'stopping'].includes(worker.status))
      return Promise.reject(new Error('无法接管缺少完成凭据的运行，请等待现有任务结束'))
    return Promise.resolve(structuredClone(worker))
  }
  /** @param parentSessionId - Owning Harness parent. @param workerId - Existing Worker identity. @param signal - View lifetime. @returns Real native child binding; opening never submits the user task again. */
  @Remote('ensureHarnessConversation')
  async ensureHarnessConversation(
    parentSessionId: string,
    workerId: string,
    signal: AbortSignal,
  ): Promise<string> {
    try {
      const parent = await this.parent(parentSessionId)
      const worker = this.runtime.get(parent.id, workerId)
      if (this.project(parent) !== worker.project) throw new Error('项目已变更，请在原项目打开会话')
      if (!this.harnessConversation) throw new Error('当前 Harness 原生会话服务未就绪')
      const ensured = await this.harnessConversation.ensure(parent, worker, {
        initialRunId: worker.runId,
        signal,
      })
      const current = this.runtime.get(parent.id, workerId)
      const previous = current.harnessConversation
      const binding =
        previous?.sessionId === ensured.sessionId
          ? {
              ...ensured,
              capabilities: {
                ...ensured.capabilities,
                tools: previous.capabilities.tools,
                skills: previous.capabilities.skills,
              },
              reasons: {
                ...ensured.reasons,
                tools: previous.reasons?.tools,
                skills: previous.reasons?.skills,
              },
            }
          : ensured
      current.harnessConversation = binding
      this.runtime.storage.save(current)
      this.runtime.changed()
      return JSON.stringify(binding)
    } catch (error) {
      throw failure(error)
    }
  }
  /** @param parentSessionId - Exact owning parent. @param workerId - Existing Worker. @param expectedSessionId - Failed display binding shown by this Client. @param signal - Explicit repair lifetime. @returns Replacement display binding; never submits a CLI prompt. */
  @Remote('repairHarnessConversation')
  async repairHarnessConversation(
    parentSessionId: string,
    workerId: string,
    expectedSessionId: string,
    signal: AbortSignal,
  ): Promise<string> {
    try {
      const parent = await this.parent(parentSessionId)
      const worker = this.runtime.get(parent.id, workerId)
      if (this.project(parent) !== worker.project) throw new Error('项目已变更，请在原项目修复显示会话')
      if (!this.harnessConversation) throw new Error('当前 Harness 原生会话服务未就绪')
      if (this.runtime.snapshot(parent.id, workerId).selectedBusy)
        throw new Error('当前任务仍在执行、提交或清理，请结束后再修复显示会话')
      return await this.runtime.prepareFollowup(
        parent.id,
        workerId,
        AbortSignal.any([signal, this.disposed.signal]),
        async (control) => {
          this.repairingDisplays.add(workerId)
          try {
            const binding = await this.harnessConversation!.repairDisplay(
              parent,
              worker,
              expectedSessionId,
              control,
            )
            const current = this.runtime.get(parent.id, workerId)
            current.harnessConversation = binding
            this.runtime.storage.save(current)
            this.runtime.changed()
            return JSON.stringify(binding)
          } finally {
            this.repairingDisplays.delete(workerId)
          }
        },
      )
    } catch (error) {
      throw failure(error)
    }
  }
  private registerTools(): void {
    const output = {
      schema: { type: 'string' as const },
      render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
    }
    this.ctx.effect(
      () =>
        this.ctx.tools.register(
          defineTool({
            name: 'cliworker_resolve',
            description: `只读解析明确调用中的 CLI 名称、别名或轻微拼写误差，不启动任务、不读取账号、不保存选型。${CLI_NAME_GUIDANCE}。未知、歧义或多个目标返回简短候选错误，不启动、不额外发问题卡。`,
            parameters: {
              name: {
                type: 'string',
                required: true,
                description: '用户要求调用的 CLI 名称；不是任务内容或模型名称。',
              },
            },
            output,
            isConcurrencySafe: () => true,
            execute: async (args, exec) =>
              JSON.stringify(
                isGenericQoderName(args.name)
                  ? await this.resolveDispatchName(
                      args.name,
                      AbortSignal.any([exec.signal, this.disposed.signal]),
                    )
                  : resolveCliName(args.name),
              ),
          }),
        ),
      'cliworker:resolve',
    )
    this.ctx.effect(
      () =>
        this.ctx.tools.register(
          defineTool({
            name: 'cliworker_start',
            description: `用户明确要求“调用 agy cli”或“用 glm cli 完成任务”时，调用本工具打开 CLI Worker 的选型流程。只需提供 CLI、任务标题和任务内容；模型、思考强度与角色由插件收集，完成选型前不会启动任务，不要把它们当作调用本工具的前置输入。${CLI_NAME_GUIDANCE}。泛称 qoder 在双版本均安装时先通过原生询问选择版本。Host 在首次选择模型、思考强度与角色，或同项目新对话确认是否沿用时提问；同对话后续不重复。不要提前自行提问或增加确认，不代答。返回后台 job、worker ID 和 agentName。若用户已在本会话配置可用智能体模板，传 template 即可创建带编号的新实例（同一模板可重复创建），不再弹选型卡。已有智能体续聊用 cliworker_followup；除泛称 qoder 的双版本选择外，其他歧义返回简短候选错误，不启动、不额外发问题卡。`,
            parameters: {
              cli: {
                type: 'string',
                required: true,
                description: `本次用户明确指定的 CLI 规范 ID 或别名：${CLI_NAME_GUIDANCE}。每次调用必填，Antigravity 也不可省略；不得照搬历史调用中省略 cli 的写法。较长名称仅接受唯一轻微误差；短名须精确，不猜模型。`,
              },
              title: { type: 'string', required: true },
              prompt: { type: 'string', required: true },
              agent_name: {
                type: 'string',
                description:
                  'Optional user-requested unique worker name within this parent conversation. Otherwise assigned from the CLI short name and an ordinal. Use followup by worker_name to reuse an existing named worker.',
              },
              read_only: {
                type: 'boolean',
                description:
                  'Use native read-only/plan mode; unsupported by Kimi print mode. Omit or false for coding.',
              },
              role: {
                type: 'string',
                description:
                  'Optional role for this worker: a saved preset name, a literal role prompt, or "none". Overrides the project default without a question card.',
              },
              model: {
                type: 'string',
                description:
                  'Optional model id or label for this worker. Omit to reuse the saved selection.',
              },
              effort: {
                type: 'string',
                description:
                  'Optional reasoning effort for this worker (must be supported by the chosen model). Omit to reuse the saved selection.',
              },
              template: {
                type: 'string',
                description:
                  'Session roster template name. Creates a NEW numbered agent from it (template1, template2, …) with the pinned CLI/model/effort/role and opens no selection card. Repeat the call to create more instances. Omit for the normal selection flow.',
              },
              parallel_write: {
                type: 'boolean',
                description:
                  'Leader opt-in: allow this write task to run concurrently with another parallel_write task in the same project. Only set it after confirming the two workers touch disjoint files. Omit for the safe serial behavior.',
              },
            },
            output,
            timeoutMs: 1800000,
            isConcurrencySafe: () => true,
            execute: async (args, exec) => {
              if (!exec.agent) throw new Error('A parent Agent is required')
              this.assertExecution(exec.agent)
              // Local patch: a role preset may pin the CLI/model/effort for this worker.
              const namedPreset =
                typeof args.role === 'string'
                  ? this.runtime.storage
                      .rolePresets()
                      .find((preset) => preset.name === args.role!.trim())
                  : undefined
              let cli = requireCliName(args.cli)
              if (namedPreset?.cli && namedPreset.cli !== cli) cli = namedPreset.cli
              if (isGenericQoderName(args.cli) && !namedPreset?.cli)
                cli = await this.chooseQoderVariant(exec.agent, exec.signal, args.cli)
              const agentName =
                args.agent_name === undefined ? undefined : agentNameSchema.parse(args.agent_name)
              // Local patch: a roster template fixes CLI/model/effort/role. The leader
              // dispatches the template itself; the Host allocates a numbered instance,
              // so one template can create many agents over time.
              const templateName = typeof args.template === 'string' ? args.template.trim() : ''
              const template = templateName ? this.rosterEntry(exec.agent.id, templateName) : undefined
              if (templateName && !template)
                throw new Error(
                  `本会话没有名为「${templateName}」的可用智能体；先用 cliworker_status 查看可用模板`,
                )
              if (template) {
                if (template.cli !== cli)
                  throw new Error(
                    `可用智能体模板「${template.title}」固定使用 ${CLI_LABELS[template.cli]}，不能改用 ${CLI_LABELS[cli]}；需要其他 CLI 请另建一个模板`,
                  )
                if (args.model !== undefined || args.effort !== undefined || args.role !== undefined)
                  throw new Error(
                    `可用智能体模板「${template.title}」的模型、思考强度与角色都已固定；如需临时调整，请先编辑该模板`,
                  )
              }
              if (cli === 'kimi' && args.read_only) throw new Error('Kimi 非交互模式不支持只读派遣')
              // Local patch: only pass overrides when the caller actually set one (or a
              // preset/template supplied one), so the stock three-argument call shape is kept.
              const overrideModel = template?.model ?? args.model ?? namedPreset?.model
              const overrideEffort = template?.effort ?? args.effort ?? namedPreset?.effort
              const hasOverride =
                template !== undefined ||
                overrideModel !== undefined ||
                overrideEffort !== undefined ||
                args.role !== undefined
              const dispatchSignal = AbortSignal.any([exec.signal, this.disposed.signal])
              const setup = hasOverride
                ? await this.chooseDispatch(exec.agent, dispatchSignal, cli, {
                    model: overrideModel,
                    effort: overrideEffort,
                    ...(template
                      ? {
                          roleSnapshot: this.rosterRole(template),
                          pinned: true,
                          label: template.title,
                        }
                      : { role: args.role }),
                  })
                : await this.chooseDispatch(exec.agent, dispatchSignal, cli)
              exec.signal.throwIfAborted()
              return this.launch(
                exec.agent,
                args.title,
                args.prompt,
                setup.preference,
                args.read_only ? 'plan' : 'accept-edits',
                undefined,
                {
                  agentName,
                  ...(template
                    ? {
                        templateId: template.id,
                        ...(agentName === undefined ? { templateTitle: template.title } : {}),
                      }
                    : {}),
                  role: setup.role ?? undefined,
                  ...(args.parallel_write === true ? { parallelWrite: true } : {}),
                },
                AbortSignal.any([exec.signal, this.disposed.signal]),
              )
            },
          }),
        ),
      'cliworker:start',
    )
    this.ctx.effect(
      () =>
        this.ctx.tools.register(
          defineTool({
            name: 'cliworker_status',
            description:
              'Read the session picture before dispatching: the available agents (roster) with their pinned CLI/model/effort, every worker with its status and execution count, or one worker’s latest result. Never starts a CLI or reads the event log.',
            parameters: { worker_id: { type: 'string' }, worker_name: { type: 'string' } },
            output,
            isConcurrencySafe: () => true,
            execute: async (args, exec) => {
              if (!exec.agent) throw new Error('A parent Agent is required')
              const parent = exec.agent.id
              if (args.worker_id || args.worker_name) {
                const worker = this.runtime.resolveWorker(parent, args.worker_id, args.worker_name)
                return JSON.stringify({
                  ...worker,
                  agentName: workerName(worker),
                  runs: worker.runCount ?? 0,
                })
              }
              const snapshot = this.runtime.snapshot(parent)
              const live = snapshot.workers
              const archived = snapshot.archivedWorkers ?? []
              const all = [...live, ...archived]
              // A template owns many instances. Count by template id, and fall back to
              // the numbered name prefix for Workers created before templates existed.
              const instances = (entry: { id: string; title: string }) =>
                all.filter((worker) => {
                  if (worker.templateId === entry.id) return true
                  if (worker.templateId) return false
                  const name = workerName(worker)
                  return name.startsWith(entry.title) && /^\d+$/.test(name.slice(entry.title.length))
                })
              const roster = this.runtime.storage.roster(parent).map((entry) => {
                const created = instances(entry)
                return {
                  title: entry.title,
                  cli: entry.cli,
                  model: entry.model,
                  effort: entry.effort,
                  role: entry.role.name,
                  roleSource: entry.roleSource,
                  created: created.length,
                  workers: created.map((worker) => workerName(worker)),
                }
              })
              const brief = (worker: Worker) => ({
                workerId: worker.id,
                agentName: workerName(worker),
                title: worker.title,
                cli: cliOf(worker.preference),
                model: worker.preference.model,
                effort: worker.preference.effort,
                status: worker.archivedAt ? 'archived' : worker.status,
                runs: worker.runCount ?? 0,
                ...(worker.error ? { error: worker.error } : {}),
                ...(worker.lastResult ? { lastResult: worker.lastResult.slice(0, 400) } : {}),
              })
              return JSON.stringify({
                roster,
                workers: live.map(brief),
                archived: archived.map(brief),
                counts: {
                  running: live.filter((worker) => active(worker.status)).length,
                  idle: live.filter((worker) => !active(worker.status)).length,
                },
              })
            },
          }),
        ),
      'cliworker:status',
    )
    this.ctx.effect(
      () =>
        this.ctx.tools.register(
          defineTool({
            name: 'cliworker_followup',
            description:
              'Continue a specific idle CLI worker by worker_id or its exact agentName in worker_name. Retains its role, current model/effort and CLI conversation; never starts another worker.',
            parameters: {
              worker_id: { type: 'string' },
              worker_name: { type: 'string' },
              prompt: { type: 'string', required: true },
            },
            output,
            isConcurrencySafe: () => true,
            execute: async (args, exec) => {
              if (!exec.agent) throw new Error('A parent Agent is required')
              const worker = this.runtime.resolveWorker(exec.agent.id, args.worker_id, args.worker_name)
              return this.followup(exec.agent.id, worker.id, args.prompt, exec.signal)
            },
          }),
        ),
      'cliworker:followup',
    )
    this.ctx.effect(
      () =>
        this.ctx.tools.register(
          defineTool({
            name: 'cliworker_stop',
            description: 'Stop a CLI worker and await cleanup of its managed processes.',
            parameters: { worker_id: { type: 'string' }, worker_name: { type: 'string' } },
            output,
            isConcurrencySafe: () => true,
            execute: async (args, exec) => {
              if (!exec.agent) throw new Error('A parent Agent is required')
              const worker = this.runtime.resolveWorker(exec.agent.id, args.worker_id, args.worker_name)
              return JSON.stringify(await this.runtime.stop(exec.agent.id, worker.id))
            },
          }),
        ),
      'cliworker:stop',
    )
  }
  /** @param parentSessionId - Owning Harness session. @param workerId - Selected worker or empty string. @param signal - Stream lifetime. @returns JSON snapshots, initially and after changes. */
  @Remote({ mode: 'stream' })
  async *watch(parentSessionId: string, workerId: string, signal: AbortSignal): AsyncIterable<string> {
    let wake: (() => void) | undefined
    let dirty = true
    let observedSessionId: string | undefined
    const notify = () => {
      dirty = true
      wake?.()
    }
    const unsubscribe = this.runtime.subscribe(notify)
    const unsubscribeSession = this.ctx.on('session/event', (session, event) => {
      if (session.id === observedSessionId && event.type === 'turn/end') notify()
    }, { global: true })
    const lifetime = AbortSignal.any([signal, this.disposed.signal])
    lifetime.addEventListener('abort', notify)
    try {
      while (!lifetime.aborted) {
        if (!dirty)
          await new Promise<void>((resolve) => {
            wake = resolve
          })
        wake = undefined
        if (lifetime.aborted) return
        dirty = false
        const snapshot = this.runtime.snapshot(parentSessionId, workerId || undefined)
        const selected = snapshot.selected
        const binding = selected?.harnessConversation
        observedSessionId = binding?.parentSessionId === parentSessionId ? binding.sessionId : undefined
        let record = binding && this.harnessConversationStore?.list().find((entry) =>
          entry.sessionId === binding.sessionId && entry.workerId === selected.id && entry.parentSessionId === parentSessionId)
        const events = selected ? this.runtime.storage.history(selected.id) : []
        const needsRecovery = record?.nativeInputs?.some((input) => input.accepted && events.some((event) =>
          event.kind === 'user' && event.queuedFollowupId === input.batchId && event.admittedRunId === event.runId &&
          !record?.turnRuns?.some((entry) => entry.runId === event.runId)))
        let externalTurnAnswer: import('../shared/native-turn-answer.ts').ExternalTurnAnswer | undefined
        if (record && selected && (record.turnRuns?.length || (!snapshot.selectedBusy && needsRecovery))) {
          const query = this.ctx?.get('sessionQuery') as
            | {
                observeSession(
                  id: SessionId,
                  options: { signal: AbortSignal; projectionMode: 'none' },
                ): Promise<Disposable & HarnessTurnObservation>
              }
            | undefined
          if (query) {
            try {
              const observation = await query.observeSession(SessionId(record.sessionId), {
                signal: lifetime,
                projectionMode: 'none',
              })
              try {
                if (!snapshot.selectedBusy && needsRecovery) record = recoverHarnessTurnRuns(record, selected, events, observation)
                externalTurnAnswer = projectExternalTurnAnswer(record, selected, events, observation)
              } finally { observation[Symbol.dispose]() }
            } catch {
              if (lifetime.aborted) return
              // Read failures are not permission to guess or rewrite an old turn.
            }
            if (this.runtime.snapshot(parentSessionId, workerId || undefined).revision !== snapshot.revision) {
              dirty = true
              continue
            }
          }
        }
        yield JSON.stringify({
          ...snapshot,
          ...(selected && binding?.parentSessionId === parentSessionId
            ? {
                externalRequestState: projectRequestState(selected, events),
                externalTurnAnswer,
                externalTurnUsage: projectExternalTurnUsage(
                  record,
                  selected,
                  !!snapshot.selectedBusy,
                  events,
                  (runId) => this.runtime.runUsage(parentSessionId, selected.id, runId),
                  (runId) => this.runtime.runCredits(parentSessionId, selected.id, runId),
                ),
              }
            : {}),
          configuring: this.pending.has(parentSessionId),
        })
      }
    } finally {
      unsubscribe()
      unsubscribeSession()
      lifetime.removeEventListener('abort', notify)
    }
  }
  /** @param parentSessionId - Owning parent session. @param workerId - Worker identity. @param anchor - Stable logical row ID, excluded from the result. @param direction - before or after. @returns JSON historical page, at most 200 rows. */
  @Remote('history')
  async history(
    parentSessionId: string,
    workerId: string,
    anchor: string,
    direction: string,
  ): Promise<string> {
    try {
      return JSON.stringify(this.runtime.history(parentSessionId, workerId, anchor, direction))
    } catch (error) {
      throw failure(error)
    }
  }
  /** @param parentSessionId - Owning Harness session. @param signal - Query lifetime. @returns Profile-wide CLI enablement JSON. */
  @Remote('cliSettings')
  async cliSettings(parentSessionId: string, signal: AbortSignal): Promise<string> {
    try {
      const parent = await this.parent(parentSessionId)
      signal.throwIfAborted()
      const settings = this.runtime.storage.cliSettings()
      let project: string
      try {
        project = this.project(parent)
      } catch {
        return JSON.stringify(settings)
      }
      // Reusing the same project's display list in another parent still pins
      // configure() to the original verified account; no CLI query is needed.
      for (const cli of CLI_IDS) {
        const binding = this.settingsCatalogs?.displayBinding(project, cli)
        const key = JSON.stringify([parentSessionId, cli])
        if (binding) (this.displayedBindings ??= new Map()).set(key, binding)
      }
      return JSON.stringify({ ...settings, settingsCache: this.settingsDisplayMetadata(project) })
    } catch (error) {
      throw failure(error)
    }
  }
  private settingsDisplayMetadata(project: string): SettingsCacheMetadata {
    this.settingsInstance ??= randomUUID()
    return {
      policy: 1,
      host: this.settingsInstance,
      project: createHash('sha256').update(project).digest('hex'),
      revisions: Object.fromEntries(
        CLI_IDS.map((cli) => [
          cli,
          `${this.settingsSourceRevisions?.get(cli) ?? 0}:${this.options.cliExecutablePaths?.revision(cli) ?? 0}`,
        ]),
      ) as Record<CliId, string>,
      catalogReady: Object.fromEntries(
        CLI_IDS.map((cli) => [cli, !!this.settingsCatalogs?.displayBinding(project, cli)]),
      ) as Record<CliId, boolean>,
      preferences: Object.fromEntries(
        CLI_IDS.flatMap((cli) => {
          const preference = this.runtime.storage.preference(project, cli)
          return preference ? [[cli, preference]] : []
        }),
      ),
    }
  }
  private invalidateSettingsDisplay(cli: CliId) {
    this.settingsCatalogs?.invalidate(cli)
    const revisions = (this.settingsSourceRevisions ??= new Map())
    revisions.set(cli, (revisions.get(cli) ?? 0) + 1)
  }
  /** @param parentSessionId - Active parent. @param cli - Explicit CLI. @param signal - Read lifetime. @returns Project/CLI running-message preference and native capability. */
  @Remote('runningMessageSettings')
  async runningMessageSettings(parentSessionId: string, cli: string, signal: AbortSignal): Promise<string> {
    try {
      const agent = await this.parent(parentSessionId)
      signal.throwIfAborted()
      return JSON.stringify(
        this.runtime.storage.runningMessageSettings(this.project(agent), validate.enum(CLI_IDS).parse(cli)),
      )
    } catch (error) {
      throw failure(error)
    }
  }
  /** @param parentSessionId - Active parent. @param cli - Explicit CLI. @param mode - Running submission preference. @param signal - Save lifetime. @returns Saved preference; never starts a CLI. */
  @Remote('saveRunningMessageMode')
  async saveRunningMessageMode(
    parentSessionId: string,
    cli: string,
    mode: string,
    signal: AbortSignal,
  ): Promise<string> {
    try {
      const agent = await this.parent(parentSessionId)
      signal.throwIfAborted()
      const result = this.runtime.storage.setRunningMessageMode(
        this.project(agent),
        validate.enum(CLI_IDS).parse(cli),
        validate.enum(RUNNING_MESSAGE_MODES).parse(mode),
      )
      this.runtime.changed()
      return JSON.stringify(result)
    } catch (error) {
      throw failure(error)
    }
  }
  /** @param parentSessionId - Active parent. @param signal - Query lifetime. @returns JSON role preset library. */
  @Remote('rolePresets')
  async rolePresets(parentSessionId: string, signal: AbortSignal): Promise<string> {
    try {
      await this.parent(parentSessionId)
      signal.throwIfAborted()
      return JSON.stringify(this.runtime.storage.rolePresets())
    } catch (error) {
      throw failure(error)
    }
  }
  /** @param parentSessionId - Active parent. @param requestJSON - Preset fields, optional existing id. @param signal - Mutation lifetime. @returns Saved preset JSON. */
  @Remote('saveRolePreset')
  async saveRolePreset(parentSessionId: string, requestJSON: string, signal: AbortSignal): Promise<string> {
    try {
      await this.parent(parentSessionId)
      signal.throwIfAborted()
      const preset = this.runtime.storage.saveRolePreset(JSON.parse(requestJSON))
      this.runtime.changed()
      return JSON.stringify(preset)
    } catch (error) {
      throw failure(error)
    }
  }
  /** @param parentSessionId - Active parent. @param presetId - Preset to delete. @param signal - Mutation lifetime. @returns Completion. */
  @Remote('deleteRolePreset')
  async deleteRolePreset(parentSessionId: string, presetId: string, signal: AbortSignal): Promise<void> {
    try {
      await this.parent(parentSessionId)
      signal.throwIfAborted()
      this.runtime.storage.deleteRolePreset(presetId)
      this.runtime.changed()
    } catch (error) {
      throw failure(error)
    }
  }
  /** @param parentSessionId - Owning parent. @param signal - Query lifetime. @returns Session roster JSON. */
  @Remote('roster')
  async roster(parentSessionId: string, signal: AbortSignal): Promise<string> {
    try {
      await this.parent(parentSessionId)
      signal.throwIfAborted()
      return JSON.stringify(this.runtime.storage.roster(parentSessionId))
    } catch (error) {
      throw failure(error)
    }
  }
  /** @param parentSessionId - Owning parent. @param requestJSON - Roster fields, optional existing id. @param signal - Mutation lifetime. @returns Saved entry JSON. */
  @Remote('saveRosterEntry')
  async saveRosterEntry(
    parentSessionId: string,
    requestJSON: string,
    signal: AbortSignal,
  ): Promise<string> {
    try {
      const agent = await this.parent(parentSessionId)
      signal.throwIfAborted()
      const saved = this.runtime.storage.saveRosterEntry(
        parentSessionId,
        this.project(agent),
        JSON.parse(requestJSON),
      )
      this.runtime.changed()
      return JSON.stringify(saved)
    } catch (error) {
      throw failure(error)
    }
  }
  /** @param parentSessionId - Owning parent. @param entryId - Roster entry to remove. @param signal - Mutation lifetime. @returns Completion; the entry’s Worker is untouched. */
  @Remote('deleteRosterEntry')
  async deleteRosterEntry(
    parentSessionId: string,
    entryId: string,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      await this.parent(parentSessionId)
      signal.throwIfAborted()
      this.runtime.storage.deleteRosterEntry(parentSessionId, entryId)
      this.runtime.changed()
    } catch (error) {
      throw failure(error)
    }
  }
  /** @param parentSessionId - Owning parent. @param cli - Selected CLI. @param signal - Query lifetime. @returns Last probed catalog and saved preference; never probes the CLI. */
  @Remote('rosterCatalog')
  async rosterCatalog(parentSessionId: string, cli: string, signal: AbortSignal): Promise<string> {
    try {
      const id = validate.enum(CLI_IDS).parse(cli)
      const agent = await this.parent(parentSessionId)
      const project = this.project(agent)
      signal.throwIfAborted()
      this.runtime.assertCliEnabled(id)
      this.settingsCatalogs ??= new SettingsCatalogCache(this.runtime.storage.directory)
      const preference = this.runtime.storage.preference(project, id)
      const saved = this.settingsCatalogs.saved(project, id)
      if (!saved) return JSON.stringify({ cli: id, missing: true, preference })
      return JSON.stringify({
        cli: id,
        catalog: saved.catalog,
        // The account identity last probed; a mismatch only means "stale display".
        current: this.settingsCatalogs.displayBinding(project, id) === saved.binding,
        preference,
      })
    } catch (error) {
      throw failure(error)
    }
  }
  /** @param parentSessionId - Owning parent. @param workerId - Worker identity. @param name - Unique readable name. @param signal - Mutation lifetime. @returns Completion. */
  @Remote('renameWorker')
  async renameWorker(
    parentSessionId: string,
    workerId: string,
    name: string,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      await this.parent(parentSessionId)
      signal.throwIfAborted()
      this.runtime.renameWorker(parentSessionId, workerId, name)
    } catch (error) {
      throw failure(error)
    }
  }
  /** @param parentSessionId - Owning parent. @param workerId - Worker identity. @param title - Single-line chat title, at most 160 characters. @param signal - Mutation lifetime. @returns Completion. */
  @Remote('renameWorkerTitle')
  async renameWorkerTitle(
    parentSessionId: string,
    workerId: string,
    title: string,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      await this.parent(parentSessionId)
      signal.throwIfAborted()
      this.runtime.renameWorkerTitle(parentSessionId, workerId, title)
    } catch (error) {
      throw failure(error)
    }
  }
  /** @param parentSessionId - Owning parent. @param workerId - Worker identity. @param objective - Persistent objective. @param expectedRevision - Current goal revision, or zero when absent. @param signal - Mutation lifetime. @returns WorkerGoal JSON. */
  @Remote('setWorkerGoal')
  async setWorkerGoal(parentSessionId: string, workerId: string, objective: string, expectedRevision: number, signal: AbortSignal): Promise<string> {
    try {
      await this.parent(parentSessionId)
      signal.throwIfAborted()
      return JSON.stringify(this.runtime.setWorkerGoal(parentSessionId, workerId, objective, expectedRevision))
    } catch (error) {
      throw failure(error)
    }
  }
  /** @param parentSessionId - Owning parent. @param workerId - Worker identity. @param status - Active or paused. @param expectedRevision - Current goal revision. @param signal - Mutation lifetime. @returns WorkerGoal JSON. */
  @Remote('setWorkerGoalStatus')
  async setWorkerGoalStatus(parentSessionId: string, workerId: string, status: 'active' | 'paused', expectedRevision: number, signal: AbortSignal): Promise<string> {
    try {
      await this.parent(parentSessionId)
      signal.throwIfAborted()
      return JSON.stringify(this.runtime.setWorkerGoalStatus(parentSessionId, workerId, status, expectedRevision))
    } catch (error) {
      throw failure(error)
    }
  }
  /** @param parentSessionId - Owning parent. @param workerId - Worker identity. @param expectedRevision - Current goal revision. @param signal - Mutation lifetime. @returns Completion. */
  @Remote('clearWorkerGoal')
  async clearWorkerGoal(parentSessionId: string, workerId: string, expectedRevision: number, signal: AbortSignal): Promise<void> {
    try {
      await this.parent(parentSessionId)
      signal.throwIfAborted()
      this.runtime.clearWorkerGoal(parentSessionId, workerId, expectedRevision)
    } catch (error) {
      throw failure(error)
    }
  }
  /** @param parentSessionId - Owning parent. @param workerId - Idle Worker to hide. @param signal - Mutation lifetime. @returns Completion without deleting native data. */
  @Remote('deleteWorker')
  async deleteWorker(parentSessionId: string, workerId: string, signal: AbortSignal): Promise<void> {
    try {
      await this.parent(parentSessionId)
      signal.throwIfAborted()
      await this.releaseDeletedHarnessSession(parentSessionId, workerId)
      signal.throwIfAborted()
      this.runtime.deleteWorker(parentSessionId, workerId)
    } catch (error) {
      throw failure(error)
    }
  }
  /**
   * Local patch: a deleted Worker must stop counting as a DSH subagent. Release its
   * display child session first; a failed release never blocks the deletion itself.
   */
  private async releaseDeletedHarnessSession(parentSessionId: string, workerId: string): Promise<void> {
    const bridge = this.harnessConversation
    if (!bridge) return
    const worker = this.runtime.storage.workers.get(workerId)
    if (!worker || worker.parentSessionId !== parentSessionId || !worker.harnessConversation) return
    try {
      const outcome = await bridge.release(worker)
      if (outcome !== 'released') return
      delete worker.harnessConversation
      this.runtime.storage.save(worker)
    } catch (error) {
      this.ctx.logger?.warn?.(`释放 CLI 子会话失败：${String(error)}`)
    }
  }
  /**
   * Local patch: Workers deleted before this rule existed still hold a child session.
   * Release them once after the bridge is ready so the session stops listing them.
   */
  private releaseArchivedHarnessSessions(): void {
    const bridge = this.harnessConversation
    if (!bridge) return
    void (async () => {
      for (const worker of [...this.runtime.storage.workers.values()]) {
        if (!worker.archivedAt || !worker.harnessConversation) continue
        try {
          const outcome = await bridge.release(worker)
          if (outcome !== 'released') continue
          delete worker.harnessConversation
          this.runtime.storage.save(worker)
        } catch {
          /* 单个历史会话释放失败不影响其他记录。 */
        }
      }
    })()
  }
  /** @param parentSessionId - Owning parent. @param workerId - Deleted Worker identity. @param signal - Mutation lifetime. @returns Completion with the original ID and history. */
  @Remote('restoreWorker')
  async restoreWorker(parentSessionId: string, workerId: string, signal: AbortSignal): Promise<void> {
    try {
      await this.parent(parentSessionId)
      signal.throwIfAborted()
      this.runtime.restoreWorker(parentSessionId, workerId)
    } catch (error) {
      throw failure(error)
    }
  }
  /** @param parentSessionId - Owning parent. @param workerId - Idle source Worker. @param atMessageId - Completed assistant message, or empty for latest. @param signal - Fork lifetime. @returns Worker and child session identities as JSON. */
  @Remote('forkWorker')
  async forkWorker(parentSessionId: string, workerId: string, atMessageId: string, signal: AbortSignal): Promise<string> {
    try {
      const parent = await this.parent(parentSessionId)
      signal.throwIfAborted()
      if (!this.harnessConversation) throw new Error('Harness CLI 会话桥未就绪')
      return JSON.stringify(await this.runtime.forkWorker(parent, workerId, atMessageId, this.harnessConversation, signal))
    } catch (error) { throw failure(error) }
  }
  /** @param parentSessionId - Owning session. @param cli - Selected CLI. @param enabled - Allow new CLI operations. @param signal - Mutation admission lifetime. @returns Updated profile-wide CLI enablement JSON. */
  @Remote('setCliEnabled')
  async setCliEnabled(
    parentSessionId: string,
    cli: string,
    enabled: boolean,
    signal: AbortSignal,
  ): Promise<string> {
    try {
      await this.parent(parentSessionId)
      signal.throwIfAborted()
      const id = validate.enum(CLI_IDS).parse(cli)
      const next = validate.boolean().parse(enabled)
      // The check, persistence, and account startup reservation are synchronous;
      // a pending managed terminal cannot be disabled during its async startup.
      if (!next && this.accounts.isBusy(id))
        throw new Error('此 CLI 正在管理账号，请先关闭账号终端再关闭 CLI')
      signal.throwIfAborted()
      const settings = this.runtime.setCliEnabled(id, next)
      this.invalidateSettingsDisplay(id)
      return JSON.stringify(settings)
    } catch (error) {
      throw failure(error)
    }
  }
  /** @param parentSessionId - Owning session. @param cli - Selected CLI. @param signal - Query lifetime. @returns Safe account status JSON. */
  @Remote('accountStatus')
  async accountStatus(parentSessionId: string, cli: string, signal: AbortSignal): Promise<string> {
    let queriedCli: CliId | undefined
    try {
      const id = validate.enum(CLI_IDS).parse(cli)
      queriedCli = id
      const project = this.project(await this.parent(parentSessionId))
      signal.throwIfAborted()
      this.runtime.assertCliEnabled(id)
      const status = await this.accounts.status(id, project, signal)
      signal.throwIfAborted()
      this.runtime.assertCliEnabled(id)
      return JSON.stringify(status)
    } catch (error) {
      if (queriedCli && error instanceof ProcessCleanupUnconfirmedError)
        this.runtime.blockCatalogOnCleanup(queriedCli, error)
      throw failure(error)
    }
  }

  private executablePathSnapshot(cli: CliId): CliExecutablePathStatus {
    const saved = this.options.cliExecutablePaths?.read(cli)
    const configured = configuredCliExecutable(cli, this.options)
    const manual = saved?.mode === 'manual'
    return {
      cli,
      path: manual ? saved.path : (configured ?? saved?.path ?? ''),
      source: manual ? 'manual' : configured ? 'configured' : saved ? 'auto' : 'none',
      available: false,
    }
  }
  private async probeExecutablePath(cli: CliId, signal: AbortSignal): Promise<CliExecutablePathStatus> {
    try {
      const path = await resolveCliExecutable(cli, this.backend, this.options, signal)
      signal.throwIfAborted()
      const current = this.executablePathSnapshot(cli)
      return { ...current, path: current.source === 'manual' ? current.path : path, available: true }
    } catch (error) {
      if (error instanceof ProcessCleanupUnconfirmedError) {
        this.runtime.blockCatalogOnCleanup(cli, error)
        throw error
      }
      signal.throwIfAborted()
      return {
        ...this.executablePathSnapshot(cli),
        error:
          error instanceof WindowsCliInstallationError
            ? error.message
            : 'CLI 路径不可用，请确认填写的是 CLI 文件的完整路径，再刷新重试',
      }
    }
  }
  /** @param parentSessionId - Owning session. @param cli - Selected CLI. @param signal - Query lifetime. @returns Machine-local executable path and availability JSON. */
  @Remote('cliExecutablePath')
  async cliExecutablePath(parentSessionId: string, cli: string, signal: AbortSignal): Promise<string> {
    try {
      await this.parent(parentSessionId)
      const id = validate.enum(CLI_IDS).parse(cli)
      const control = AbortSignal.any([signal, this.disposed.signal])
      control.throwIfAborted()
      // While a CLI is in use, expose its saved selection without probing or
      // replacing an installation under an active task/account terminal.
      try {
        this.runtime.assertAccountIdle(id)
        if (this.accounts.isBusy(id)) throw new Error('请先关闭此 CLI 的账号终端再刷新路径')
      } catch (error) {
        return JSON.stringify({ ...this.executablePathSnapshot(id), error: String(error) })
      }
      return JSON.stringify(await this.probeExecutablePath(id, control))
    } catch (error) {
      throw failure(error)
    }
  }
  /** @param parentSessionId - Owning session. @param cli - Selected CLI. @param path - Full file path for manual selection. @param action - manual, refresh or auto. @param signal - Mutation/query lifetime. @returns Saved machine-local path and fresh availability JSON. */
  @Remote('refreshCliExecutablePath')
  async refreshCliExecutablePath(
    parentSessionId: string,
    cli: string,
    path: string,
    action: string,
    signal: AbortSignal,
  ): Promise<string> {
    try {
      await this.parent(parentSessionId)
      const id = validate.enum(CLI_IDS).parse(cli)
      const operation = validate.enum(['manual', 'refresh', 'auto']).parse(action)
      const control = AbortSignal.any([signal, this.disposed.signal])
      control.throwIfAborted()
      this.runtime.assertAccountIdle(id)
      if (this.accounts.isBusy(id)) throw new Error('请先关闭此 CLI 的账号终端再修改路径')
      const store = this.options.cliExecutablePaths
      if (!store) throw new Error('CLI 路径存储尚未就绪')
      if (operation === 'manual') store.setManual(id, path)
      else if (operation === 'auto') store.reset(id)
      this.displayedBindings?.clear()
      this.invalidateSettingsDisplay(id)
      this.runtime.changed()
      return JSON.stringify(await this.probeExecutablePath(id, control))
    } catch (error) {
      throw failure(error)
    }
  }
  /** @param parentSessionId - Owning session. @param cli - Selected CLI. @param action - Explicit human action. @param signal - Startup lifetime. @returns Managed account terminal identity and instruction JSON. */
  @Remote('accountStart')
  async accountStart(
    parentSessionId: string,
    cli: string,
    action: string,
    signal: AbortSignal,
  ): Promise<string> {
    return this.startAccount(parentSessionId, cli, action, signal)
  }

  /** @param source - One current CLI-native source, never a filesystem path. */
  @Remote('accountStartForSource')
  async accountStartForSource(
    parentSessionId: string,
    cli: string,
    action: string,
    source: string,
    signal: AbortSignal,
  ): Promise<string> {
    try {
      const selected = validate.enum(['native', 'plugin']).parse(source)
      return this.startAccount(parentSessionId, cli, action, signal, selected)
    } catch (error) {
      throw failure(error)
    }
  }

  /** @param provider - Explicit ZCode native login provider, never a URL or logout source. */
  @Remote('accountStartForProvider')
  async accountStartForProvider(
    parentSessionId: string,
    cli: string,
    action: string,
    provider: string,
    signal: AbortSignal,
  ): Promise<string> {
    try {
      const selected = validate.enum(['bigmodel', 'zai']).parse(provider)
      if (cli !== 'zcode' || action !== 'login') throw new Error('不支持的 ZCode 授权来源')
      return this.startAccount(parentSessionId, cli, action, signal, undefined, selected)
    } catch (error) {
      throw failure(error)
    }
  }

  private async startAccount(
    parentSessionId: string,
    cli: string,
    action: string,
    signal: AbortSignal,
    source?: 'native' | 'plugin',
    provider?: 'bigmodel' | 'zai',
  ): Promise<string> {
    try {
      const id = validate.enum(CLI_IDS).parse(cli)
      const operation = validate.enum(['login', 'logout', 'manage']).parse(action)
      const parent = await this.parent(parentSessionId)
      this.assertExecution(parent)
      this.runtime.assertCliEnabled(id)
      this.runtime.assertAccountIdle(id)
      if (!this.accountParents.has(parent.id)) {
        const dispose = parent.ctx.effect(
          () => () => {
            this.accountParents.delete(parent.id)
            return this.accounts.closeParent(parent.id)
          },
          'cliworker:account-parent',
        )
        this.accountParents.set(parent.id, dispose)
      }
      this.invalidateSettingsDisplay(id)
      return JSON.stringify(
        await this.accounts.start(parent.id, id, operation, this.project(parent), signal, source, provider),
      )
    } catch (error) {
      throw failure(error)
    }
  }
  /** @param parentSessionId - Owning session. @param accountId - Account terminal identity. @param signal - Stream lifetime. @returns Ephemeral terminal frame JSON. */
  @Remote({ mode: 'stream' })
  async *accountWatch(
    parentSessionId: string,
    accountId: string,
    signal: AbortSignal,
  ): AsyncIterable<string> {
    try {
      await this.parent(parentSessionId)
      for await (const frame of this.accounts.watch(parentSessionId, accountId, signal))
        yield JSON.stringify(frame)
    } catch (error) {
      throw failure(error)
    }
  }
  /** @param parentSessionId - Owning session. @param accountId - Account terminal identity. @param data - Human keyboard input. @returns Input accepted. */
  @Remote('accountWrite')
  async accountWrite(parentSessionId: string, accountId: string, data: string): Promise<boolean> {
    try {
      this.assertExecution(await this.parent(parentSessionId))
      await this.accounts.write(parentSessionId, accountId, data)
      return true
    } catch (error) {
      throw failure(error)
    }
  }
  /** @param parentSessionId - Owning session. @param accountId - Account terminal identity. @param cols - Visible columns. @param rows - Visible rows. @returns Resize accepted. */
  @Remote('accountResize')
  async accountResize(
    parentSessionId: string,
    accountId: string,
    cols: number,
    rows: number,
  ): Promise<boolean> {
    try {
      await this.parent(parentSessionId)
      await this.accounts.resize(parentSessionId, accountId, cols, rows)
      return true
    } catch (error) {
      throw failure(error)
    }
  }
  /** @param parentSessionId - Owning session. @param accountId - Account terminal identity. @returns Process cleanup completed. */
  @Remote('accountStop')
  async accountStop(parentSessionId: string, accountId: string): Promise<boolean> {
    try {
      await this.accounts.stop(parentSessionId, accountId)
      return true
    } catch (error) {
      throw failure(error)
    }
  }
  /** @param parentSessionId - Parent session identity. @param signal - Caller lifetime. @returns JSON model catalog and project preference. */
  @Remote('catalog')
  async catalog(parentSessionId: string, signal: AbortSignal): Promise<string> {
    return this.catalogForCli(parentSessionId, 'antigravity', signal)
  }
  /** @param parentSessionId - Parent session identity. @param cli - Selected CLI. @param signal - Caller lifetime. @returns CLI catalog and saved project preference. */
  @Remote('catalogForCli')
  async catalogForCli(parentSessionId: string, cli: string, signal: AbortSignal): Promise<string> {
    return this.settingsCatalog(parentSessionId, cli, signal, false)
  }
  /** @param parentSessionId - Owning parent. @param workerId - Worker whose original account scopes the saved choices. @param signal - Caller lifetime. @returns Saved model choices; only a missing valid directory requires discovery. */
  @Remote('catalogForWorker')
  async catalogForWorker(parentSessionId: string, workerId: string, signal: AbortSignal): Promise<string> {
    let queriedCli: CliId | undefined
    try {
      const agent = await this.parent(parentSessionId)
      const control = AbortSignal.any([signal, this.disposed.signal])
      control.throwIfAborted()
      const worker = this.runtime.get(agent.id, workerId)
      const cli = cliOf(worker.preference)
      queriedCli = cli
      const expected = this.runtime.storage.accountBinding(workerId)
      if (!expected) throw new Error(LEGACY_ACCOUNT_RECORD_NOTICE)
      this.runtime.assertCliEnabled(cli)
      this.settingsCatalogs ??= new SettingsCatalogCache(this.runtime.storage.directory)
      let catalog = this.settingsCatalogs.display(worker.project, cli, expected)
      if (!catalog) {
        const result = await this.settingsCatalogs.get({
          cli,
          project: worker.project,
          signal: control,
          selfVerifiedDiscovery: cli === 'qoder' || cli === 'qodercn',
          binding: async () => {
            const current = await readCliAccountBinding(
              cli,
              this.backend,
              this.options,
              worker.project,
              control,
            )
            if (current !== expected) throw new Error(ACCOUNT_CHANGED)
            return current
          },
          discover: () =>
            this.queryCatalog(cli, this.backend, this.options, worker.project, control, expected),
        })
        catalog = result.catalog
      }
      control.throwIfAborted()
      this.runtime.assertCliEnabled(cli)
      return JSON.stringify(catalog)
    } catch (error) {
      if (queriedCli && error instanceof ProcessCleanupUnconfirmedError)
        this.runtime.blockCatalogOnCleanup(queriedCli, error)
      throw failure(error)
    }
  }
  /** @param parentSessionId - Parent session identity. @param cli - Selected CLI. @param signal - Caller lifetime. @returns Fresh model catalog and saved project preference. */
  @Remote('refreshCatalogForCli')
  async refreshCatalogForCli(parentSessionId: string, cli: string, signal: AbortSignal): Promise<string> {
    return this.settingsCatalog(parentSessionId, cli, signal, true)
  }
  private async settingsCatalog(
    parentSessionId: string,
    cli: string,
    signal: AbortSignal,
    refresh: boolean,
  ): Promise<string> {
    let queriedCli: CliId | undefined
    try {
      const id = validate.enum(CLI_IDS).parse(cli)
      queriedCli = id
      const project = this.project(await this.parent(parentSessionId))
      const control = AbortSignal.any([signal, this.disposed.signal])
      this.runtime.assertCliEnabled(id)
      this.settingsCatalogs ??= new SettingsCatalogCache(this.runtime.storage.directory)
      const { catalog, binding } = await this.settingsCatalogs.get({
        cli: id,
        project,
        signal: control,
        refresh,
        selfVerifiedDiscovery: id === 'qoder' || id === 'qodercn',
        binding: () => readCliAccountBinding(id, this.backend, this.options, project, control),
        discover: () => this.queryCatalog(id, this.backend, this.options, project, control),
      })
      control.throwIfAborted()
      ;(this.displayedBindings ??= new Map()).set(JSON.stringify([parentSessionId, id]), binding)
      this.runtime.assertCliEnabled(id)
      return JSON.stringify({ ...catalog, preference: this.runtime.storage.preference(project, id) })
    } catch (error) {
      if (queriedCli && error instanceof ProcessCleanupUnconfirmedError)
        this.runtime.blockCatalogOnCleanup(queriedCli, error)
      throw failure(error)
    }
  }
  /** @param parentSessionId - Parent session identity. @param selection - JSON model and effort. @param signal - Caller lifetime. @returns Saved JSON preference. */
  @Remote('configure')
  async configure(parentSessionId: string, selection: string, signal: AbortSignal): Promise<string> {
    try {
      const agent = await this.parent(parentSessionId)
      let preference: Preference = preferenceSchema.parse(JSON.parse(selection))
      const project = this.project(agent)
      this.runtime.assertCliEnabled(cliOf(preference))
      const { catalog } = await this.querySelection(
        preference,
        this.backend,
        this.options,
        project,
        signal,
        this.displayedBindings?.get(JSON.stringify([parentSessionId, cliOf(preference)])),
      )
      validatePreference(preference, catalog)
      preference = resolveModel(preference, catalog.models)
      signal.throwIfAborted()
      this.runtime.assertCliEnabled(cliOf(preference))
      this.runtime.storage.setPreference(project, preference)
      this.runtime.changed()
      return JSON.stringify(preference)
    } catch (error) {
      throw failure(error)
    }
  }
  /** @param parentSessionId - Owning session. @param workerId - Idle worker. @param selection - JSON preference from saved choices. @param signal - Caller lifetime. @returns Saved preference; execution performs live authorization. */
  @Remote('configureWorker')
  async configureWorker(
    parentSessionId: string,
    workerId: string,
    selection: string,
    signal: AbortSignal,
  ): Promise<string> {
    try {
      const agent = await this.parent(parentSessionId)
      const worker = this.runtime.get(agent.id, workerId)
      const preference = preferenceSchema.parse(JSON.parse(selection))
      if (cliOf(preference) !== cliOf(worker.preference)) throw new Error('已有会话不能切换 CLI')
      const expected = this.runtime.storage.accountBinding(workerId)
      if (!expected) throw new Error(LEGACY_ACCOUNT_RECORD_NOTICE)
      this.runtime.assertCliEnabled(cliOf(preference))
      this.settingsCatalogs ??= new SettingsCatalogCache(this.runtime.storage.directory)
      const catalog = this.settingsCatalogs.display(worker.project, cliOf(preference), expected)
      if (!catalog) throw new Error('模型目录已失效，请重试读取或在设置中刷新')
      validatePreference(preference, catalog)
      signal.throwIfAborted()
      this.runtime.assertCliEnabled(cliOf(preference))
      this.assertNativeWorkerSettingsIdle(worker)
      return JSON.stringify(
        this.runtime.configureWorker(agent.id, workerId, resolveModel(preference, catalog.models)),
      )
    } catch (error) {
      throw failure(error)
    }
  }
  private assertNativeWorkerSettingsIdle(worker: Worker): void {
    const id = worker.harnessConversation?.sessionId
    if (!id) return
    const child = this.ctx.agents.get(id as Agent['id'])
    if (child && (child.status !== 'idle' || child.inbox.nextTurn.length || child.inbox.nextStep.length))
      throw new Error('请等待原生对话结束，并发送或移除原生待发消息后再修改设置')
  }
  /** Update a cold child's real Session without activating an Agent or delivering input. */
  private async configureColdWorkerPermission(
    parent: Agent,
    worker: Worker,
    selected: TaskMode,
    signal: AbortSignal,
  ): Promise<Worker> {
    const sessionId = SessionId(worker.harnessConversation!.sessionId)
    return this.runtime.prepareFollowup(
      parent.id,
      worker.id,
      AbortSignal.any([signal, this.disposed.signal]),
      async (control, preparationId) => {
        const persistence = this.ctx.get('sessionPersistence')
        const sessions = this.ctx.get('sessions')
        const query = this.ctx.get('sessionQuery')
        const projections = this.ctx.get('sessionProjections')
        if (!persistence || !sessions || !query || !projections)
          throw new Error('原生历史会话服务尚未就绪，未修改权限')
        const validateCurrent = () => {
          control.throwIfAborted()
          if (this.ctx.agents.get(parent.id) !== parent)
            throw new Error('所属主对话已关闭，未修改权限')
          this.assertExecution(parent)
          const current = this.runtime.get(parent.id, worker.id)
          const record = this.harnessConversation?.lookup(sessionId)
          if (
            this.project(parent) !== current.project ||
            current.project !== worker.project ||
            current.harnessConversation?.sessionId !== sessionId ||
            current.harnessConversation.parentSessionId !== parent.id ||
            record?.sessionId !== sessionId ||
            record.workerId !== worker.id ||
            record.parentSessionId !== parent.id
          )
            throw new Error('CLI 子会话所属主对话不匹配，未修改权限')
          this.assertNativeWorkerSettingsIdle(current)
        }
        validateCurrent()
        // The public writer is the exclusive cold-session mutation lease. It
        // also prevents a concurrent native resume from using an older mode.
        const writer = await persistence.open(sessionId, 'write', { signal: control })
        let detach: (() => void) | undefined
        try {
          validateCurrent()
          const read = await writer.read(0, undefined, { signal: control })
          validateCurrent()
          if (
            writer.header.origin !== 'subagent' ||
            writer.header.parentSession !== parent.id ||
            writer.header.cwd !== worker.project ||
            this.ctx.agents.get(sessionId)
          )
            throw new Error('CLI 子会话所属主对话不匹配，未修改权限')
          const session = sessions.prepare(sessionId, {
            seed: read.events,
            meta: structuredClone(writer.header),
            inheritedEventCount: writer.inheritedEventCount,
            eventState: read.eventState,
          })
          const inbox = projections.stateOf(session, 'inbox')
          const turn = projections.stateOf(session, 'turnBoundary')
          const plan = projections.stateOf(session, 'plan')
          if (!inbox || !turn || !plan)
            throw new Error('原生历史会话投影尚未就绪，未修改权限')
          if (plan.running !== null)
            throw new Error('原生规划命令尚未完成，未修改权限')
          if (inbox['next-turn'].length || inbox['next-step'].length || turn.openTurnStartSeq !== null)
            throw new Error('请等待原生对话结束，并发送或移除原生待发消息后再修改设置')
          detach = sessions.enter(session)
          // Native restore may append a lifecycle marker before publication.
          // Read that suffix through the public query rather than private logs.
          const observation = await query.observeSession(sessionId, {
            signal: control,
            projectionMode: 'none',
          })
          try {
            const suffix = observation.events.slice(read.events.length)
            if (suffix.length) await writer.append(suffix, { signal: control })
          } finally { observation[Symbol.dispose]() }
          validateCurrent()
          sessions.announce(session)
          validateCurrent()
          const saved = this.runtime.configureWorkerPermission(parent.id, worker.id, selected, preparationId)
          const sandbox = selected === 'plan' ? 'read-only' :
            parent.ctx.get('sandboxPolicy')!.resolve({ session: parent.session }).mode
          if (parent.ctx.get('sandboxPolicy')!.resolve({ session }).mode !== sandbox)
            setSandboxMode(session, sandbox)
          // This is the native persisted collaboration event. There is no
          // Agent to queue a pending intent or inject a synthetic user message.
          if (plan.active !== (selected === 'plan') || plan.wanted !== null)
            session.append('plan/mode', { active: selected === 'plan' })
          if (!(await sessions.flush(session)))
            throw new Error('原生会话权限持久化服务不可用，请重新读取当前状态')
          return saved
        } finally {
          // Finish the writer even on cancellation/failure before releasing the
          // Session and the outer Worker preparation lease.
          try { await writer.close() } finally { detach?.() }
        }
      },
    )
  }
  /** @param parentSessionId - Owning parent. @param workerId - Exact Worker. @param signal - Read lifetime. @returns Native permission control data; no task or permission change. */
  @Remote('permissionForWorker')
  async permissionForWorker(parentSessionId: string, workerId: string, signal: AbortSignal): Promise<string> {
    try {
      const parent = await this.parent(parentSessionId)
      signal.throwIfAborted()
      const worker = this.runtime.get(parent.id, workerId)
      if (this.project(parent) !== worker.project) throw new Error('项目已变更，请在原项目继续')
      let reason: string | undefined
      try {
        this.assertExecution(parent)
        this.assertNativeWorkerSettingsIdle(worker)
        const snapshot = this.runtime.snapshot(parent.id, worker.id)
        if (snapshot.selectedBusy) throw new Error('请等待本轮结束后再修改权限')
        if (snapshot.queuedFollowups?.length)
          throw new Error('请先发送或取消待发送消息（包含已暂停消息），再修改权限')
      } catch (error) { reason = error instanceof Error ? error.message : String(error) }
      const state: WorkerPermissionState = {
        currentValue: worker.mode, options: workerPermissionOptions(worker), writable: !reason, ...(reason ? { reason } : {}),
      }
      return JSON.stringify(state)
    } catch (error) { throw failure(error) }
  }
  /** @param parentSessionId - Owning parent. @param workerId - Exact idle Worker. @param mode - An advertised native CLI mode. @param signal - Save lifetime. @returns Saved Worker; no task is launched. */
  @Remote('configureWorkerPermission')
  async configureWorkerPermission(parentSessionId: string, workerId: string, mode: string, signal: AbortSignal): Promise<string> {
    try {
      const parent = await this.parent(parentSessionId)
      signal.throwIfAborted()
      this.assertExecution(parent)
      const worker = this.runtime.get(parent.id, workerId)
      if (this.project(parent) !== worker.project) throw new Error('项目已变更，请在原项目继续')
      const selected = validate.enum(['plan', 'accept-edits']).parse(mode)
      if (!workerPermissionOptions(worker).some((option) => option.value === selected))
        throw new Error('当前 CLI 通路不支持此权限模式')
      this.assertNativeWorkerSettingsIdle(worker)
      const binding = worker.harnessConversation
      const child = binding && this.ctx.agents.get(binding.sessionId as Agent['id'])
      if (
        binding &&
        (binding.parentSessionId !== parent.id ||
          binding.sessionId === parent.id ||
          (child &&
            (child.session.header.origin !== 'subagent' ||
              child.session.header.parentSession !== parent.id ||
              !this.ctx.agents.isOwnedBy(child.id, parent))))
      )
        throw new Error('CLI 子会话所属主对话不匹配，未修改权限')
      if (binding && !child)
        return JSON.stringify(await this.configureColdWorkerPermission(parent, worker, selected, signal))
      const saved = this.runtime.configureWorkerPermission(parent.id, worker.id, selected)
      if (child) {
        // Keep the real session projection and tool policy aligned with the
        // saved CLI mode while idle; the next run rechecks the same parent policy.
        const sandbox =
          selected === 'plan'
            ? 'read-only'
            : parent.ctx.get('sandboxPolicy')!.resolve({ session: parent.session }).mode
        if (child.ctx.get('sandboxPolicy')!.resolve({ session: child.session }).mode !== sandbox)
          setSandboxMode(child.session, sandbox)
        child.ctx.get('planMode')?.set(child, selected === 'plan')
      }
      return JSON.stringify(saved)
    } catch (error) { throw failure(error) }
  }
  /** @param parentSessionId - Owning parent. @param workerId - Conversation identity. @param requestJSON - Immutable click identity, text, mode and destination. @param signal - Admission lifetime. @returns Exact message acceptance receipt, not native completion. */
  @Remote('submitMessage')
  async submitMessage(
    parentSessionId: string,
    workerId: string,
    requestJSON: string,
    signal: AbortSignal,
  ): Promise<string> {
    try {
      const request = messageSubmissionSchema.parse(JSON.parse(requestJSON))
      const key = `${parentSessionId}:${workerId}:${request.id}`
      const canonical = JSON.stringify(request)
      const submissions = (this.messageSubmissions ??= new Map())
      const prior = submissions.get(key)
      if (prior) {
        if (prior.request === canonical) return await prior.done
        const original = messageSubmissionSchema.parse(JSON.parse(prior.request))
        const promotion =
          original.mode === 'queue' &&
          original.intent === 'running' &&
          request.mode === 'interrupt' &&
          request.intent === 'running' &&
          request.prompt === original.prompt &&
          request.clientId === original.clientId &&
          request.sequence > original.sequence
        if (!promotion) throw new Error('重复提交标识对应的消息不同')
      }
      // Occupancy and the Stop boundary must exist before parent lookup or model preparation awaits.
      const reservation = this.runtime.reserveSubmission(parentSessionId, workerId, request.id)
      const control = AbortSignal.any([signal, this.disposed.signal, reservation.signal])
      const done = (async () => {
        const agent = await this.parent(parentSessionId)
        control.throwIfAborted()
        reservation.assertCurrent()
        this.assertExecution(agent)
        const worker = this.runtime.get(agent.id, workerId)
        if (this.project(agent) !== worker.project) throw new Error('项目已变更，请在原项目继续')
        if (this.accounts.isBusy(cliOf(worker.preference))) throw new Error('请先关闭账号终端')
        if (request.intent === 'direct') {
          const receipt = this.runtime.directMessageReceipt(agent.id, workerId, request.prompt, request.id)
          if (receipt) return JSON.stringify({ ...receipt, revision: this.runtime.revision })
          return await this.launch(
            agent,
            worker.title,
            request.prompt,
            worker.preference,
            worker.mode,
            workerId,
            undefined,
            control,
            undefined,
            undefined,
            undefined,
            request.id,
          )
        }
        if (request.mode === 'interrupt')
          return JSON.stringify(
            this.runtime.interruptMessage(
              agent.id,
              workerId,
              request.prompt,
              request.id,
              request.clientId,
              request.sequence,
              control,
            ),
          )
        const receipt = await this.runtime.sendRunningMessage(
          agent.id,
          workerId,
          request.prompt,
          request.expectedRunId,
          request.id,
          control,
          request.mode,
        )
        return JSON.stringify({ ...(receipt ?? { accepted: true }), revision: this.runtime.revision })
      })()
      const operation = { request: canonical, done }
      submissions.set(key, operation)
      try {
        return await done
      } finally {
        if (submissions.get(key) === operation) submissions.delete(key)
        reservation.release()
      }
    } catch (error) {
      throw failure(error)
    }
  }
  /** @param parentSessionId - Owning parent. @param workerId - Worker to continue after this turn. @param prompt - Unsent message. @param expectedRunId - Run observed by the caller. @param requestId - Stable UUID for retries of this message. @param signal - Admission lifetime. @returns Accepted outbox item JSON. */
  @Remote('queueFollowup')
  async queueFollowup(
    parentSessionId: string,
    workerId: string,
    prompt: string,
    expectedRunId: string,
    requestId: string,
    signal: AbortSignal,
  ): Promise<string> {
    try {
      const agent = await this.parent(parentSessionId)
      signal.throwIfAborted()
      this.assertExecution(agent)
      const worker = this.runtime.get(agent.id, workerId)
      if (this.project(agent) !== worker.project) throw new Error('项目已变更，请在原项目继续')
      return JSON.stringify(this.runtime.queueFollowup(agent.id, workerId, prompt, expectedRunId, requestId))
    } catch (error) {
      throw failure(error)
    }
  }
  /** @param parentSessionId - Owning parent. @param workerId - Current native Worker. @param prompt - Current-run input. @param expectedRunId - Exact target run. @param requestId - Stable steering identity. @param signal - Receipt lifetime. @returns Native acceptance; never creates or schedules a later turn. */
  @Remote('steerMessage')
  async steerMessage(
    parentSessionId: string,
    workerId: string,
    prompt: string,
    expectedRunId: string,
    requestId: string,
    signal: AbortSignal,
  ): Promise<string> {
    try {
      validate.uuid().parse(requestId)
      validate
        .string()
        .min(1)
        .max(100_000)
        .refine((text) => !!text.trim())
        .parse(prompt)
      const observed = this.runtime.get(parentSessionId, workerId)
      if (observed.runId !== expectedRunId) throw new Error('本轮状态已变化，请核对当前运行后发送引导')
      const control = AbortSignal.any([signal, this.disposed.signal])
      const agent = await this.parent(parentSessionId)
      control.throwIfAborted()
      this.assertExecution(agent)
      const worker = this.runtime.get(agent.id, workerId)
      if (this.project(agent) !== worker.project) throw new Error('项目已变更，请在原项目继续')
      if (this.accounts.isBusy(cliOf(worker.preference))) throw new Error('请先关闭账号终端')
      await this.runtime.steerMessage(agent.id, workerId, prompt, expectedRunId, requestId, control)
      return JSON.stringify({
        accepted: true,
        requestId,
        runId: expectedRunId,
        revision: this.runtime.revision,
      })
    } catch (error) {
      throw failure(error)
    }
  }
  /** @param parentSessionId - Owning parent. @param workerId - Active Worker. @param prompt - New message. @param expectedRunId - Observed run. @param requestId - Stable submission UUID. @param signal - Admission lifetime. @returns Accepted submission using the saved mode. */
  @Remote('sendRunningMessage')
  async sendRunningMessage(
    parentSessionId: string,
    workerId: string,
    prompt: string,
    expectedRunId: string,
    requestId: string,
    signal: AbortSignal,
  ): Promise<string> {
    try {
      const agent = await this.parent(parentSessionId)
      signal.throwIfAborted()
      this.assertExecution(agent)
      const worker = this.runtime.get(agent.id, workerId)
      if (this.project(agent) !== worker.project) throw new Error('项目已变更，请在原项目继续')
      if (this.accounts.isBusy(cliOf(worker.preference))) throw new Error('请先关闭账号终端')
      const receipt = await this.runtime.sendRunningMessage(
        agent.id,
        workerId,
        prompt,
        expectedRunId,
        requestId,
        signal,
      )
      return JSON.stringify(receipt ?? { accepted: true })
    } catch (error) {
      throw failure(error)
    }
  }
  /** @param parentSessionId - Owning parent. @param workerId - Current Worker. @param prompt - Message text. @param requestId - Stable message UUID, including a local queue item. @param clientId - Panel source UUID. @param sequence - Increasing click order for this source. @param signal - Admission transport lifetime. @returns JSON durable acceptance receipt; execution proceeds independently of this RPC. */
  @Remote('interruptMessage')
  async interruptMessage(
    parentSessionId: string,
    workerId: string,
    prompt: string,
    requestId: string,
    clientId: string,
    sequence: number,
    signal: AbortSignal,
  ): Promise<string> {
    try {
      const agent = await this.parent(parentSessionId)
      signal.throwIfAborted()
      this.assertExecution(agent)
      const worker = this.runtime.get(agent.id, workerId)
      if (this.project(agent) !== worker.project) throw new Error('项目已变更，请在原项目继续')
      if (this.accounts.isBusy(cliOf(worker.preference))) throw new Error('请先关闭账号终端')
      return JSON.stringify(
        this.runtime.interruptMessage(agent.id, workerId, prompt, requestId, clientId, sequence, signal),
      )
    } catch (error) {
      throw failure(error)
    }
  }
  /** @param parentSessionId - Owning parent. @param workerId - Worker with pending messages. @param queuedId - Explicit priority message. @param expectedRunId - Observed run. @param signal - Admission lifetime. @returns JSON priority request receipt with queuedId and snapshot revision; not confirmation of native delivery. */
  @Remote('interruptQueuedFollowup')
  async interruptQueuedFollowup(
    parentSessionId: string,
    workerId: string,
    queuedId: string,
    expectedRunId: string,
    signal: AbortSignal,
  ): Promise<string> {
    try {
      const agent = await this.parent(parentSessionId)
      signal.throwIfAborted()
      this.assertExecution(agent)
      const worker = this.runtime.get(agent.id, workerId)
      if (this.project(agent) !== worker.project) throw new Error('项目已变更，请在原项目继续')
      if (this.accounts.isBusy(cliOf(worker.preference))) throw new Error('请先关闭账号终端')
      await this.runtime.interruptQueuedFollowup(agent.id, workerId, queuedId, expectedRunId, signal)
      return JSON.stringify({ queuedId, revision: this.runtime.revision })
    } catch (error) {
      throw failure(error)
    }
  }
  /** @param parentSessionId - Owning parent. @param workerId - Owning Worker. @param queuedId - Unsent item identity. @param signal - Mutation lifetime. @returns Completion; already admitted messages cannot be cancelled here. */
  @Remote('cancelQueuedFollowup')
  async cancelQueuedFollowup(
    parentSessionId: string,
    workerId: string,
    queuedId: string,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      const agent = await this.parent(parentSessionId)
      signal.throwIfAborted()
      this.runtime.cancelQueuedFollowup(agent.id, workerId, queuedId)
    } catch (error) {
      throw failure(error)
    }
  }
  /** @param parentSessionId - Owning parent. @param workerId - Idle Worker with paused messages. @param expectedRunId - Current run identity. @param signal - Mutation lifetime. @returns Explicit queue reactivation; each turn rechecks native authorization. */
  @Remote('retryQueuedFollowups')
  async retryQueuedFollowups(
    parentSessionId: string,
    workerId: string,
    expectedRunId: string,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      const agent = await this.parent(parentSessionId)
      signal.throwIfAborted()
      this.assertExecution(agent)
      const worker = this.runtime.get(agent.id, workerId)
      if (this.project(agent) !== worker.project) throw new Error('项目已变更，请在原项目继续')
      this.runtime.retryQueuedFollowups(agent.id, workerId, expectedRunId)
    } catch (error) {
      throw failure(error)
    }
  }
  /** @param parentSessionId - Parent session identity. @param workerId - Worker to continue. @param prompt - New task. @param signal - Admission lifetime. @returns Published background receipt. */
  @Remote('followup')
  async followup(
    parentSessionId: string,
    workerId: string,
    prompt: string,
    signal: AbortSignal,
  ): Promise<string> {
    try {
      const agent = await this.parent(parentSessionId)
      signal.throwIfAborted()
      this.assertExecution(agent)
      const worker = this.runtime.get(agent.id, workerId)
      this.runtime.assertCliEnabled(cliOf(worker.preference))
      return this.launch(
        agent,
        worker.title,
        prompt,
        worker.preference,
        worker.mode,
        workerId,
        undefined,
        signal,
      )
    } catch (error) {
      throw failure(error)
    }
  }
  /** @param parentSessionId - Owning parent. @param workerId - Idle legacy history without an account binding. @param prompt - Explicit new-dialog task. @param signal - Admission lifetime. @returns JSON background receipt for a fresh Worker. */
  @Remote('restartWorker')
  async restartWorker(
    parentSessionId: string,
    workerId: string,
    prompt: string,
    signal: AbortSignal,
  ): Promise<string> {
    try {
      const agent = await this.parent(parentSessionId)
      signal.throwIfAborted()
      this.assertExecution(agent)
      const worker = this.runtime.assertLegacyRestart(agent.id, workerId)
      if (this.project(agent) !== worker.project) throw new Error('项目已变更，请在原项目新建对话')
      return await this.launch(
        agent,
        worker.title,
        prompt,
        { ...worker.preference },
        worker.mode,
        undefined,
        { role: worker.role ? structuredClone(worker.role) : undefined },
        signal,
        workerId,
      )
    } catch (error) {
      throw failure(error)
    }
  }
  /** @param parentSessionId - Owning Harness session. @param workerId - Worker to stop. @returns Final worker state after cleanup. */
  @Remote('stop')
  async stop(parentSessionId: string, workerId: string): Promise<string> {
    try {
      return JSON.stringify(await this.runtime.stop(parentSessionId, workerId))
    } catch (error) {
      throw failure(error)
    }
  }
}

export default CliWorkerService
