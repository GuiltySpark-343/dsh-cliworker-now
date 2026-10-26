import type {
  AccountAction,
  AccountGuide,
  AccountLoginMode,
  AccountResponse,
  AccountStatus,
} from '../../shared/accounts.ts'
import { allowedLink } from '../../shared/account-links.ts'

/** What a guide asks the account manager to do. Keys only ever answer a user's choice. */
export type GuideEvent =
  | { guide: AccountGuide }
  /** Keys for the user's answer; `enter` presses Enter after a short pause. */
  | { write: string; enter?: boolean }
  /** An automatic sign-out command the user asked for by clicking「退出」. */
  | { command: string }
  | { confirm: 'login' | 'logout' }
  | { identify: true }
  | { finish: true }

export type AccountChange = 'login' | 'logout'
/** The native account state a guide judges, never terminal text. */
export type AccountEvidence = Pick<AccountStatus, 'state'> & Partial<Pick<AccountStatus, 'logins' | 'accountLabel'>>

/** The account manager's view of one guided terminal. */
export interface AccountGuideDriver {
  readonly size: { cols: number; rows: number }
  output(text: string): GuideEvent[]
  /** Raw keys typed in the visible native terminal. */
  input(data: string): GuideEvent[]
  /** An answer from the plugin window; throws when the current step does not take it. */
  respond(response: AccountResponse): GuideEvent[]
  settled(): GuideEvent[]
  identified(state: AccountEvidence | undefined): GuideEvent[]
  /** The native process ended by itself. */
  exited(code: number | undefined): GuideEvent[]
  confirmed(change: AccountChange): GuideEvent[]
  unconfirmed(change: AccountChange): GuideEvent[]
  /** After an automatic command, whether one more Enter cannot start something else. */
  retryEnter(): boolean
  proves(change: AccountChange, before: AccountEvidence | undefined, after: AccountEvidence | undefined, exitCode?: number): boolean
}

export class GuideResponseError extends Error {
  constructor() {
    super('当前步骤不接受此操作，请按窗口提示继续')
  }
}

