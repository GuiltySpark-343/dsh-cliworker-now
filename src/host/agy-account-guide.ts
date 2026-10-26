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
  method: { step: 'method', tone: 'action', text: '选择登录方式：Google 账号登录（Google OAuth）。' },
  code: {
    step: 'code',
    tone: 'action',
    text: '在浏览器中登录 Google 并允许授权，然后复制页面显示的授权码，粘贴后按回车。',
  },
  pasted: { step: 'pasted', tone: 'action', text: '授权码已粘贴，请按回车完成登录。' },
  confirming: { step: 'confirming', tone: 'info', text: '正在确认登录…' },
  signedIn: { step: 'signedIn', tone: 'success', text: '已登录 Antigravity' },
  unconfirmed: {
    step: 'unconfirmed',
    tone: 'warning',
    text: '未能确认登录：授权码可能不完整或已过期。请重新开始登录，或查看原生终端中的提示。',
  },
  alreadySignedIn: { step: 'alreadySignedIn', tone: 'info', text: '当前已登录 Antigravity。如需切换账号，请先退出登录。' },
  loggingOut: { step: 'loggingOut', tone: 'info', text: '正在退出 Antigravity…' },
  loggedOut: { step: 'loggedOut', tone: 'success', text: '已退出 Antigravity' },
  notSignedIn: { step: 'notSignedIn', tone: 'info', text: '当前未登录 Antigravity，无需退出。' },
  logoutUnconfirmed: { step: 'logoutUnconfirmed', tone: 'warning', text: '未能确认已退出，请查看原生终端中的提示。' },
} as const satisfies Record<string, AccountGuide>

export type AgyGuideEvent =
  | { guide: AccountGuide }
  | { command: 'logout' }
  | { confirm: 'login' | 'logout' }
  | { identify: true }

const SCREEN_LIMIT = 4096
// Drawing sequences carry no text: drop CSI/OSC/charset controls before matching.
const CONTROL = /\x1b\[[0-9;?<=>]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Za-z0-9]|\x1b[=>78]/g
const compact = (text: string) => text.replace(/\s+/g, '').toLowerCase()
// agy draws its sign-in address as an OSC 8 hyperlink; take the target, never the wrapped text.
const LINK = /\x1b\]8;[^;\x07\x1b]*;([^\x07\x1b]+)(?:\x07|\x1b\\)/g
const RAW_LIMIT = 8192
const googleSignIn = (value: string): string | undefined => {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.hostname === 'accounts.google.com' && !url.username && !url.password
      ? url.href
      : undefined
  } catch {
    return undefined
  }
}
const PATTERNS = Object.fromEntries(
  Object.entries(MARKERS).map(([key, value]) => [key, compact(value)]),
) as Record<keyof typeof MARKERS, string>

/** Follows one Antigravity login or logout terminal; never stores what the user types. */
export class AgyAccountGuide {
  private screen = ''
  private raw = ''
  private link?: string
  private step?: string
  private typed = false
  private commandSent = false
  private identifying = false

  constructor(private readonly action: AccountAction) {}

  output(text: string): AgyGuideEvent[] {
    if (this.action === 'manage') return []
    this.screen = (this.screen + compact(text.replace(CONTROL, ''))).slice(-SCREEN_LIMIT)
    const seen = (marker: keyof typeof MARKERS) => this.screen.includes(PATTERNS[marker])
    const linked = this.action === 'login' ? this.readLink(text) : false
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
    // A sign-in address drawn after the code prompt still reaches the open step.
    if (linked && this.step === 'code') return [{ guide: this.withLink(AGY_GUIDES.code) }]
    return []
  }

  /**
   * The screen stopped changing before any known step: ask the Host to read the
   * native account. The main screen's exact text is not relied on alone.
   */
  settled(): AgyGuideEvent[] {
    if (this.action === 'manage' || this.step || this.commandSent || this.identifying || !this.screen) return []
    const seen = (marker: keyof typeof MARKERS) => this.screen.includes(PATTERNS[marker])
    if (seen('trust') || seen('signedOut') || seen('method') || seen('code')) return []
    this.identifying = true
    return [{ identify: true }]
  }

  /** The native account state read after `settled`. */
  identified(state: string | undefined): AgyGuideEvent[] {
    this.identifying = false
    if (this.step || this.commandSent) return []
    if (state === 'authenticated') {
      if (this.action === 'login') return this.show(AGY_GUIDES.alreadySignedIn)
      this.commandSent = true
      return [...this.show(AGY_GUIDES.loggingOut), { command: 'logout' }]
    }
    if (state === 'unconfigured' && this.action === 'logout') return this.show(AGY_GUIDES.notSignedIn)
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
    return [{ guide: guide.step === 'code' ? this.withLink(guide) : guide }]
  }

  private withLink(guide: AccountGuide): AccountGuide {
    return this.link ? { ...guide, link: this.link } : guide
  }

  /** Keeps the latest Google sign-in address; true when it changed. */
  private readLink(text: string): boolean {
    this.raw = (this.raw + text).slice(-RAW_LIMIT)
    let found: string | undefined
    for (const match of this.raw.matchAll(LINK)) found = googleSignIn(match[1]) ?? found
    if (!found || found === this.link) return false
    this.link = found
    return true
  }
}
