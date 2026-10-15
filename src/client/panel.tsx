import { ComposerTelemetry } from './telemetry.tsx'
import { ConversationTimeline } from './conversation-timeline.tsx'
import { displayModelName } from '../shared/model-presentation.ts'
import { operationMessage } from './operation-error.ts'
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
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
import { RenameWorker } from './rename-worker.tsx'
import { WorkerCard, type WorkerManagementAction } from './worker-card.tsx'
import { RUNNING_MESSAGE_LABELS } from '../shared/running-message.ts'

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
    />
  )
}
function SessionPanel({
  sessionId,
  api,
  openNativeSettings,
  drafts,
  editDraft,
  clearSubmitted,
}: PanelProps & {
  drafts: Record<string, string>
  editDraft: (id: string, text: string) => void
  clearSubmitted: (id: string, submitted: string) => void
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
  const [errors, setErrors] = useState<Record<string, string>>({}),
    [busy, setBusy] = useState(false)
  const error = errors[selected] ?? ''
  const setError = (text: string) => setErrors((old) => ({ ...old, [selected]: text }))
  const pendingAction = useRef(false)
  const pendingStop = useRef(false)
  const [stoppingRequest, setStoppingRequest] = useState(false)
  const queuedRequests = useRef(new Map<string, { runId: string; prompt: string; id: string }>())
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
    if (pendingStop.current || target.status === 'stopping' || unavailable) return
    pendingStop.current = true
    setStoppingRequest(true)
    setErrors((old) => ({ ...old, [target.id]: '' }))
    try {
      value(await api.cliworker.stop(sessionId, target.id))
    } catch (error) {
      if (alive.current) setErrors((old) => ({ ...old, [target.id]: operationMessage(error) }))
    } finally {
      pendingStop.current = false
      if (alive.current) setStoppingRequest(false)
    }
  }
  const running = worker && active(worker.status)
  const unavailable = connecting || !!streamError
  const startingNew = !!worker && restartFor === worker.id
  const resumeBlocked = snapshot.resumeBlockedReason
  const queuedFollowups = snapshot.queuedFollowups ?? []
  const followupsExpanded = !collapsedFollowups[selected]
  const waitingForTurn = worker?.status === 'running' || worker?.status === 'queued'
  const queueSubmission = !!waitingForTurn || queuedFollowups.length > 0
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
    (startingNew || ((waitingForTurn || worker?.conversationId) && !resumeBlocked)) &&
    !retired &&
    (!startingNew || !running) &&
    worker?.status !== 'stopping' &&
    !stoppingRequest &&
    !unavailable
  submitEnabled.current = !!prompt.trim() && !!canResume && !busy
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
            ? w.status === 'failed' || w.status === 'interrupted' || w.status === 'uncertain'
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
  const displayedTimeline = history?.items ?? snapshot.timeline
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
              <div className="cwn-action-menu">
                {worker && (
                  <>
                    <strong>{CLI_LABELS[cliOf(worker.preference)]}</strong>
                    <p>{worker.mode === 'plan' ? 'CLI 规划模式' : '可编辑任务'}</p>
                    {worker.role && <p title={worker.role.summary}>角色：{worker.role.name}</p>}
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
              placeholder="搜索智能体、话题或模型…"
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
      {worker?.error && (
        <div role="status" className={worker.status === 'uncertain' ? 'cwn-notice cwn-warning' : 'cwn-error'}>
          {worker.error}
        </div>
      )}
      {selected && history && (
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
      {selected && (
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
            <ConversationTimeline items={displayedTimeline} latestItems={snapshot.timeline} worker={worker} />
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
      {selected && worker && (
        <form
          ref={composerForm}
          className="cwn-compose"
          onSubmit={(e) => {
            e.preventDefault()
            if (!prompt.trim() || !canResume || busy) return
            void perform(async (isCurrent) => {
              if (startingNew) {
                const controller = new AbortController()
                managementAbort.current = controller
                let receipt: { workerId?: string }
                try {
                  receipt = JSON.parse(
                    value(await api.cliworker.restartWorker(sessionId, worker.id, prompt, controller.signal)),
                  )
                } finally {
                  if (managementAbort.current === controller) managementAbort.current = undefined
                }
                if (!receipt.workerId || receipt.workerId === worker.id)
                  throw new Error('新对话未返回有效的智能体记录')
                clearSubmitted(worker.id, prompt)
                if (isCurrent()) {
                  lastWorker.current = receipt.workerId
                  setRestartFor('')
                  select(receipt.workerId)
                }
                return
              }
              if (queueSubmission) {
                const previous = queuedRequests.current.get(worker.id)
                const request =
                  previous?.runId === worker.runId && previous.prompt === prompt
                    ? previous
                    : { runId: worker.runId, prompt, id: crypto.randomUUID() }
                queuedRequests.current.set(worker.id, request)
                value(
                  waitingForTurn
                    ? await api.cliworker.sendRunningMessage(
                        sessionId,
                        worker.id,
                        prompt,
                        worker.runId,
                        request.id,
                      )
                    : await api.cliworker.queueFollowup(
                        sessionId,
                        worker.id,
                        prompt,
                        worker.runId,
                        request.id,
                      ),
                )
                if (queuedRequests.current.get(worker.id) === request)
                  queuedRequests.current.delete(worker.id)
              } else {
                value(await api.cliworker.followup(sessionId, worker.id, prompt))
              }
              clearSubmitted(worker.id, prompt)
              if (isCurrent()) jumpToLatest()
            })
          }}
        >
          {retired && <p className="cwn-resume-hint">{RETIRED_HARNESS_NOTICE}</p>}
          {queuedFollowups.length > 0 && (
            <section className="cwn-followup-queue" aria-label="待发送消息" aria-live="polite">
              <div className="cwn-followup-heading">
                <span>待发送 · {queuedFollowups.length}</span>
                <div className="cwn-followup-heading-actions">
                  {queuedFollowups.some((item) => item.state === 'paused') && !running && (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      disabled={busy || unavailable || !!resumeBlocked || !worker.conversationId}
                      onClick={() =>
                        void perform(async () => {
                          value(await api.cliworker.retryQueuedFollowups(sessionId, worker.id, worker.runId))
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
                    onClick={() => setCollapsedFollowups((old) => ({ ...old, [worker.id]: !old[worker.id] }))}
                  >
                    <IconChevronDownOutlineRegular size={14} />
                  </Button>
                </div>
              </div>
              <div
                id={followupQueueId}
                className="cwn-followup-body"
                data-expanded={followupsExpanded}
                aria-hidden={!followupsExpanded}
                {...(!followupsExpanded ? { inert: '' } : {})}
              >
                <div className="cwn-followup-body-inner">
                  <ol>
                    {queuedFollowups.map((item, index) => (
                      <li key={item.id}>
                        <div className="cwn-followup-content">
                          <p>{item.prompt}</p>
                          <small>
                            {item.state === 'paused'
                              ? item.pauseReason || '已暂停，等待继续发送'
                              : item.state === 'sending'
                                ? '准备发送…'
                                : '本轮结束后发送'}
                          </small>
                        </div>
                        <div className="cwn-followup-actions">
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            aria-label={`插队待发送消息 ${index + 1}`}
                            title="停止当前轮后优先发送这条消息"
                            disabled={
                              busy ||
                              unavailable ||
                              !!resumeBlocked ||
                              !worker.conversationId ||
                              worker.status === 'stopping' ||
                              (item.state === 'sending' && !!running)
                            }
                            onClick={() => {
                              if (
                                busy ||
                                unavailable ||
                                resumeBlocked ||
                                !worker.conversationId ||
                                worker.status === 'stopping' ||
                                (item.state === 'sending' && running)
                              )
                                return
                              void perform(async () => {
                                value(
                                  await api.cliworker.interruptQueuedFollowup(
                                    sessionId,
                                    worker.id,
                                    item.id,
                                    worker.runId,
                                  ),
                                )
                              })
                            }}
                          >
                            插队
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            aria-label={`取消待发送消息 ${index + 1}`}
                            disabled={busy || unavailable || (item.state === 'sending' && !!running)}
                            onClick={() =>
                              void perform(async () => {
                                value(await api.cliworker.cancelQueuedFollowup(sessionId, worker.id, item.id))
                              })
                            }
                          >
                            取消
                          </Button>
                        </div>
                      </li>
                    ))}
                  </ol>
                </div>
              </div>
            </section>
          )}
          <div className="cwn-compose-box">
            <textarea
              ref={composerInput}
              aria-label={startingNew ? '新建对话内容' : '继续对话'}
              value={prompt}
              onChange={(e) => editDraft(worker.id, e.target.value)}
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
              <WorkerModelMenu
                key={worker.id}
                worker={worker}
                api={api}
                sessionId={sessionId}
                disabled={retired || busy || unavailable || !!running || startingNew || !!resumeBlocked}
              />
              {running && (!prompt.trim() || worker.status === 'stopping' || stoppingRequest) ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="cwn-send"
                  aria-label="停止"
                  title="停止"
                  disabled={stoppingRequest || unavailable || worker.status === 'stopping'}
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
                  disabled={!canResume || busy || !prompt.trim()}
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
            statusLabel={status[worker.status]}
          />
        </form>
      )}
    </section>
  )
}
