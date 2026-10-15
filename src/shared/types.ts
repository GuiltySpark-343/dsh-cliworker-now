import type { Telemetry, TokenUsage } from './telemetry.ts'
import type { RunningMessageMode } from './running-message.ts'
export const EFFORTS = [
  'default',
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
] as const
export const CLI_IDS = [
  'antigravity',
  'codex',
  'claude',
  'kimi',
  'mimo',
  'zcode',
  'grok',
  'omp',
  'pi',
  'hermes',
  'opencode',
] as const
export type ActiveCliId = (typeof CLI_IDS)[number]
/** Retired IDs remain readable in existing worker history, never selectable for execution. */
export type CliId = ActiveCliId | 'harness'
export const RETIRED_HARNESS_NOTICE =
  '外部 Harness CLI 入口已移除；历史记录仅供查看。请新建 Hermes Agent 任务。'
export const isRetiredCli = (cli: CliId): cli is 'harness' => cli === 'harness'
export const CLI_LABELS: Record<CliId, string> = {
  antigravity: 'Antigravity',
  codex: 'Codex',
  claude: 'Claude Code',
  kimi: 'Kimi',
  mimo: 'MiMo',
  zcode: 'ZCode',
  grok: 'Grok Build',
  omp: 'OMP',
  pi: 'Pi',
  hermes: 'Hermes Agent',
  harness: 'Harness（已移除）',
  opencode: 'OpenCode',
}
/** Short CLI stems used for automatic Worker names; protocol IDs remain unchanged. */
export const CLI_SHORT_NAMES: Record<CliId, string> = {
  antigravity: 'agy',
  codex: 'codex',
  claude: 'claude',
  kimi: 'kimi',
  mimo: 'mimo',
  zcode: 'zcode',
  grok: 'grok',
  omp: 'omp',
  pi: 'pi',
  hermes: 'hermes',
  harness: 'harness',
  opencode: 'opencode',
}
export const cliOf = (preference: Preference): CliId => preference.cli ?? 'antigravity'
export const effortLabel = (effort: string) =>
  effort === 'default' ? '默认' : effort.charAt(0).toUpperCase() + effort.slice(1)
export const LEGACY_ACCOUNT_RECORD_NOTICE = '此历史任务缺少账号记录，请新建任务'
export type Effort = (typeof EFFORTS)[number]
export type WorkerStatus =
  | 'queued'
  | 'running'
  | 'stopping'
  | 'completed'
  | 'failed'
  | 'interrupted'
  | 'uncertain'
export type TaskMode = 'plan' | 'accept-edits'
export interface Preference {
  /** Missing in v0.1.x data means Antigravity. */
  cli?: CliId
  model: string
  effort: Effort
}
export interface ModelChoice {
  id: string
  label: string
  /** Explicit native cost evidence only; missing/default zero prices are unknown. */
  cost?: 'free' | 'paid' | 'unknown'
  efforts?: Effort[]
  /** Exact CLI model IDs for the supported effort variants. */
  variants?: Partial<Record<Effort, string>>
}
/** User-editable role library. Prompts are user instructions, never executable HTML. */
export interface RolePreset {
  id: string
  name: string
  summary: string
  prompt: string
  builtin?: boolean
  source?: string
}
/** Frozen when a worker is created; library edits cannot change an existing conversation. */
export interface RoleSnapshot {
  presetId?: string
  name: string
  summary: string
  prompt: string
}
export interface Worker {
  id: string
  parentSessionId: string
  project: string
  title: string
  agentName?: string
  /** Provenance distinguishes automatic names from user-supplied lookalikes. */
  agentNameOrigin?: 'auto' | 'custom'
  /** Exact former automatic names reserved for compatible historical references. */
  nameAliases?: string[]
  /** Reversible deletion keeps the original Worker, native session and account binding. */
  archivedAt?: string
  role?: RoleSnapshot
  preference: Preference
  mode: TaskMode
  conversationId?: string
  status: WorkerStatus
  createdAt: string
  updatedAt: string
  runId: string
  jobId?: string
  error?: string
  /** User-requested stop confirmed after the owned process range exited. */
  interruptionReason?: 'user'
  observedModel?: string
  lastResult?: string
}
/** Exact legacy stop messages are compatible; other interrupted outcomes stay diagnostic. */
export const isUserInterrupted = (worker: Pick<Worker, 'status' | 'error' | 'interruptionReason'>) =>
  worker.status === 'interrupted' &&
  ((worker.interruptionReason === 'user' && !worker.error) ||
    ['Error: 用户已停止任务', '用户已取消排队任务'].includes(worker.error ?? ''))
