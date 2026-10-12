import { useEffect, useId, useRef, useState } from 'react'
import { Button, Input, StateDot, IconChevronDownOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { CLI_LABELS, type CliId } from '../shared/types.ts'
import type { CliExecutablePathStatus } from '../shared/cli-settings.ts'
import { operationMessage } from './operation-error.ts'
import { value, type API } from './workers.ts'

type PathAction = 'manual' | 'refresh' | 'auto'
function readPath(raw: string, cli: CliId): CliExecutablePathStatus {
  const next = JSON.parse(raw)
  if (
    next?.cli !== cli || typeof next.path !== 'string' || typeof next.available !== 'boolean' ||
    !['auto', 'manual', 'configured', 'none'].includes(next.source) ||
    (next.error !== undefined && typeof next.error !== 'string')
  ) throw new Error('收到不匹配的 CLI 路径信息，请刷新重试')
  return next
}

/** Path management remains usable for a disabled CLI and never saves model defaults. */
export function CliExecutableSettings({
  api, sessionId, cli, blocked, accountLoading, accountRevision, onApplied, onBusyChange,
}: {
  api: API
  sessionId: string
  cli: CliId
  blocked: boolean
  accountLoading: boolean
  accountRevision: unknown
  onApplied: () => void
  onBusyChange: (busy: boolean) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const [draft, setDraft] = useState('')
  const [current, setCurrent] = useState<CliExecutablePathStatus>()
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [feedback, setFeedback] = useState('')
  const contentId = useId()
  const inputId = useId()
  const hintId = useId()
  const draftRef = useRef(draft)
  const baseline = useRef('')
  const revision = useRef(0)
  const request = useRef<{ controller: AbortController; kind: 'read' | 'write' }>()
  const callbacks = useRef({ onApplied, onBusyChange })
  callbacks.current = { onApplied, onBusyChange }
  const service = api.cliworker

  useEffect(() => () => {
    request.current?.controller.abort()
    request.current = undefined
  }, [])

  useEffect(() => {
    if (request.current?.kind === 'write') return
    request.current?.controller.abort()
    request.current = undefined
    setLoading(false)
    if (!expanded || blocked || accountLoading) return
    const controller = new AbortController()
    const editRevision = revision.current
    const dirty = draftRef.current.trim() !== baseline.current
    request.current = { controller, kind: 'read' }
    setLoading(true)
    void (async () => {
      try {
        const next = readPath(value(await service.cliExecutablePath(sessionId, cli, controller.signal)), cli)
        if (controller.signal.aborted || revision.current !== editRevision) return
        baseline.current = next.path
        setCurrent(next)
        if (!dirty) {
          draftRef.current = next.path
          setDraft(next.path)
          setError(next.error || '')
        }
      } catch (error) {
        if (!controller.signal.aborted && revision.current === editRevision) setError(operationMessage(error))
      } finally {
        if (request.current?.controller === controller) {
          request.current = undefined
          setLoading(false)
        }
      }
    })()
  }, [service, sessionId, cli, expanded, blocked, accountLoading, accountRevision])

  async function refresh(action: PathAction) {
    if (blocked || request.current?.kind === 'write') return
    request.current?.controller.abort()
    const controller = new AbortController()
    const submitted = draftRef.current.trim()
    request.current = { controller, kind: 'write' }
    setLoading(false)
    setSaving(true)
    setError('')
    setFeedback('')
    callbacks.current.onBusyChange(true)
    try {
      const next = readPath(value(await service.refreshCliExecutablePath(
        sessionId, cli, submitted, action, controller.signal,
      )), cli)
      if (controller.signal.aborted) return
      baseline.current = next.path
      setCurrent(next)
      if (action === 'auto' || next.available) {
        draftRef.current = next.path
        setDraft(next.path)
      }
      setError(next.error || (!next.available ? '未找到可用 CLI，请检查路径后重试' : ''))
      setFeedback(next.available ? (action === 'auto' ? '已恢复自动识别' : 'CLI 路径已刷新') : '')
      // A saved but unavailable manual path must also invalidate the previous
      // account and models; the Host retains that explicit choice.
      callbacks.current.onApplied()
    } catch (error) {
      if (!controller.signal.aborted) setError(operationMessage(error))
    } finally {
      if (request.current?.controller === controller) {
        request.current = undefined
        setSaving(false)
        callbacks.current.onBusyChange(false)
      }
    }
  }

  const sourceLabel = current && {
    auto: '自动识别', manual: '手动指定', configured: '已配置路径', none: '未找到 CLI',
  }[current.source]
  return (
    <section className="cwn-settings-section" aria-label="高级设置">
      <div className="cwn-settings-section-head">
        <h3 className="cwn-settings-advanced-heading">
          <Button
            type="button" variant="ghost" size="md" className="cwn-settings-advanced-toggle"
            aria-label="高级设置" aria-expanded={expanded} aria-controls={contentId}
            onClick={() => setExpanded((old) => !old)}
          >
            <span>高级设置</span>
            <IconChevronDownOutlineRegular size={14} />
          </Button>
        </h3>
      </div>
      {expanded && (
        <div id={contentId} className="cwn-cli-path-settings">
          <h4>CLI 路径管理</h4>
          <p className="cwn-setting-description" id={hintId}>
            自动识别安装位置，也可输入 CLI 可执行文件的完整路径。
          </p>
          <form onSubmit={(event) => {
            event.preventDefault()
            void refresh(draftRef.current.trim() === baseline.current ? 'refresh' : 'manual')
          }}>
            <label htmlFor={inputId}>CLI 路径</label>
            <Input
              id={inputId} className="cwn-control-input cwn-cli-path-input"
              aria-label={`${CLI_LABELS[cli]} CLI 路径`} aria-describedby={hintId}
              value={draft} disabled={blocked || saving} spellCheck={false} autoComplete="off"
              placeholder="输入 CLI 可执行文件的完整路径"
              onChange={(event) => {
                revision.current++
                draftRef.current = event.target.value
                setDraft(event.target.value)
                setError('')
                setFeedback('')
              }}
            />
            <div className="cwn-cli-path-actions">
              <span className="cwn-cli-path-source">{sourceLabel || ''}</span>
              <Button type="button" variant="ghost" size="md" disabled={blocked || saving}
                onClick={() => void refresh('auto')}>恢复自动识别</Button>
              <Button type="submit" variant="outline" size="md" aria-label="刷新 CLI 路径"
                disabled={blocked || saving}>
                {(loading || saving) && <StateDot state="ongoing" size={14} />}
                刷新
              </Button>
            </div>
            <p className="cwn-cli-path-feedback" role="status">
              {blocked ? '请先结束当前账号操作或设置保存' : error || feedback || (loading ? '正在检查 CLI 路径…' : '')}
            </p>
          </form>
        </div>
      )}
    </section>
  )
}
