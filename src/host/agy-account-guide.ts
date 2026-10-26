import type { AccountAction, AccountGuide } from '../shared/accounts.ts'

/**
 * Screen texts of agy 1.4.7 (checked on macOS 2026-10-26). Whitespace is
 * ignored when matching, since a TUI may draw spaces as cursor moves.
 */
const MARKERS = {
  trust: 'Do you trust the contents of this project?',
  signedOut: 'You are currently not signed in.',
  method: 'Select login method',
  code: 'paste the authorization code',
  ready: '? for shortcuts',
} as const

export const AGY_GUIDES = {
  trust: { step: 'trust', tone: 'action', text: 'Antigravity 询问是否信任当前文件夹：选择「Yes, I trust this folder」后按回车。' },
  method: { step: 'method', tone: 'action', text: '第 1 步：用 ↑/↓ 选择「1. Google OAuth」，按回车。' },
  code: {
    step: 'code',
    tone: 'action',
    text: '第 2 步：在自动打开的浏览器中登录 Google 并授权，页面会显示授权码。复制授权码，点击下方终端后粘贴（右键，或 ⌘V / Ctrl+V）。浏览器没有打开时，在终端中选中登录链接复制到浏览器打开。',
  },
  pasted: { step: 'pasted', tone: 'action', text: '授权码已粘贴，请按回车完成登录。' },
  confirming: { step: 'confirming', tone: 'info', text: '正在确认登录…' },
  signedIn: { step: 'signedIn', tone: 'success', text: '已登录 Antigravity，可以关闭终端。' },
  unconfirmed: {
    step: 'unconfirmed',
    tone: 'warning',
    text: '暂未确认登录，请查看终端中的提示；授权码过期时请重新授权，粘贴新的授权码后按回车。',
  },
  alreadySignedIn: { step: 'alreadySignedIn', tone: 'info', text: '当前已登录 Antigravity；如需切换账号，请先退出登录。' },
  loggingOut: { step: 'loggingOut', tone: 'info', text: '正在退出 Antigravity…' },
  loggedOut: { step: 'loggedOut', tone: 'success', text: '已退出 Antigravity。' },
  notSignedIn: { step: 'notSignedIn', tone: 'info', text: '当前未登录 Antigravity，无需退出。' },
  logoutUnconfirmed: { step: 'logoutUnconfirmed', tone: 'warning', text: '未能确认已退出，请在终端中查看提示。' },
} as const satisfies Record<string, AccountGuide>

export type AgyGuideEvent =
  | { guide: AccountGuide }
  | { command: 'logout' }
  | { confirm: 'login' | 'logout' }

const SCREEN_LIMIT = 4096
// Drawing sequences carry no text: drop CSI/OSC/charset controls before matching.
const CONTROL = /\x1b\[[0-9;?<=>]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Za-z0-9]|\x1b[=>78]/g
const compact = (text: string) => text.replace(/\s+/g, '').toLowerCase()
const PATTERNS = Object.fromEntries(
  Object.entries(MARKERS).map(([key, value]) => [key, compact(value)]),
) as Record<keyof typeof MARKERS, string>

/** Follows one Antigravity login or logout terminal; never stores what the user types. */
export class AgyAccountGuide {
  private screen = ''
  private step?: string
  private typed = false
  private commandSent = false

  constructor(private readonly action: AccountAction) {}

  output(text: string): AgyGuideEvent[] {
    if (this.action === 'manage') return []
    this.screen = (this.screen + compact(text.replace(CONTROL, ''))).slice(-SCREEN_LIMIT)
    const seen = (marker: keyof typeof MARKERS) => this.screen.includes(PATTERNS[marker])
    if (this.action === 'logout') {
      if (this.commandSent || this.step) return []
      if (seen('trust') || seen('signedOut')) return this.show(seen('trust') ? AGY_GUIDES.trust : AGY_GUIDES.notSignedIn)
      if (!seen('ready')) return []
      this.commandSent = true
      return [...this.show(AGY_GUIDES.loggingOut), { command: 'logout' }]
    }
    // Login steps only move forward; a redraw of an earlier screen is ignored.
    if (seen('code') && this.order('code')) return this.show(AGY_GUIDES.code)
    if (seen('method') && this.order('method')) return this.show(AGY_GUIDES.method)
    if (seen('trust') && !this.step) return this.show(AGY_GUIDES.trust)
    if (seen('ready') && !seen('signedOut') && (!this.step || this.step === 'trust'))
      return this.show(AGY_GUIDES.alreadySignedIn)
    return []
  }

  input(data: string): AgyGuideEvent[] {
    if (this.action !== 'login' || (this.step !== 'code' && this.step !== 'pasted')) return []
    const enter = /[\r\n]/.test(data)
    const content = data.replace(/\x1b\[20[01]~/g, '').replace(/[\r\n]/g, '')
    // A bracketed or multi-character write is a paste; single keys are typing.
    const pasted = data.includes('\x1b[200~') || content.length >= 16
    if (content.length) this.typed = true
    if (enter && this.typed) return [...this.show(AGY_GUIDES.confirming), { confirm: 'login' }]
    if (pasted && this.step === 'code') return this.show(AGY_GUIDES.pasted)
    return []
  }

  /** The login could not be confirmed in time; the user may paste a fresh code. */
  unconfirmed(): AgyGuideEvent[] {
    this.typed = false
    this.step = 'code'
    return [{ guide: AGY_GUIDES.unconfirmed }]
  }

  private order(step: 'method' | 'code') {
    const rank = ['trust', 'method', 'code', 'pasted', 'confirming', 'signedIn', 'unconfirmed']
    return rank.indexOf(this.step ?? 'trust') < rank.indexOf(step) || !this.step
  }

  private show(guide: AccountGuide): AgyGuideEvent[] {
    this.step = guide.step
    return [{ guide }]
  }
}
