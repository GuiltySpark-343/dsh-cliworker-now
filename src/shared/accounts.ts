import type { CliId } from './types.ts'

export type AccountAction = 'login' | 'logout' | 'manage'
export type AccountSource = 'native' | 'plugin'
/** Explicit ZCode native login provider; unrelated to logout storage sources. */
export type ZCodeLoginProvider = 'bigmodel' | 'zai'
export interface AccountActionDescriptor {
  id: AccountAction
  label: string
  description: string
  target?: 'models'
  /** Logout applies only to the selected source, never all visible accounts. */
  sources?: { id: AccountSource; label: string }[]
}
/** Safe display projection of one authenticated provider; never raw credentials or route URLs. */
export interface AccountLogin {
  providerLabel: string
  authMethod: 'oauth' | 'api'
  /** Optional safe account email for OAuth only; API identities must never be displayed. */
  accountLabel?: string
}
export interface AccountStatus {
  cli: CliId
  installed: boolean
  /** unconfigured is absence; unauthenticated is known invalid/expired auth; unavailable is a read/config error. */
  state: 'authenticated' | 'unconfigured' | 'unauthenticated' | 'configured' | 'unknown' | 'unavailable'
  summary: string
  /** Display-only identity; never a token, API key, or key prefix. */
  authMethod?: 'oauth' | 'api'
  accountLabel?: string
  /** Each current provider retains its own login method. Absent on older Hosts. */
  logins?: AccountLogin[]
  /** A CLI status report or local session metadata, not a remote credential check. */
  verification?: 'cli' | 'local'
  actions: AccountActionDescriptor[]
}
/** A Host-authored step hint for an account terminal; never CLI output. */
export interface AccountGuide {
  step: string
  tone: 'info' | 'action' | 'success' | 'warning'
  text: string
  /** The native Google sign-in page, only an https://accounts.google.com address. */
  link?: string
}
/** Ephemeral, user-operated terminal transport; never stored with worker events. */
export interface AccountFrame {
  seq: number
  data?: string
  status?: 'running' | 'closed' | 'failed'
  message?: string
  /** Current guide; absent on older Hosts and for CLIs without one. */
  guide?: AccountGuide
  /** Host has confirmed process-range exit and released account resources. */
  cleanupConfirmed?: boolean
}
