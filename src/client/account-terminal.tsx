import { useEffect, useRef, useState, type MutableRefObject } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { Button, StateDot, writeClipboard } from '@deepseek-ai/dsh-client-ui-primitives'
import type { AccountAction, AccountFrame, AccountGuide, AccountSource, ZCodeLoginProvider } from '../shared/accounts.ts'
import { CLI_LABELS, type CliId } from '../shared/types.ts'
import { value, type API } from './workers.ts'
import { accountTerminalCSS } from './account-terminal-css.ts'
import { createZcodeLoginLinkParser } from './zcode-login-link.ts'
import { createZcodeLoginLinkProvider } from './zcode-login-link-provider.ts'
import { t, type MessageKey, useT } from './i18n.ts'
import { hostText } from './operation-error.ts'
import { AgyAccountWizard, googleSignInLink } from './agy-account-wizard.tsx'

const STARTUP_TIMEOUT_MS = 20_000
const CLEANUP_TIMEOUT_MS = 12_000
const MAX_INPUT_BYTES = 16_384

function isPasteShortcut(event: KeyboardEvent): boolean {
  if (event.altKey || event.isComposing) return false
  return (
    ((event.key.toLowerCase() === 'v' || event.code === 'KeyV') && event.ctrlKey !== event.metaKey) ||
    (event.key === 'Insert' && event.shiftKey && !event.ctrlKey && !event.metaKey)
  )
}

function isCopyShortcut(event: KeyboardEvent): boolean {
  return (
    !event.altKey &&
    !event.isComposing &&
    (event.key.toLowerCase() === 'c' || event.code === 'KeyC') &&
    event.ctrlKey !== event.metaKey
  )
}

export type AccountCloseControl = MutableRefObject<(() => Promise<boolean>) | undefined>

// RPC errors may contain native output. Only plugin-owned, fixed diagnostics
// cross this boundary; never display arbitrary exception text from a CLI.
function startupMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : ''
  const safe: MessageKey[] = [
    '此 CLI 已有账号终端，请先关闭后重试',
    '当前宿主不支持交互终端',
    '账号终端尚未确认完全退出，请重启应用',
    'Windows 账号终端托管不可用，请检查 PowerShell 后重试',
    '账号终端启动超时，正在回收启动过程；请稍后重试',
    '无法启动账号终端，请检查 CLI 安装',
    'CLI 启动入口无法确认，请配置原生程序或固定 Node/Bun 入口',
    '无法确认 ZCode 账号功能，请检查完整 CLI 安装后重试',
    '当前 ZCode 未声明原生登录能力，请检查 CLI 安装',
    '当前 ZCode 未声明原生终端界面，请检查 CLI 安装',
    '当前 ZCode 未声明原生退出登录能力，请检查 CLI 安装',
    'ZCode 配套资源不可用，请检查 CLI 安装或配置 zcodeBuiltinConfig',
    '当前插件 Host 不支持 ZCode 授权来源选择，请更新插件后重试',
    '不支持的 ZCode 授权来源',
    '授权来源只支持 ZCode 登录时选择智谱 BigModel 或 Z.AI',
    '当前 ZCode CLI 不支持智谱 BigModel 授权，请更新为支持 login bigmodel 的官方完整 CLI 后重试；不会改用 Z.AI 登录。',
    'OMP 执行入口身份不匹配，请检查该 CLI 的安装和路径',
    'Pi 执行入口身份不匹配，请检查该 CLI 的安装和路径',
    'Codex Windows 应用包入口无法确认，请检查安装',
    'Codex npm 安装入口无法确认，请检查安装',
    'Hermes Windows 安装入口无法确认，请检查安装',
    '检测到 Hermes 安装目录，但未找到可用 CLI 入口，请完成安装或配置已有入口',
    'Windows CLI 安装入口无法读取，请检查安装',
    'Windows CLI 安装目录配置无效',
    'Windows 系统目录配置无效',
    'Hermes 插件账号不能使用额外的托管配置',
    'Hermes 请使用自身 .env，暂不支持外部密码库配置',
    'Hermes 请使用自身 API 配置，暂不支持外部密码库引用',
    '请先关闭 Hermes 的 auth.adopt_external_logins',
    'Hermes 当前使用外部 Codex 登录，请改用自身账号',
    'Hermes 账号来源无法确认',
    'Hermes 含外部账号来源，请使用自身登录',
  ]
  return t(
    safe.find((item) => message === item || message === `Error: ${item}`) ??
      '账号终端暂不可用，请确认此 CLI 没有运行任务且当前项目允许执行，再重试',
  )
}

