import type { AccountAction, AccountGuide, AccountResponse } from '../shared/accounts.ts'
import {
  CONTROL,
  compact,
  FlowGuide,
  GUIDE_SIZE,
  GuideResponseError,
  type AccountChange,
  type AccountEvidence,
  type AccountGuideDriver,
  type GuideEvent,
} from './account-guide/engine.ts'

/**
 * Screen texts of agy 1.4.7 (checked on macOS 2026-10-26). Whitespace is
 * ignored when matching, since a TUI may draw spaces as cursor moves.
 * `signedOut` is drawn before every sign-in check, also for a signed-in
 * account, so only the login method menu proves a signed-out start.
 */
const MARKERS = {
  trust: 'Do you trust the contents of this project?',
  signedOut: 'You are currently not signed in.',
  method: 'Select login method',
  code: 'paste the authorization code',
  ready: '? for shortcuts',
} as const

const PLAN = ['选择登录方式', '在浏览器中授权', '粘贴授权码，按回车登录']
const login = { plan: PLAN } as const

export const AGY_GUIDES = {
  trust: { step: 'trust', tone: 'action', template: 'trust', ...login, stage: 0, text: 'Antigravity 首次在此项目文件夹运行，需要你确认是否信任该文件夹。' },
  method: {
    step: 'method',
    tone: 'action',
    template: 'choice',
    ...login,
    stage: 0,
    text: '使用 Google 账号登录 Antigravity。',
    options: [{ id: 'google', label: '使用 Google 账号登录', detail: '如需使用 Google Cloud 项目登录，请打开原生终端操作。' }],
  },
  code: {
    step: 'code',
    tone: 'action',
    template: 'browserCode',
    ...login,
    stage: 1,
    text: '浏览器已打开 Google 登录页面。登录并点击「允许」后，页面会显示一串授权码，把它复制下来。',
  },
  pasted: { step: 'pasted', tone: 'action', template: 'browserCode', ...login, stage: 1, text: '授权码已粘贴，请按回车完成登录。' },
  confirming: { step: 'confirming', tone: 'info', template: 'waiting', ...login, stage: 2, text: '正在确认登录…' },
  signedIn: { step: 'signedIn', tone: 'success', template: 'result', text: '已登录 Antigravity' },
  unconfirmed: {
    step: 'unconfirmed',
    tone: 'warning',
    template: 'browserCode',
    ...login,
    stage: 1,
    text: '未能确认登录：授权码可能不完整或已过期。请重新开始登录，或查看原生终端中的提示。',
  },
  alreadySignedIn: { step: 'alreadySignedIn', tone: 'info', template: 'result', text: '当前已登录 Antigravity。如需切换账号，请先退出登录。' },
  loggingOut: { step: 'loggingOut', tone: 'info', template: 'waiting', text: '正在退出 Antigravity…' },
  loggedOut: { step: 'loggedOut', tone: 'success', template: 'result', text: '已退出 Antigravity' },
  notSignedIn: { step: 'notSignedIn', tone: 'info', template: 'result', text: '当前未登录 Antigravity，无需退出。' },
  logoutUnconfirmed: { step: 'logoutUnconfirmed', tone: 'warning', template: 'result', text: '未能确认已退出，请查看原生终端中的提示。' },
} as const satisfies Record<string, AccountGuide>

export type AgyGuideEvent = GuideEvent

const SCREEN_LIMIT = 4096
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
export class AgyAccountGuide implements AccountGuideDriver {
  readonly size = GUIDE_SIZE
  private screen = ''
  private raw = ''
  private link?: string
  private step?: string
  private typed = false
  private commandSent = false
  private identifying = false
  private afterCommand = ''
  private trustAnswered = false

  constructor(private readonly action: AccountAction) {}

