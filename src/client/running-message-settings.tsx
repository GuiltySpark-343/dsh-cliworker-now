import { useEffect, useId, useRef, useState } from 'react'
import { Button, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CliId } from '../shared/types.ts'
import {
  RUNNING_MESSAGE_LABELS,
  type RunningMessageMode,
  type RunningMessageSettings,
} from '../shared/running-message.ts'
import { NativeChoice } from './native-settings-choice.tsx'
import { operationMessage } from './operation-error.ts'
import { value, type API } from './workers.ts'
import { t, useT, type MessageKey } from './i18n.ts'
import { hostText } from './operation-error.ts'

function readSettings(raw: string, cli: CliId): RunningMessageSettings {
  const next = JSON.parse(raw)
  if (
    next?.cli !== cli ||
    !['steer', 'interrupt', 'queue'].includes(next.mode) ||
    typeof next.canSteer !== 'boolean' ||
    (next.mode === 'steer' && !next.canSteer)
  )
    throw new Error(t('收到不匹配的运行中发送设置，请重试'))
  return next
}

const descriptions: Record<RunningMessageMode, MessageKey> = {
  steer: '立即交给 CLI 在当前运行中处理，不保证打断正在生成的内容。',
  interrupt: '先停止当前轮，确认停止后沿原对话优先发送。',
  queue: '等待当前轮正常结束后，沿原对话按顺序发送。',
}

/** Keyed by project session and CLI in the parent: late reads/writes cannot cross settings pages. */
export function RunningMessageChoice({
  api,
  sessionId,
  cli,
  expanded,
  blocked,
  onBusyChange,
}: {
  api: API
  sessionId: string
  cli: CliId
  expanded: boolean
  blocked: boolean
  onBusyChange: (busy: boolean) => void
}) {
  useT()
  const [settings, setSettings] = useState<RunningMessageSettings>()
  const [selected, setSelected] = useState<RunningMessageMode>()
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [attempt, retry] = useState(0)
  const hintId = useId()
  const request = useRef<AbortController>()
  const busyCallback = useRef(onBusyChange)
  busyCallback.current = onBusyChange
  const service = api.cliworker

  useEffect(
    () => () => {
      request.current?.abort()
      request.current = undefined
      busyCallback.current(false)
    },
    [],
  )

  useEffect(() => {
    if (!expanded || blocked || settings) return
    const controller = new AbortController()
    request.current = controller
    setLoading(true)
    setError('')
    void (async () => {
      try {
        const next = readSettings(
          value(await service.runningMessageSettings(sessionId, cli, controller.signal)),
          cli,
        )
        if (controller.signal.aborted) return
        setSettings(next)
        setSelected(next.mode)
      } catch (error) {
        if (!controller.signal.aborted) setError(operationMessage(error))
      } finally {
        if (request.current === controller) {
          request.current = undefined
          setLoading(false)
        }
      }
    })()
    return () => controller.abort()
  }, [service, sessionId, cli, expanded, blocked, !!settings, attempt])

  async function save(mode: RunningMessageMode) {
    if (!settings || blocked || request.current || (mode === 'steer' && !settings.canSteer)) return
    const controller = new AbortController()
    request.current = controller
    setSelected(mode)
    setSaving(true)
    setError('')
    busyCallback.current(true)
    try {
      const next = readSettings(
        value(await service.saveRunningMessageMode(sessionId, cli, mode, controller.signal)),
        cli,
      )
      if (controller.signal.aborted) return
      if (next.mode !== mode) throw new Error(t('发送方式未保存，请重新选择重试'))
      setSettings(next)
    } catch (error) {
      if (!controller.signal.aborted) setError(operationMessage(error))
    } finally {
      if (request.current === controller) {
        request.current = undefined
        setSaving(false)
        busyCallback.current(false)
      }
    }
  }

  return (
    <div className="cwn-settings-form cwn-running-message-settings">
      <div className="cwn-setting-row">
        <span className="cwn-setting-row-text">
          <span>{t('运行中发送')}</span>
          <span className="cwn-setting-description" id={hintId}>
            {selected ? t(descriptions[selected]) : t('选择对话运行中发送新消息的方式。')}
            {settings && !settings.canSteer ? t(' 当前 CLI 不支持引导。') : ''}
          </span>
        </span>
        <NativeChoice
          label={t('运行中发送')}
          describedBy={hintId}
          selected={selected ?? ''}
          placeholder={loading ? t('正在读取…') : t('选择发送方式')}
          choices={[
            { id: 'steer', label: hostText(RUNNING_MESSAGE_LABELS.steer), disabled: !settings?.canSteer },
            { id: 'interrupt', label: hostText(RUNNING_MESSAGE_LABELS.interrupt) },
            { id: 'queue', label: hostText(RUNNING_MESSAGE_LABELS.queue) },
          ]}
          disabled={blocked || loading || saving || !settings}
          onChange={(mode) => void save(mode as RunningMessageMode)}
        />
      </div>
      {(loading || saving || error) && (
        <div className="cwn-settings-save">
          <span className="cwn-settings-feedback-slot" role="status">
            {(loading || saving) && <StateDot state="ongoing" size={14} />}
            {error || (loading ? t('正在读取发送方式…') : t('正在保存发送方式…'))}
          </span>
          {error && !settings && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={blocked || loading}
              onClick={() => retry((old) => old + 1)}
            >
              {t('重试读取发送方式')}
            </Button>
          )}
        </div>
      )}
    </div>
  )
}