/** Stable, non-mutating name for histories created before named workers. */
export const workerName = (worker: Worker): string => worker.agentName || `智能体-${worker.id.slice(0, 6)}`
export type DeliveryState =
  | 'pending'
  | 'admitted'
  | 'running'
  | 'superseded'
  | 'cancelled'
  | 'failed'
  | 'completed'
export interface WorkerEvent {
  seq: number
  runId: string
  time: string
  kind: 'user' | 'assistant' | 'reasoning' | 'tool' | 'status' | 'diagnostic' | 'result' | 'submission'
  text: string
  observedModel?: string
  step?: number
  state?: string
  detail?: string
  /** Exact persisted outbox item admitted into this run; admission is not native delivery. */
  queuedFollowupId?: string
  /** Submission intent is distinct from a native run. */
  deliveryState?: DeliveryState
  deliveryError?: string
  admittedRunId?: string
  submissionClientId?: string
  submissionSequence?: number
}
export interface TimelineItem {
  usage?: TokenUsage
  /** Duration reported for this individual response step; never added to session totals. */
  durationSeconds?: number
  /** Upstream AGY conversation total, distinct from the locally timed run. */
  sessionDurationSeconds?: number
  id: string
  kind: WorkerEvent['kind']
  text: string
  time: string
  state?: string
  detail?: string
  queuedFollowupId?: string
  deliveryState?: DeliveryState
  deliveryError?: string
  admittedRunId?: string
  /** Run ended without a final tool status; the observed CLI state stays intact. */
  runStatus?: WorkerStatus
  runStartedAt?: string
  runEndedAt?: string
  runOutcome?: WorkerStatus
}
export interface QueuedFollowup {
  id: string
  prompt: string
  createdAt: string
  state: 'pending' | 'sending' | 'paused'
  pauseReason?: string
}
export interface WorkerSnapshot {
  telemetry?: Telemetry
  workers: Worker[]
  archivedWorkers?: Worker[]
  selected?: Worker
  /** Safe selected-Worker admission information; never exposes account identities. */
  resumeBlockedReason?: string
  /** Accepted messages for the selected Worker; not delivered to the CLI yet. */
  queuedFollowups?: QueuedFollowup[]
  /** Current project/CLI preference for submissions during an active turn. */
  runningMessageMode?: RunningMessageMode
  timeline: TimelineItem[]
  revision: number
  truncated: boolean
}
/** A bounded, frozen reading page; indexes/count refer to the moment it was read. */
export interface HistoryPage {
  workerId: string
  items: TimelineItem[]
  start: number
  end: number
  total: number
  hasOlder: boolean
  hasNewer: boolean
}
export const active = (status: WorkerStatus) =>
  status === 'queued' || status === 'running' || status === 'stopping'