async function waitForCleanup(cleanup: Promise<void>) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      cleanup,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('account cleanup timed out')), CLEANUP_TIMEOUT_MS)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

/** Only mounted after a human selects an account action. No prompt is auto-entered. */
export function AccountTerminal({
  api,
  sessionId,
  cli,
  action,
  source,
  provider,
  onClose,
  onFinished,
  closeControl,
}: {
  api: API
  sessionId: string
  cli: CliId
  action: AccountAction
  source?: AccountSource
  provider?: ZCodeLoginProvider
  onClose: () => void
  onFinished: () => void
  closeControl?: AccountCloseControl
}) {
  useT()
  const element = useRef<HTMLDivElement>(null)
  const callbacks = useRef({ onClose, onFinished })
  callbacks.current = { onClose, onFinished }
  const stop = useRef<() => Promise<void>>(async () => {})
  const focus = useRef<() => void>(() => {})
  const contextClipboard = useRef<() => Promise<void>>(async () => {})
  const send = useRef<(data: string) => void>(() => {})
  const refit = useRef<() => void>(() => {})
  // Antigravity sign-in/out is drawn by the plugin; the native terminal stays behind it.
  const guided = cli === 'antigravity' && action !== 'manage'
  const [rawVisible, setRawVisible] = useState(false)
  const rawShown = useRef(false)
  rawShown.current = !guided || rawVisible
  const generation = useRef(0)
  const closing = useRef<Promise<boolean>>()
  const [attempt, setAttempt] = useState(0)
  const [phase, setPhase] = useState<'loading' | 'running' | 'closed' | 'failed' | 'stopping'>('loading')
  const [instruction, setInstruction] = useState('')
  const [notice, setNotice] = useState('')
  const [guide, setGuide] = useState<AccountGuide>()
  useEffect(() => {
    const ownGeneration = ++generation.current
    setPhase('loading')
    setInstruction('')
    setNotice('')
    setGuide(undefined)
    let alive = true,
      id = '',
      ended = false,
      cleanupConfirmed = false,
      lastSeq = 0,
      queuedBytes = 0,
      resizeFrame = 0,
      viewDisposed = false
    const startup = new AbortController()
    let startupTimer: ReturnType<typeof setTimeout> | undefined
    let stream: ReturnType<API['$stream']> | undefined
    let streamDisposal: Promise<void> | undefined
    let terminal: Terminal | undefined
    let observer: ResizeObserver | undefined
    let themeObserver: MutationObserver | undefined
    let input: { dispose(): void } | undefined
    let loginLinks: { dispose(): void } | undefined
    let removePasteListener: (() => void) | undefined
    let readingClipboard = false
    // Only the current native login prompt may authorize browser navigation.
    // Keep parsed URLs in this terminal's memory, outside persistent UI state.
    const loginLinkParser =
      cli === 'zcode' && action === 'login' ? createZcodeLoginLinkParser(provider) : undefined
    let loginUrl: string | undefined
    const openedLoginUrls = new Set<string>()
    const clearLoginLink = () => {
      loginUrl = undefined
      loginLinkParser?.reset()
      openedLoginUrls.clear()
    }
    let inputQueue = Promise.resolve()
    let stopping: Promise<void> | undefined
    const disposeStream = () => {
      if (!stream) return Promise.resolve()
      const currentStream = stream
      return (streamDisposal ??= Promise.resolve().then(() => currentStream.dispose()))
    }
    const disableInput = () => {
      if (terminal) terminal.options.disableStdin = true
    }
    const finish = (failed = false) => {
      disableInput()
      clearLoginLink()
      if (alive) setPhase(failed ? 'failed' : 'closed')
      if (!ended) {
        ended = true
        if (alive) callbacks.current.onFinished()
      }
    }
    const stopSession = () => {
      clearTimeout(startupTimer)
      startup.abort()
      disableInput()
      clearLoginLink()
      if (!id || cleanupConfirmed) return Promise.resolve()
      return (stopping ??= (async () => {
        value(await api.cliworker.accountStop(sessionId, id))
        if (!ended) finish()
      })().catch((error) => {
        stopping = undefined
        throw error
      }))
    }
    stop.current = stopSession
    const fail = (message: string) => {
      clearTimeout(startupTimer)
      if (alive) {
        setNotice(message)
        finish(true)
      }
      void stopSession().catch(() => {
        if (alive) setNotice(t('终端尚未完成清理，请点击关闭终端后重试'))
      })
      void disposeStream().catch(() => undefined)
    }
    const disposeView = () => {
      if (viewDisposed) return
      viewDisposed = true
      // A partially opened renderer may also fail during disposal. Always release
      // the remaining observers; renderer cleanup must not skip PTY cleanup.
      for (const dispose of [
        () => observer?.disconnect(),
        () => themeObserver?.disconnect(),
        () => cancelAnimationFrame(resizeFrame),
        () => input?.dispose(),
        () => loginLinks?.dispose(),
        () => removePasteListener?.(),
        () => terminal?.dispose(),
      ]) {
        try {
          dispose()
        } catch {
          // The Host owns process cleanup, independently of these browser handles.
        }
      }
    }
    try {
      if (!element.current) throw new Error('terminal container unavailable')
      terminal = new Terminal({
        fontSize: 12,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        cursorBlink: true,
        cursorStyle: 'block',
        cursorInactiveStyle: 'outline',
        scrollback: 1000,
        disableStdin: true,
        // Do not turn CLI-controlled escape sequences into browser navigation.
        linkHandler: { activate: () => {} },
        allowProposedApi: false,
      })
      const view = terminal
      focus.current = () => {
        if (alive && !ended && !startup.signal.aborted) view.focus()
      }
      const fit = new FitAddon()
      view.loadAddon(fit)
      view.open(element.current)
      const canWrite = () => alive && !!id && !ended && !startup.signal.aborted && !viewDisposed
      const canCopy = () => alive && !viewDisposed && !startup.signal.aborted
      const openLoginUrl = (url: string) => {
        if (!canWrite() || url !== loginUrl) return
        try {
          // Harness routes HTTP(S) new-window requests to its native external
          // browser handler on both Mac and Windows; no shell command is used.
          window.open(url, '_blank', 'noopener,noreferrer')
        } catch {
          setNotice(t('无法打开登录网页，请在终端中查看原生登录提示'))
        }
      }
      if (loginLinkParser)
        loginLinks = view.registerLinkProvider(
          createZcodeLoginLinkProvider(view, () => (canWrite() ? loginUrl : undefined), openLoginUrl),
        )
      const pasteText = (text: string) => {
        if (!canWrite()) return
        if (!text) {
          setNotice(t('剪贴板中没有可粘贴的文本'))
          return
        }
        setNotice('')
        view.focus()
        // xterm owns newline normalization and the CLI's bracketed-paste mode.
        // Its onData handler remains the only path to the scoped Gateway.
        view.paste(text)
      }
      contextClipboard.current = async () => {
        if (!canCopy() || readingClipboard) return
        // Native keyboard copy remains xterm's selection/copy event. Right click
        // uses the same selected text; with no selection it pastes instead.
        if (view.hasSelection()) {
          const text = view.getSelection()
          if (!text) return
          readingClipboard = true
          try {
            const copied = await writeClipboard(text)
            if (!canCopy()) return
            if (!copied) setNotice(t('复制失败，请重新选择文本后重试'))
            else {
              setNotice('')
              view.clearSelection()
              view.focus()
            }
          } catch {
            if (canCopy()) setNotice(t('复制失败，请重新选择文本后重试'))
          } finally {
            readingClipboard = false
          }
          return
        }
        if (!canWrite()) return
        readingClipboard = true
        try {
          if (!navigator.clipboard?.readText) throw new Error('clipboard unavailable')
          const text = await navigator.clipboard.readText()
          pasteText(text)
        } catch {
          if (canWrite()) setNotice(t('无法读取剪贴板，请聚焦终端后按 Ctrl+V（Mac 为 ⌘V）粘贴'))
        } finally {
          readingClipboard = false
        }
      }
      // Windows xterm otherwise turns Ctrl+V into ^V and cancels the native
      // paste event. Leave the browser default intact; don't read twice.
      view.attachCustomKeyEventHandler((event) => {
        if (isCopyShortcut(event) && view.hasSelection()) {
          event.stopPropagation()
          return false
        }
        if (!isPasteShortcut(event)) return true
        event.stopPropagation()
        return false
      })
      const container = element.current
      const onPaste = (event: ClipboardEvent) => {
        event.preventDefault()
        event.stopPropagation()
        if (!canWrite()) return
        if (!event.clipboardData) {
          setNotice(t('无法读取粘贴内容，请右键重试'))
          return
        }
        pasteText(event.clipboardData.getData('text/plain'))
      }
      // Capture before xterm's textarea listener so a native menu/shortcut
      // paste is forwarded once and never retained in the hidden textarea.
      container.addEventListener('paste', onPaste, { capture: true })
      removePasteListener = () => container.removeEventListener('paste', onPaste, { capture: true })
      const theme = () => {
        if (!alive || viewDisposed) return
        try {
          const css = getComputedStyle(document.body)
          view.options.theme = {
            background: css.getPropertyValue('--dsw-alias-bg-layer-2').trim() || '#ffffff',
            foreground: css.getPropertyValue('--dsw-alias-label-primary').trim() || '#222222',
            cursor: css.getPropertyValue('--dsw-alias-label-primary').trim() || '#222222',
            cursorAccent: css.getPropertyValue('--dsw-alias-bg-layer-2').trim() || '#ffffff',
          }
        } catch {
          fail(t('账号终端显示未能初始化，请重试'))
        }
      }
      theme()
      if (ended) throw new Error('terminal theme unavailable')
      themeObserver = new MutationObserver(theme)
      themeObserver.observe(document.body, {
        attributes: true,
        attributeFilter: ['data-ds-dark-theme', 'style', 'class'],
      })
      const resize = () => {
        cancelAnimationFrame(resizeFrame)
        resizeFrame = requestAnimationFrame(() => {
          // A hidden view has no size; the Host keeps its own large PTY until it is shown.
          if (!alive || viewDisposed || ended || !rawShown.current) return
          try {
            fit.fit()
            if (id && !startup.signal.aborted)
              void api.cliworker.accountResize(sessionId, id, view.cols, view.rows).catch(() => undefined)
          } catch {
            fail(t('账号终端显示未能初始化，请重试'))
          }
        })
      }
      observer = new ResizeObserver(resize)
      observer.observe(element.current)
      refit.current = resize
      resize()
      const sendInput = (data: string) => {
        if (!canWrite()) return
        const bytes = new TextEncoder().encode(data).byteLength
        if (queuedBytes + bytes > MAX_INPUT_BYTES) {
          setNotice(t('输入过长或仍在发送，请缩短内容后重试'))
          return
        }
        queuedBytes += bytes
        inputQueue = inputQueue
          .then(async () => {
            if (alive && !ended && !startup.signal.aborted)
              value(await api.cliworker.accountWrite(sessionId, id, data))
          })
          .catch(() => {
            if (alive) setNotice(t('输入未能送达，请关闭终端后重试'))
          })
          .finally(() => {
            queuedBytes -= bytes
          })
      }
      send.current = sendInput
      input = view.onData(sendInput)
      startupTimer = setTimeout(() => {
        fail(t('启动超过 20 秒，已取消本次请求。请确认 CLI 可用后重试'))
      }, STARTUP_TIMEOUT_MS)
      void (async () => {
        try {
          if (provider && typeof api.cliworker.accountStartForProvider !== 'function')
            // Matched by startupMessage's allowlist, which translates it.
            throw new Error('当前插件 Host 不支持 ZCode 授权来源选择，请更新插件后重试')
          const result = JSON.parse(
            value(
              await (provider
                ? api.cliworker.accountStartForProvider(sessionId, cli, action, provider, startup.signal)
                : source
                  ? api.cliworker.accountStartForSource(sessionId, cli, action, source, startup.signal)
                  : api.cliworker.accountStart(sessionId, cli, action, startup.signal)),
            ),
          ) as { id: string; instruction: string }
          clearTimeout(startupTimer)
          id = result.id
          if (!alive || startup.signal.aborted) {
            await stopSession()
            return
          }
          setInstruction(result.instruction)
          setPhase('running')
          view.options.disableStdin = false
          if (rawShown.current) view.focus()
          resize()
          const accountStream = api.$stream<string>({
            name: 'CLI 账号终端',
            open: (signal) => api.cliworker.accountWatch(sessionId, id, signal),
            ended: () => new Error(t('账号终端连接已结束')),
          })
          stream = accountStream
          for await (const item of accountStream) {
            const frame = JSON.parse(item.value) as AccountFrame
            if (alive && !ended && frame.seq > lastSeq) {
              lastSeq = frame.seq
              if (frame.data) {
                view.write(frame.data)
                const link = canWrite() ? loginLinkParser?.write(frame.data) : undefined
                if (link) {
                  loginUrl = link
                  if (!openedLoginUrls.has(link)) {
                    openedLoginUrls.add(link)
                    openLoginUrl(link)
                  }
                }
              }
              if (frame.message) setNotice(hostText(frame.message))
              if (frame.guide) setGuide(frame.guide)
            }
            item.accept()
            if (frame.status === 'closed' || frame.status === 'failed') {
              cleanupConfirmed = frame.cleanupConfirmed === true
              if (!ended) finish(frame.status === 'failed')
              break
            }
          }
          if (!ended) {
            if (alive) setNotice(t('账号终端连接已结束，请重试'))
            finish(true)
            void stopSession().catch(() => undefined)
          }
        } catch (error) {
          clearTimeout(startupTimer)
          if (alive && !startup.signal.aborted) {
            setNotice(startupMessage(error))
            finish(true)
          }
          // Start process cleanup independently so a slow stop RPC cannot keep
          // a failed stream subscribed until the dialog is unmounted.
          if (id) void stopSession().catch(() => undefined)
        } finally {
          await disposeStream().catch(() => undefined)
        }
      })()
    } catch {
      fail(t('账号终端显示未能初始化，请重试'))
      disposeView()
      focus.current = () => {}
      contextClipboard.current = async () => {}
    }
    return () => {
      alive = false
      send.current = () => {}
      refit.current = () => {}
      clearLoginLink()
      if (generation.current === ownGeneration) generation.current++
      clearTimeout(startupTimer)
      startup.abort()
      disposeView()
      void stopSession().catch(() => undefined)
      void disposeStream().catch(() => undefined)
    }
  }, [api, sessionId, cli, action, source, provider, attempt])

  const close = (retry = false): Promise<boolean> => {
    if (closing.current) return closing.current
    const ownGeneration = generation.current
    setPhase('stopping')
    const operation = (async () => {
      try {
        await waitForCleanup(stop.current())
        if (generation.current !== ownGeneration) return false
        if (retry) setAttempt((value) => value + 1)
        else callbacks.current.onClose()
        return true
      } catch {
        if (generation.current !== ownGeneration) return false
        setPhase('failed')
        setNotice(t('终端关闭失败，请重试'))
        return false
      }
    })()
    closing.current = operation
    void operation.finally(() => {
      if (closing.current === operation) closing.current = undefined
    })
    return operation
  }
  useEffect(() => {
    if (rawVisible) refit.current()
  }, [rawVisible])
  useEffect(() => {
    if (!closeControl) return
    const request = () => close()
    closeControl.current = request
    return () => {
      if (closeControl.current === request) closeControl.current = undefined
    }
  })
  return (
    <section className="cwn-account-terminal" data-cli={cli}>
      <style>{accountTerminalCSS}</style>
      <style>{`.cwn-account-terminal-view:focus-within { outline: none; }`}</style>
      {!guided && (
        <div className="cwn-account-terminal-head">
          <strong>{t('{cli} 账号终端', { cli: CLI_LABELS[cli] })}</strong>
          <Button variant="ghost" size="md" onClick={() => void close()} disabled={phase === 'stopping'}>
            {t('关闭终端')}
          </Button>
        </div>
      )}
      {guided && phase !== 'stopping' && (
        <AgyAccountWizard
          action={action}
          phase={phase}
          guide={guide}
          rawVisible={rawVisible}
          onToggleRaw={() => setRawVisible((shown) => !shown)}
          onSend={(data) => send.current(data)}
          onOpenLink={(url) => {
            const link = googleSignInLink(url)
            // Harness routes HTTP(S) new-window requests to the native browser.
            if (link) window.open(link, '_blank', 'noopener,noreferrer')
          }}
          onRestart={() => void close(true)}
          onDone={() => void close()}
        />
      )}
      {(phase === 'loading' || phase === 'stopping') && (!guided || phase === 'stopping') && (
        <div className="cwn-loading" role="status">
          <StateDot state="ongoing" size={14} />
          {phase === 'loading' ? t('正在启动账号终端…') : t('正在关闭终端…')}
        </div>
      )}
      {!guided && instruction && <p className="cwn-account-instruction">{hostText(instruction)}</p>}
      {!guided && guide && (
        <p className="cwn-account-guide" data-tone={guide.tone} data-step={guide.step} role="status" aria-live="polite">
          {hostText(guide.text)}
        </p>
      )}
      <div
        className="cwn-account-terminal-view"
        hidden={!rawShown.current}
        ref={element}
        aria-label={t('{cli} 原生账号终端', { cli: CLI_LABELS[cli] })}
        onClick={() => focus.current()}
        onContextMenuCapture={(event) => {
          event.preventDefault()
          event.stopPropagation()
          void contextClipboard.current()
        }}
      />
      {!guided && (phase === 'failed' || phase === 'closed') && (
        <Button variant="ghost" size="md" onClick={() => void close(true)}>
          {phase === 'closed' ? t('重新打开终端') : t('重试')}
        </Button>
      )}
      {notice && (
        <p className="cwn-account-instruction" role="status">
          {notice}
        </p>
      )}
    </section>
  )
}
