import { useEffect, useRef, useState } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HistoryPage, QueuedFollowup, TimelineItem, Worker } from '../shared/types.ts'
import { ConversationTimeline } from './conversation-timeline.tsx'
import { operationMessage } from './operation-error.ts'
import { value, type API } from './workers.ts'

export const harnessLegacyHistoryNotice = '原生对话从本次挂接开始；更早记录见旧历史。'

/** Reads the existing WorkerStorage Gateway only; never imports, copies or replays a turn. */
export function HarnessLegacyHistory({
  api,
  parentSessionId,
  worker,
  items,
  truncated,
  queuedFollowups = [],
}: {
  api: API
  parentSessionId: string
  worker: Worker
  items: TimelineItem[]
  truncated: boolean
  queuedFollowups?: readonly QueuedFollowup[]
}) {
  const [opened, setOpened] = useState<{ items: TimelineItem[]; truncated: boolean; queuedFollowups: readonly QueuedFollowup[] }>()
  const [page, setPage] = useState<HistoryPage>()
  const [error, setError] = useState('')
  const [pending, setPending] = useState(false)
  const request = useRef<AbortController>()
  useEffect(() => () => request.current?.abort(), [])
  const close = () => {
    request.current?.abort()
    request.current = undefined
    setOpened(undefined)
    setPage(undefined)
    setPending(false)
    setError('')
  }
  const visible = page?.items ?? opened?.items ?? []
  const load = async (direction: 'before' | 'after') => {
    if (request.current || !opened || !visible.length) return
    const controller = new AbortController()
    request.current = controller
    setPending(true)
    setError('')
    const anchor = direction === 'before' ? visible[0]!.id : visible.at(-1)!.id
    try {
      const next = JSON.parse(
        value(await api.cliworker.history(parentSessionId, worker.id, anchor, direction)),
      ) as HistoryPage
      if (next.workerId !== worker.id || !Array.isArray(next.items)) throw new Error('收到不匹配的旧历史记录')
      if (!controller.signal.aborted) setPage(next)
    } catch (cause) {
      if (!controller.signal.aborted) setError(operationMessage(cause))
    } finally {
      if (!controller.signal.aborted) {
        request.current = undefined
        setPending(false)
      }
    }
  }
  return (
    <>
      <p>{harnessLegacyHistoryNotice}</p>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        onClick={() => {
          setOpened({ items: [...items], truncated, queuedFollowups: queuedFollowups.map((item) => ({ ...item })) })
          setPage(undefined)
          setError('')
        }}
      >
        旧历史
      </Button>
      <Modal
        open={!!opened}
        title="旧历史"
        closeLabel="关闭旧历史"
        onClose={close}
        className="cwn-legacy-history-dialog"
        contentClassName="cwn-legacy-history-content"
      >
        <p>此处只读原 Worker 记录，不重新发送任务。页面保持本次读取时的内容。</p>
        {!!opened?.queuedFollowups.length && (
          <section aria-label="只读旧待发消息">
            <p>旧待发消息仅供核对，不会加入原生队列或自动发送。</p>
            <ul>{opened.queuedFollowups.map((item) => (
              <li key={item.id}>
                <span>{item.state === 'paused' ? '已暂停' : '旧待发消息'}</span>
                <p style={{ whiteSpace: 'pre-wrap' }}>{item.prompt}</p>
                {item.pauseReason && <small>{item.pauseReason}</small>}
              </li>
            ))}</ul>
          </section>
        )}
        <div className="cwn-legacy-history-nav">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={pending || !(page?.hasOlder ?? opened?.truncated) || !visible.length}
            onClick={() => void load('before')}
          >
            更早记录
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={pending || !page?.hasNewer || !visible.length}
            onClick={() => void load('after')}
          >
            较新记录
          </Button>
          {page && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={pending}
              onClick={() => {
                setPage(undefined)
                setError('')
              }}
            >
              返回打开时记录
            </Button>
          )}
          <span>
            {pending
              ? '正在读取…'
              : page
                ? `历史记录 ${page.start + 1}–${page.end} · 读取时共 ${page.total} 条`
                : '本次打开时的最近记录'}
          </span>
        </div>
        {error && <p role="alert">{error}</p>}
        <div className="cwn-legacy-history-rows" aria-label="只读旧历史">
          {visible.length ? (
            <ConversationTimeline items={visible} latestItems={visible} />
          ) : (
            <p>没有可显示的旧记录。</p>
          )}
        </div>
      </Modal>
    </>
  )
}
