import { ComposerTelemetry } from './telemetry.tsx'
import { HarnessLegacyHistory } from './harness-legacy-history.tsx'
import { ConversationTimeline } from './conversation-timeline.tsx'
import { displayModelName } from '../shared/model-presentation.ts'
import { operationMessage } from './operation-error.ts'
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  Button,
  Input,
  Tooltip,
  StateDot,
  IconChevronDownOutlineRegular,
  IconTrashOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { createComposerKeymap } from './composer-keymap.ts'
import {
  active,
  CLI_IDS,
  CLI_LABELS,
  isRetiredCli,
  isUserInterrupted,
  RETIRED_HARNESS_NOTICE,
  cliOf,
  workerName,
  type CliId,
  type WorkerStatus,
  type HistoryPage,
  type Worker,
} from '../shared/types.ts'
import { useWorkers, value, type API } from './workers.ts'
import { CopyText } from './copy-text.tsx'
import { BrandIcon, Glyph } from './icons.tsx'
import { WorkerModelMenu } from './worker-model-menu.tsx'
import { SettingsDialog } from './settings-dialog.tsx'
import { RosterList } from './roster.tsx'
import { RawLogDialog } from './raw-log.tsx'
import { RenameWorker } from './rename-worker.tsx'
import { WorkerCard, type WorkerManagementAction } from './worker-card.tsx'
import { RUNNING_MESSAGE_LABELS } from '../shared/running-message.ts'
import { useMessageSubmissions } from './message-submissions.ts'
import { FollowupQueuePresence } from './followup-queue-presence.tsx'
import { HarnessCapabilityNotes } from './harness-conversation.tsx'

