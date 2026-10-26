import type { CliId } from './types.ts'

/**
 * Sign-in pages each CLI's own login prints, the only addresses a login window
 * may open. `.example.com` also allows subdomains. Checked by Host and Client.
 */
export const ACCOUNT_LOGIN_HOSTS: Partial<Record<CliId, readonly string[]>> = {
  antigravity: ['accounts.google.com'],
  codex: ['auth.openai.com'],
  claude: ['claude.com', 'claude.ai'],
  qoder: ['qoder.com'],
  qodercn: ['qoder.cn'],
  grok: ['accounts.x.ai', 'auth.x.ai'],
  zcode: ['.bigmodel.cn', '.z.ai'],
  mimo: ['platform.xiaomimimo.com'],
}

/** An https address on one of `hosts`, without user info; trailing punctuation is not part of it. */
export function allowedLink(value: string | undefined, hosts: readonly string[] | undefined): string | undefined {
  if (!value || !hosts?.length) return undefined
  try {
    const url = new URL(value.replace(/[.,;:)\]]+$/, ''))
    const host = url.hostname.toLowerCase()
    const ok = hosts.some((item) => (item.startsWith('.') ? host.endsWith(item) || host === item.slice(1) : host === item))
    return url.protocol === 'https:' && ok && !url.username && !url.password ? url.href : undefined
  } catch {
    return undefined
  }
}

/** CLIs whose login and logout the plugin draws (Host flows); others keep their native terminal. */
export const GUIDED_ACCOUNT_CLIS: ReadonlySet<CliId> = new Set<CliId>(['antigravity', 'codex', 'claude', 'qoder', 'qodercn', 'grok', 'zcode', 'mimo'])
/** CLIs that hold one account at a time; signing in again means switching accounts. */
export const SINGLE_ACCOUNT_CLIS: ReadonlySet<CliId> = new Set<CliId>([
  'antigravity',
  'codex',
  'claude',
  'qoder',
  'qodercn',
  'mimo',
  'grok',
])
