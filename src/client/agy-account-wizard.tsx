import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  Button,
  IconCheckCircleFillRegular,
  IconCheckOutlineRegular,
  Input,
  StateDot,
  writeClipboard,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { AccountAction, AccountGuide } from '../shared/accounts.ts'
import { t, useT } from './i18n.ts'
import { hostText } from './operation-error.ts'

const MAX_CODE_LENGTH = 2048
// agy enables bracketed paste; a pasted code then Enter is what its input box expects.
const SUBMIT_DELAY_MS = 300

/** The only address the wizard may open, matching the Host's own check. */
export function googleSignInLink(value: string | undefined): string | undefined {
  if (!value) return undefined
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.hostname === 'accounts.google.com' && !url.username && !url.password
      ? url.href
      : undefined
  } catch {
    return undefined
  }
}

type Phase = 'loading' | 'running' | 'closed' | 'failed' | 'stopping'
type StepState = 'pending' | 'active' | 'done'

function Step({ index, state, title, children }: { index: number; state: StepState; title: string; children?: ReactNode }) {
  return (
    <li className="cwn-agy-step" data-state={state} aria-current={state === 'active' ? 'step' : undefined}>
      <span className="cwn-agy-step-mark" aria-hidden="true">
        {state === 'done' ? <IconCheckOutlineRegular size={14} /> : index}
      </span>
      <div className="cwn-agy-step-main">
        <span className="cwn-agy-step-title">{title}</span>
        {state === 'active' && children && <div className="cwn-agy-step-body">{children}</div>}
      </div>
    </li>
  )
}

function Result({ tone, title, detail, children }: { tone: 'success' | 'info' | 'warning'; title: string; detail?: string; children?: ReactNode }) {
  return (
    <div className="cwn-agy-result" data-tone={tone} role="status" aria-live="polite">
      {tone === 'success' && <IconCheckCircleFillRegular size={40} className="cwn-agy-result-icon" />}
      <strong>{title}</strong>
      {detail && <p>{detail}</p>}
      {children && <div className="cwn-agy-actions">{children}</div>}
    </div>
  )
}

function Waiting({ text }: { text: string }) {
  return (
    <div className="cwn-agy-waiting" role="status">
      <StateDot state="ongoing" size={14} />
      {text}
    </div>
  )
}

/**
 * Antigravity sign-in and sign-out, drawn by the plugin. The native agy terminal
 * still runs behind it; every key it receives is one the user asked for here.
 */
