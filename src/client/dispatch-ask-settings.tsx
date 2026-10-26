import { useEffect, useId, useRef, useState } from 'react'
import { Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CliId } from '../shared/types.ts'
import type { DispatchAskSettings } from '../shared/dispatch-ask.ts'
import { operationMessage } from './operation-error.ts'
import { value, type API } from './workers.ts'

function readSettings(raw: string, cli: CliId): DispatchAskSettings {
  const next = JSON.parse(raw)
  if (next?.cli !== cli || typeof next.ask !== 'boolean') throw new Error('收到不匹配的调用前询问设置，请重试')
  return next
}

/** Keyed by project session and CLI in the parent; saves immediately with no success text. */
export function DispatchAskRow({
  api,
  sessionId,
  cli,
  disabled,
}: {
  api: API
  sessionId: string
  cli: CliId
  disabled: boolean
}) {
  const [ask, setAsk] = useState<boolean>()
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const hintId = useId()
  const request = useRef<AbortController>()
  const service = api.cliworker

  useEffect(() => {
    const controller = new AbortController()
    request.current = controller
    void (async () => {
      try {
        const next = readSettings(value(await service.dispatchAskSettings(sessionId, cli, controller.signal)), cli)
        if (!controller.signal.aborted) setAsk(next.ask)
      } catch (error) {
        if (!controller.signal.aborted) setError(operationMessage(error))
      } finally {
        if (request.current === controller) request.current = undefined
      }
    })()
    return () => {
      controller.abort()
      request.current = undefined
    }
  }, [service, sessionId, cli])

  async function save(next: boolean) {
    if (ask === undefined || disabled || request.current) return
    const previous = ask
    const controller = new AbortController()
    request.current = controller
    setAsk(next)
    setSaving(true)
    setError('')
    try {
      const saved = readSettings(value(await service.setDispatchAsk(sessionId, cli, next, controller.signal)), cli)
      if (controller.signal.aborted) return
      if (saved.ask !== next) throw new Error('调用前询问设置未保存，请重试')
    } catch (error) {
      if (!controller.signal.aborted) {
        setAsk(previous)
        setError(operationMessage(error))
      }
    } finally {
      if (request.current === controller) {
        request.current = undefined
        setSaving(false)
      }
    }
  }

  return (
    <>
      <div className="cwn-setting-row">
        <span className="cwn-setting-row-text">
          <span>调用前询问模型</span>
          <span className="cwn-setting-description" id={hintId}>
            关闭后直接使用本项目的默认模型、强度与上次确认的角色；无有效设定时仍会询问
          </span>
        </span>
        <Switch
          checked={ask ?? true}
          onChange={(next: boolean) => void save(next)}
          label="调用前询问模型"
          aria-describedby={hintId}
          disabled={disabled || saving || ask === undefined}
        />
      </div>
      <p className="cwn-settings-notice cwn-settings-hint" role="status">
        {error}
      </p>
    </>
  )
}
