import { useEffect, useId, useRef, useState } from 'react'
import { Button, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  LANGUAGE_PREFERENCES,
  MAX_CONCURRENT_LIMIT,
  type GeneralSettings,
  type LanguagePreference,
} from '../shared/cli-settings.ts'
import { BrandIcon } from './icons.tsx'
import { NativeChoice } from './native-settings-choice.tsx'
import { operationMessage } from './operation-error.ts'
import { value, type API } from './workers.ts'
import { setLanguagePreference, t, useT, type MessageKey } from './i18n.ts'

function readSettings(raw: string): GeneralSettings {
  const next = JSON.parse(raw)
  const count = (input: unknown) =>
    Number.isInteger(input) && (input as number) >= 1 && (input as number) <= MAX_CONCURRENT_LIMIT
  // An absent language is an older Host's `follow`; any other value is rejected.
  const language = next?.language ?? 'follow'
  if (!count(next?.maxConcurrent) || !count(next?.defaultMaxConcurrent) || !LANGUAGE_PREFERENCES.includes(language))
    throw new Error(t('收到无效的通用设置，请重试'))
  return { ...next, language }
}

type Field = 'language' | 'maxConcurrent'
const SAVING: Record<Field, MessageKey> = { language: '正在保存界面语言…', maxConcurrent: '正在保存同时对话数…' }
const SAVED: Record<Field, MessageKey> = { language: '界面语言已保存', maxConcurrent: '同时对话数已保存' }
const UNSAVED: Record<Field, MessageKey> = {
  language: '界面语言未保存，请重新选择重试',
  maxConcurrent: '同时对话数未保存，请重新选择重试',
}
// Each language is named in itself, so the choice stays findable after a switch.
const LANGUAGE_LABELS: Record<LanguagePreference, () => string> = {
  follow: () => t('跟随 DSH'),
  zh: () => '中文',
  en: () => 'English',
}