// Drawing sequences carry no text: drop CSI/OSC/charset controls before matching.
export const CONTROL = /\x1b\[[0-9;?<=>]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Za-z0-9]|\x1b[=>78]/g
export const compact = (text: string) => text.replace(/\s+/g, '').toLowerCase()
const OSC8 = /\x1b\]8;[^;\x07\x1b]*;([^\x07\x1b]+)(?:\x07|\x1b\\)/g
const URL_TEXT = /https:\/\/[^\s"'<>\x00-\x1f\x7f]+/g
const SCREEN_LIMIT = 8192
const RAW_LIMIT = 16_384
const MAX_ANSWER = 4096
// No control characters, no line breaks: an answer is one pasted value.
const ANSWER = /^[^\x00-\x1f\x7f]+$/

export interface ScreenView {
  /** Every marker, compared without whitespace or case, is on the recent screen. */
  has(...markers: string[]): boolean
  /** Recent screen text with controls replaced by spaces. */
  readonly plain: string
  readonly link?: string
  readonly code?: string
}

export interface FlowContext {
  action: AccountAction
  provider?: string
  mode?: AccountLoginMode
  bracketedPaste: boolean
}

export interface FlowAnswer {
  keys: string
  enter?: boolean
  /** The answer submits the sign-in; start reading the native account. */
  confirm?: AccountChange
  /** The answer leaves this screen (e.g. folder trust); judge only what the CLI draws next. */
  resets?: boolean
}

export interface FlowStep {
  id: string
  when: readonly string[] | ((screen: ScreenView, ctx: FlowContext) => boolean)
  guide: (screen: ScreenView, ctx: FlowContext) => AccountGuide
  respond?: (response: AccountResponse, ctx: FlowContext) => FlowAnswer | undefined
  /** Keys written once when the step shows, for a choice the user already made in the window. */
  auto?: (screen: ScreenView, ctx: FlowContext) => string | undefined
  /** Reaching this step is itself a sign that the change may have taken effect. */
  confirms?: AccountChange
  /** Enter typed in the visible terminal after content submits this step. */
  typedConfirms?: AccountChange
  /** The step is a final answer of the CLI (e.g. nothing to sign out); the window closes. */
  ends?: boolean
}

export interface FlowDefinition {
  /** CLI name used in plugin texts. */
  name: string
  size?: { cols: number; rows: number }
  links?: readonly string[]
  /** Device code on the plain screen; group 1 is the code. */
  deviceCode?: RegExp
  /** `plan` titles the whole sign-in; the confirmation is its last step. */
  login?: { steps: FlowStep[]; plan?: readonly string[] }
  logout?: {
    steps?: FlowStep[]
    /**
     * A TUI command typed once its ready screen shows, or once the screen settles on a
     * signed-in account; `signedOut` proves nothing to do, `menu` that Enter is unsafe again.
     */
    command?: { ready?: readonly string[]; text: string; signedOut?: readonly string[]; menu?: readonly string[] }
  }
  proves?: FlowGuide['proves']
}

export const GUIDE_SIZE = { cols: 200, rows: 60 }
const DEVICE_CODE = /^[A-Z0-9]{3,12}(?:-[A-Z0-9]{3,12})?$/i

/** Plugin texts shared by every CLI; a flow only adds its own steps. */
export function guideTexts(name: string) {
  return {
    starting: { step: 'starting', tone: 'info', template: 'starting', text: `正在启动 ${name}…` },
    confirming: { step: 'confirming', tone: 'info', template: 'waiting', text: '正在确认登录…' },
    signedIn: { step: 'signedIn', tone: 'success', template: 'result', text: `已登录 ${name}` },
    unconfirmed: {
      step: 'unconfirmed',
      tone: 'warning',
      template: 'result',
      text: '未能确认登录。请重新开始登录，或查看原生终端中的提示。',
    },
    loggingOut: { step: 'loggingOut', tone: 'info', template: 'waiting', text: `正在退出 ${name}…` },
    loggedOut: { step: 'loggedOut', tone: 'success', template: 'result', text: `已退出 ${name}` },
    notSignedIn: { step: 'notSignedIn', tone: 'info', template: 'result', text: `当前未登录 ${name}，无需退出。` },
    logoutUnconfirmed: {
      step: 'logoutUnconfirmed',
      tone: 'warning',
      template: 'result',
      text: '未能确认已退出，请查看原生终端中的提示。',
    },
    native: { step: 'native', tone: 'warning', template: 'native', text: '无法识别当前步骤，请在原生终端中继续。' },
  } as const satisfies Record<string, AccountGuide>
}

/** A guide driven by one CLI's flow definition. It never stores what the user types. */
export class FlowGuide implements AccountGuideDriver {
  readonly size: { cols: number; rows: number }
  private readonly texts: ReturnType<typeof guideTexts>
  private readonly steps: FlowStep[]
  private screen = ''
  private plain = ''
  private raw = ''
  private link?: string
  private code?: string
  private index = -1
  private shown?: AccountGuide
  private autoDone = new Set<string>()
  private typed = false
  private commandSent = false
  private afterCommand = ''
  private identifying = false
  private confirming = false
  private done = false
  private bracketed = false

  constructor(
    private readonly flow: FlowDefinition,
    private readonly ctx: Omit<FlowContext, 'bracketedPaste'>,
  ) {
    this.size = flow.size ?? GUIDE_SIZE
    this.texts = guideTexts(flow.name)
    this.steps = (ctx.action === 'login' ? flow.login?.steps : ctx.action === 'logout' ? flow.logout?.steps : undefined) ?? []
  }

  private get context(): FlowContext {
    return { ...this.ctx, bracketedPaste: this.bracketed }
  }

  private view(): ScreenView {
    const screen = this.screen
    return {
      has: (...markers) => markers.every((marker) => screen.includes(compact(marker))),
      plain: this.plain,
      link: this.link,
      code: this.code,
    }
  }

  output(text: string): GuideEvent[] {
    if (this.ctx.action === 'manage' || this.done) return []
    const stripped = text.replace(CONTROL, ' ')
    const on = text.lastIndexOf('\x1b[?2004h'),
      off = text.lastIndexOf('\x1b[?2004l')
    if (on !== off) this.bracketed = on > off
    this.screen = (this.screen + compact(stripped)).slice(-SCREEN_LIMIT)
    this.plain = (this.plain + stripped).slice(-SCREEN_LIMIT)
    this.readLinks(text)
    if (this.commandSent) {
      this.afterCommand = (this.afterCommand + compact(stripped)).slice(-SCREEN_LIMIT)
      return []
    }
    const command = this.ctx.action === 'logout' ? this.flow.logout?.command : undefined
    if (command && this.index < 0) {
      const screen = this.view()
      if (command.signedOut?.length && screen.has(...command.signedOut)) return this.end(this.texts.notSignedIn)
      if (command.ready?.length && screen.has(...command.ready)) return this.sendCommand(command.text)
    }
    return this.advance()
  }

  private advance(): GuideEvent[] {
    if (this.confirming) return []
    const screen = this.view()
    const context = this.context
    for (let i = this.steps.length - 1; i >= Math.max(0, this.index); i--) {
      const step = this.steps[i]
      const matched = typeof step.when === 'function' ? step.when(screen, context) : screen.has(...step.when)
      if (!matched) continue
      const guide = step.guide(screen, context)
      if (i === this.index && sameGuide(guide, this.shown)) return []
      if (i !== this.index) this.typed = false
      this.index = i
      if (step.ends) return this.end(guide)
      const events = this.show(guide)
      if (step.auto && !this.autoDone.has(step.id)) {
        const keys = step.auto(screen, context)
        if (keys) {
          this.autoDone.add(step.id)
          events.push({ write: keys })
        }
      }
      if (step.confirms) events.push(...this.startConfirm(step.confirms))
      return events
    }
    return []
  }

  input(data: string): GuideEvent[] {
    const step = this.steps[this.index]
    if (!step?.typedConfirms || this.confirming) return []
    const content = data.replace(/\x1b\[20[01]~/g, '').replace(/[\r\n]/g, '')
    if (content.length) this.typed = true
    return /[\r\n]/.test(data) && this.typed ? this.startConfirm(step.typedConfirms) : []
  }

  respond(response: AccountResponse): GuideEvent[] {
    const step = this.steps[this.index]
    if (!step?.respond || this.confirming || this.done) throw new GuideResponseError()
    if ('code' in response || 'secret' in response) {
      const value = ('code' in response ? response.code : response.secret).trim()
      if (!value || value.length > MAX_ANSWER || !ANSWER.test(value)) throw new GuideResponseError()
    }
    const answer = step.respond(response, this.context)
    if (!answer) throw new GuideResponseError()
    const events: GuideEvent[] = [{ write: answer.keys, enter: answer.enter }]
    if (answer.resets) {
      this.screen = ''
      this.plain = ''
      this.index = -1
      this.shown = undefined
    }
    if (answer.confirm) events.push(...this.startConfirm(answer.confirm))
    return events
  }

  /** The user's own answer as keys: bracketed when the CLI asked for it, as typed otherwise. */
  static paste(value: string, ctx: FlowContext): string {
    return ctx.bracketedPaste ? `\x1b[200~${value}\x1b[201~` : value
  }

  settled(): GuideEvent[] {
    if (this.ctx.action === 'manage' || this.done || this.confirming || this.commandSent || this.identifying) return []
    if (this.index >= 0) return []
    if (this.ctx.action === 'logout' && this.flow.logout?.command) {
      this.identifying = true
      return [{ identify: true }]
    }
    return this.show(this.texts.native)
  }

  identified(state: AccountEvidence | undefined): GuideEvent[] {
    this.identifying = false
    if (this.done || this.commandSent || this.index >= 0) return []
    const command = this.flow.logout?.command
    if (this.ctx.action !== 'logout' || !command) return []
    if (state?.state === 'authenticated') return this.sendCommand(command.text)
    if (state?.state === 'unconfigured' || state?.state === 'unauthenticated') return this.end(this.texts.notSignedIn)
    return this.show(this.texts.native)
  }

  exited(): GuideEvent[] {
    if (this.done || this.ctx.action === 'manage') return []
    const change: AccountChange = this.ctx.action === 'logout' ? 'logout' : 'login'
    this.confirming = false
    return this.startConfirm(change)
  }

  confirmed(change: AccountChange): GuideEvent[] {
    return this.end(change === 'login' ? this.texts.signedIn : this.texts.loggedOut)
  }

  unconfirmed(change: AccountChange): GuideEvent[] {
    this.confirming = false
    this.typed = false
    if (change === 'logout') return this.show(this.texts.logoutUnconfirmed)
    // A pasted code or key may be retried in the same step; anything else starts over.
    const step = this.steps[this.index]
    if (step?.respond) {
      const guide = { ...this.texts.unconfirmed, template: this.shown?.template, plan: this.shown?.plan, stage: this.shown?.stage }
      return this.show({ ...guide, step: step.id, options: this.shown?.options, link: this.shown?.link, code: this.shown?.code })
    }
    return this.show(this.texts.unconfirmed)
  }

  retryEnter(): boolean {
    const menu = this.flow.logout?.command?.menu
    return !menu?.length || !menu.every((marker) => this.afterCommand.includes(compact(marker)))
  }

  proves(change: AccountChange, before: AccountEvidence | undefined, after: AccountEvidence | undefined, exitCode?: number): boolean {
    if (this.flow.proves) return this.flow.proves(change, before, after, exitCode)
    if (change === 'logout') return !!after && after.state !== 'authenticated'
    if (after?.state !== 'authenticated') return false
    return before?.state !== 'authenticated' || exitCode === 0 || signature(before) !== signature(after)
  }

  private startConfirm(change: AccountChange): GuideEvent[] {
    if (this.confirming || this.done) return []
    this.confirming = true
    const plan = change === 'login' ? this.flow.login?.plan : undefined
    const guide = change === 'login' ? this.texts.confirming : this.texts.loggingOut
    return [...this.show(plan?.length ? { ...guide, plan: [...plan], stage: plan.length - 1 } : guide), { confirm: change }]
  }

  private sendCommand(text: string): GuideEvent[] {
    this.commandSent = true
    return [...this.show(this.texts.loggingOut), { command: text }]
  }

  private end(guide: AccountGuide): GuideEvent[] {
    this.done = true
    return [...this.show(guide), { finish: true }]
  }

  private show(guide: AccountGuide): GuideEvent[] {
    this.shown = guide
    return [{ guide }]
  }

  private readLinks(text: string) {
    const hosts = this.flow.links
    this.raw = (this.raw + text).slice(-RAW_LIMIT)
    if (hosts?.length) {
      let found: string | undefined
      for (const match of this.raw.matchAll(OSC8)) found = allowedLink(match[1], hosts) ?? found
      for (const match of this.raw.replace(CONTROL, ' ').matchAll(URL_TEXT)) found = allowedLink(match[0], hosts) ?? found
      if (found) this.link = found
    }
    const device = this.flow.deviceCode?.exec(this.plain)
    if (device && DEVICE_CODE.test(device[1])) this.code = device[1]
  }
}

function sameGuide(a: AccountGuide, b: AccountGuide | undefined) {
  return !!b && a.step === b.step && a.link === b.link && a.code === b.code && a.text === b.text
}

function signature(state: AccountEvidence | undefined) {
  return JSON.stringify([state?.accountLabel, state?.logins])
}
