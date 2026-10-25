import { en, type MessageKey } from './i18n-messages.ts'
import { t, uiLanguage } from './i18n.ts'

/** `<CLI> 已关闭…` and similar Host messages carry one variable part. */
const hostPatterns: [RegExp, MessageKey, string][] = [
  [/^(.+) 已关闭，请先在 CLI Worker 设置中开启$/u, '{cli} 已关闭，请先在 CLI Worker 设置中开启', 'cli'],
  [/^目标须包含 1–(\d+) 个字符$/u, '目标须包含 1–{limit} 个字符', 'limit'],
]

/**
 * Host text in the interface language when the dictionary knows it; other
 * Host and CLI text stays verbatim rather than guessing a translation.
 */
export function hostText(text: string): string
export function hostText(text: string | undefined): string | undefined
export function hostText(text: string | undefined): string | undefined {
  if (!text) return text
  if (Object.hasOwn(en, text)) return t(text as MessageKey)
  if (uiLanguage() !== 'en') return text
  // Stored run errors may keep an `Error: ` prefix; only a known message drops it.
  const bare = text.replace(/^(?:(?:[A-Za-z_$][\w$]*Error|Error):\s*)+/, '')
  if (bare !== text && Object.hasOwn(en, bare)) return t(bare as MessageKey)
  for (const [pattern, key, name] of hostPatterns) {
    const match = pattern.exec(bare)
    if (match) return t(key, { [name]: match[1]! })
  }
  return text
}

/** Keep transport traces out of the conversation and selection options. */
export function operationMessage(error: unknown): string {
  const text = String(error)
  if (/HTTP 404/.test(text)) return t('插件服务尚未更新，请重启 DeepSeek Harness 后重试。现有记录不会丢失。')
  if (/transport failure|Failed to fetch|NetworkError/.test(text)) return t('暂时无法连接插件服务，请稍后重试。')
  return hostText(
    text
      .replace(/^.*cliworker\/unavailable[^:]*:\s*/, '')
      .replace(/^(?:(?:[A-Za-z_$][\w$]*Error|Error):\s*)+/, ''),
  )
}