  output(text: string): AgyGuideEvent[] {
    if (this.action === 'manage') return []
    this.screen = (this.screen + compact(text.replace(CONTROL, ''))).slice(-SCREEN_LIMIT)
    const seen = (marker: keyof typeof MARKERS) => this.screen.includes(PATTERNS[marker])
    const linked = this.action === 'login' ? this.readLink(text) : false
    if (this.action === 'logout') {
      if (this.commandSent) {
        this.afterCommand = (this.afterCommand + compact(text.replace(CONTROL, ''))).slice(-SCREEN_LIMIT)
        return []
      }
      // After the user answers the folder trust question, the main screen follows.
      if (this.step && (this.step !== 'trust' || !this.trustAnswered)) return []
      if (seen('trust') && !this.step) return this.show(AGY_GUIDES.trust)
      if (seen('method')) return this.show(AGY_GUIDES.notSignedIn)
      if (!seen('ready')) return []
      this.commandSent = true
      return [...this.show(AGY_GUIDES.loggingOut), { command: '/logout' }]
    }
    // Login steps only move forward; a redraw of an earlier screen is ignored.
    if (seen('code') && this.order('code')) return this.show(AGY_GUIDES.code)
    if (seen('method') && this.order('method')) return this.show(AGY_GUIDES.method)
    if (seen('trust') && !this.step) return this.show(AGY_GUIDES.trust)
    if (seen('ready') && !seen('method') && (!this.step || this.step === 'trust'))
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
    if (this.action === 'manage' || (this.step && (this.step !== 'trust' || !this.trustAnswered)) || this.commandSent || this.identifying || !this.screen)
      return []
    const seen = (marker: keyof typeof MARKERS) => this.screen.includes(PATTERNS[marker])
    if (seen('trust') || seen('method') || seen('code')) return []
    this.identifying = true
    return [{ identify: true }]
  }

  /** agy redrew its login menu after `/logout`: a further Enter would start a sign-in. */
  loginMenuAfterCommand(): boolean {
    return this.afterCommand.includes(PATTERNS.method)
  }

  /** The native account state read after `settled`. */
  identified(evidence: AccountEvidence | string | undefined): AgyGuideEvent[] {
    const state = typeof evidence === 'string' ? evidence : evidence?.state
    this.identifying = false
    if ((this.step && (this.step !== 'trust' || !this.trustAnswered)) || this.commandSent) return []
    if (state === 'authenticated') {
      if (this.action === 'login') return this.show(AGY_GUIDES.alreadySignedIn)
      this.commandSent = true
      return [...this.show(AGY_GUIDES.loggingOut), { command: '/logout' }]
    }
    if (state === 'unconfigured' && this.action === 'logout') return this.show(AGY_GUIDES.notSignedIn)
    return []
  }

  input(data: string): AgyGuideEvent[] {
    // The trust question is answered: judge only what agy draws next.
    if (this.step === 'trust' && /[\r\n]/.test(data)) {
      this.screen = ''
      this.trustAnswered = true
    }
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
  unconfirmed(change: AccountChange = 'login'): AgyGuideEvent[] {
    if (change === 'logout') return [{ guide: AGY_GUIDES.logoutUnconfirmed }]
    this.typed = false
    this.step = 'code'
    return [{ guide: this.withLink(AGY_GUIDES.unconfirmed) }]
  }

  /** An answer from the plugin window, turned into the keys agy expects. */
  respond(response: AccountResponse): AgyGuideEvent[] {
    if (this.action === 'manage') throw new GuideResponseError()
    if ('confirm' in response && this.step === 'trust' && !this.trustAnswered) {
      if (response.confirm === 'decline') return [{ finish: true }]
      this.screen = ''
      this.trustAnswered = true
      return [{ write: '\r' }]
    }
    if (this.action !== 'login') throw new GuideResponseError()
    if ('option' in response && response.option === 'google' && this.step === 'method') return [{ write: '\r' }]
    if ('code' in response && ['code', 'pasted', 'unconfirmed'].includes(this.step ?? '')) {
      const value = response.code.trim()
      if (!value || value.length > 2048 || /[\x00-\x1f\x7f]/.test(value)) throw new GuideResponseError()
      // agy enables bracketed paste; a pasted code then Enter is what its input box expects.
      return [
        { write: FlowGuide.paste(value, { action: 'login', bracketedPaste: true }), enter: true },
        ...this.show(AGY_GUIDES.confirming),
        { confirm: 'login' },
      ]
    }
    throw new GuideResponseError()
  }

  exited(): AgyGuideEvent[] {
    return []
  }

  confirmed(change: AccountChange): AgyGuideEvent[] {
    return [...this.show(change === 'login' ? AGY_GUIDES.signedIn : AGY_GUIDES.loggedOut), { finish: true }]
  }

  retryEnter(): boolean {
    return !this.loginMenuAfterCommand()
  }

  proves(change: AccountChange, _before: AccountEvidence | undefined, after: AccountEvidence | undefined): boolean {
    return change === 'login' ? after?.state === 'authenticated' : after?.state === 'unconfigured'
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