/** Profile-wide plugin settings; each section owns its own save feedback. */
export function GeneralSettingsPane({ api, sessionId }: { api: API; sessionId: string }) {
  const t = useT()
  const [settings, setSettings] = useState<GeneralSettings>()
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState<Field>()
  const [saved, setSaved] = useState<Field>()
  const [error, setError] = useState<{ field?: Field; message: string }>()
  const [attempt, retry] = useState(0)
  const languageHintId = useId()
  const hintId = useId()
  const request = useRef<AbortController>()
  const service = api.cliworker

  useEffect(() => {
    const controller = new AbortController()
    request.current = controller
    setLoading(true)
    setError(undefined)
    void (async () => {
      try {
        const next = readSettings(value(await service.generalSettings(sessionId, controller.signal)))
        if (controller.signal.aborted) return
        setSettings(next)
        setLanguagePreference(next.language)
      } catch (error) {
        if (!controller.signal.aborted) setError({ message: operationMessage(error) })
      } finally {
        if (request.current === controller) {
          request.current = undefined
          setLoading(false)
        }
      }
    })()
    return () => controller.abort()
  }, [service, sessionId, attempt])

  async function save<K extends Field>(field: K, next: GeneralSettings[K]) {
    if (!settings || request.current || next === settings[field]) return
    const controller = new AbortController()
    request.current = controller
    setSaving(field)
    setSaved(undefined)
    setError(undefined)
    try {
      const updated = readSettings(
        value(await service.saveGeneralSettings(sessionId, JSON.stringify({ [field]: next }), controller.signal)),
      )
      if (controller.signal.aborted) return
      if (updated[field] !== next) throw new Error(t(UNSAVED[field]))
      setSettings(updated)
      // Switch the whole plugin at once; other windows follow through the Worker stream.
      if (field === 'language') setLanguagePreference(updated.language)
      setSaved(field)
    } catch (error) {
      if (!controller.signal.aborted) setError({ field, message: operationMessage(error) })
    } finally {
      if (request.current === controller) {
        request.current = undefined
        setSaving(undefined)
      }
    }
  }

  const feedback = (field: Field) =>
    (saving === field || saved === field || error?.field === field) && (
      <div className="cwn-settings-save">
        <span className="cwn-settings-feedback-slot" role="status">
          {saving === field && <StateDot state="ongoing" size={14} />}
          {error?.field === field ? error.message : saving === field ? t(SAVING[field]) : t(SAVED[field])}
        </span>
      </div>
    )
  const progress = (
    <span className="cwn-section-progress" role="status" aria-label={loading ? t('正在读取通用设置') : undefined}>
      {loading && <StateDot state="ongoing" size={14} />}
    </span>
  )
  const disabled = loading || !!saving || !settings
  const placeholder = loading ? t('正在读取…') : undefined
  const choices = Array.from({ length: MAX_CONCURRENT_LIMIT }, (_, index) => {
    const count = index + 1
    return {
      id: String(count),
      label: count === settings?.defaultMaxConcurrent ? t('{count}（默认）', { count }) : String(count),
    }
  })
  return (
    <div className="cwn-settings-pane" aria-label={t('CLI Worker 通用设置')}>
      <div className="cwn-cli-identity">
        <div className="cwn-settings-cli-name">
          <BrandIcon size={40} />
          <div>
            <h2>{t('CLI Worker 设置')}</h2>
            <p className="cwn-cli-subtitle">{t('适用于所有 CLI 与对话')}</p>
          </div>
        </div>
      </div>
      <section className="cwn-settings-section" aria-label={t('语言')}>
        <div className="cwn-settings-section-head">
          <h3>{t('语言')}</h3>
          <div className="cwn-settings-section-tools">{progress}</div>
        </div>
        <div className="cwn-settings-form">
          <div className="cwn-setting-row">
            <span className="cwn-setting-row-text">
              <span>{t('界面语言')}</span>
              <span className="cwn-setting-description" id={languageHintId}>
                {t('跟随 DSH 时与 DeepSeek Harness 当前语言一致；只影响 CLI Worker 界面。')}
              </span>
            </span>
            <NativeChoice
              label={t('界面语言')}
              describedBy={languageHintId}
              selected={settings?.language ?? ''}
              placeholder={placeholder ?? t('选择语言')}
              choices={LANGUAGE_PREFERENCES.map((id) => ({ id, label: LANGUAGE_LABELS[id]() }))}
              disabled={disabled}
              onChange={(language) => void save('language', language as LanguagePreference)}
            />
          </div>
          {feedback('language')}
        </div>
      </section>
      <section className="cwn-settings-section" aria-label={t('任务调度')}>
        <div className="cwn-settings-section-head">
          <h3>{t('任务调度')}</h3>
        </div>
        <div className="cwn-settings-form">
          <div className="cwn-setting-row">
            <span className="cwn-setting-row-text">
              <span>{t('最高同时对话数')}</span>
              <span className="cwn-setting-description" id={hintId}>
                {t('所有 CLI 共用；超出后新任务排队。调低不会中断进行中的任务。')}
              </span>
            </span>
            <NativeChoice
              label={t('最高同时对话数')}
              describedBy={hintId}
              selected={settings ? String(settings.maxConcurrent) : ''}
              placeholder={placeholder ?? t('选择数量')}
              choices={choices}
              disabled={disabled}
              onChange={(count) => void save('maxConcurrent', Number(count))}
            />
          </div>
          {feedback('maxConcurrent')}
          {error && !error.field && (
            <div className="cwn-settings-save">
              <span className="cwn-settings-feedback-slot" role="status">
                {error.message}
              </span>
              {!settings && (
                <Button type="button" size="sm" variant="ghost" disabled={loading} onClick={() => retry((old) => old + 1)}>
                  {t('重试读取通用设置')}
                </Button>
              )}
            </div>
          )}
        </div>
      </section>
    </div>
  )
}
