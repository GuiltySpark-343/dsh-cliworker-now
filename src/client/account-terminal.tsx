import { useEffect, useRef, useState, type MutableRefObject } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { Button, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { AccountAction, AccountFrame, AccountSource } from '../shared/accounts.ts'
import { CLI_LABELS, type CliId } from '../shared/types.ts'
import { value, type API } from './workers.ts'
import { accountTerminalCSS } from './account-terminal-css.ts'

const STARTUP_TIMEOUT_MS = 20_000
const CLEANUP_TIMEOUT_MS = 12_000

export type AccountCloseControl = MutableRefObject<(() => Promise<boolean>) | undefined>

// RPC errors may contain native output. Only plugin-owned, fixed diagnostics
// cross this boundary; never display arbitrary exception text from a CLI.
function startupMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : ''
  const safe = [
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
    'OMP 执行入口身份不匹配，请检查该 CLI 的安装和路径',
    'Pi 执行入口身份不匹配，请检查该 CLI 的安装和路径',
  ]
  return (
    safe.find((item) => message === item || message === `Error: ${item}`) ??
    '账号终端暂不可用，请确认此 CLI 没有运行任务且当前项目允许执行，再重试'
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
  onClose,
  onFinished,
  closeControl,
}: {
  api: API
  sessionId: string
  cli: CliId
  action: AccountAction
  source?: AccountSource
  onClose: () => void
  onFinished: () => void
  closeControl?: AccountCloseControl
}) {
  const element = useRef<HTMLDivElement>(null)
  const callbacks = useRef({ onClose, onFinished })
  callbacks.current = { onClose, onFinished }
  const stop = useRef<() => Promise<void>>(async () => {})
  const focus = useRef<() => void>(() => {})
  const generation = useRef(0)
  const closing = useRef<Promise<boolean>>()
  const [attempt, setAttempt] = useState(0)
  const [phase, setPhase] = useState<'loading' | 'running' | 'closed' | 'failed' | 'stopping'>('loading')
  const [instruction, setInstruction] = useState('')
  const [notice, setNotice] = useState('')
  useEffect(() => {
    const ownGeneration = ++generation.current
    setPhase('loading')
    setInstruction('')
    setNotice('')
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
        if (alive) setNotice('终端尚未完成清理，请点击关闭终端后重试')
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
          fail('账号终端显示未能初始化，请重试')
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
          if (!alive || viewDisposed || ended) return
          try {
            fit.fit()
            if (id && !startup.signal.aborted)
              void api.cliworker.accountResize(sessionId, id, view.cols, view.rows).catch(() => undefined)
          } catch {
            fail('账号终端显示未能初始化，请重试')
          }
        })
      }
      observer = new ResizeObserver(resize)
      observer.observe(element.current)
      resize()
      input = view.onData((data) => {
        if (!alive || !id || ended || startup.signal.aborted || queuedBytes + data.length > 16_384) return
        queuedBytes += data.length
        inputQueue = inputQueue
          .then(async () => {
            if (alive && !ended && !startup.signal.aborted)
              value(await api.cliworker.accountWrite(sessionId, id, data))
          })
          .catch(() => {
            if (alive) setNotice('输入未能送达，请关闭终端后重试')
          })
          .finally(() => {
            queuedBytes -= data.length
          })
      })
      startupTimer = setTimeout(() => {
        fail('启动超过 20 秒，已取消本次请求。请确认 CLI 可用后重试')
      }, STARTUP_TIMEOUT_MS)
      void (async () => {
        try {
          const result = JSON.parse(
            value(
              await (source
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
          view.focus()
          resize()
          const accountStream = api.$stream<string>({
            name: 'CLI 账号终端',
            open: (signal) => api.cliworker.accountWatch(sessionId, id, signal),
            ended: () => new Error('账号终端连接已结束'),
          })
          stream = accountStream
          for await (const item of accountStream) {
            const frame = JSON.parse(item.value) as AccountFrame
            if (alive && !ended && frame.seq > lastSeq) {
              lastSeq = frame.seq
              if (frame.data) view.write(frame.data)
              if (frame.message) setNotice(frame.message)
            }
            item.accept()
            if (frame.status === 'closed' || frame.status === 'failed') {
              cleanupConfirmed = frame.cleanupConfirmed === true
              if (!ended) finish(frame.status === 'failed')
              break
            }
          }
          if (!ended) {
            if (alive) setNotice('账号终端连接已结束，请重试')
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
      fail('账号终端显示未能初始化，请重试')
      disposeView()
      focus.current = () => {}
    }
    return () => {
      alive = false
      if (generation.current === ownGeneration) generation.current++
      clearTimeout(startupTimer)
      startup.abort()
      disposeView()
      void stopSession().catch(() => undefined)
      void disposeStream().catch(() => undefined)
    }
  }, [api, sessionId, cli, action, source, attempt])

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
        setNotice('终端关闭失败，请重试')
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
      <style>{`.cwn-account-terminal-view:focus-within { outline: 2px solid var(--dsw-alias-label-primary); outline-offset: 3px; border-radius: 4px; }`}</style>
      <div className="cwn-account-terminal-head">
        <strong>{CLI_LABELS[cli]} 账号终端</strong>
        <Button variant="ghost" size="md" onClick={() => void close()} disabled={phase === 'stopping'}>
          关闭终端
        </Button>
      </div>
      {(phase === 'loading' || phase === 'stopping') && (
        <div className="cwn-loading" role="status">
          <StateDot state="ongoing" size={14} />
          {phase === 'loading' ? '正在启动账号终端…' : '正在关闭终端…'}
        </div>
      )}
      {instruction && <p className="cwn-account-instruction">{instruction}</p>}
      <div
        className="cwn-account-terminal-view"
        ref={element}
        aria-label={`${CLI_LABELS[cli]} 原生账号终端`}
        onClick={() => focus.current()}
      />
      {phase === 'running' && (
        <p className="cwn-account-instruction">点击终端开始输入，闪烁方块表示输入位置。</p>
      )}
      {(phase === 'failed' || phase === 'closed') && (
        <Button variant="ghost" size="md" onClick={() => void close(true)}>
          {phase === 'closed' ? '重新打开终端' : '重试'}
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
