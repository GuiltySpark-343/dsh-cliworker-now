import { useEffect, useRef, useState } from 'react'
import { Button, Modal, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import { workerName, type Worker } from '../shared/types.ts'
import { hostText, operationMessage } from './operation-error.ts'
import { t, useT } from './i18n.ts'
import { value, type API } from './workers.ts'

export type IsolationAction = 'merge' | 'discard'
type MergeResult =
  | { status: 'merged'; written: string[]; deleted: string[] }
  | { status: 'conflict'; conflicts: { path: string; reason: string }[]; copy: string }

// Local placement for the native Modal; reuses the rename dialog layout.
export const isolationStyles = `
.cwn-worker-isolation{grid-column:1;grid-row:3;display:flex;align-items:center;gap:4px;min-width:0;margin-top:6px;color:var(--cwn-muted);font-size:var(--dsw-font-xxs-12-font-size);line-height:20px}
.cwn-worker-isolation>span{flex:1;min-width:0;overflow-wrap:anywhere}
.cwn-worker-isolation[data-tone=warn]{color:var(--dsw-alias-state-warn-label)}
.cwn-isolation-body{display:flex;flex-direction:column;gap:12px;min-width:0;width:100%}
.cwn-isolation-body>p{margin:0;font-size:var(--dsw-font-xxs-12-font-size);line-height:20px;color:var(--dsw-alias-label-secondary)}
.cwn-isolation-list{margin:0;padding:0 0 0 16px;max-height:220px;overflow:auto;font-size:var(--dsw-font-xxs-12-font-size);line-height:20px;overflow-wrap:anywhere}
.cwn-isolation-path{font-family:ui-monospace,monospace;user-select:text}
`
const LISTED = 50

/** Merge or discard one Worker's isolated copy; both require an explicit click here. */
export function IsolationDialog({
  api,
  sessionId,
  worker,
  action,
  onClose,
}: {
  api: API
  sessionId: string
  worker: Worker
  action: IsolationAction
  onClose: () => void
}) {
  useT()
  const [working, setWorking] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<MergeResult>()
  const pending = useRef<AbortController>()
  useEffect(() => () => pending.current?.abort(), [])
  const close = () => {
    pending.current?.abort()
    pending.current = undefined
    onClose()
  }
  const run = async () => {
    if (pending.current) return
    const controller = new AbortController()
    pending.current = controller
    setWorking(true)
    setError('')
    try {
      if (action === 'merge') {
        const next: MergeResult = JSON.parse(
          value(await api.cliworker.mergeIsolation(sessionId, worker.id, controller.signal)),
        )
        if (!controller.signal.aborted) setResult(next)
      } else {
        value(await api.cliworker.discardIsolation(sessionId, worker.id, controller.signal))
        if (!controller.signal.aborted) onClose()
      }
    } catch (e) {
      if (!controller.signal.aborted) setError(operationMessage(e))
    } finally {
      if (!controller.signal.aborted) {
        pending.current = undefined
        setWorking(false)
      }
    }
  }
  const merge = action === 'merge'
  const listed = (paths: string[]) => (
    <ul className="cwn-isolation-list">
      {paths.slice(0, LISTED).map((path) => (
        <li key={path}>{path}</li>
      ))}
      {paths.length > LISTED && <li>{t('另有 {count} 项', { count: paths.length - LISTED })}</li>}
    </ul>
  )
  return (
    <Modal
      open
      onClose={close}
      title={merge ? t('合并隔离副本') : t('丢弃隔离副本')}
      closeLabel={merge ? t('关闭合并隔离副本') : t('关闭丢弃隔离副本')}
      className="cwn-rename-dialog"
      contentClassName="cwn-rename-content"
    >
      <div className="cwn-isolation-body">
        {!result && (
          <p>
            {merge
              ? t('把 {name} 在副本中的改动写回项目。写回为未提交改动，不会创建提交；有冲突时项目不做任何改动，副本保留。', {
                  name: workerName(worker),
                })
              : t('丢弃后，{name} 副本中的改动将永久删除，项目主目录不变。', { name: workerName(worker) })}
          </p>
        )}
        {result?.status === 'merged' && (
          <>
            <p>
              {t('已写回 {written} 个、删除 {deleted} 个文件，均为未提交改动；副本已清理。', {
                written: result.written.length,
                deleted: result.deleted.length,
              })}
            </p>
            {!!result.written.length && listed(result.written)}
            {!!result.deleted.length && listed(result.deleted.map((path) => t('已删除：{path}', { path })))}
          </>
        )}
        {result?.status === 'conflict' && (
          <>
            <p>{t('有 {count} 个冲突，项目没有任何改动，副本已保留。可查看副本中的文件后手动处理，或丢弃副本。', { count: result.conflicts.length })}</p>
            {listed(result.conflicts.map((item) => `${item.path} — ${hostText(item.reason)}`))}
            <p>
              {t('副本位置：')}<span className="cwn-isolation-path">{result.copy}</span>
            </p>
          </>
        )}
        {error && (
          <div className="cwn-rename-error" role="alert">
            {error}
          </div>
        )}
        <div className="cwn-rename-actions">
          {result ? (
            <Button type="button" size="md" variant="primary" data-modal-autofocus onClick={close}>
              {t('完成')}
            </Button>
          ) : (
            <>
              <Button type="button" size="md" variant="outline" onClick={close}>
                {t('取消')}
              </Button>
              <Button
                type="button"
                size="md"
                variant="primary"
                data-modal-autofocus
                disabled={working}
                onClick={() => void run()}
              >
                {working && <StateDot state="ongoing" size={14} />}
                {merge ? t('合并') : t('丢弃')}
              </Button>
            </>
          )}
        </div>
      </div>
    </Modal>
  )
}
