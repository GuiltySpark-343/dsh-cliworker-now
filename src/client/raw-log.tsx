import { useEffect, useState } from 'react'
import { Button, Modal, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import { workerName, type Worker } from '../shared/types.ts'
import { value, type API } from './workers.ts'

/**
 * Bounded raw run log for one Worker run. The full stream stays on disk; this
 * dialog only ever shows a tail and says so, so a truncated mirror is never
 * mistaken for a complete transcript.
 */
export function RawLogDialog({
  api,
  sessionId,
  worker,
  onClose,
}: {
  api: API
  sessionId: string
  worker: Worker
  onClose: () => void
}) {
  const [state, setState] = useState<{
    loading: boolean
    text?: string
    size?: number
    truncated?: boolean
    missing?: boolean
    error?: string
  }>({ loading: true })
  useEffect(() => {
    const controller = new AbortController()
    void (async () => {
      try {
        const reply = value(
          await api.cliworker.workerRawLog(sessionId, worker.id, worker.runId, 262_144, controller.signal),
        )
        setState({ loading: false, ...reply })
      } catch (error) {
        if (!controller.signal.aborted) setState({ loading: false, error: String(error) })
      }
    })()
    return () => controller.abort()
  }, [])
  return (
    <Modal
      open
      onClose={onClose}
      title={`原始日志｜${workerName(worker)}`}
      closeLabel="关闭原始日志"
      className="cwn-raw-log-modal"
    >
      <div className="cwn-raw-log">
        {state.loading && (
          <p>
            <StateDot state="ongoing" size={14} /> 正在读取…
          </p>
        )}
        {state.error && (
          <p role="alert" className="cwn-warning">
            {state.error}
          </p>
        )}
        {state.missing && <p>这一轮没有原始日志（可能已被清理，或该轮未走原生桥）。</p>}
        {state.text !== undefined && (
          <>
            <p>
              文件共 {state.size?.toLocaleString()} 字节
              {state.truncated ? '，下面只显示尾部 256 KiB' : '，下面是完整内容'}
            </p>
            <pre className="cwn-raw-log-text">{state.text}</pre>
          </>
        )}
        <div className="cwn-raw-log-actions">
          <Button type="button" size="md" variant="outline" onClick={onClose}>
            关闭
          </Button>
        </div>
      </div>
    </Modal>
  )
}
