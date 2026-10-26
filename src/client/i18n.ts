import { useSyncExternalStore } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { LanguagePreference } from '../shared/cli-settings.ts'
import { effortLabel as sharedEffortLabel } from '../shared/types.ts'
import { en, type MessageKey } from './i18n-messages.ts'

export type { MessageKey } from './i18n-messages.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** CLI Worker copy; the Chinese source text is the key. */
    cliworker: MessageKey
  }
}

export const LOCALE_NS = 'cliworker'
export type UiLanguage = 'zh' | 'en'
export type TranslateParams = Record<string, string | number>
export type Translate = (key: MessageKey, params?: TranslateParams) => string

/** The Chinese dictionary is the identity map over the source keys. */
export const zh = Object.fromEntries(Object.keys(en).map((key) => [key, key])) as Record<MessageKey, string>

interface HarnessLocale {
  active: string
  revision: number
  translate: (key: string, params?: TranslateParams) => string
}

// One module-level store: copy is also produced by plain helpers (status
// labels, errors, formatting) that never receive props.
let preference: LanguagePreference = 'follow'
let harness: HarnessLocale | undefined
let revision = 0
const listeners = new Set<() => void>()

const fill = (template: string, params?: TranslateParams) =>
  params ? template.replace(/\{(\w+)\}/g, (match, name: string) => (name in params ? String(params[name]) : match)) : template

function lookup(key: MessageKey, params?: TranslateParams): string {
  if (preference === 'follow' && harness) return harness.translate(key, params)
  return fill(uiLanguage() === 'en' ? en[key] : key, params)
}

/** Rebound per revision so memoized consumers keyed on `t` refresh. */
let bound: Translate = (key, params) => lookup(key, params)

function publish() {
  revision += 1
  bound = (key, params) => lookup(key, params)
  for (const listener of listeners) listener()
}

/** Effective language: an explicit choice, else DSH's, else Chinese without a locale service. */
export function uiLanguage(): UiLanguage {
  if (preference !== 'follow') return preference
  if (!harness) return 'zh'
  return /^zh(?:-|$)/i.test(harness.active) ? 'zh' : 'en'
}

/** BCP 47 tag for dates and numbers in the effective language. */
export const formatLocale = () => (uiLanguage() === 'en' ? 'en-US' : 'zh-CN')

/** Translate at call time; components rendering copy must also call {@link useT}. */
export const t: Translate = (key, params) => bound(key, params)

/** Effort names stay native except the plugin's own `default` label. */
export const effortLabel = (effort: string) => (effort === 'default' ? t('默认') : sharedEffortLabel(effort))

export function languagePreference(): LanguagePreference {
  return preference
}

/** Adopt a saved or streamed preference; unknown values are ignored. */
export function setLanguagePreference(next: unknown): void {
  const value: LanguagePreference | undefined =
    next === undefined ? 'follow' : next === 'follow' || next === 'zh' || next === 'en' ? next : undefined
  if (!value || value === preference) return
  preference = value
  publish()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
const currentRevision = () => revision

/** Subscribe the calling component to language changes and return the current translator. */
export function useT(): Translate {
  useSyncExternalStore(subscribe, currentRevision, currentRevision)
  return bound
}

/**
 * Register the `cliworker` dictionaries with Harness locale and follow its
 * active language. Both are owned effects of the optional `locale` scope.
 */
export function installClientLocale(ctx: Context): void {
  ctx.inject(['locale'], (scope) => {
    const locale = scope.locale
    scope.effect(() => locale.register(LOCALE_NS, { zh, en }), 'cliworker:locale-dictionary')
    scope.effect(() => {
      const translate = locale.bind(LOCALE_NS) as HarnessLocale['translate']
      const sync = () => {
        const snapshot = locale.getLocale()
        if (harness?.active === snapshot.active && harness.revision === snapshot.revision) return
        harness = { active: snapshot.active, revision: snapshot.revision, translate }
        publish()
      }
      sync()
      const off = locale.subscribe(sync)
      return () => {
        off()
        harness = undefined
        publish()
      }
    }, 'cliworker:locale-follow')
  })
}
