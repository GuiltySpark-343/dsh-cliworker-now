import { useEffect, useId, useRef, useState } from 'react'
import { Button, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import { MAX_CONCURRENT_LIMIT, type GeneralSettings } from '../shared/cli-settings.ts'
import { BrandIcon } from './icons.tsx'
import { NativeChoice } from './native-settings-choice.tsx'
import { operationMessage } from './operation-error.ts'
import { value, type API } from './workers.ts'

function readSettings(raw: string): GeneralSettings {
  const next = JSON.parse(raw)
  const count = (input: unknown) =>
    Number.isInteger(input) && (input as number) >= 1 && (input as number) <= MAX_CONCURRENT_LIMIT
  if (!count(next?.maxConcurrent) || !count(next?.defaultMaxConcurrent))
    throw new Error('收到无效的通用设置，请重试')
  return next
}

/** Profile-wide plugin settings; each section owns its own save feedback. */
export function GeneralSettingsPane({ api, sessionId }: { api: API; sessionId: string }) {
  const [settings, setSettings] = useState<GeneralSettings>()
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')
  const [attempt, retry] = useState(0)
  const hintId = useId()
  const request = useRef<AbortController>()
  const service = api.cliworker

  useEffect(() => {
    const controller = new AbortController()
    request.current = controller
    setLoading(true)
    setError('')
    void (async () => {
      try {
        const next = readSettings(value(await service.generalSettings(sessionId, controller.signal)))
        if (!controller.signal.aborted) setSettings(next)
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
  }, [service, sessionId, attempt])

  async function saveMaxConcurrent(count: number) {
    if (!settings || request.current || count === settings.maxConcurrent) return
    const controller = new AbortController()
    request.current = controller
    setSaving(true)
    setSaved(false)
    setError('')
    try {
      const next = readSettings(
        value(
          await service.saveGeneralSettings(sessionId, JSON.stringify({ maxConcurrent: count }), controller.signal),
        ),
      )
      if (controller.signal.aborted) return
      if (next.maxConcurrent !== count) throw new Error('同时对话数未保存，请重新选择重试')
      setSettings(next)
      setSaved(true)
    } catch (error) {
      if (!controller.signal.aborted) setError(operationMessage(error))
    } finally {
      if (request.current === controller) {
        request.current = undefined
        setSaving(false)
      }
    }
  }

  const choices = Array.from({ length: MAX_CONCURRENT_LIMIT }, (_, index) => {
    const count = index + 1
    return {
      id: String(count),
      label: count === settings?.defaultMaxConcurrent ? `${count}（默认）` : String(count),
    }
  })
  return (
    <div className="cwn-settings-pane" aria-label="CLI Worker 通用设置">
      <div className="cwn-cli-identity">
        <div className="cwn-settings-cli-name">
          <BrandIcon size={40} />
          <div>
            <h2>CLI Worker 设置</h2>
            <p className="cwn-cli-subtitle">适用于所有 CLI 与对话</p>
          </div>
        </div>
      </div>
      <section className="cwn-settings-section" aria-label="任务调度">
        <div className="cwn-settings-section-head">
          <h3>任务调度</h3>
          <div className="cwn-settings-section-tools">
            <span className="cwn-section-progress" role="status" aria-label={loading ? '正在读取通用设置' : undefined}>
              {loading && <StateDot state="ongoing" size={14} />}
            </span>
          </div>
        </div>
        <div className="cwn-settings-form">
          <div className="cwn-setting-row">
            <span className="cwn-setting-row-text">
              <span>最高同时对话数</span>
              <span className="cwn-setting-description" id={hintId}>
                所有 CLI 共用；超出后新任务排队。调低不会中断进行中的任务。
              </span>
            </span>
            <NativeChoice
              label="最高同时对话数"
              describedBy={hintId}
              selected={settings ? String(settings.maxConcurrent) : ''}
              placeholder={loading ? '正在读取…' : '选择数量'}
              choices={choices}
              disabled={loading || saving || !settings}
              onChange={(count) => void saveMaxConcurrent(Number(count))}
            />
          </div>
          {(saving || saved || error) && (
            <div className="cwn-settings-save">
              <span className="cwn-settings-feedback-slot" role="status">
                {saving && <StateDot state="ongoing" size={14} />}
                {error || (saving ? '正在保存同时对话数…' : '同时对话数已保存')}
              </span>
              {error && !settings && (
                <Button type="button" size="sm" variant="ghost" disabled={loading} onClick={() => retry((old) => old + 1)}>
                  重试读取通用设置
                </Button>
              )}
            </div>
          )}
        </div>
      </section>
    </div>
  )
}