/** Fold repeated step updates without duplicating streamed text or the final response. */
export function foldEvents(
  events: readonly WorkerEvent[],
  endedRun?: { runId: string; status: WorkerStatus },
  cli?: CliId,
): TimelineItem[] {
  const rows: TimelineItem[] = []
  const steps = new Map<string, TimelineItem>()
  const submissions = new Map<string, TimelineItem>()
  const submissionIds = new Set(
    events.filter((event) => event.kind === 'submission').map((event) => event.queuedFollowupId),
  )
  const markEnded = (runId: string, status: WorkerStatus) => {
    for (const row of rows) {
      if (
        (row.kind === 'tool' || row.kind === 'reasoning') &&
        row.id.startsWith(runId + ':') &&
        ['ACTIVE', 'RUNNING', 'PENDING', 'QUEUED', 'IN_PROGRESS'].includes(row.state ?? '')
      )
        row.runStatus = status
    }
  }
  for (const event of events) {
    if (event.kind === 'submission' && event.queuedFollowupId) {
      const row = submissions.get(event.queuedFollowupId) ?? {
        id: `submission:${event.queuedFollowupId}`,
        kind: 'user' as const,
        text: event.text,
        time: event.time,
        queuedFollowupId: event.queuedFollowupId,
      }
      if (!submissions.has(event.queuedFollowupId)) rows.push(row)
      Object.assign(row, {
        deliveryState: event.deliveryState,
        deliveryError: event.deliveryError,
        admittedRunId: event.admittedRunId,
      })
      submissions.set(event.queuedFollowupId, row)
      continue
    }
    if (event.kind === 'user' && event.queuedFollowupId && submissionIds.has(event.queuedFollowupId)) continue
    if (event.kind === 'status') {
      const terminal = event.state ?? event.text
      if (
        terminal === 'completed' ||
        terminal === 'failed' ||
        terminal === 'interrupted' ||
        terminal === 'uncertain'
      )
        markEnded(event.runId, terminal)
    }
    if (event.kind === 'result') {
      // A failed aggregate is diagnostic evidence, not a replacement for
      // already observed text (including histories written by older versions).
      if (cli === 'antigravity' && event.state && event.state !== 'SUCCESS') {
        rows.push({
          id: `${event.runId}:event:${event.seq}`,
          kind: 'diagnostic',
          text: 'CLI 最终汇总',
          time: event.time,
          state: event.state,
          detail: event.detail ?? event.text,
        })
        continue
      }
      const lastAssistant = rows.findLast(
        (row) => row.kind === 'assistant' && row.id.startsWith(event.runId + ':'),
      )
      if (lastAssistant) {
        // agy may repeat all earlier response steps in its final response.
        // Strip only exact earlier prefixes, leaving interleaved tool rows intact.
        let finalText = event.text.trimStart()
        const earlier = rows.filter(
          (row) => row !== lastAssistant && row.kind === 'assistant' && row.id.startsWith(event.runId + ':'),
        )
        for (const row of earlier) {
          const prefix = row.text.trim()
          if (!prefix) continue
          if (finalText.startsWith(prefix)) finalText = finalText.slice(prefix.length).trimStart()
          else break
        }
        if (event.text) lastAssistant.text = finalText
        continue
      }
    }
    const key =
      event.step === undefined
        ? `${event.runId}:event:${event.seq}`
        : `${event.runId}:${event.kind}:${event.step}`
    const existing = steps.get(key)
    if (existing) {
      if (event.kind === 'assistant') existing.text += event.text
      else if (event.text) existing.text = event.text
      if (event.state) existing.state = event.state
      // Public reasoning carries a complete visible-text snapshot. An empty
      // snapshot can withdraw a block; never append or retain its older text.
      if (event.detail || (event.kind === 'reasoning' && event.detail !== undefined))
        existing.detail = event.detail
    } else {
      const row: TimelineItem = {
        id: key,
        kind: event.kind === 'result' ? 'assistant' : event.kind,
        text: event.text,
        time: event.time,
        state: event.state,
        detail: event.detail,
        queuedFollowupId: event.queuedFollowupId,
      }
      steps.set(key, row)
      rows.push(row)
    }
  }
  // Use full persisted events before pagination. Duration includes admission/queue time.
  const timing = new Map<string, { runStartedAt?: string; runEndedAt?: string; runOutcome?: WorkerStatus }>()
  for (const event of events) {
    const run = timing.get(event.runId) ?? {}
    if (event.kind === 'user' && !run.runStartedAt) run.runStartedAt = event.time
    if (
      event.kind === 'status' &&
      ['completed', 'failed', 'interrupted', 'uncertain'].includes(event.state ?? event.text)
    ) {
      run.runEndedAt = event.time
      run.runOutcome = (event.state ?? event.text) as WorkerStatus
    }
    timing.set(event.runId, run)
  }
  for (const row of rows) Object.assign(row, timing.get(row.admittedRunId ?? row.id.split(':')[0]!))
  if (endedRun) markEnded(endedRun.runId, endedRun.status)
  return rows
}