const status: Record<WorkerStatus, string> = {
  queued: '排队中',
  running: '运行中',
  stopping: '正在停止',
  completed: '已完成',
  failed: '失败',
  uncertain: '结果待核实',
  interrupted: '已中断',
}
interface PanelProps {
  sessionId: string
  api: API
  openNativeSettings?: () => void
  renderHarnessConversation?: (worker: Worker) => ReactNode
  activeHarnessSessionId?: string
}
export function Panel(props: PanelProps) {
  // In-memory only: project content is never copied into browser localStorage.
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  return (
    <SessionPanel
      key={props.sessionId}
      {...props}
      drafts={drafts}
      editDraft={(id, text) => setDrafts((old) => ({ ...old, [id]: text }))}
      clearSubmitted={(id, submitted) =>
        setDrafts((old) => (old[id] === submitted ? { ...old, [id]: '' } : old))
      }
      restoreDraft={(id, text) => setDrafts((old) => (old[id] ? old : { ...old, [id]: text }))}
    />
  )
}
function SessionPanel({
  sessionId,
  api,
  openNativeSettings,
  renderHarnessConversation,
  activeHarnessSessionId,
  drafts,
  editDraft,
  clearSubmitted,
  restoreDraft,
}: PanelProps & {
  drafts: Record<string, string>
  editDraft: (id: string, text: string) => void
  clearSubmitted: (id: string, submitted: string) => void
  restoreDraft: (id: string, text: string) => void
}) {
  const [selected, select] = useState('')
  const [collapsed, setCollapsed] = useState<Partial<Record<CliId, boolean>>>({})
  const [collapsedFollowups, setCollapsedFollowups] = useState<Record<string, boolean>>({})
  const cliGroupId = useId()
  const followupQueueId = useId()
  const overview = useRef<HTMLDivElement>(null),
    overviewScroll = useRef(0)
  const back = useRef<HTMLButtonElement>(null),
    lastWorker = useRef('')
  useLayoutEffect(() => {
    if (selected) back.current?.focus()
    else if (overview.current) {
      overview.current.scrollTop = overviewScroll.current
      overview.current
        .querySelector<HTMLButtonElement>(`[data-open-worker-id='${lastWorker.current}']`)
        ?.focus({ preventScroll: true })
    }
  }, [selected])
  const openWorker = (id: string) => {
    lastWorker.current = id
    setSettings(false)
    select(id)
  }
  const [query, setQuery] = useState(''),
    [filter, setFilter] = useState('all')
  const [showArchived, setShowArchived] = useState(false)
  const [historyPage, setHistoryPage] = useState<HistoryPage>()
  const history = historyPage?.workerId === selected ? historyPage : undefined
  const { snapshot, error: streamError, connecting, reconnect } = useWorkers(api, sessionId, selected)
  const seenActiveSession = useRef<string>()
  useEffect(() => {
    if (!activeHarnessSessionId) { seenActiveSession.current = undefined; return }
    if (!renderHarnessConversation || seenActiveSession.current === activeHarnessSessionId) return
    const active = snapshot.workers.find((worker) => worker.harnessConversation?.sessionId === activeHarnessSessionId)
    if (active) { seenActiveSession.current = activeHarnessSessionId; select(active.id) }
  }, [activeHarnessSessionId, snapshot.workers, renderHarnessConversation])
  const [errors, setErrors] = useState<Record<string, string>>({}),
    [busy, setBusy] = useState(false)
  const error = errors[selected] ?? ''
  const setError = (text: string) => setErrors((old) => ({ ...old, [selected]: text }))
  const pendingAction = useRef(false)
  const pendingStop = useRef(new Set<string>())
  const [stoppingWorkers, setStoppingWorkers] = useState(new Set<string>())
  const stoppingRequest = stoppingWorkers.has(selected)
  const submissions = useMessageSubmissions(api, sessionId, snapshot, restoreDraft)
  const submittedDraft = useRef(new Map<string, string>())
  const managementAbort = useRef<AbortController>()
  const [following, setFollowing] = useState(true)
  const alive = useRef(true),
    currentSelection = useRef(selected)
  currentSelection.current = selected
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      managementAbort.current?.abort()
    }
  }, [])
  const [settingsCli, setSettingsCli] = useState<CliId>('antigravity')
  const [settings, setSettings] = useState(false)
  const [renaming, setRenaming] = useState<{ worker: Worker; mode: 'name' | 'title' }>()
  const [rawLog, setRawLog] = useState<Worker>()
  const [restartFor, setRestartFor] = useState('')
  const nativeSettingsRequested = useRef(false)
  useEffect(() => {
    // The native command must run after our Modal releases its focus/inert seat.
    if (!settings && nativeSettingsRequested.current) {
      nativeSettingsRequested.current = false
      try {
        openNativeSettings?.()
      } catch {
        setError('无法打开原生设置。请从 Harness 左侧打开「设置 → 模型」管理 API 登录。')
      }
    }
  }, [settings, openNativeSettings])
  const feed = useRef<HTMLDivElement>(null),
    stick = useRef(true)
  const worker = snapshot.selected
  const retired = !!worker && isRetiredCli(cliOf(worker.preference))
  const prompt = drafts[selected] ?? ''
  const composerInput = useRef<HTMLTextAreaElement>(null)
  const composerForm = useRef<HTMLFormElement>(null)
  const submitEnabled = useRef(false)
  const composerKeys = useMemo(
    () =>
      createComposerKeymap(
        () => submitEnabled.current,
        () => composerForm.current?.requestSubmit(),
      ),
    [selected],
  )
  useLayoutEffect(() => {
    const el = composerInput.current
    if (!el) return
    el.style.height = '36px'
    el.style.height = `${Math.max(36, Math.min(el.scrollHeight, 336))}px`
  }, [prompt, selected, snapshot.selected?.id])
  useEffect(() => {
    stick.current = true
    setFollowing(true)
    setHistoryPage(undefined)
    setRestartFor('')
  }, [selected])
  useEffect(() => {
    if (restartFor) composerInput.current?.focus({ preventScroll: true })
  }, [restartFor])
  useEffect(() => {
    if (!history && stick.current && feed.current) feed.current.scrollTop = feed.current.scrollHeight
  }, [snapshot.timeline, selected, history])
  useEffect(() => {
    if (history && feed.current) feed.current.scrollTop = 0
  }, [history])
  async function perform(action: (isCurrent: () => boolean) => Promise<void>) {
    if (pendingAction.current) return
    pendingAction.current = true
    const origin = selected
    const isCurrent = () => alive.current && currentSelection.current === origin
    setBusy(true)
    setError('')
    try {
      await action(isCurrent)
    } catch (e) {
      if (alive.current) setErrors((old) => ({ ...old, [origin]: operationMessage(e) }))
    } finally {
      pendingAction.current = false
      if (alive.current) setBusy(false)
    }
  }
  async function stopWorker(target: Worker) {
    if (
      pendingStop.current.has(target.id) ||
      (target.status === 'stopping' && !submissions.interrupting && !submissions.stopUnconfirmed) ||
      unavailable
    )
      return
    const stopScope = submissions.stopScope(target.id)
    pendingStop.current.add(target.id)
    setStoppingWorkers(new Set(pendingStop.current))
    setErrors((old) => ({ ...old, [target.id]: '' }))
    try {
      const preparation = submissions.cancelPending(target.id)
      // The Host confirms process cleanup; cancelling a browser RPC alone does not.
      const stopped = api.cliworker.stop(sessionId, target.id).then(value)
      submissions.waitForStop(target.id, stopped)
      const [, receipt] = await Promise.all([preparation, stopped])
      if (receipt) {
        const result = JSON.parse(receipt) as { runId?: string }
        if (result.runId) submissions.confirmStopped(target.id, result.runId, stopScope)
      }
    } catch (error) {
      if (alive.current) setErrors((old) => ({ ...old, [target.id]: operationMessage(error) }))
    } finally {
      pendingStop.current.delete(target.id)
      if (alive.current) setStoppingWorkers(new Set(pendingStop.current))
    }
  }
  const running = !!worker && (submissions.busyFor(worker.id) || stoppingRequest)
  const unavailable = connecting || !!streamError
  const startingNew = !!worker && restartFor === worker.id
  const resumeBlocked = snapshot.resumeBlockedReason
  const queuedFollowups = [...submissions.hostQueue, ...submissions.optimisticQueue]
  const followupsExpanded = !collapsedFollowups[selected]
  const waitingForTurn = running
  const userInterrupted = !!worker && isUserInterrupted(worker)
  const queueSubmission = !!waitingForTurn || queuedFollowups.some((item) => item.state !== 'paused')
  const workerModelMenu = worker && (
    <WorkerModelMenu
      key={`model:${worker.id}`}
      worker={worker}
      api={api}
      sessionId={sessionId}
      disabled={
        retired ||
        busy ||
        unavailable ||
        !!running ||
        submissions.pending ||
        submissions.uncertain ||
        queuedFollowups.length > 0 ||
        startingNew ||
        !!resumeBlocked
      }
      disabledReason={
        queuedFollowups.length > 0
          ? '请先发送或取消待发送消息，再修改模型与强度'
          : submissions.pending || submissions.uncertain
            ? '请等待当前消息提交确认，再修改模型与强度'
            : undefined
      }
    />
  )
  const runningMessageMode = snapshot.runningMessageMode ?? 'queue'
  const submissionLabel = waitingForTurn
    ? runningMessageMode === 'queue'
      ? '加入待发送消息'
      : `${RUNNING_MESSAGE_LABELS[runningMessageMode]}发送`
    : queueSubmission
      ? '加入待发送消息'
      : '继续对话'
  const submissionHint = waitingForTurn
    ? runningMessageMode === 'steer'
      ? '引导当前运行'
      : runningMessageMode === 'interrupt'
        ? '停止当前轮后插队发送'
        : '本轮结束后发送'
    : queueSubmission
      ? '加入待发送消息'
      : '继续对话'
  const canResume =
    (startingNew || ((waitingForTurn || worker?.conversationId || userInterrupted) && !resumeBlocked)) &&
    !retired &&
    (!startingNew || !running) &&
    !unavailable
  submitEnabled.current =
    !!prompt.trim() && !!canResume && !busy && (!submissions.uncertain || runningMessageMode === 'interrupt')
  function submitPrompt(submittedText: string, selectedMode = runningMessageMode): boolean {
    if (!worker) return false
    if (
      !submittedText.trim() ||
      !canResume ||
      busy ||
      (submissions.uncertain && selectedMode !== 'interrupt')
    )
      return false
    if (!startingNew) {
      if (submittedDraft.current.get(worker.id) === submittedText) return false
      const occupied = submissions.busyFor(worker.id) || pendingStop.current.has(worker.id)
      if (occupied && selectedMode === 'steer' && !submissions.canSteer(worker.id)) {
        setError('当前运行尚未准备好接收引导，请保留消息后重试或选择其他发送方式。')
        return false
      }
      const sent =
        occupied && selectedMode === 'steer'
          ? submissions.steerMessage(worker, submittedText)
          : submissions.submit(
              worker,
              submittedText,
              occupied ? 'running' : queueSubmission ? 'queue' : 'followup',
              occupied ? selectedMode : 'queue',
            )
      if (!sent) return false
      submittedDraft.current.set(worker.id, submittedText)
      void sent.done.then(() => {
        if (sent.state !== 'accepted' && submittedDraft.current.get(worker.id) === submittedText)
          submittedDraft.current.delete(worker.id)
      })
      clearSubmitted(worker.id, submittedText)
      setError('')
      jumpToLatest()
      return true
    }
    void perform(async (isCurrent) => {
      const controller = new AbortController()
      managementAbort.current = controller
      let receipt: { workerId?: string }
      try {
        receipt = JSON.parse(
          value(await api.cliworker.restartWorker(sessionId, worker.id, submittedText, controller.signal)),
        )
      } finally {
        if (managementAbort.current === controller) managementAbort.current = undefined
      }
      if (!receipt.workerId || receipt.workerId === worker.id)
        throw new Error('新对话未返回有效的智能体记录')
      clearSubmitted(worker.id, submittedText)
      if (isCurrent()) {
        lastWorker.current = receipt.workerId
        setRestartFor('')
        select(receipt.workerId)
      }
    })
    return false
  }
  const jumpToLatest = () => {
    setHistoryPage(undefined)
    stick.current = true
    setFollowing(true)
    if (feed.current) feed.current.scrollTop = feed.current.scrollHeight
  }
  const visibleWorkers = snapshot.workers.filter((w) => {
    const matches =
      `${CLI_LABELS[cliOf(w.preference)]} ${workerName(w)} ${w.title} ${w.preference.model} ${w.preference.effort}`
        .toLowerCase()
        .includes(query.trim().toLowerCase())
    return (
      matches &&
      (filter === 'all' ||
        (filter === 'active'
          ? active(w.status)
          : filter === 'attention'
            ? w.status === 'failed' ||
              (w.status === 'interrupted' && !isUserInterrupted(w)) ||
              w.status === 'uncertain'
            : w.status === 'completed'))
    )
  })
  const archivedWorkers = snapshot.archivedWorkers ?? []
  const manageWorker = (target: Worker, action: WorkerManagementAction) => {
    if (action === 'name' || action === 'title') {
      setRenaming({ worker: target, mode: action })
      return
    }
    void perform(async (isCurrent) => {
      const controller = new AbortController()
      managementAbort.current = controller
      try {
        value(await api.cliworker.deleteWorker(sessionId, target.id, controller.signal))
      } finally {
        if (managementAbort.current === controller) managementAbort.current = undefined
      }
      if (isCurrent()) {
        if (selected === target.id) select('')
        setShowArchived(true)
      }
    })
  }
  const latestTimeline = [...submissions.hostTimeline, ...submissions.optimisticTimeline]
  const displayedTimeline = history?.items ?? latestTimeline
  const loadHistory = (direction: 'before' | 'after') => {
    const anchor = direction === 'before' ? displayedTimeline[0]?.id : displayedTimeline.at(-1)?.id
    if (!worker || !anchor) return
    void perform(async (isCurrent) => {
      const page: HistoryPage = JSON.parse(
        value(await api.cliworker.history(sessionId, worker.id, anchor, direction)),
      )
      if (!isCurrent()) return
      if (page.workerId !== worker.id) throw new Error('收到不匹配的历史记录')
      if (!page.items.length) {
        jumpToLatest()
        return
      }
      stick.current = false
      setFollowing(false)
      setHistoryPage(page)
    })
  }
  return (
    <section className="cwn" aria-label="CLI Worker Now">
      <header className="cwn-head">
        {selected ? (
          <>
            <Tooltip label="返回子 Agent 列表" side="bottom" portal>
              <Button
                ref={back}
                type="button"
                variant="outline"
                size="sm"
                className="cwn-back"
                aria-label="返回子 Agent 列表"
                onClick={() => {
                  setSettings(false)
                  select('')
                }}
              >
                <Glyph name="back" />
              </Button>
            </Tooltip>
            <h2 title={worker ? `${workerName(worker)}｜${worker.title}` : undefined}>
              {(() => {
                const current = worker ?? snapshot.workers.find((w) => w.id === selected)
                return current ? `${workerName(current)}｜${current.title}` : '正在加载…'
              })()}
            </h2>
            <details className="cwn-actions">
              <summary aria-label="任务选项" title="任务选项">
                <Glyph name="more" />
              </summary>
              <div className={`cwn-action-menu${renderHarnessConversation ? ' cwn-native-action-menu' : ''}`}>
                {worker && (
                  <>
                    <strong>{CLI_LABELS[cliOf(worker.preference)]}</strong>
                    <p>{worker.mode === 'plan' ? 'CLI 规划模式' : '可编辑任务'}</p>
                    {worker.role && <p title={worker.role.summary}>角色：{worker.role.name}</p>}
                    {worker.harnessConversation && (
                      <HarnessCapabilityNotes binding={worker.harnessConversation} />
                    )}
                    {renderHarnessConversation && (
                      <>
                        {workerModelMenu}
                        <HarnessLegacyHistory
                          key={`history:${worker.id}`}
                          api={api}
                          parentSessionId={sessionId}
                          worker={worker}
                          items={snapshot.timeline}
                          truncated={snapshot.truncated}
                          queuedFollowups={snapshot.queuedFollowups}
                        />
                      </>
                    )}
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => manageWorker(worker, 'name')}
                      disabled={unavailable || busy}
                    >
                      修改智能体名称
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => manageWorker(worker, 'title')}
                      disabled={unavailable || busy}
                    >
                      修改聊天标题
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => manageWorker(worker, 'delete')}
                      disabled={unavailable || busy || !!running}
                    >
                      删除
                    </Button>
                    {worker.observedModel && worker.observedModel !== worker.preference.model && (
                      <p>
                        CLI 实际模型：
                        {displayModelName({ ...worker.preference, model: worker.observedModel })}
                      </p>
                    )}
                    {worker.lastResult && (
                      <CopyText
                        key={`${worker.id}:${worker.runId}`}
                        text={worker.lastResult}
                        label="复制最新结果"
                      />
                    )}
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => setRawLog(worker)}
                    >
                      查看原始日志
                    </Button>
                  </>
                )}
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setSettingsCli(worker && !retired ? cliOf(worker.preference) : settingsCli)
                    setSettings(true)
                  }}
                  disabled={retired}
                >
                  默认设置
                </Button>
              </div>
            </details>
          </>
        ) : (
          <>
            <div className="cwn-wordmark">
              <BrandIcon size={36} tone="monochrome" />
              <h2 aria-label="CLI Worker Now">
                <span>CLI Worker</span>
                <small>NOW</small>
              </h2>
            </div>
            <Tooltip label="默认设置" side="bottom" portal>
              <Button
                type="button"
                variant="ghost"
                size="md"
                className="cwn-settings-button"
                aria-label="默认设置"
                onClick={() => setSettings(true)}
              >
                <Glyph name="settings" />
              </Button>
            </Tooltip>
          </>
        )}
      </header>
      {selected && worker && !retired && !running && (resumeBlocked || startingNew) && (
        <div className="cwn-resume-banner" role="status" aria-label="对话状态">
          <span>
            {startingNew
              ? '新对话将沿用原设定'
              : resumeBlocked === '此历史任务缺少账号记录，请新建任务'
                ? '历史账号记录缺失'
                : resumeBlocked}
          </span>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            aria-label={startingNew ? '取消新建' : '新建对话'}
            disabled={busy || (!startingNew && unavailable)}
            onClick={() => setRestartFor(startingNew ? '' : worker.id)}
          >
            {startingNew ? '取消' : '新建对话'}
          </Button>
        </div>
      )}
      {rawLog && (
        <RawLogDialog
          key={`raw:${rawLog.id}:${rawLog.runId}`}
          api={api}
          sessionId={sessionId}
          worker={rawLog}
          onClose={() => setRawLog(undefined)}
        />
      )}
      {renaming && (
        <RenameWorker
          key={`${renaming.worker.id}:${renaming.mode}`}
          api={api}
          sessionId={sessionId}
          worker={renaming.worker}
          mode={renaming.mode}
          onClose={() => setRenaming(undefined)}
        />
      )}
      <SettingsDialog
        openNativeSettings={
          openNativeSettings
            ? () => {
                nativeSettingsRequested.current = true
                setSettings(false)
              }
            : undefined
        }
        open={settings}
        onClose={() => setSettings(false)}
        api={api}
        sessionId={sessionId}
        initialCli={settingsCli}
      />
      {!selected && (
        <div className="cwn-overview">
          <div className="cwn-overview-controls">
            <Input
              className="cwn-search"
              icon={<Glyph name="search" />}
              type="search"
              aria-label="筛选子 Agent"
              placeholder={filter === 'roster' ? '搜索可用智能体…' : '搜索智能体、话题或模型…'}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <div className="cwn-filter-row">
              <div className="cwn-filters" role="group" aria-label="任务状态筛选">
                {(
                  [
                    ['all', '全部'],
                    ['active', '进行中'],
                    ['completed', '已完成'],
                    ['attention', '异常'],
                    ['roster', '可用智能体'],
                  ] as const
                ).map(([id, label]) => (
                  <Button
                    key={id}
                    type="button"
                    variant="outline"
                    size="md"
                    aria-pressed={!showArchived && filter === id}
                    onClick={() => {
                      setShowArchived(false)
                      setFilter(id)
                    }}
                  >
                    {label}
                  </Button>
                ))}
              </div>
              {filter !== 'roster' && (
                <Tooltip label={showArchived ? '返回列表' : '已删除'} side="bottom" portal>
                  <Button
                    type="button"
                    size="md"
                    variant="ghost"
                    className="cwn-archive-toggle"
                    aria-label={showArchived ? '返回列表' : '已删除'}
                    aria-pressed={showArchived}
                    onClick={() => setShowArchived((shown) => !shown)}
                  >
                    <IconTrashOutlineRegular />
                  </Button>
                </Tooltip>
              )}
            </div>
          </div>
          <div
            className="cwn-overview-list"
            ref={overview}
            onScroll={() => {
              overviewScroll.current = overview.current?.scrollTop ?? 0
            }}
          >
            {showArchived ? (
              <div className="cwn-archived-list" aria-label="已删除对话">
                {archivedWorkers.length === 0 && <div className="cwn-empty">没有已删除的对话</div>}
                {archivedWorkers.map((archived) => (
                  <article key={archived.id} className="cwn-archived-row">
                    <div>
                      <strong>{archived.title}</strong>
                      <small>{workerName(archived)}</small>
                    </div>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      aria-label={`恢复对话 ${archived.title}`}
                      disabled={busy || unavailable}
                      onClick={() => {
                        void perform(async () => {
                          const controller = new AbortController()
                          managementAbort.current = controller
                          try {
                            value(
                              await api.cliworker.restoreWorker(sessionId, archived.id, controller.signal),
                            )
                          } finally {
                            if (managementAbort.current === controller) managementAbort.current = undefined
                          }
                        })
                      }}
                    >
                      恢复
                    </Button>
                  </article>
                ))}
              </div>
            ) : filter === 'roster' ? (
              <RosterList
                api={api}
                sessionId={sessionId}
                workers={snapshot.workers}
                archived={snapshot.archivedWorkers ?? []}
                query={query}
              />
            ) : (
              <nav aria-label="子 Agent">
                {([...CLI_IDS, 'harness'] as const).map((cli) => {
                  const rows = visibleWorkers.filter((w) => cliOf(w.preference) === cli)
                  if (!rows.length) return null
                  return (
                    <section className="cwn-cli-group" key={cli} aria-label={`${CLI_LABELS[cli]} 子 Agent`}>
                      <button
                        className="cwn-cli-heading"
                        type="button"
                        aria-expanded={!collapsed[cli]}
                        aria-controls={`${cliGroupId}-${cli}`}
                        onClick={() => setCollapsed((old) => ({ ...old, [cli]: !old[cli] }))}
                      >
                        <BrandIcon cli={cli} />
                        <strong>{CLI_LABELS[cli]}</strong>
                        <span>{rows.length} 个 Agent</span>
                        <Glyph name="chevron" />
                      </button>
                      <div
                        id={`${cliGroupId}-${cli}`}
                        className="cwn-cli-rows"
                        data-expanded={!collapsed[cli]}
                        aria-hidden={!!collapsed[cli]}
                        {...(collapsed[cli] ? { inert: '' } : {})}
                      >
                        <div className="cwn-cli-rows-inner">
                          {rows.map((w) => (
                            <WorkerCard
                              key={w.id}
                              worker={w}
                              collapsed={!!collapsed[cli]}
                              unavailable={unavailable}
                              busy={busy}
                              onOpen={() => openWorker(w.id)}
                              onManage={(action) => manageWorker(w, action)}
                            />
                          ))}
                        </div>
                      </div>
                    </section>
                  )
                })}
              </nav>
            )}
            {snapshot.configuring && (
              <div className="cwn-notice">等待确认设定。请在主对话的问题卡片中选择。</div>
            )}
            {!connecting &&
              !streamError &&
              !snapshot.workers.length &&
              !snapshot.configuring &&
              !showArchived &&
              !query &&
              filter === 'all' && (
                <div className="cwn-empty cwn-start-empty">
                  <h3>把想做的事，交给合适的伙伴。</h3>
                  <p>在主对话中发起任务，协作会在这里展开。</p>
                </div>
              )}
          </div>
        </div>
      )}
      {streamError && (
        <div role="alert" className="cwn-error">
          <div>实时连接已断开，已收到的记录保留在这里。重新连接不会重新执行任务。</div>
          <Button type="button" size="sm" variant="outline" onClick={reconnect}>
            重新连接
          </Button>
          <details>
            <summary>连接详情</summary>
            {streamError}
          </details>
        </div>
      )}
      {connecting && (
        <div className="cwn-notice" role="status">
          <StateDot state="ongoing" size={14} /> 正在连接并恢复记录…
        </div>
      )}
      {error && !settings && (
        <div role="alert" className="cwn-notice">
          {error}
        </div>
      )}
      {worker?.error && !isUserInterrupted(worker) && (
        <div role="status" className={worker.status === 'uncertain' ? 'cwn-notice cwn-warning' : 'cwn-error'}>
          {worker.error}
        </div>
      )}
      {selected && history && !renderHarnessConversation && (
        <div className="cwn-history-nav" aria-label="历史翻页">
          <span>
            历史记录 {history.start + 1}–{history.end} · 读取时共 {history.total} 条
          </span>
          <div>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy || unavailable || !history.hasOlder}
              onClick={() => loadHistory('before')}
            >
              更早记录
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy || unavailable || !history.hasNewer}
              onClick={() => loadHistory('after')}
            >
              较新记录
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={jumpToLatest}>
              返回实时
            </Button>
          </div>
          <small>历史页保持静止，返回实时可查看最新进展。</small>
        </div>
      )}
      {selected &&
        worker &&
        renderHarnessConversation &&
        renderHarnessConversation(worker)}
      {selected && !renderHarnessConversation && (
        <div className="cwn-conversation">
          <div
            className="cwn-feed"
            ref={feed}
            onScroll={() => {
              if (history) return
              const el = feed.current!
              // Harness rc.2 ScrollFollow uses a 25px bottom tolerance.
              stick.current = el.scrollHeight - el.scrollTop - el.clientHeight <= 25
              setFollowing(stick.current)
            }}
            aria-label="对话记录"
            aria-busy={running || false}
          >
            {snapshot.configuring && (
              <div className="cwn-notice">等待确认设定。请在主对话的问题卡片中选择。</div>
            )}
            {!history && snapshot.truncated && (
              <div className="cwn-history-start">
                <span>当前显示最近 {snapshot.timeline.length} 条记录</span>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={busy || unavailable}
                  onClick={() => loadHistory('before')}
                >
                  查看更早记录
                </Button>
              </div>
            )}
            <ConversationTimeline
              items={displayedTimeline}
              latestItems={latestTimeline}
              worker={worker}
              messageFeedback={Object.fromEntries(
                submissions.localMessages
                  .filter((message) => message.route !== 'interrupt' && message.state === 'failed')
                  .map((message) => [
                    `local-${message.id}:user`,
                    <span key={message.id} role="status">
                      {message.uncertain ? message.error : `未发送：${message.error}`}
                      {(message.uncertain || message.runEnded) && (
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          aria-label={`恢复内容 ${message.prompt}`}
                          onClick={() => submissions.recover(message)}
                        >
                          恢复内容
                        </Button>
                      )}
                      {message.state === 'failed' && (
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          aria-label={`重试发送 ${message.prompt}`}
                          disabled={
                            !canResume ||
                            busy ||
                            message.uncertain ||
                            message.runEnded ||
                            (message.mode === 'steer' && !submissions.canSteer(message.worker.id))
                          }
                          title={message.runEnded ? '原轮已结束，请核查记录或恢复内容后自行处理' : undefined}
                          onClick={() => {
                            submissions.submit(
                              message.worker,
                              message.prompt,
                              message.route,
                              message.mode,
                              message,
                            )
                            clearSubmitted(message.worker.id, message.prompt)
                            submittedDraft.current.delete(message.worker.id)
                          }}
                        >
                          重试
                        </Button>
                      )}
                    </span>,
                  ]),
              )}
            />
          </div>
          {!history && !following && worker && (
            <div className="cwn-jump">
              <button
                className="cwn-jump-button"
                type="button"
                aria-label="回到最新消息"
                onClick={jumpToLatest}
              >
                <IconChevronDownOutlineRegular />
              </button>
            </div>
          )}
        </div>
      )}
      {selected && worker && !renderHarnessConversation && (
        <>
          <form
            ref={composerForm}
            className="cwn-compose"
            aria-label={renderHarnessConversation ? 'CLI Worker 消息输入' : undefined}
            onSubmit={(e) => {
              e.preventDefault()
              submitPrompt(prompt)
            }}
          >
            {renderHarnessConversation && (
              <p className="cwn-resume-hint" role="status">
                原生对话用于显示；请在此发送、排队或引导，停止仍等待 CLI 进程清理完成。
              </p>
            )}
            {retired && <p className="cwn-resume-hint">{RETIRED_HARNESS_NOTICE}</p>}
            {snapshot.runningMessageModeReason && (
              <p className="cwn-resume-hint" role="status">
                {snapshot.runningMessageModeReason}
              </p>
            )}
            {userInterrupted && !worker.conversationId && !resumeBlocked && (
              <p className="cwn-resume-hint" role="status">
                上次停止前尚未建立 CLI 会话，再次发送将开始新会话；已有记录会保留。
              </p>
            )}
            <FollowupQueuePresence
              scopeKey={worker.id}
              items={queuedFollowups}
              expanded={followupsExpanded}
              bodyId={followupQueueId}
              heading={(count) => (
                <>
                  <span>待发送 · {count}</span>
                  <div className="cwn-followup-heading-actions">
                    {snapshot.queuedFollowups?.some((item) => item.state === 'paused') && !running && (
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        disabled={
                          busy ||
                          submissions.interrupting ||
                          submissions.uncertain ||
                          unavailable ||
                          !!resumeBlocked ||
                          (!worker.conversationId && !userInterrupted)
                        }
                        onClick={() =>
                          void perform(async () => {
                            value(
                              await api.cliworker.retryQueuedFollowups(sessionId, worker.id, worker.runId),
                            )
                          })
                        }
                      >
                        继续发送
                      </Button>
                    )}
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="cwn-followup-toggle"
                      aria-label={followupsExpanded ? '折叠待发送消息' : '展开待发送消息'}
                      aria-expanded={followupsExpanded}
                      aria-controls={followupQueueId}
                      onClick={() =>
                        setCollapsedFollowups((old) => ({ ...old, [worker.id]: !old[worker.id] }))
                      }
                    >
                      <IconChevronDownOutlineRegular size={14} />
                    </Button>
                  </div>
                </>
              )}
              renderItem={(item, index) => {
                const local = submissions.localQueue.find((message) => message.id === item.id)
                return (
                  <>
                    <div className="cwn-followup-content">
                      <p>{item.prompt}</p>
                      {item.state === 'paused' &&
                        item.pauseReason &&
                        !['已停止发送', '任务已停止，请确认后继续发送'].includes(item.pauseReason) && (
                          <small>{item.pauseReason}</small>
                        )}
                    </div>
                    <div className="cwn-followup-actions">
                      {local?.state === 'failed' && (
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          aria-label={`${local.uncertain ? '恢复内容' : '重试发送'} ${local.prompt}`}
                          disabled={!local.uncertain && (!canResume || busy)}
                          onClick={() => {
                            if (local.uncertain) submissions.recover(local)
                            else {
                              submissions.submit(local.worker, local.prompt, local.route, local.mode, local)
                              clearSubmitted(local.worker.id, local.prompt)
                              submittedDraft.current.delete(local.worker.id)
                            }
                          }}
                        >
                          {local.uncertain ? '恢复内容' : '重试'}
                        </Button>
                      )}
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        aria-label={`插队待发送消息 ${index + 1}`}
                        title="停止当前轮后优先发送这条消息"
                        disabled={
                          unavailable || !!resumeBlocked || (!worker.conversationId && !userInterrupted)
                        }
                        onClick={() => {
                          if (unavailable || resumeBlocked || (!worker.conversationId && !userInterrupted))
                            return
                          submissions.interruptQueued(worker, item)
                          jumpToLatest()
                        }}
                      >
                        插队
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        aria-label={`取消待发送消息 ${index + 1}`}
                        disabled={
                          busy ||
                          unavailable ||
                          (!!local && local.state !== 'failed' && local.state !== 'cancelled') ||
                          (item.state === 'sending' && !!running)
                        }
                        onClick={() => {
                          if (local) submissions.discard(local)
                          else
                            void perform(async () => {
                              value(await api.cliworker.cancelQueuedFollowup(sessionId, worker.id, item.id))
                            })
                        }}
                      >
                        取消
                      </Button>
                    </div>
                  </>
                )
              }}
            />
            <div className="cwn-compose-box">
              <textarea
                ref={composerInput}
                aria-label={startingNew ? '新建对话内容' : '继续对话'}
                value={prompt}
                onChange={(e) => {
                  submittedDraft.current.delete(worker.id)
                  editDraft(worker.id, e.target.value)
                }}
                onKeyDown={composerKeys.onKeyDown}
                onCompositionStart={composerKeys.onCompositionStart}
                onCompositionEnd={composerKeys.onCompositionEnd}
                disabled={!canResume}
                maxLength={100000}
                placeholder={
                  startingNew
                    ? '输入新对话的任务…'
                    : running
                      ? runningMessageMode === 'steer'
                        ? '输入引导消息，交给 CLI 在当前运行中处理…'
                        : runningMessageMode === 'interrupt'
                          ? '输入消息，停止当前轮后优先发送…'
                          : '输入下一步，本轮结束后自动发送…'
                      : '给这个子 Agent 分配下一步…'
                }
                rows={1}
              />
              <div className="cwn-compose-bottom">
                {!renderHarnessConversation && workerModelMenu}
                {(running ||
                  submissions.pending ||
                  stoppingRequest ||
                  submissions.uncertain ||
                  submissions.stopUnconfirmed) &&
                !prompt.trim() ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="cwn-send"
                    aria-label="停止"
                    title="停止"
                    disabled={
                      stoppingRequest ||
                      unavailable ||
                      (worker.status === 'stopping' &&
                        !submissions.interrupting &&
                        !submissions.stopUnconfirmed)
                    }
                    onClick={() => void stopWorker(worker)}
                  >
                    <Glyph name="stop" />
                  </Button>
                ) : (
                  <button
                    type="submit"
                    className="cwn-send"
                    aria-label={startingNew ? '新建对话并发送' : submissionLabel}
                    title={startingNew ? '新建对话并发送' : submissionHint}
                    disabled={!submitEnabled.current}
                    onMouseDown={(e) => {
                      e.preventDefault()
                      composerInput.current?.focus({ preventScroll: true })
                    }}
                  >
                    <Glyph name="send" />
                  </button>
                )}
              </div>
            </div>
            <ComposerTelemetry
              worker={worker}
              telemetry={snapshot.telemetry}
              statusLabel={userInterrupted ? '已停止' : status[worker.status]}
            />
          </form>
        </>
      )}
    </section>
  )
}