export function AgyAccountWizard({
  action,
  phase,
  guide,
  rawVisible,
  onToggleRaw,
  onSend,
  onOpenLink,
  onRestart,
  onDone,
}: {
  action: AccountAction
  phase: Phase
  guide?: AccountGuide
  rawVisible: boolean
  onToggleRaw: () => void
  onSend: (data: string) => void
  onOpenLink: (url: string) => void
  onRestart: () => void
  onDone: () => void
}) {
  useT()
  const [code, setCode] = useState('')
  const [pasted, setPasted] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout>>()
  const step = guide?.step
  useEffect(() => () => clearTimeout(timer.current), [])
  useEffect(() => {
    if (step !== 'unconfirmed') return
    setSubmitted(false)
    setCode('')
    setPasted(false)
  }, [step])

  const running = phase === 'running'
  const link = googleSignInLink(guide?.link)
  const rawToggle = (
    <Button variant="ghost" size="sm" onClick={onToggleRaw}>
      {rawVisible ? t('隐藏原生终端') : t('显示原生终端')}
    </Button>
  )

  if (action === 'logout') {
    let body: ReactNode
    if (step === 'loggedOut') body = <Result tone="success" title={t('已退出 Antigravity')} detail={t('需要时可在设置中重新登录。')}><Button variant="primary" size="md" onClick={onDone}>{t('完成')}</Button></Result>
    else if (step === 'notSignedIn') body = <Result tone="info" title={t('当前未登录 Antigravity')} detail={t('无需退出。')}><Button variant="primary" size="md" onClick={onDone}>{t('完成')}</Button></Result>
    else if (step === 'logoutUnconfirmed') body = <Result tone="warning" title={t('未能确认已退出')} detail={hostText(guide!.text)}><Button variant="outline" size="md" onClick={onRestart}>{t('重试')}</Button></Result>
    else if (step === 'trust')
      body = (
        <div className="cwn-agy-step-body">
          <p>{t('Antigravity 首次在此项目文件夹运行，需要你确认是否信任该文件夹，确认后插件会自动退出登录。')}</p>
          <div className="cwn-agy-actions">
            <Button variant="primary" size="md" disabled={!running} onClick={() => onSend('\r')}>{t('信任并继续')}</Button>
            <Button variant="ghost" size="md" onClick={onDone}>{t('取消')}</Button>
          </div>
        </div>
      )
    else if (phase === 'failed' || phase === 'closed') body = <Result tone="warning" title={t('退出未完成')} detail={t('原生终端已关闭，请重试。')}><Button variant="outline" size="md" onClick={onRestart}>{t('重试')}</Button></Result>
    else body = <Waiting text={step === 'loggingOut' ? t('正在退出 Antigravity…') : t('正在检查登录状态…')} />
    return (
      <div className="cwn-agy-wizard">
        {body}
        <div className="cwn-agy-foot">{rawToggle}</div>
      </div>
    )
  }

  if (step === 'signedIn')
    return (
      <div className="cwn-agy-wizard">
        <Result tone="success" title={t('已登录 Antigravity')} detail={t('现在可以派遣 Antigravity 任务了。')}>
          <Button variant="primary" size="md" onClick={onDone}>{t('完成')}</Button>
        </Result>
      </div>
    )
  if (step === 'alreadySignedIn')
    return (
      <div className="cwn-agy-wizard">
        <Result tone="info" title={t('当前已登录 Antigravity')} detail={t('如需切换账号，请先点击「退出登录」，再重新登录。')}>
          <Button variant="primary" size="md" onClick={onDone}>{t('关闭')}</Button>
        </Result>
        <div className="cwn-agy-foot">{rawToggle}</div>
      </div>
    )

  const ended = phase === 'failed' || phase === 'closed'
  const choosing = !step || step === 'trust' || step === 'method'
  const confirming = step === 'confirming' || submitted
  const submit = () => {
    const value = code.replace(/[\r\n]/g, '').trim()
    if (!value || !running || confirming) return
    setSubmitted(true)
    onSend(`\x1b[200~${value}\x1b[201~`)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => onSend('\r'), SUBMIT_DELAY_MS)
  }
  const copyLink = async () => {
    if (!link) return
    const ok = await writeClipboard(link).catch(() => false)
    setCopied(!!ok)
  }

  return (
    <div className="cwn-agy-wizard">
      <ol className="cwn-agy-steps">
        <Step index={1} state={choosing ? 'active' : 'done'} title={t('选择登录方式')}>
          {!step && !ended && <Waiting text={t('正在启动 Antigravity…')} />}
          {step === 'trust' && (
            <>
              <p>{t('Antigravity 首次在此项目文件夹运行，需要你确认是否信任该文件夹。')}</p>
              <div className="cwn-agy-actions">
                <Button variant="primary" size="md" disabled={!running} onClick={() => onSend('\r')}>{t('信任并继续')}</Button>
                <Button variant="ghost" size="md" onClick={onDone}>{t('取消')}</Button>
              </div>
            </>
          )}
          {step === 'method' && (
            <>
              <p>{t('使用 Google 账号登录 Antigravity。')}</p>
              <div className="cwn-agy-actions">
                <Button variant="primary" size="md" disabled={!running} onClick={() => onSend('\r')}>{t('使用 Google 账号登录')}</Button>
              </div>
              <p className="cwn-agy-hint">{t('如需使用 Google Cloud 项目登录，请打开原生终端操作。')}</p>
            </>
          )}
        </Step>
        <Step index={2} state={choosing ? 'pending' : confirming ? 'done' : 'active'} title={t('在浏览器中授权')}>
          <p>{t('浏览器已打开 Google 登录页面。登录并点击「允许」后，页面会显示一串授权码，把它复制下来。')}</p>
          {link && (
            <div className="cwn-agy-actions">
              <Button variant="outline" size="sm" onClick={() => onOpenLink(link)}>{t('重新打开登录页面')}</Button>
              <Button variant="ghost" size="sm" onClick={() => void copyLink()}>{copied ? t('已复制链接') : t('复制登录链接')}</Button>
            </div>
          )}
        </Step>
        <Step index={3} state={choosing ? 'pending' : 'active'} title={t('粘贴授权码，按回车登录')}>
          {step === 'unconfirmed' && (
            <p className="cwn-agy-callout" data-tone="warning" role="alert">{hostText(guide!.text)}</p>
          )}
          {confirming ? (
            <Waiting text={t('正在确认登录…')} />
          ) : (
            <form
              className="cwn-agy-code"
              onSubmit={(event) => {
                event.preventDefault()
                submit()
              }}
            >
              <Input
                autoFocus
                value={code}
                maxLength={MAX_CODE_LENGTH}
                spellCheck={false}
                autoComplete="off"
                aria-label={t('授权码')}
                placeholder={t('在这里粘贴授权码（⌘V / Ctrl+V）')}
                disabled={!running}
                onPaste={() => setPasted(true)}
                onChange={(event) => {
                  setCode(event.target.value)
                  if (!event.target.value) setPasted(false)
                }}
              />
              {code.trim() ? (
                <p className="cwn-agy-callout" data-tone="success" role="status">
                  <IconCheckCircleFillRegular size={16} />
                  <span>
                    {pasted ? t('授权码已粘贴。') : t('已输入授权码。')}
                    <strong>{t('按回车键完成登录')}</strong>
                  </span>
                  <kbd>↵</kbd>
                </p>
              ) : (
                <p className="cwn-agy-hint">{t('粘贴后按回车键，或点击「完成登录」。')}</p>
              )}
              <div className="cwn-agy-actions">
                <Button type="submit" variant="primary" size="md" disabled={!running || !code.trim()}>{t('完成登录')}</Button>
                {step === 'unconfirmed' && (
                  <Button type="button" variant="outline" size="md" onClick={onRestart}>{t('重新开始登录')}</Button>
                )}
              </div>
            </form>
          )}
        </Step>
      </ol>
      {ended && (
        <p className="cwn-agy-callout" data-tone="warning" role="alert">
          {t('登录窗口已结束。')}
          <Button variant="ghost" size="sm" onClick={onRestart}>{t('重新开始登录')}</Button>
        </p>
      )}
      <div className="cwn-agy-foot">{rawToggle}</div>
    </div>
  )
}
