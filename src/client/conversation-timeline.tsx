import { Fragment, useEffect, useState } from 'react'
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import { CLI_LABELS, cliOf, active, type TimelineItem, type Worker } from '../shared/types.ts'
import { messageClock } from '../shared/telemetry.ts'
import { UsageIndicator } from './telemetry.tsx'
import { CopyText } from './copy-text.tsx'
import { Glyph } from './icons.tsx'
const labels: Record<string, string> = {
  completed: '已完成',
  failed: '失败',
  uncertain: '结果待核实',
  interrupted: '已中断',
  running: '运行中',
  queued: '排队中',
  stopping: '正在停止',
}
const markdownLabels = { code: { copyLabel: '复制', copiedLabel: '已复制' }, footnotes: '脚注' }
const runOf = (item: TimelineItem) => item.id.split(':')[0]
function completedEmptyReply(item: TimelineItem, worker?: Worker): boolean {
  return (
    item.kind === 'assistant' &&
    !item.text.trim() &&
    (item.state === 'DONE' ||
      !!item.runEndedAt ||
      (!!item.runOutcome && !active(item.runOutcome)) ||
      (worker?.runId === runOf(item) && !active(worker.status)))
  )
}
function ProcessRow({ item }: { item: TimelineItem }) {
  return item.kind === 'tool' || item.kind === 'diagnostic' || item.kind === 'reasoning' ? (
    <details className={`cwn-tool${item.kind === 'reasoning' ? ' cwn-reasoning' : ''}`}>
      <summary>
        {item.kind !== 'reasoning' && <Glyph name="tool" />}
        <span className="cwn-tool-title">{item.text}</span>
        <small title={item.runStatus ? `CLI 最后状态：${item.state}；未收到最终工具状态` : undefined}>
          {item.runStatus ? (item.runStatus === 'interrupted' ? '本轮已中断' : '本轮已结束') : item.state}
        </small>
      </summary>
      <pre>{item.detail}</pre>
    </details>
  ) : (
    <div className="cwn-process-event">{labels[item.state ?? item.text] ?? item.text}</div>
  )
}
function Progress({ rows, item, worker }: { rows: TimelineItem[]; item: TimelineItem; worker?: Worker }) {
  const [now, setNow] = useState(Date.now)
  const isRunning =
    !item.runEndedAt &&
    worker?.runId === runOf(item) &&
    ['running', 'queued', 'stopping'].includes(worker.status)
  useEffect(() => {
    if (!isRunning) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [isRunning])
  const start = Date.parse(item.runStartedAt ?? '')
  const end = item.runEndedAt ? Date.parse(item.runEndedAt) : isRunning ? now : NaN
  const seconds =
    Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, Math.floor((end - start) / 1000)) : undefined
  const label = labels[item.runOutcome ?? ''] ?? (isRunning ? labels[worker!.status] : '工作过程')
  return (
    <details className="cwn-progress">
      <summary>
        {label}
        {seconds !== undefined ? `，用时 ${seconds}秒` : ''}
        <span className="cwn-progress-chevron">
          <Glyph name="chevron" />
        </span>
      </summary>
      <div className="cwn-process-body">
        <p className="cwn-process-note">
          {rows.some((row) => row.kind === 'reasoning' && row.detail?.trim())
            ? '以下为 CLI 返回的公开思考、计划与工具记录。'
            : '本轮 CLI 未返回可展示的思考摘要；以下为已有工作记录。'}
        </p>
        {item.sessionDurationSeconds !== undefined && (
          <p className="cwn-process-note">CLI 会话累计耗时：{item.sessionDurationSeconds}秒</p>
        )}
        {rows
          .filter((row) =>
            row.kind === 'reasoning'
              ? !!row.detail?.trim()
              : !['user', 'assistant'].includes(row.kind) || completedEmptyReply(row, worker),
          )
          .map((row) =>
            row.kind === 'assistant' ? (
              <div key={row.id} className="cwn-process-event" data-empty-reply-id={row.id}>
                <span>无正文回复 · </span>
                <UsageIndicator usage={row.usage} reply />
                {row.durationSeconds !== undefined && <span> · CLI 报告耗时：{row.durationSeconds}秒</span>}
                <span> · </span>
                <time dateTime={row.time} title={new Date(row.time).toLocaleString('zh-CN')}>
                  {messageClock(row.time)}
                </time>
              </div>
            ) : (
              <ProcessRow key={row.id} item={row} />
            ),
          )}
      </div>
    </details>
  )
}
export function ConversationTimeline({
  items,
  latestItems = items,
  worker,
}: {
  items: TimelineItem[]
  latestItems?: TimelineItem[]
  worker?: Worker
}) {
  // Match rc.2 UserMessageNodeView / TurnTailNodeView. A newer user turn
  // hides the preceding assistant tail; a history page is never the live end.
  const latestUser = latestItems.findLast((item) => item.kind === 'user')?.id
  const lastContent = latestItems.findLast(
    (item) => ['user', 'assistant', 'tool'].includes(item.kind) && !completedEmptyReply(item, worker),
  )
  const latestReply =
    lastContent?.kind === 'assistant' &&
    lastContent.text.trim() &&
    !(worker && active(worker.status) && worker.runId === runOf(lastContent))
      ? lastContent.id
      : undefined
  const runs = new Map<string | undefined, TimelineItem[]>()
  for (const item of items) {
    const id = runOf(item)
    runs.set(id, [...(runs.get(id) ?? []), item])
  }
  const seen = new Set<string | undefined>()
  return (
    <>
      {items.map((item) => {
        const id = runOf(item)
        const first = item.kind !== 'user' && !seen.has(id)
        if (item.kind !== 'user') seen.add(id)
        return (
          <Fragment key={item.id}>
            {first && <Progress rows={runs.get(id)!} item={item} worker={worker} />}
            {(item.kind === 'user' || (item.kind === 'assistant' && !completedEmptyReply(item, worker))) && (
              <article
                className={`cwn-message ${item.kind}`}
                data-message-id={item.id}
                data-actions-reveal={
                  item.kind === 'user' ? (item.id === latestUser ? 'always' : 'hover') : undefined
                }
              >
                <div className={item.kind === 'assistant' ? 'cwn-markdown' : 'cwn-text'}>
                  {item.kind === 'assistant' ? (
                    <MarkdownText text={item.text} labels={markdownLabels} />
                  ) : (
                    item.text
                  )}
                </div>
                <div
                  className="cwn-message-tail"
                  data-actions-reveal={
                    item.kind === 'assistant' ? (item.id === latestReply ? 'always' : 'hover') : undefined
                  }
                >
                  <div className="cwn-message-label">
                    <span className="cwn-sr-only">
                      {item.kind === 'user' ? '你' : worker ? CLI_LABELS[cliOf(worker.preference)] : 'CLI'}
                    </span>
                    {item.kind === 'assistant' && item.text && (
                      <CopyText text={item.text} label="复制回复" iconOnly />
                    )}
                    {item.kind === 'assistant' && <UsageIndicator usage={item.usage} reply />}
                    <time dateTime={item.time} title={new Date(item.time).toLocaleString('zh-CN')}>
                      {messageClock(item.time)}
                    </time>
                    {item.kind === 'user' && item.text && (
                      <CopyText text={item.text} label="复制消息" iconOnly />
                    )}
                  </div>
                </div>
              </article>
            )}
          </Fragment>
        )
      })}
    </>
  )
}
