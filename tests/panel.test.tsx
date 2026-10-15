import { createElement, forwardRef } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { Panel } from '../src/client/panel.tsx'
import type { API, Snapshot } from '../src/client/workers.ts'
import { CLI_IDS, type Worker, type HistoryPage } from '../src/shared/types.ts'

const clipboard = vi.hoisted(() => vi.fn().mockResolvedValue(true))
// Only the native control skins is replaced; actual Panel, hooks and stream consumer run.
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  writeClipboard: clipboard,
  Tooltip: ({ children }: any) => children,
  StateDot: () => createElement('span', { 'data-loading': true }),
  Switch: ({ checked, onChange, label, disabled }: any) =>
    createElement('button', {
      role: 'switch',
      'aria-label': label,
      'aria-checked': checked,
      disabled,
      onClick: () => onChange(!checked),
    }),
  Modal: ({ open, title, children, onClose, closeLabel }: any) =>
    open
      ? createElement(
          'section',
          { role: 'dialog', 'aria-label': title },
          createElement('button', { 'aria-label': closeLabel, onClick: onClose }, closeLabel),
          children,
        )
      : null,
  useAnchoredPosition: () => null,
  useDismissOnOutsidePointer: () => {},
  IconCheckOutlineRegular: () => createElement('svg'),
  IconChevronRightOutlineRegular: () => createElement('svg'),
  IconDatabaseOutlineRegular: () => createElement('svg'),
  IconGaugeOutlineRegular: () => createElement('svg'),
  IconSettingsOutlineRegular: () => createElement('svg'),
  IconSendOutlineRegular: () => createElement('svg'),
  IconCopyOutlineRegular: () => createElement('svg'),
  IconChevronDownOutlineRegular: () => createElement('svg'),
  IconTrashOutlineRegular: () => createElement('svg'),
  IconRefreshOutlineRegular: () => createElement('svg'),
  IconUserOutlineRegular: () => createElement('svg'),
  IconLinkOutlineRegular: () => createElement('svg'),
  MarkdownText: ({ text }: any) => createElement('div', {}, text),
  MenuItemButton: ({ children, onSelect, disabled }: any) =>
    createElement('button', { onClick: onSelect, disabled }, children),
  Menu: ({ anchor, open, items = [], onSelect, children }: any) =>
    createElement(
      'div',
      {},
      anchor,
      open &&
        createElement(
          'div',
          {},
          items.map((item: any) =>
            createElement(
              'button',
              {
                key: item.id,
                'aria-label': item.id,
                disabled: item.disabled,
                onClick: () => onSelect(item.id),
              },
              item.text ?? item.label,
            ),
          ),
          children,
        ),
    ),
  Input: forwardRef(({ icon, className, ...props }: any, ref) =>
    createElement('span', { className }, icon, createElement('input', { ...props, ref })),
  ),
  Button: forwardRef(({ children, variant: _variant, size: _size, ...props }: any, ref) =>
    createElement('button', { type: 'button', ...props, ref }, children),
  ),
}))
const workers: Worker[] = ['a', 'b'].map((id) => ({
  id,
  parentSessionId: 'parent',
  project: '/fixture',
  title: `Worker ${id}`,
  preference: { model: 'fixture', effort: 'low' },
  mode: 'accept-edits',
  status: 'completed',
  createdAt: '',
  updatedAt: '',
  runId: `run-${id}`,
  conversationId: `cli-${id}`,
}))
class Stream {
  private queue: string[] = []
  private wake?: () => void
  private error?: Error
  private closed = false
  accept = vi.fn()
  push(snapshot: Snapshot) {
    this.queue.push(JSON.stringify(snapshot))
    this.wake?.()
  }
  fail() {
    this.error = new Error('fixture disconnected')
    this.wake?.()
  }
  async dispose() {
    this.closed = true
    this.wake?.()
  }
  async *[Symbol.asyncIterator]() {
    while (!this.closed) {
      if (this.error) throw this.error
      const text = this.queue.shift()
      if (text) yield { value: text, accept: this.accept }
      else
        await new Promise<void>((resolve) => {
          this.wake = resolve
        })
    }
  }
}
const mounted: ReactTestRenderer[] = []
afterEach(async () => {
  await act(async () => {
    for (const r of mounted.splice(0)) r.unmount()
  })
})
const deferred = () => {
  let resolve!: (value: any) => void, reject!: (reason: unknown) => void
  const promise = new Promise<any>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
async function setup(
  openFirst = true,
  openNativeSettings?: () => void,
  snapshotWorkers = workers,
  cliworkerOverrides = {},
) {
  clipboard.mockReset().mockResolvedValue(true)
  const streams: Stream[] = []
  const history = vi.fn()
  const followup = vi.fn().mockResolvedValue({ ok: true, value: '{}' })
  const api = {
    $stream: () => {
      const s = new Stream()
      streams.push(s)
      return s
    },
    cliworker: {
      followup,
      history,
      catalogForWorker: vi.fn(async (_parent, id) => ({
        ok: true,
        value: JSON.stringify({
          cli: snapshotWorkers.find((worker) => worker.id === id)?.preference.cli ?? 'antigravity',
          models: [{ id: 'fixture', label: 'Synthetic fixture', efforts: ['low'] }],
        }),
      })),
      restartWorker: vi
        .fn()
        .mockResolvedValue({ ok: true, value: JSON.stringify({ workerId: 'new-worker-fixture' }) }),
      renameWorkerTitle: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
      renameWorker: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
      deleteWorker: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
      restoreWorker: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
      cliSettings: vi.fn(async () => ({
        ok: true,
        value: JSON.stringify({ enabled: Object.fromEntries(CLI_IDS.map((id) => [id, true])) }),
      })),
      accountStatus: vi.fn(async (_parent, cli) => ({
        ok: true,
        value: JSON.stringify({
          cli,
          installed: true,
          state: 'unknown',
          summary: '模拟账号状态未知',
          actions: [],
        }),
      })),
      ...cliworkerOverrides,
    },
  } as unknown as API
  const feed = { scrollTop: 0, scrollHeight: 1400, clientHeight: 300 }
  const overviewFocus = vi.fn()
  const overview = {
    scrollTop: 0,
    querySelector: vi.fn((selector: string) => (selector.includes("=''") ? null : { focus: overviewFocus })),
  }
  let r!: ReactTestRenderer
  await act(async () => {
    r = create(<Panel api={api} sessionId="parent" openNativeSettings={openNativeSettings} />, {
      createNodeMock: (el) =>
        el.props.className === 'cwn-feed'
          ? feed
          : el.props.className === 'cwn-overview-list'
            ? overview
            : el.props.className === 'cwn-compose'
              ? {
                  requestSubmit: () =>
                    r.root.findByProps({ className: 'cwn-compose' }).props.onSubmit({ preventDefault() {} }),
                }
              : null,
    })
    mounted.push(r)
  })
  const snapshot = (id?: string, revision = 1, overrides: Partial<Worker> = {}): Snapshot => ({
    workers: snapshotWorkers,
    selected: id ? { ...snapshotWorkers.find((w) => w.id === id)!, ...overrides } : undefined,
    revision,
    truncated: false,
    timeline: id
      ? [{ id: `message-${id}`, kind: 'assistant', text: `answer-${id}`, time: '2026-10-04T00:00:00Z' }]
      : [],
  })
  const push = async (id?: string, revision?: number, overrides?: Partial<Worker>) => {
    await act(async () => {
      streams.at(-1)!.push(snapshot(id, revision, overrides))
    })
  }
  await push()
  if (openFirst) {
    await act(async () => {
      r.root.findByProps({ 'data-open-worker-id': 'a' }).props.onClick()
    })
    await push('a')
  }
  const text = () => JSON.stringify(r.toJSON())
  const input = () => r.root.findByType('textarea')
  const edit = async (value: string) => {
    await act(async () => {
      input().props.onChange({ target: { value } })
    })
  }
  const click = async (label: string) => {
    await act(async () => {
      r.root
        .findAllByType('button')
        .find((b) => b.children.includes(label) || b.props['aria-label'] === label)!
        .props.onClick()
    })
  }
  const goBack = async () => {
    await click('返回子 Agent 列表')
    await push()
  }
  const select = async (id: string) => {
    if (r.root.findAllByProps({ 'aria-label': '返回子 Agent 列表' }).length) await goBack()
    await act(async () => {
      r.root.findByProps({ 'data-open-worker-id': id }).props.onClick()
    })
  }
  const submit = async () => {
    await act(async () => {
      r.root.findByProps({ className: 'cwn-compose' }).props.onSubmit({ preventDefault() {} })
    })
  }
  return {
    r,
    streams,
    api,
    followup,
    history,
    feed,
    overview,
    overviewFocus,
    push,
    snapshot,
    text,
    input,
    edit,
    click,
    select,
    submit,
    goBack,
  }
}
it.each([false, true])(
  'shows one neutral settings prompt while configuring (selected=%s)',
  async (selected) => {
    const t = await setup(selected)
    await act(async () => {
      t.streams.at(-1)!.push({ ...t.snapshot(selected ? 'a' : undefined), configuring: true })
    })
    expect(t.text()).toContain('等待确认设定。请在主对话的问题卡片中选择。')
    expect(t.text()).not.toContain('等待选择模型、思考强度与智能体预设')
    expect(t.followup).not.toHaveBeenCalled()
    await t.push(selected ? 'a' : undefined, 2)
    expect(t.text()).not.toContain('等待确认设定')
  },
)

it('preserves each worker draft and hides old content while switching', async () => {
  const t = await setup()
  await t.edit('draft A')
  await t.select('b')
  expect(t.text()).not.toContain('answer-a')
  await t.push('b')
  expect(t.input().props.value).toBe('')
  await t.edit('draft B')
  await t.select('a')
  await t.push('a')
  expect(t.input().props.value).toBe('draft A')
  await t.select('b')
  await t.push('b')
  expect(t.input().props.value).toBe('draft B')
})
it('shows and searches worker names alongside model metadata and the conversation topic', async () => {
  const named = [{ ...workers[0], agentName: '因果审稿人' }, workers[1]]
  const t = await setup(false, undefined, named)
  expect(t.r.root.findByType('h2').findByType('span').children).toEqual(['CLI Worker'])
  const meta = t.r.root.findByProps({ 'data-worker-id': 'a' }).findByProps({ className: 'cwn-worker-meta' })
  expect(meta.findByProps({ className: 'cwn-worker-name' }).findByType('span').children).toEqual([
    '因果审稿人',
  ])
  await act(async () => t.r.root.findByType('input').props.onChange({ target: { value: '因果' } }))
  expect(t.r.root.findAllByProps({ 'data-worker-id': 'b' })).toHaveLength(0)
  await t.select('a')
  await t.push('a')
  expect(t.r.root.findByProps({ className: 'cwn-head' }).findByType('h2').children).toEqual([
    '因果审稿人｜Worker a',
  ])
  await t.click('修改智能体名称')
  expect(t.r.root.findByProps({ 'aria-label': '新的智能体名称' }).props.value).toBe('因果审稿人')
})
it('queues a running followup without interrupting and keeps newer typing while admission is pending', async () => {
  const t = await setup(),
    done = deferred()
  const sendRunningMessage = vi.fn().mockReturnValue(done.promise)
  const stop = vi.fn()
  Object.assign(t.api.cliworker, { sendRunningMessage, stop })
  await t.push('a', 2, { status: 'running' })
  expect(t.input().props.disabled).toBe(false)
  const composerActions = () =>
    t.r.root.findAllByType('button').filter((button) => button.props.className === 'cwn-send')
  expect(composerActions()).toHaveLength(1)
  expect(composerActions()[0]!.props['aria-label']).toBe('停止')
  await t.edit('next step')
  expect(composerActions()).toHaveLength(1)
  expect(composerActions()[0]!.props['aria-label']).toBe('加入待发送消息')
  await t.submit()
  await t.submit()
  expect(sendRunningMessage).toHaveBeenCalledOnce()
  expect(sendRunningMessage.mock.calls[0]!.slice(0, 4)).toEqual(['parent', 'a', 'next step', 'run-a'])
  expect(sendRunningMessage.mock.calls[0]![4]).toEqual(expect.any(String))
  expect(t.input().props.disabled).toBe(false)
  await t.edit('another instruction')
  await act(async () => done.resolve({ ok: true, value: '{}' }))
  expect(t.input().props.value).toBe('another instruction')
  expect(t.followup).not.toHaveBeenCalled()
  expect(stop).not.toHaveBeenCalled()
  await t.edit('')
  expect(composerActions()).toHaveLength(1)
  expect(composerActions()[0]!.props['aria-label']).toBe('停止')
})
it('retains a rejected queued draft and reuses its request identity on retry', async () => {
  const t = await setup()
  const sendRunningMessage = vi
    .fn()
    .mockRejectedValueOnce(new Error('模拟连接中断'))
    .mockResolvedValue({ ok: true, value: '{}' })
  Object.assign(t.api.cliworker, { sendRunningMessage })
  await t.push('a', 2, { status: 'queued', conversationId: undefined })
  await t.edit('send after the first turn')
  await t.submit()
  expect(t.input().props.value).toBe('send after the first turn')
  expect(t.text()).toContain('模拟连接中断')
  await t.submit()
  expect(sendRunningMessage.mock.calls[1]!.slice(0, 5)).toEqual(sendRunningMessage.mock.calls[0]!.slice(0, 5))
  expect(t.input().props.value).toBe('')
})
it('shows host queued messages with cancel and explicit resume after failure, without automatic client dispatch', async () => {
  const t = await setup()
  const cancelQueuedFollowup = vi.fn().mockResolvedValue({ ok: true, value: undefined })
  const retryQueuedFollowups = vi.fn().mockResolvedValue({ ok: true, value: undefined })
  const queueFollowup = vi.fn().mockResolvedValue({ ok: true, value: '{}' })
  Object.assign(t.api.cliworker, { cancelQueuedFollowup, retryQueuedFollowups, queueFollowup })
  const queuedFollowups = [
    {
      id: 'pending-a',
      prompt: 'saved pending instruction',
      createdAt: '',
      state: 'paused' as const,
      pauseReason: '前轮失败，等待继续发送',
    },
  ]
  await act(async () =>
    t.streams.at(-1)!.push({ ...t.snapshot('a', 2, { status: 'failed' }), queuedFollowups }),
  )
  expect(t.text()).toContain('saved pending instruction')
  expect(t.text()).toContain('前轮失败，等待继续发送')
  expect(retryQueuedFollowups).not.toHaveBeenCalled()
  await t.edit('append after the paused message')
  await t.submit()
  expect(queueFollowup.mock.calls[0]!.slice(0, 3)).toEqual(['parent', 'a', 'append after the paused message'])
  expect(t.followup).not.toHaveBeenCalled()
  await t.click('继续发送')
  expect(retryQueuedFollowups).toHaveBeenCalledWith('parent', 'a', 'run-a')
  await t.click('取消待发送消息 1')
  expect(cancelQueuedFollowup).toHaveBeenCalledWith('parent', 'a', 'pending-a')
})
it('does not submit queued guidance while stopping or disconnected', async () => {
  const t = await setup()
  const sendRunningMessage = vi.fn()
  Object.assign(t.api.cliworker, { sendRunningMessage })
  await t.edit('keep this draft')
  await t.push('a', 2, { status: 'stopping' })
  expect(t.input().props.disabled).toBe(true)
  await t.submit()
  await t.push('a', 3, { status: 'running' })
  await act(async () => t.streams.at(-1)!.fail())
  await t.submit()
  expect(sendRunningMessage).not.toHaveBeenCalled()
  expect(t.input().props.value).toBe('keep this draft')
})
it('allows cancelling queued metadata preparation but uses stop after runtime admission', async () => {
  const t = await setup()
  const cancelQueuedFollowup = vi.fn().mockResolvedValue({ ok: true, value: undefined })
  Object.assign(t.api.cliworker, { cancelQueuedFollowup })
  const queuedFollowups = [
    { id: 'preparing', prompt: 'pending preparation', createdAt: '', state: 'sending' as const },
  ]
  await act(async () => t.streams.at(-1)!.push({ ...t.snapshot('a', 2), queuedFollowups }))
  const cancel = () =>
    t.r.root.findAllByType('button').find((button) => button.props['aria-label'] === '取消待发送消息 1')!
  expect(cancel().props.disabled).toBe(false)
  await t.click('取消待发送消息 1')
  expect(cancelQueuedFollowup).toHaveBeenCalledWith('parent', 'a', 'preparing')
  await act(async () =>
    t.streams.at(-1)!.push({ ...t.snapshot('a', 3, { status: 'queued' }), queuedFollowups }),
  )
  expect(cancel().props.disabled).toBe(true)
  expect(
    t.r.root.findAllByType('button').find((button) => button.props['aria-label'] === '停止')!.props.disabled,
  ).toBe(false)
})
it('late submission success clears only its originating draft', async () => {
  const t = await setup(),
    done = deferred()
  t.followup.mockReturnValue(done.promise)
  await t.edit('submit A')
  await t.submit()
  await t.select('b')
  await t.push('b')
  await t.edit('keep B')
  await act(async () => {
    done.resolve({ ok: true, value: '{}' })
  })
  expect(t.input().props.value).toBe('keep B')
  expect(t.followup).toHaveBeenCalledWith('parent', 'a', 'submit A', expect.any(AbortSignal))
  await t.select('a')
  await t.push('a')
  expect(t.input().props.value).toBe('')
})
it('late errors belong to the original worker and preserve its draft', async () => {
  const t = await setup(),
    done = deferred()
  t.followup.mockReturnValue(done.promise)
  await t.edit('retry A')
  await t.submit()
  await t.select('b')
  await t.push('b')
  await act(async () => {
    done.resolve({ ok: false, error: { message: 'fixture submission failed' } })
  })
  expect(t.text()).not.toContain('fixture submission failed')
  await t.select('a')
  await t.push('a')
  expect(t.text()).toContain('fixture submission failed')
  expect(t.input().props.value).toBe('retry A')
})
it('reconnect preserves received history and draft without dispatching or duplicating messages', async () => {
  const t = await setup()
  await t.edit('unsent')
  await act(async () => {
    t.streams.at(-1)!.fail()
  })
  expect(t.text()).toContain('answer-a')
  expect(t.input().props.disabled).toBe(true)
  await t.click('重新连接')
  expect(t.text()).toContain('answer-a')
  await t.push('a')
  expect(t.text().match(/answer-a/g)).toHaveLength(1)
  expect(t.input().props.value).toBe('unsent')
  expect(t.followup).not.toHaveBeenCalled()
})
it('keeps reading position during updates and offers jump to latest', async () => {
  const t = await setup()
  t.feed.scrollTop = 50
  await act(async () => {
    t.r.root.findByProps({ className: 'cwn-feed' }).props.onScroll()
  })
  t.feed.scrollHeight = 2000
  await t.push('a', 2)
  expect(t.feed.scrollTop).toBe(50)
  await t.click('回到最新消息')
  expect(t.feed.scrollTop).toBe(2000)
  expect(t.r.root.findAllByProps({ 'aria-label': '回到最新消息' })).toHaveLength(0)
})
it('keeps a missing CLI session unable to send while removing its input notice and retaining errors, history and draft', async () => {
  const t = await setup()
  await t.edit('unsent draft before the session became unavailable')
  await t.push('a', 2, { status: 'interrupted', conversationId: undefined, error: '上次 Harness 运行中断' })
  expect(t.text()).not.toContain('本次运行未建立 CLI 会话')
  expect(t.text()).not.toContain('无法续聊')
  expect(t.text()).toContain('上次 Harness 运行中断')
  expect(t.text()).toContain('answer-a')
  expect(t.input().props.disabled).toBe(true)
  expect(
    t.r.root.findAllByType('button').find((button) => button.props['aria-label'] === '继续对话')!.props
      .disabled,
  ).toBe(true)
  await act(async () =>
    t.input().props.onKeyDown({
      key: 'Enter',
      preventDefault() {},
      getModifierState: () => false,
      nativeEvent: {},
    }),
  )
  await t.submit()
  expect(t.followup).not.toHaveBeenCalled()
  expect(t.api.cliworker.restartWorker).not.toHaveBeenCalled()
  expect(t.input().props.value).toBe('unsent draft before the session became unavailable')
})
it('changing parent session hides prior worker and ignores old stream updates', async () => {
  const t = await setup(),
    oldStream = t.streams.at(-1)!
  await act(async () => {
    t.r.update(<Panel api={t.api} sessionId="other-parent" />)
  })
  await act(async () => {
    oldStream.push({ workers, timeline: [], revision: 50, truncated: false })
  })
  expect(t.text()).not.toContain('Worker a')
  expect(t.text()).not.toContain('answer-a')
})

const oldPage = (workerId = 'a'): HistoryPage => ({
  workerId,
  items: [{ id: 'old-row', kind: 'assistant', text: 'historical answer', time: '2026-10-04T00:00:00Z' }],
  start: 0,
  end: 1,
  total: 2,
  hasOlder: false,
  hasNewer: true,
})
it('keeps historical content and reading position stable while live snapshots arrive', async () => {
  const t = await setup()
  await act(async () => {
    t.streams.at(-1)!.push({ ...t.snapshot('a'), truncated: true })
  })
  t.history.mockResolvedValue({ ok: true, value: JSON.stringify(oldPage()) })
  await t.click('查看更早记录')
  expect(t.history).toHaveBeenCalledWith('parent', 'a', 'message-a', 'before')
  expect(t.text()).toContain('historical answer')
  t.feed.scrollTop = 40
  await t.push('a', 10)
  expect(t.text()).not.toContain('answer-a')
  expect(t.feed.scrollTop).toBe(40)
  await t.click('返回实时')
  expect(t.text()).toContain('answer-a')
  expect(t.text()).not.toContain('historical answer')
  expect(t.followup).not.toHaveBeenCalled()
})
it('ignores a delayed history page after changing workers', async () => {
  const t = await setup(),
    result = deferred()
  await act(async () => {
    t.streams.at(-1)!.push({ ...t.snapshot('a'), truncated: true })
  })
  t.history.mockReturnValue(result.promise)
  await t.click('查看更早记录')
  await t.select('b')
  await t.push('b')
  await act(async () => {
    result.resolve({ ok: true, value: JSON.stringify(oldPage()) })
  })
  expect(t.text()).not.toContain('historical answer')
  expect(t.text()).toContain('answer-b')
})
it('preserves the overview filters and each draft across back navigation', async () => {
  const t = await setup()
  await t.edit('draft remains')
  await t.goBack()
  expect(t.r.root.findAllByType('textarea')).toHaveLength(0)
  await act(async () =>
    t.r.root.findByProps({ 'aria-label': '筛选子 Agent' }).props.onChange({ target: { value: 'worker A' } }),
  )
  const list = () => t.r.root.findAll((n) => n.type === 'button' && n.props['data-open-worker-id'])
  expect(list()).toHaveLength(1)
  await t.select('a')
  await t.push('a')
  expect(t.input().props.value).toBe('draft remains')
  expect(t.r.root.findAllByProps({ 'aria-label': '子 Agent' })).toHaveLength(0)
  await t.goBack()
  expect(t.r.root.findByProps({ 'aria-label': '筛选子 Agent' }).props.value).toBe('worker A')
  await t.click('进行中')
  expect(list()).toHaveLength(0)
  expect(t.text()).not.toContain('没有匹配的任务')
  expect(t.text()).not.toContain('清除筛选')
  await act(async () =>
    t.r.root.findByProps({ 'aria-label': '筛选子 Agent' }).props.onChange({ target: { value: '' } }),
  )
  await t.click('全部')
  expect(list()).toHaveLength(2)
  await t.select('a')
  await t.push('a')
  expect(t.input().props.value).toBe('draft remains')
})
it('shows uncertain AGY results as attention warnings, preserves replies and never retries automatically', async () => {
  const uncertain: Worker = {
    ...workers[0]!,
    status: 'uncertain',
    lastResult: 'AGY_READY',
    error: '本轮已返回，但 CLI 汇总状态异常；结果待核实，请勿自动重试。',
  }
  const t = await setup(false, undefined, [uncertain, workers[1]!])
  await t.click('已完成')
  expect(t.r.root.findAllByProps({ 'data-open-worker-id': 'a' })).toHaveLength(0)
  await t.click('异常')
  expect(t.r.root.findAllByProps({ 'data-open-worker-id': 'a' })).toHaveLength(1)
  expect(t.text()).toContain('结果待核实')
  await t.select('a')
  await act(async () =>
    t.streams.at(-1)!.push({
      ...t.snapshot('a'),
      timeline: [
        {
          id: 'run-a:assistant:45',
          kind: 'assistant',
          text: 'AGY_READY',
          state: 'DONE',
          time: '2026-10-15T00:00:00Z',
        },
      ],
    }),
  )
  expect(t.r.root.findByProps({ className: 'cwn-notice cwn-warning' }).children).toContain(uncertain.error)
  expect(t.r.root.findAllByProps({ className: 'cwn-error' })).toHaveLength(0)
  expect(t.text()).toContain('AGY_READY')
  expect(t.input().props.disabled).toBeFalsy()
  expect(t.followup).not.toHaveBeenCalled()
  expect(t.api.cliworker.restartWorker).not.toHaveBeenCalled()
})
it.each([
  ['进行中', 'running'],
  ['已完成', 'completed'],
  ['异常', 'failed'],
] as const)(
  'keeps %s filtering and search usable without summary or reset text',
  async (label, selectedStatus) => {
    const history: Worker[] = (['running', 'completed', 'failed'] as const).map((status, index) => ({
      ...workers[0]!,
      id: `status-${index}`,
      status,
      title: `Task ${status}`,
    }))
    const t = await setup(false, undefined, history)
    const cards = () =>
      t.r.root.findAll((node) => node.type === 'button' && node.props['data-open-worker-id'])
    const search = async (value: string) =>
      act(async () =>
        t.r.root.findByProps({ 'aria-label': '筛选子 Agent' }).props.onChange({ target: { value } }),
      )
    await t.click(label)
    expect(cards().map((card) => card.props['data-open-worker-id'])).toEqual([
      history.find((worker) => worker.status === selectedStatus)!.id,
    ])
    expect(t.text()).not.toContain('个匹配任务')
    expect(t.text()).not.toContain('清除筛选')
    await search('no matching task')
    expect(cards()).toHaveLength(0)
    expect(t.text()).not.toContain('没有匹配的任务')
    expect(t.text()).not.toContain('清除筛选')
    await search('')
    expect(cards()).toHaveLength(1)
    await t.click('全部')
    expect(cards()).toHaveLength(3)
    expect(t.followup).not.toHaveBeenCalled()
    expect(t.api.cliworker.restartWorker).not.toHaveBeenCalled()
  },
)
it('keeps search and status controls outside the card scroller and restores its reading position', async () => {
  const t = await setup(false)
  const scroller = t.r.root.findByProps({ className: 'cwn-overview-list' })
  expect(scroller.findAllByProps({ 'aria-label': '筛选子 Agent' })).toHaveLength(0)
  expect(scroller.findAllByProps({ 'aria-label': '任务状态筛选' })).toHaveLength(0)
  expect(scroller.findAllByProps({ 'data-open-worker-id': 'a' })).toHaveLength(1)
  t.overview.scrollTop = 275
  await act(async () => scroller.props.onScroll())
  await t.select('a')
  await t.push('a')
  t.overview.scrollTop = 0
  await t.goBack()
  expect(t.overview.scrollTop).toBe(275)
  expect(t.overview.querySelector).toHaveBeenLastCalledWith("[data-open-worker-id='a']")
  expect(t.overviewFocus).toHaveBeenCalledWith({ preventScroll: true })
})

it('toggles the accessible trash entry without changing search or any of the four status filters', async () => {
  const t = await setup(false)
  const search = () => t.r.root.findByProps({ 'aria-label': '筛选子 Agent' })
  await act(async () => search().props.onChange({ target: { value: 'Worker a' } }))
  await t.click('已完成')
  const filters = () => t.r.root.findByProps({ 'aria-label': '任务状态筛选' }).findAllByType('button')
  const selection = () => filters().map((button) => button.props['aria-pressed'])
  expect(selection()).toEqual([false, false, true, false])
  await t.click('已删除')
  expect(t.r.root.findByProps({ 'aria-label': '返回列表' }).props['aria-pressed']).toBe(true)
  expect(selection()).toEqual([false, false, false, false])
  expect(search().props.value).toBe('Worker a')
  expect(t.text()).toContain('没有已删除的对话')
  expect(t.text()).not.toContain('把想做的事')
  await t.click('返回列表')
  expect(selection()).toEqual([false, false, true, false])
  expect(search().props.value).toBe('Worker a')
  expect(t.r.root.findAllByProps({ 'data-open-worker-id': 'a' })).toHaveLength(1)
  expect(t.r.root.findAllByProps({ 'data-open-worker-id': 'b' })).toHaveLength(0)
})

it.each([
  ['全部', ['queued', 'running', 'stopping', 'completed', 'failed', 'interrupted']],
  ['进行中', ['queued', 'running', 'stopping']],
  ['已完成', ['completed']],
  ['异常', ['failed', 'interrupted']],
] as const)(
  'leaves the recycle view through %s while preserving the search and applying the requested filter',
  async (label, expectedIds) => {
    const source: Worker[] = (
      ['queued', 'running', 'stopping', 'completed', 'failed', 'interrupted'] as const
    ).map((state) => ({
      ...workers[0]!,
      id: state,
      title: `needle ${state}`,
      status: state,
    }))
    source.push({
      ...workers[1]!,
      id: 'outside',
      title: 'outside search',
      preference: { model: 'other', effort: 'low' },
    })
    const t = await setup(false, undefined, source)
    await act(async () =>
      t.streams.at(-1)!.push({
        ...t.snapshot(),
        archivedWorkers: [
          {
            ...workers[0]!,
            id: 'deleted',
            title: 'needle deleted',
            archivedAt: '2026-10-09T08:00:00Z',
          },
        ],
      }),
    )
    const search = () => t.r.root.findByProps({ 'aria-label': '筛选子 Agent' })
    await act(async () => search().props.onChange({ target: { value: 'needle' } }))
    await t.click('已完成')
    await t.click('已删除')
    const filters = () => t.r.root.findByProps({ 'aria-label': '任务状态筛选' }).findAllByType('button')
    expect(filters().every((button) => !button.props['aria-pressed'] && !button.props.disabled)).toBe(true)
    expect(t.r.root.findAllByProps({ 'aria-label': '已删除对话' })).toHaveLength(1)
    await t.click(label)
    expect(t.r.root.findAllByProps({ 'aria-label': '已删除对话' })).toHaveLength(0)
    expect(search().props.value).toBe('needle')
    expect(
      filters()
        .filter((button) => button.props['aria-pressed'])
        .map((button) => button.children[0]),
    ).toEqual([label])
    expect(t.r.root.findByProps({ 'aria-label': '已删除' }).props['aria-pressed']).toBe(false)
    expect(
      t.r.root
        .findAll((node) => node.type === 'button' && node.props['data-open-worker-id'])
        .map((node) => node.props['data-open-worker-id']),
    ).toEqual([...expectedIds])
    expect(t.api.cliworker.followup).not.toHaveBeenCalled()
    expect(t.api.cliworker.restartWorker).not.toHaveBeenCalled()
  },
)

it('distinguishes the short initial empty page from filtered and deleted empty states and incoming tasks', async () => {
  const t = await setup(false, undefined, [])
  const initial = t.r.root.findByProps({ className: 'cwn-empty cwn-start-empty' })
  expect(initial.findAllByType('h3')[0]!.children).toEqual(['把想做的事，交给合适的伙伴。'])
  expect(initial.findAllByType('p')[0]!.children).toEqual(['在主对话中发起任务，协作会在这里展开。'])
  expect(initial.findAllByType('svg')).toHaveLength(0)
  expect(initial.findAllByType('blockquote')).toHaveLength(0)
  for (const filter of ['进行中', '已完成', '异常']) {
    await t.click(filter)
    expect(t.text()).not.toContain('没有匹配的任务')
    expect(t.text()).not.toContain('清除筛选')
    expect(t.text()).not.toContain('把想做的事')
    expect(t.r.root.findByProps({ 'aria-label': '子 Agent' }).children).toHaveLength(0)
  }
  await t.click('已删除')
  expect(t.text()).toContain('没有已删除的对话')
  expect(t.text()).not.toContain('没有匹配的任务')
  await t.click('返回列表')
  await t.click('全部')
  expect(t.text()).toContain('把想做的事')
  await act(async () => t.streams.at(-1)!.push({ ...t.snapshot(), workers: [workers[0]!] }))
  expect(t.text()).not.toContain('把想做的事')
  expect(t.r.root.findAllByProps({ 'data-open-worker-id': 'a' })).toHaveLength(1)
})

it('copies the exact current result and reports clipboard refusal honestly', async () => {
  const t = await setup()
  await t.push('a', 2, { lastResult: 'exact result\n' })
  await t.click('复制最新结果')
  expect(clipboard).toHaveBeenLastCalledWith('exact result\n')
  expect(t.text()).toContain('已复制')
  clipboard.mockResolvedValue(false)
  await t.click('复制回复')
  expect(clipboard).toHaveBeenLastCalledWith('answer-a')
  expect(t.text()).toContain('复制失败，请选择文本手动复制')
})

it('selects defaults per CLI and limits effort choices to the selected model', async () => {
  const f = await setup()
  const catalogForCli = vi.fn(async (_parent, cli) => ({
    ok: true,
    value: JSON.stringify({
      cli,
      models:
        cli === 'kimi'
          ? [{ id: 'kimi-model', efforts: ['default'] }]
          : [
              { id: 'model-a', efforts: ['low', 'high'] },
              { id: 'model-b', efforts: ['high'] },
            ],
    }),
  }))
  const configure = vi.fn().mockResolvedValue({ ok: true, value: '{}' })
  Object.assign(f.api.cliworker, { catalogForCli, configure })
  await f.click('默认设置')
  await f.click('Codex 设置')
  expect(configure).not.toHaveBeenCalled()
  await f.click('默认模型')
  await f.click('model-b')
  expect(f.text()).toContain('High')
  expect(configure).toHaveBeenCalledTimes(1)
  expect(JSON.parse(configure.mock.calls[0]![1])).toEqual({
    cli: 'codex',
    model: 'model-b',
    effort: 'high',
  })
  await f.click('Kimi 设置')
  expect(f.text()).toContain('默认')
  expect(configure).toHaveBeenCalledTimes(1)
  await f.click('默认模型')
  await f.click('kimi-model')
  expect(configure).toHaveBeenCalledTimes(2)
  expect(JSON.parse(configure.mock.calls[1]![1])).toEqual({
    cli: 'kimi',
    model: 'kimi-model',
    effort: 'default',
  })
})
it('failed CLI discovery clears the previous catalog and prevents saving it to another CLI', async () => {
  const f = await setup()
  const configure = vi.fn().mockResolvedValue({ ok: true, value: '{}' })
  Object.assign(f.api.cliworker, {
    configure,
    catalogForCli: vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        value: JSON.stringify({ cli: 'antigravity', models: [{ id: 'm', efforts: ['low'] }] }),
      })
      .mockRejectedValueOnce(new Error('CLI missing')),
  })
  await f.click('默认设置')
  await f.click('MiMo 设置')
  expect(f.text()).toContain('CLI missing')
  expect(
    f.r.root.findAllByType('button').find((b) => b.props['aria-label'] === '默认模型')?.props.disabled,
  ).toBe(true)
  expect(
    f.r.root.findAllByType('button').find((b) => b.props['aria-label'] === '默认思考强度')?.props.disabled,
  ).toBe(true)
  expect(configure).not.toHaveBeenCalled()
})

it('uses the selected CLI name in assistant messages and shows the reported model alias target', async () => {
  const f = await setup()
  await f.push('a', 2, {
    preference: { cli: 'claude', model: 'sonnet', effort: 'low' },
    observedModel: 'glm-example',
  })
  expect(
    f.r.root.findByProps({ className: 'cwn-message-label' }).findByProps({ className: 'cwn-sr-only' })
      .children[0],
  ).toBe('Claude Code')
  expect(f.text()).toContain('glm-example')
})

it('starts on grouped overview without auto-opening a worker and keeps collapsed groups', async () => {
  const mixed = [
    ...workers,
    {
      ...workers[0]!,
      id: 'c',
      title: 'Codex task',
      preference: { cli: 'codex' as const, model: 'gpt-example', effort: 'high' as const },
      status: 'running' as const,
    },
  ]
  const t = await setup(false, undefined, mixed)
  await act(async () =>
    t.streams.at(-1)!.push({ workers: mixed, timeline: [], revision: 2, truncated: false }),
  )
  const groups = () => t.r.root.findAllByProps({ className: 'cwn-cli-group' })
  expect(groups()).toHaveLength(2)
  expect(groups()[0]!.findAllByProps({ className: 'cwn-worker' })).toHaveLength(2)
  expect(groups()[1]!.findAllByProps({ className: 'cwn-worker' })).toHaveLength(1)
  expect(t.r.root.findAllByType('textarea')).toHaveLength(0)
  const line = groups()[1]!.findByProps({ className: 'cwn-worker-line' })
  expect(line.children[0].props.className).toBe('cwn-worker-title')
  expect(line.children[1].props.className).toContain('cwn-worker-status')
  const codexHeading = () => groups()[1]!.findByProps({ className: 'cwn-cli-heading' })
  const codexRows = () => groups()[1]!.findByProps({ className: 'cwn-cli-rows' })
  const codexWorker = () => groups()[1]!.findByProps({ 'data-open-worker-id': 'c' })
  const rowsId = codexHeading().props['aria-controls']
  expect(codexRows().props.id).toBe(rowsId)
  expect(codexWorker().props.tabIndex).toBeUndefined()
  await act(async () => groups()[1]!.findByProps({ className: 'cwn-cli-heading' }).props.onClick())
  // Retain rows for the CSS height transition, but remove all interaction while collapsed.
  expect(groups()[1]!.findAllByProps({ className: 'cwn-worker' })).toHaveLength(1)
  expect(codexRows().props['aria-hidden']).toBe(true)
  expect(codexRows().props.inert).toBe('')
  expect(codexWorker().props.tabIndex).toBe(-1)
  const streamsBefore = t.streams.length
  await act(async () => codexWorker().props.onClick())
  expect(t.streams).toHaveLength(streamsBefore)
  expect(t.r.root.findAllByProps({ 'aria-label': '返回子 Agent 列表' })).toHaveLength(0)
  await t.select('a')
  await t.push('a')
  await t.goBack()
  await act(async () =>
    t.streams.at(-1)!.push({ workers: mixed, timeline: [], revision: 3, truncated: false }),
  )
  expect(codexHeading().props['aria-expanded']).toBe(false)
  expect(codexHeading().props['aria-controls']).toBe(rowsId)
  expect(codexRows().props['aria-hidden']).toBe(true)
  await act(async () => codexHeading().props.onClick())
  expect(codexRows().props['aria-hidden']).toBe(false)
  expect(codexRows().props.inert).toBeUndefined()
  expect(codexWorker().props.tabIndex).toBeUndefined()
  await t.select('c')
  await t.push('c')
  expect(t.text()).toContain('answer-c')
  expect(t.r.root.findAllByType('textarea')).toHaveLength(1)
})
it('keeps metadata out of child header and stops through the integrated composer without sending text', async () => {
  const t = await setup()
  const stop = vi.fn().mockResolvedValue({ ok: true, value: '{}' })
  Object.assign(t.api.cliworker, { stop })
  await t.push('a', 2, { status: 'running' })
  const header = t.r.root.findByProps({ className: 'cwn-head' })
  expect(header.findAllByProps({ title: '派遣时选择的模型' })).toHaveLength(0)
  expect(header.findAllByProps({ className: 'cwn-back' })).not.toHaveLength(0)
  expect(t.text()).toContain('fixture')
  expect(t.input().props.disabled).toBe(false)
  await t.click('停止')
  expect(stop).toHaveBeenCalledWith('parent', 'a')
  expect(t.followup).not.toHaveBeenCalled()
})

it('model menu updates an idle worker without dispatching or changing project defaults', async () => {
  const configureWorker = vi.fn().mockResolvedValue({ ok: true, value: '{}' })
  const configure = vi.fn()
  const t = await setup(true, undefined, workers, {
    catalogForWorker: vi.fn().mockResolvedValue({
      ok: true,
      value: JSON.stringify({ cli: 'antigravity', models: [{ id: 'next-model', efforts: ['low'] }] }),
    }),
    configureWorker,
    configure,
  })
  await t.click('模型与强度')
  await t.click('model')
  await act(async () => {
    t.r.root
      .findAllByType('button')
      .find((b) => b.findAll((n) => n.type === 'span' && n.children.includes('next-model')).length > 0)!
      .props.onClick()
  })
  expect(configureWorker).toHaveBeenCalledWith(
    'parent',
    'a',
    JSON.stringify({ cli: 'antigravity', model: 'next-model', effort: 'low' }),
  )
  expect(configure).not.toHaveBeenCalled()
  expect(t.followup).not.toHaveBeenCalled()
})
it('simplifies a historical full model route in task cards and the composer without a catalog', async () => {
  const id = 'account:bigmodel-individual-coding-plan/GLM-5.3-Flash'
  const history = [
    { ...workers[0]!, preference: { cli: 'zcode' as const, model: id, effort: 'low' as const } },
  ]
  const t = await setup(false, undefined, history)
  const card = t.r.root.findByProps({ className: 'cwn-worker-model' })
  expect(card.children).toEqual(['GLM-5.3-Flash'])
  expect(card.props.title).toBe('GLM-5.3-Flash')
  expect(t.text()).not.toContain('account:bigmodel')
  expect(history[0]!.preference.model).toBe(id)
  await t.select('a')
  await t.push('a')
  const compose = t.r.root.findByProps({ 'aria-label': '模型与强度' })
  expect(compose.findAllByType('span')[0]!.children).toEqual(['GLM-5.3-Flash'])
  expect(compose.props.title).toBe('GLM-5.3-Flash · Low')
  expect(t.text()).not.toContain('account:bigmodel')
})

it('worker model choices deduplicate with free priority while keeping the selected exact route and effort', async () => {
  const history = [
    { ...workers[0]!, preference: { cli: 'pi' as const, model: 'paid/GLM-5.3', effort: 'high' as const } },
  ]
  const configureWorker = vi.fn().mockResolvedValue({ ok: true, value: '{}' })
  const configure = vi.fn()
  const t = await setup(true, undefined, history, {
    catalogForWorker: vi.fn().mockResolvedValue({
      ok: true,
      value: JSON.stringify({
        cli: 'pi',
        models: [
          { id: 'paid/GLM-5.3', label: 'GLM-5.3（paid source）', cost: 'paid', efforts: ['high'] },
          { id: 'free/glm-5.3', label: 'GLM-5.3 (free source)', cost: 'free', efforts: ['default'] },
          { id: 'native/other-free', label: 'Other free (provider)', cost: 'free', efforts: ['default'] },
          {
            id: 'native/GLM-5.3-Flash',
            label: 'GLM-5.3-Flash (provider)',
            cost: 'unknown',
            efforts: ['medium'],
          },
        ],
      }),
    }),
    configureWorker,
    configure,
  })
  await t.click('模型与强度')
  await t.click('effort')
  const effortButtons = t.r.root
    .findAllByType('button')
    .filter((button) => ['high', 'default'].includes(button.props['aria-label']))
  expect(effortButtons.map((button) => button.props['aria-label'])).toEqual(['high'])
  await t.click('back')
  await t.click('model')
  const entries = t.r.root
    .findAllByType('button')
    .filter(
      (button) =>
        button.findAll((node) => node.type === 'span' && typeof node.props.title === 'string').length > 0,
    )
  expect(
    entries.map((button) =>
      button
        .findAll((node) => node.type === 'span' && typeof node.props.title === 'string')[0]!
        .children.join(''),
    ),
  ).toEqual(['Other free', 'GLM-5.3', 'GLM-5.3-Flash'])
  expect(t.text()).not.toContain('source')
  expect(configureWorker).not.toHaveBeenCalled()
  await act(async () => entries[1]!.props.onClick())
  expect(configureWorker).toHaveBeenCalledWith(
    'parent',
    'a',
    JSON.stringify({ cli: 'pi', model: 'paid/GLM-5.3', effort: 'high' }),
  )
  expect(configure).not.toHaveBeenCalled()
  expect(t.followup).not.toHaveBeenCalled()
})

it('model catalog failure is recoverable and never appears as a raw transport option', async () => {
  const t = await setup(true, undefined, workers, {
    catalogForWorker: vi.fn().mockRejectedValue(new Error('transport failure: HTTP 404')),
  })
  await t.click('模型与强度')
  expect(t.text()).toContain('插件服务尚未更新')
  expect(t.text()).not.toContain('HTTP 404')
  expect(t.text()).not.toContain('transport failure')
})

it('worker model menu preloads once and reuses its choices after reopening and changing selection', async () => {
  const catalogForWorker = vi.fn().mockResolvedValue({
    ok: true,
    value: JSON.stringify({
      cli: 'antigravity',
      models: [{ id: 'saved-model', label: 'Saved model', efforts: ['low', 'high'] }],
    }),
  })
  const configureWorker = vi.fn().mockResolvedValue({ ok: true, value: '{}' })
  const t = await setup(true, undefined, workers, { catalogForWorker, configureWorker })
  expect(catalogForWorker).toHaveBeenCalledExactlyOnceWith('parent', 'a', expect.any(AbortSignal))
  await t.click('模型与强度')
  await t.click('model')
  const choice = t.r.root
    .findAllByType('button')
    .find(
      (button) =>
        button.findAll((node) => node.type === 'span' && node.props.title === 'Saved model').length > 0,
    )!
  await act(async () => choice.props.onClick())
  expect(configureWorker).toHaveBeenCalledWith(
    'parent',
    'a',
    JSON.stringify({ cli: 'antigravity', model: 'saved-model', effort: 'low' }),
  )
  await t.click('模型与强度')
  await t.click('effort')
  await t.click('high')
  expect(configureWorker).toHaveBeenLastCalledWith(
    'parent',
    'a',
    JSON.stringify({ cli: 'antigravity', model: 'saved-model', effort: 'high' }),
  )
  await t.click('模型与强度')
  await t.click('model')
  expect(t.text()).toContain('Saved model')
  expect(catalogForWorker).toHaveBeenCalledTimes(1)
  expect(t.followup).not.toHaveBeenCalled()
})

it('worker model preload rejects a different CLI and retries without admitting its choices', async () => {
  const response = (cli: string, models: unknown[]) => ({ ok: true, value: JSON.stringify({ cli, models }) })
  const catalogForWorker = vi
    .fn()
    .mockResolvedValueOnce(response('pi', [{ id: 'wrong-cli-model', efforts: ['low'] }]))
    .mockRejectedValueOnce(new Error('CliAccountBindingError: 模拟：原生目录读取失败'))
    .mockResolvedValueOnce(response('antigravity', []))
    .mockResolvedValueOnce(response('antigravity', [{ id: 'recovered-model', efforts: ['low'] }]))
  const configureWorker = vi.fn()
  const t = await setup(true, undefined, workers, { catalogForWorker, configureWorker })
  await t.click('模型与强度')
  expect(t.text()).toContain('收到不匹配的 CLI 模型目录')
  expect(t.text()).not.toContain('wrong-cli-model')
  const modelButton = () =>
    t.r.root.findAllByType('button').find((button) => button.props['aria-label'] === 'model')!
  expect(modelButton().props.disabled).toBe(true)
  await t.click('重试')
  expect(t.text()).toContain('模拟：原生目录读取失败')
  expect(t.text()).not.toContain('Error:')
  await t.click('重试')
  expect(t.text()).toContain('此 CLI 未返回可用模型')
  expect(modelButton().props.disabled).toBe(true)
  await t.click('重试')
  expect(modelButton().props.disabled).toBe(false)
  await t.click('model')
  expect(t.text()).toContain('recovered-model')
  expect(configureWorker).not.toHaveBeenCalled()
  expect(t.followup).not.toHaveBeenCalled()
})

it('worker menu cancels a slow preload when changing conversations', async () => {
  const first = deferred()
  const catalogForWorker = vi
    .fn()
    .mockReturnValueOnce(first.promise)
    .mockResolvedValueOnce({
      ok: true,
      value: JSON.stringify({ cli: 'antigravity', models: [{ id: 'worker-b-model', efforts: ['low'] }] }),
    })
  const t = await setup(true, undefined, workers, { catalogForWorker })
  const firstSignal = catalogForWorker.mock.calls[0]![2] as AbortSignal
  await t.select('b')
  await t.push('b')
  expect(firstSignal.aborted).toBe(true)
  await act(async () =>
    first.resolve({
      ok: true,
      value: JSON.stringify({
        cli: 'antigravity',
        models: [{ id: 'stale-worker-a-model', efforts: ['low'] }],
      }),
    }),
  )
  await t.click('模型与强度')
  await t.click('model')
  expect(t.text()).toContain('worker-b-model')
  expect(t.text()).not.toContain('stale-worker-a-model')
})

it('closing settings during slow CLI discovery leaves conversation and stop controls available', async () => {
  const t = await setup(),
    models = deferred()
  const stop = vi.fn().mockResolvedValue({ ok: true, value: '{}' })
  Object.assign(t.api.cliworker, { catalogForCli: vi.fn().mockReturnValue(models.promise), stop })
  await t.click('默认设置')
  expect(t.text()).toContain('正在读取 Antigravity 模型')
  await t.click('关闭设置')
  expect(t.input().props.disabled).toBe(false)
  await t.edit('可以继续输入')
  await t.push('a', 2, { status: 'running' })
  // The single composer action becomes Stop only after the running draft is empty.
  await t.edit('')
  await t.click('停止')
  expect(stop).toHaveBeenCalledWith('parent', 'a')
  await act(async () =>
    models.resolve({
      ok: true,
      value: JSON.stringify({ cli: 'antigravity', models: [{ id: 'late model', efforts: ['low'] }] }),
    }),
  )
  expect(t.text()).not.toContain('late model')
})

it.each([false, true])(
  'releases the plugin modal before native settings handoff (failure: %s)',
  async (fail) => {
    let t!: Awaited<ReturnType<typeof setup>>
    const openNativeSettings = vi.fn(() => {
      expect(t.r.root.findAllByProps({ role: 'dialog' })).toHaveLength(0)
      if (fail) throw new Error('Synthetic missing native settings')
    })
    t = await setup(false, openNativeSettings)
    Object.assign(t.api.cliworker, {
      catalogForCli: vi.fn(async (_parent, cli) => ({
        ok: true,
        value: JSON.stringify({ cli, models: [{ id: 'simulation', efforts: ['low'] }] }),
      })),
      accountStatus: vi.fn(async (_parent, cli) => ({
        ok: true,
        value: JSON.stringify({
          cli,
          installed: true,
          state: 'configured',
          summary: '模拟 API 配置',
          actions: [{ id: 'login', label: '配置 API 登录', description: '模拟', target: 'models' }],
        }),
      })),
    })
    await t.click('默认设置')
    expect(t.r.root.findAllByProps({ role: 'dialog' })).toHaveLength(1)
    await t.click('登录设置')
    expect(openNativeSettings).toHaveBeenCalledTimes(1)
    expect(t.r.root.findAllByProps({ role: 'dialog' })).toHaveLength(0)
    if (fail) expect(t.text()).toContain('设置 → 模型')
  },
)

it('keeps retired Harness history readable without offering resume or configuration', async () => {
  const legacy: Worker = {
    ...workers[0]!,
    preference: { cli: 'harness', model: 'legacy-model', effort: 'low' },
  }
  const t = await setup(false, undefined, [legacy])
  expect(t.text()).toContain('Harness（已移除）')
  await t.select('a')
  await t.push('a')
  expect(t.text()).toContain('answer-a')
  expect(t.text()).toContain('历史记录仅供查看')
  expect(t.input().props.disabled).toBe(true)
  expect(
    t.r.root.findAllByType('button').find((button) => button.children.includes('默认设置'))!.props.disabled,
  ).toBe(true)
  expect(
    t.r.root.findAllByType('button').find((button) => button.props['aria-label'] === '模型与强度')!.props
      .disabled,
  ).toBe(true)
  await t.edit('must not run')
  await t.submit()
  expect(t.followup).not.toHaveBeenCalled()
})

it.each([{}, { ctrlKey: true }, { metaKey: true }])(
  'uses native Enter submission for the selected worker (%j)',
  async (modifiers) => {
    const t = await setup()
    await t.edit('keyboard followup')
    const preventDefault = vi.fn()
    await act(async () => {
      t.input().props.onKeyDown({
        key: 'Enter',
        ...modifiers,
        preventDefault,
        getModifierState: () => false,
        nativeEvent: {},
      })
    })
    expect(preventDefault).toHaveBeenCalledOnce()
    expect(t.followup).toHaveBeenCalledExactlyOnceWith(
      'parent',
      'a',
      'keyboard followup',
      expect.any(AbortSignal),
    )
    expect(t.input().props.value).toBe('')
  },
)

it('keeps keyboard submission on the current worker and preserves failed drafts', async () => {
  const t = await setup()
  await t.edit('draft a')
  await t.select('b')
  await t.push('b')
  await t.edit('draft b')
  t.followup.mockResolvedValueOnce({ ok: false, error: { message: 'synthetic failure' } })
  await act(async () => {
    t.input().props.onKeyDown({
      key: 'Enter',
      preventDefault() {},
      getModifierState: () => false,
      nativeEvent: {},
    })
  })
  expect(t.followup).toHaveBeenCalledExactlyOnceWith('parent', 'b', 'draft b', expect.any(AbortSignal))
  expect(t.input().props.value).toBe('draft b')
  await t.select('a')
  await t.push('a')
  expect(t.input().props.value).toBe('draft a')
})

it('blocks repeated Enter while a followup is pending', async () => {
  const t = await setup()
  const pending = deferred()
  t.followup.mockReturnValueOnce(pending.promise)
  await t.edit('once')
  const event = { key: 'Enter', preventDefault() {}, getModifierState: () => false, nativeEvent: {} }
  await act(async () => {
    t.input().props.onKeyDown(event)
    t.input().props.onKeyDown(event)
  })
  expect(t.followup).toHaveBeenCalledOnce()
  await act(async () => pending.resolve({ ok: true, value: '{}' }))
})

it('marks history actions against the live conversation end and updates the assistant tail on a new user turn', async () => {
  const t = await setup()
  const row = (id: string, kind: 'user' | 'assistant') => ({
    id,
    kind,
    text: `synthetic-${id}`,
    time: '2026-10-09T00:00:00Z',
  })
  const timeline = [
    row('r1:user', 'user'),
    row('r1:reply', 'assistant'),
    row('r2:user', 'user'),
    row('r2:reply', 'assistant'),
  ]
  await act(async () => t.streams.at(-1)!.push({ ...t.snapshot('a', 2), timeline }))
  const reveal = (id: string) => {
    const article = t.r.root.findByProps({ 'data-message-id': id })
    return (
      article.props['data-actions-reveal'] ??
      article.findByProps({ className: 'cwn-message-tail' }).props['data-actions-reveal']
    )
  }
  expect(timeline.map((row) => reveal(row.id))).toEqual(['hover', 'hover', 'always', 'always'])
  // Copy/time/usage remain mounted and keyboard reachable while opacity hides them.
  expect(t.r.root.findAllByProps({ className: 'cwn-message-label' })).toHaveLength(4)
  const next = [...timeline, row('r3:user', 'user')]
  await act(async () => t.streams.at(-1)!.push({ ...t.snapshot('a', 3), timeline: next }))
  expect(reveal('r2:reply')).toBe('hover')
  expect(reveal('r3:user')).toBe('always')
  t.history.mockResolvedValueOnce({
    ok: true,
    value: JSON.stringify({
      workerId: 'a',
      start: 0,
      end: 2,
      total: 5,
      hasOlder: false,
      hasNewer: true,
      items: timeline.slice(0, 2),
    }),
  })
  await act(async () => t.streams.at(-1)!.push({ ...t.snapshot('a', 4), timeline: next, truncated: true }))
  await t.click('查看更早记录')
  expect(reveal('r1:user')).toBe('hover')
  expect(reveal('r1:reply')).toBe('hover')
})

it('uses native bottom tolerance without treating a scrolled-up reader as following', async () => {
  const t = await setup()
  t.feed.scrollTop = t.feed.scrollHeight - t.feed.clientHeight - 25
  await act(async () => t.r.root.findByProps({ className: 'cwn-feed' }).props.onScroll())
  expect(t.r.root.findAllByProps({ 'aria-label': '回到最新消息' })).toHaveLength(0)
  t.feed.scrollTop -= 1
  await act(async () => t.r.root.findByProps({ className: 'cwn-feed' }).props.onScroll())
  expect(t.r.root.findAllByProps({ 'aria-label': '回到最新消息' })).toHaveLength(1)
})

it('keeps an unfinished streaming reply tail on native hover until its run completes', async () => {
  const t = await setup()
  const timeline = [
    { id: 'stream:user', kind: 'user' as const, text: 'synthetic prompt', time: '2026-10-09T00:00:00Z' },
    {
      id: 'stream:reply',
      kind: 'assistant' as const,
      text: 'synthetic partial',
      time: '2026-10-09T00:00:00Z',
    },
  ]
  await act(async () =>
    t.streams.at(-1)!.push({ ...t.snapshot('a', 2, { status: 'running', runId: 'stream' }), timeline }),
  )
  expect(
    t.r.root.findByProps({ 'data-message-id': 'stream:reply' }).findByProps({ className: 'cwn-message-tail' })
      .props['data-actions-reveal'],
  ).toBe('hover')
  await act(async () =>
    t.streams.at(-1)!.push({ ...t.snapshot('a', 3, { status: 'completed', runId: 'stream' }), timeline }),
  )
  expect(
    t.r.root.findByProps({ 'data-message-id': 'stream:reply' }).findByProps({ className: 'cwn-message-tail' })
      .props['data-actions-reveal'],
  ).toBe('always')
})

it('offers native portaled card management with pointer and keyboard access without nested buttons', async () => {
  const t = await setup(false)
  const card = t.r.root.findByProps({ 'data-worker-id': 'a' })
  const prevented = vi.fn()
  await act(async () =>
    card.props.onContextMenu({ preventDefault: prevented, stopPropagation() {}, clientX: 91, clientY: 127 }),
  )
  expect(prevented).toHaveBeenCalledOnce()
  const menu = card.findAll((node) => typeof node.type === 'function' && node.props.getAnchorRect)[0]!
  expect(menu.props.portal).toBe(true)
  expect(menu.props.autoFocus).toBe(true)
  await t.click('title')
  expect(t.r.root.findByProps({ 'aria-label': '新的聊天标题' }).props.value).toBe('Worker a')
  await t.click('关闭聊天标题编辑')
  await act(async () =>
    card.findByProps({ 'data-open-worker-id': 'a' }).props.onKeyDown({
      key: 'F10',
      shiftKey: true,
      preventDefault: prevented,
      stopPropagation() {},
    }),
  )
  await t.click('name')
  expect(t.r.root.findByProps({ 'aria-label': '新的智能体名称' }).props.value).toBe('智能体-a')
  for (const button of card.findAllByType('button')) expect(button.findAllByType('button')).toHaveLength(1)
  expect(t.r.root.findAllByType('textarea')).toHaveLength(0)
})

it('has only independent open and name-copy controls, with a decorative arrow outside both content rows', async () => {
  const t = await setup(false)
  const card = t.r.root.findByProps({ 'data-worker-id': 'a' })
  const open = card.findByProps({ 'data-open-worker-id': 'a' })
  expect(card.findAllByType('button')).toHaveLength(2)
  expect(card.findAllByProps({ className: 'cwn-worker-manage' })).toHaveLength(0)
  expect(open.findAllByType('svg')).toHaveLength(0)
  const arrow = card.findByProps({ className: 'cwn-worker-chevron' })
  expect(arrow.props['aria-hidden']).toBe('true')
  expect(arrow.findAllByType('svg')).toHaveLength(1)
  const layout = card.findByProps({ className: 'cwn-worker-layout' })
  expect(layout.findByProps({ className: 'cwn-worker-meta' })).toBeDefined()
  expect(open.props['aria-haspopup']).toBe('menu')
  expect(open.props['aria-keyshortcuts']).toBe('Shift+F10')
})

it.each([{ key: 'ContextMenu' }, { key: 'F10', shiftKey: true }])(
  'opens and closes native card management from its open control (%j) without dispatching a conversation',
  async (key) => {
    const t = await setup(false)
    const card = t.r.root.findByProps({ 'data-worker-id': 'a' })
    const before = t.streams.length
    const event = { ...key, preventDefault: vi.fn(), stopPropagation: vi.fn() }
    await act(async () => card.findByProps({ 'data-open-worker-id': 'a' }).props.onKeyDown(event))
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(event.stopPropagation).toHaveBeenCalledOnce()
    expect(t.streams).toHaveLength(before)
    const menu = card.findAll((node) => typeof node.type === 'function' && node.props.getAnchorRect)[0]!
    expect(menu.props.portal).toBe(true)
    expect(menu.props.autoFocus).toBe(true)
    expect(menu.props.anchor.props.className).toBe('cwn-worker-layout')
    // The native Menu owns the actual open button, so its focus-return mechanism
    // can find the keyboard trigger instead of an empty or removed ellipsis anchor.
    expect(menu.findByProps({ 'data-open-worker-id': 'a' }).props['aria-expanded']).toBe(true)
    await act(async () => menu.props.onClose())
    expect(card.findByProps({ 'data-open-worker-id': 'a' }).props['aria-expanded']).toBe(false)
    await act(async () => card.findByProps({ 'data-open-worker-id': 'a' }).props.onClick())
    expect(t.streams).toHaveLength(before + 1)
  },
)

it('copies a card name independently and reports actual clipboard failure', async () => {
  const t = await setup(false, undefined, [{ ...workers[0]!, agentName: 'hermes-1' }])
  const before = t.streams.length
  await t.click('复制名称 hermes-1')
  expect(clipboard).toHaveBeenLastCalledWith('hermes-1')
  expect(t.text()).toContain('已复制')
  expect(t.streams).toHaveLength(before)
  clipboard.mockResolvedValue(false)
  await t.click('复制名称 hermes-1')
  expect(t.text()).toContain('复制失败，请选择文本手动复制')
  expect(t.r.root.findAllByType('textarea')).toHaveLength(0)
})

it('deletes only the chosen card, retains four main filters and restores from the persistent deleted view', async () => {
  const t = await setup(false)
  await act(async () =>
    t.r.root
      .findByProps({ 'data-worker-id': 'a' })
      .props.onContextMenu({ preventDefault() {}, stopPropagation() {}, clientX: 1, clientY: 2 }),
  )
  await t.click('delete')
  expect(t.api.cliworker.deleteWorker).toHaveBeenCalledOnce()
  expect(vi.mocked(t.api.cliworker.deleteWorker).mock.calls[0]!.slice(0, 2)).toEqual(['parent', 'a'])
  const archived = { ...workers[0]!, archivedAt: '2026-10-09T08:00:00Z' }
  await act(async () =>
    t.streams.at(-1)!.push({ ...t.snapshot(), workers: [workers[1]!], archivedWorkers: [archived] }),
  )
  expect(t.r.root.findByProps({ 'aria-label': '任务状态筛选' }).findAllByType('button')).toHaveLength(4)
  expect(t.r.root.findByProps({ 'aria-label': '已删除对话' }).findAllByType('article')).toHaveLength(1)
  await t.click('恢复对话 Worker a')
  expect(vi.mocked(t.api.cliworker.restoreWorker).mock.calls[0]!.slice(0, 2)).toEqual(['parent', 'a'])
  await t.click('返回列表')
  expect(t.r.root.findAllByProps({ 'data-worker-id': 'a' })).toHaveLength(0)
  await t.click('已删除')
  expect(t.text()).toContain('Worker a')
})

it('does not offer deletion of an active card and leaves a failed deletion visible', async () => {
  const t = await setup(false, undefined, [{ ...workers[0]!, status: 'running' }, workers[1]!])
  await act(async () =>
    t.r.root
      .findByProps({ 'data-worker-id': 'a' })
      .findByProps({ 'data-open-worker-id': 'a' })
      .props.onKeyDown({ key: 'ContextMenu', preventDefault() {}, stopPropagation() {} }),
  )
  expect(t.r.root.findByProps({ 'aria-label': 'delete' }).props.disabled).toBe(true)
  const other = t.r.root.findByProps({ 'data-worker-id': 'b' })
  await act(async () =>
    other.props.onContextMenu({ preventDefault() {}, stopPropagation() {}, clientX: 0, clientY: 0 }),
  )
  vi.mocked(t.api.cliworker.deleteWorker).mockResolvedValueOnce({
    ok: false,
    error: { message: '清理尚未确认' },
  } as any)
  await act(async () => other.findByProps({ 'aria-label': 'delete' }).props.onClick())
  expect(t.text()).toContain('清理尚未确认')
  expect(t.r.root.findAllByProps({ 'data-worker-id': 'b' })).toHaveLength(1)
  expect(t.r.root.findAllByProps({ 'aria-label': '已删除对话' })).toHaveLength(0)
})

it('requires explicit new conversation mode for missing account history and keeps the draft on failure', async () => {
  const t = await setup()
  await t.edit('historical draft\nsecond line')
  await act(async () =>
    t.streams
      .at(-1)!
      .push({ ...t.snapshot('a', 2), resumeBlockedReason: '此历史任务缺少账号记录，请新建任务' }),
  )
  expect(t.input().props.disabled).toBe(true)
  const banner = () => t.r.root.findByProps({ 'aria-label': '对话状态' })
  expect(banner().parent).toBe(t.r.root.findByProps({ className: 'cwn' }))
  expect(banner().findByType('span').children).toEqual(['历史账号记录缺失'])
  expect(
    t.r.root.findByProps({ className: 'cwn-compose' }).findAllByProps({ 'aria-label': '对话状态' }),
  ).toHaveLength(0)
  await t.submit()
  expect(t.followup).not.toHaveBeenCalled()
  expect(t.api.cliworker.restartWorker).not.toHaveBeenCalled()
  await t.click('新建对话')
  expect(banner().findByType('span').children).toEqual(['新对话将沿用原设定'])
  expect(t.input().props.value).toBe('historical draft\nsecond line')
  expect(t.input().props.disabled).toBe(false)
  expect(t.api.cliworker.restartWorker).not.toHaveBeenCalled()
  vi.mocked(t.api.cliworker.restartWorker).mockResolvedValueOnce({
    ok: false,
    error: { message: '模拟：当前账号模型无效' },
  } as any)
  await t.submit()
  expect(t.followup).not.toHaveBeenCalled()
  expect(vi.mocked(t.api.cliworker.restartWorker).mock.calls[0]!.slice(0, 3)).toEqual([
    'parent',
    'a',
    'historical draft\nsecond line',
  ])
  expect(t.input().props.value).toBe('historical draft\nsecond line')
  expect(t.text()).toContain('模拟：当前账号模型无效')
  await t.click('取消新建')
  expect(banner().findByType('span').children).toEqual(['历史账号记录缺失'])
  expect(t.input().props.disabled).toBe(true)
  expect(t.input().props.value).toBe('historical draft\nsecond line')
})

it('selects the new worker after restart and never sends to the old native conversation', async () => {
  const t = await setup()
  await t.edit('new account task')
  await act(async () =>
    t.streams
      .at(-1)!
      .push({ ...t.snapshot('a', 2), resumeBlockedReason: '此历史任务缺少账号记录，请新建任务' }),
  )
  await t.click('新建对话')
  const streamCount = t.streams.length
  await t.submit()
  expect(t.api.cliworker.restartWorker).toHaveBeenCalledOnce()
  expect(t.followup).not.toHaveBeenCalled()
  expect(t.streams.length).toBe(streamCount + 1)
  const newWorker = { ...workers[0]!, id: 'new-worker-fixture', agentName: 'hermes-2' }
  await act(async () =>
    t.streams.at(-1)!.push({ ...t.snapshot(), workers: [...workers, newWorker], selected: newWorker }),
  )
  expect(t.input().props.value).toBe('')
  expect(t.r.root.findByType('h2').children).toEqual(['hermes-2｜Worker a'])
  await t.goBack()
  await t.select('a')
  await t.push('a', 3)
  expect(t.text()).toContain('answer-a')
})

it('opens bare card metadata and ignores control and portal menu clicks without double opening', async () => {
  const t = await setup(false)
  const card = t.r.root.findByProps({ 'data-worker-id': 'a' })
  const before = t.streams.length
  await act(async () => card.props.onClick({ target: { closest: () => ({}) } }))
  expect(t.streams.length).toBe(before)
  await act(async () => card.props.onClick({ target: { closest: () => null } }))
  expect(t.streams.length).toBe(before + 1)
  await t.push('a')
  await t.goBack()
  const next = t.r.root.findByProps({ 'data-worker-id': 'a' })
  const after = t.streams.length
  await act(async () => {
    next.findByProps({ 'data-open-worker-id': 'a' }).props.onClick()
    next.props.onClick({ target: { closest: () => ({}) } })
  })
  expect(t.streams.length).toBe(after + 1)
})

it('retains the old draft when restart does not identify a distinct new worker', async () => {
  const t = await setup()
  await t.edit('must retain draft')
  await act(async () =>
    t.streams.at(-1)!.push({ ...t.snapshot('a'), resumeBlockedReason: '此历史任务缺少账号记录，请新建任务' }),
  )
  await t.click('新建对话')
  vi.mocked(t.api.cliworker.restartWorker).mockResolvedValueOnce({
    ok: true,
    value: JSON.stringify({ workerId: 'a' }),
  } as any)
  await t.submit()
  expect(t.text()).toContain('新对话未返回有效的智能体记录')
  expect(t.input().props.value).toBe('must retain draft')
  expect(t.followup).not.toHaveBeenCalled()
})

it('cancels a pending management request when its panel unmounts', async () => {
  const t = await setup(false)
  const waiting = deferred()
  vi.mocked(t.api.cliworker.deleteWorker).mockReturnValueOnce(waiting.promise)
  await act(async () =>
    t.r.root
      .findByProps({ 'data-worker-id': 'a' })
      .props.onContextMenu({ preventDefault() {}, stopPropagation() {}, clientX: 1, clientY: 2 }),
  )
  await t.click('delete')
  const signal = vi.mocked(t.api.cliworker.deleteWorker).mock.calls[0]![2]!
  expect(signal.aborted).toBe(false)
  await act(async () => t.r.unmount())
  expect(signal.aborted).toBe(true)
  waiting.resolve({ ok: false, error: { message: '模拟：已取消' } })
  await act(async () => {
    await waiting.promise
  })
})

it('settings refresh explicitly queries a fresh directory and keeps a still-valid saved default', async () => {
  const f = await setup()
  const response = {
    ok: true,
    value: JSON.stringify({
      cli: 'antigravity',
      models: [{ id: 'saved-model', label: 'saved-model', efforts: ['low', 'high'] }],
      preference: { cli: 'antigravity', model: 'saved-model', effort: 'high' },
    }),
  }
  const catalogForCli = vi.fn().mockResolvedValue(response)
  const refreshCatalogForCli = vi.fn().mockResolvedValue(response)
  const configure = vi.fn()
  Object.assign(f.api.cliworker, { catalogForCli, refreshCatalogForCli, configure })
  await f.click('默认设置')
  expect(f.text()).toContain('saved-model')
  expect(f.text()).toContain('High')
  expect(catalogForCli).toHaveBeenCalledTimes(1)
  await f.click('刷新模型')
  expect(refreshCatalogForCli).toHaveBeenCalledTimes(1)
  expect(catalogForCli).toHaveBeenCalledTimes(1)
  expect(f.text()).toContain('High')
  expect(configure).not.toHaveBeenCalled()
})

it.each(['steer', 'interrupt', 'queue'] as const)(
  'submits %s running messages through Host preference routing while keeping one action',
  async (runningMessageMode) => {
    const sendRunningMessage = vi.fn().mockResolvedValue({ ok: true, value: '{}' })
    const t = await setup(true, undefined, workers, { sendRunningMessage })
    await act(async () =>
      t.streams.at(-1)!.push({ ...t.snapshot('a', 2, { status: 'running' }), runningMessageMode }),
    )
    const actions = () =>
      t.r.root.findAllByType('button').filter((button) => button.props.className === 'cwn-send')
    expect(actions()).toHaveLength(1)
    expect(actions()[0]!.props['aria-label']).toBe('停止')
    await t.edit('new instruction')
    expect(actions()).toHaveLength(1)
    expect(actions()[0]!.props['aria-label']).toBe(
      runningMessageMode === 'steer'
        ? '引导发送'
        : runningMessageMode === 'interrupt'
          ? '插队发送'
          : '加入待发送消息',
    )
    expect(t.input().props.placeholder).toContain(
      runningMessageMode === 'steer'
        ? '当前运行中处理'
        : runningMessageMode === 'interrupt'
          ? '停止当前轮'
          : '本轮结束后',
    )
    await t.submit()
    expect(sendRunningMessage.mock.calls[0]!.slice(0, 4)).toEqual(['parent', 'a', 'new instruction', 'run-a'])
    expect(t.followup).not.toHaveBeenCalled()
    expect(t.input().props.value).toBe('')
    expect(actions()).toHaveLength(1)
    expect(actions()[0]!.props['aria-label']).toBe('停止')
  },
)

it('prioritizes the chosen queued card and allows Stop while priority cleanup is pending', async () => {
  const pending = deferred()
  const interruptQueuedFollowup = vi.fn().mockReturnValue(pending.promise)
  const stop = vi.fn().mockResolvedValue({ ok: true, value: undefined })
  const t = await setup(true, undefined, workers, { interruptQueuedFollowup, stop })
  const queuedFollowups = ['first', 'second'].map((id) => ({
    id,
    prompt: id,
    createdAt: '',
    state: 'pending' as const,
  }))
  await act(async () =>
    t.streams.at(-1)!.push({ ...t.snapshot('a', 2, { status: 'running' }), queuedFollowups }),
  )
  await t.click('插队待发送消息 2')
  expect(interruptQueuedFollowup).toHaveBeenCalledExactlyOnceWith(
    'parent',
    'a',
    'second',
    'run-a',
    expect.any(AbortSignal),
  )
  const stopButton = t.r.root.findAllByType('button').find((button) => button.props['aria-label'] === '停止')!
  expect(stopButton.props.disabled).toBe(false)
  await t.click('停止')
  expect(stop).toHaveBeenCalledExactlyOnceWith('parent', 'a')
  await act(async () => pending.reject(new Error('模拟插队被停止')))
  expect(t.text()).not.toContain('模拟插队被停止')
  expect(t.text()).toContain('first')
  expect(t.text()).toContain('second')
})

it.each([
  { status: 'running' as const, conversationId: undefined, state: 'pending' as const },
  { status: 'stopping' as const, conversationId: 'session-a', state: 'pending' as const },
  { status: 'running' as const, conversationId: 'session-a', state: 'sending' as const },
])(
  'blocks queued-card priority without a usable native session or during admission: %j',
  async ({ status, conversationId, state }) => {
    const interruptQueuedFollowup = vi.fn()
    const t = await setup(true, undefined, workers, { interruptQueuedFollowup })
    await act(async () =>
      t.streams.at(-1)!.push({
        ...t.snapshot('a', 2, { status, conversationId }),
        queuedFollowups: [{ id: 'pending', prompt: 'keep text', createdAt: '', state }],
      }),
    )
    const button = t.r.root
      .findAllByType('button')
      .find((button) => button.props['aria-label'] === '插队待发送消息 1')!
    expect(button.props.disabled).toBe(true)
    await t.click('插队待发送消息 1')
    expect(interruptQueuedFollowup).not.toHaveBeenCalled()
  },
)

it('folds the pending list per worker without changing Host messages, and keeps resume available', async () => {
  const retryQueuedFollowups = vi.fn().mockResolvedValue({ ok: true, value: undefined })
  const cancelQueuedFollowup = vi.fn()
  const interruptQueuedFollowup = vi.fn()
  const t = await setup(true, undefined, workers, {
    retryQueuedFollowups,
    cancelQueuedFollowup,
    interruptQueuedFollowup,
  })
  const queuedFollowups = [
    { id: 'waiting', prompt: 'retained pending text', createdAt: '', state: 'paused' as const },
  ]
  const pushQueued = async (id: string, revision: number) =>
    act(async () => {
      t.streams.at(-1)!.push({ ...t.snapshot(id, revision, { status: 'failed' }), queuedFollowups })
    })
  await pushQueued('a', 2)
  const body = () => t.r.root.findByProps({ className: 'cwn-followup-body' })
  const toggle = (label: string) =>
    t.r.root.findAllByType('button').find((button) => button.props['aria-label'] === label)!
  expect(body().props['data-expanded']).toBe(true)
  expect(toggle('折叠待发送消息').props['aria-controls']).toBe(body().props.id)
  await t.click('折叠待发送消息')
  expect(body().props['aria-hidden']).toBe(true)
  expect(body().props.inert).toBe('')
  expect(toggle('展开待发送消息').props['aria-expanded']).toBe(false)
  expect(t.text()).toContain('待发送 · ')
  expect(t.text()).toContain('retained pending text')
  expect(cancelQueuedFollowup).not.toHaveBeenCalled()
  expect(interruptQueuedFollowup).not.toHaveBeenCalled()
  await t.click('继续发送')
  expect(retryQueuedFollowups).toHaveBeenCalledExactlyOnceWith('parent', 'a', 'run-a')
  await t.select('b')
  await pushQueued('b', 3)
  expect(body().props['data-expanded']).toBe(true)
  await t.select('a')
  await pushQueued('a', 4)
  expect(body().props['data-expanded']).toBe(false)
  await t.click('展开待发送消息')
  expect(body().props['aria-hidden']).toBe(false)
  expect(body().props.inert).toBeUndefined()
})

it('immediately shows a pending user message and clears the composer before slow preparation', async () => {
  const done = deferred()
  const t = await setup()
  t.followup.mockReturnValueOnce(done.promise)
  await t.edit('slow preparation message')
  await t.submit()
  expect(t.input().props.value).toBe('')
  expect(t.input().props.disabled).toBe(false)
  expect(t.r.root.findAllByProps({ className: 'cwn-message user' })).toHaveLength(1)
  expect(t.text()).not.toContain('正在发送…')
  const actions = t.r.root.findAllByType('button').filter((button) => button.props.className === 'cwn-send')
  expect(actions).toHaveLength(1)
  expect(actions[0]!.props['aria-label']).toBe('停止')
  expect(actions[0]!.props.disabled).toBe(false)
  await t.edit('newer draft')
  await act(async () => done.resolve({ ok: false, error: { message: 'synthetic preflight rejected' } }))
  expect(t.input().props.value).toBe('newer draft')
  expect(t.text()).toContain('synthetic preflight rejected')
  expect(t.text()).toContain('slow preparation message')
  await t.click('重试发送 slow preparation message')
  expect(t.followup.mock.calls[1]![2]).toBe('slow preparation message')
  expect(t.input().props.value).toBe('newer draft')
})

it('serializes preparation and sends a second draft against the admitted run without locking another worker', async () => {
  const done = deferred()
  const sendRunningMessage = vi.fn().mockResolvedValue({ ok: true, value: '{}' })
  const t = await setup(true, undefined, workers, { sendRunningMessage })
  t.followup.mockReturnValueOnce(done.promise)
  await t.edit('first preparation')
  await t.submit()
  await t.edit('second instruction')
  await t.submit()
  expect(t.input().props.value).toBe('')
  expect(t.followup).toHaveBeenCalledOnce()
  expect(sendRunningMessage).not.toHaveBeenCalled()
  await t.select('b')
  await t.push('b')
  await t.edit('independent B')
  await t.submit()
  expect(t.followup.mock.calls[1]!.slice(0, 3)).toEqual(['parent', 'b', 'independent B'])
  await act(async () => done.resolve({ ok: true, value: JSON.stringify({ runId: 'admitted-a' }) }))
  expect(sendRunningMessage.mock.calls[0]!.slice(0, 4)).toEqual([
    'parent',
    'a',
    'second instruction',
    'admitted-a',
  ])
  expect(t.text()).not.toContain('second instruction')
})

it('keeps one pending queue card until its actual Host identity appears and never duplicates it', async () => {
  const done = deferred()
  const sendRunningMessage = vi.fn().mockReturnValue(done.promise)
  const t = await setup(true, undefined, workers, { sendRunningMessage })
  await t.push('a', 2, { status: 'running' })
  await t.edit('queued immediately')
  await t.submit()
  expect(t.input().props.value).toBe('')
  expect(t.text()).toContain('正在加入待发送…')
  expect(t.r.root.findAllByProps({ className: 'cwn-followup-content' })).toHaveLength(1)
  expect(t.r.root.findAllByProps({ className: 'cwn-message user' })).toHaveLength(0)
  const id = sendRunningMessage.mock.calls[0]![4]
  await act(async () =>
    t.streams.at(-1)!.push({
      ...t.snapshot('a', 3, { status: 'running' }),
      queuedFollowups: [{ id, prompt: 'queued immediately', createdAt: '', state: 'pending' }],
    }),
  )
  expect(t.r.root.findAllByProps({ className: 'cwn-followup-content' })).toHaveLength(1)
  await act(async () => done.reject(new Error('transport failure after acceptance')))
  expect(t.input().props.value).toBe('')
  expect(t.text()).not.toContain('transport failure after acceptance')
})

it('matches identical optimistic steering messages to distinct actual events one at a time', async () => {
  const first = deferred(),
    second = deferred()
  const sendRunningMessage = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
  const t = await setup(true, undefined, workers, { sendRunningMessage })
  await act(async () =>
    t.streams.at(-1)!.push({ ...t.snapshot('a', 2, { status: 'running' }), runningMessageMode: 'steer' }),
  )
  await t.edit('same guidance')
  await t.submit()
  await t.edit('same guidance')
  await t.submit()
  expect(sendRunningMessage).toHaveBeenCalledOnce()
  expect(t.r.root.findAllByProps({ className: 'cwn-message user' })).toHaveLength(2)
  const host = t.snapshot('a', 3, { status: 'running' })
  host.runningMessageMode = 'steer'
  host.timeline.push({ id: 'run-a:first', kind: 'user', text: 'same guidance', time: '' })
  await act(async () => t.streams.at(-1)!.push(host))
  expect(t.r.root.findAllByProps({ className: 'cwn-message user' })).toHaveLength(2)
  expect(
    t.r.root.findAllByType('article').filter((row) => row.props['data-message-id']?.startsWith('local-')),
  ).toHaveLength(1)
  await act(async () => first.resolve({ ok: true, value: '{}' }))
  expect(sendRunningMessage).toHaveBeenCalledTimes(2)
  expect(sendRunningMessage.mock.calls[0]![4]).not.toBe(sendRunningMessage.mock.calls[1]![4])
  await act(async () =>
    t.streams.at(-1)!.push({
      ...host,
      revision: 4,
      timeline: [...host.timeline, { id: 'run-a:second', kind: 'user', text: 'same guidance', time: '' }],
    }),
  )
  await act(async () => second.resolve({ ok: true, value: '{}' }))
  expect(t.r.root.findAllByProps({ className: 'cwn-message user' })).toHaveLength(2)
  expect(t.text()).not.toContain('正在发送…')
})

it('cancels preparation but keeps Stop disabled until the Host confirms cleanup', async () => {
  const stopDone = deferred()
  const stop = vi.fn().mockReturnValue(stopDone.promise)
  const t = await setup(true, undefined, workers, { stop })
  t.followup.mockImplementationOnce(
    (_parent, _worker, _prompt, signal: AbortSignal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      }),
  )
  await t.edit('cancel during preparation')
  await t.submit()
  await t.click('停止')
  expect(t.followup.mock.calls[0]![3].aborted).toBe(true)
  expect(t.input().props.disabled).toBe(true)
  expect(t.r.root.findAllByProps({ className: 'cwn-send' }).at(-1)!.props.disabled).toBe(true)
  await act(async () => stopDone.resolve({ ok: true, value: '{}' }))
  expect(t.input().props.disabled).toBe(false)
  expect(t.input().props.value).toBe('cancel during preparation')
  expect(t.text()).toContain('已停止发送')
  expect(t.text()).not.toContain('未发送：')
})

it('normal Stop without a native ID permits a fresh conversation and leaves paused cards explicit', async () => {
  const queueFollowup = vi.fn()
  const t = await setup(true, undefined, workers, { queueFollowup })
  await act(async () =>
    t.streams.at(-1)!.push({
      ...t.snapshot('a', 2, { status: 'interrupted', interruptionReason: 'user', conversationId: undefined }),
      queuedFollowups: [{ id: 'old-pending', prompt: 'old queued message', state: 'paused', createdAt: '' }],
    }),
  )
  expect(t.input().props.disabled).toBe(false)
  expect(t.text()).toContain('再次发送将开始新会话')
  expect(t.text()).toContain('已停止')
  await t.edit('explicit new instruction')
  await t.submit()
  expect(t.followup.mock.calls[0]!.slice(0, 3)).toEqual(['parent', 'a', 'explicit new instruction'])
  expect(queueFollowup).not.toHaveBeenCalled()
  expect(t.text()).toContain('old queued message')
})

it('keeps real resume blocks after a normal Stop and excludes only normal Stop from attention', async () => {
  const t = await setup(false, undefined, [
    { ...workers[0]!, status: 'interrupted', interruptionReason: 'user' },
    { ...workers[1]!, status: 'interrupted', error: '真实进程故障' },
  ])
  await t.click('异常')
  expect(t.r.root.findAllByProps({ 'data-worker-id': 'a' })).toHaveLength(0)
  expect(t.r.root.findAllByProps({ 'data-worker-id': 'b' })).toHaveLength(1)
  await t.click('全部')
  expect(t.text()).toContain('已停止')
  await t.select('a')
  await act(async () =>
    t.streams.at(-1)!.push({
      ...t.snapshot('a', 2),
      resumeBlockedReason: '无法确认进程清理',
    }),
  )
  expect(t.input().props.disabled).toBe(true)
  await t.edit('must not dispatch')
  await t.submit()
  expect(t.followup).not.toHaveBeenCalled()
})

it('does not replay an uncertain ordinary followup until Stop confirms the original run never advanced', async () => {
  const stop = vi.fn().mockResolvedValue({
    ok: true,
    value: JSON.stringify({ ...workers[0], status: 'interrupted', interruptionReason: 'user' }),
  })
  const t = await setup(true, undefined, workers, { stop })
  t.followup.mockRejectedValueOnce(new Error('transport failure'))
  await t.edit('unknown admission')
  await t.submit()
  expect(t.input().props.value).toBe('')
  expect(t.text()).toContain('发送结果待确认')
  await t.edit('new draft while checking')
  await t.submit()
  expect(t.followup).toHaveBeenCalledOnce()
  expect(
    t.r.root.findAllByType('button').filter((button) => button.props.className === 'cwn-send')[0]!.props[
      'aria-label'
    ],
  ).toBe('停止')
  await t.click('停止')
  await t.submit()
  expect(t.followup).toHaveBeenCalledTimes(2)
})

it('does not use an old accepted receipt after a later queued run has completed', async () => {
  const sendRunningMessage = vi.fn()
  const t = await setup(true, undefined, workers, { sendRunningMessage })
  t.followup.mockResolvedValueOnce({ ok: true, value: JSON.stringify({ runId: 'first-admitted' }) })
  await t.edit('first accepted')
  await t.submit()
  await act(async () =>
    t.streams.at(-1)!.push({
      ...t.snapshot('a', 2, { status: 'completed', runId: 'later-queued-run' }),
      timeline: [{ id: 'first-admitted:user', kind: 'user', text: 'first accepted', time: '' }],
    }),
  )
  await t.edit('fresh followup after queue')
  await t.submit()
  expect(t.followup).toHaveBeenCalledTimes(2)
  expect(t.followup.mock.calls[1]![2]).toBe('fresh followup after queue')
  expect(sendRunningMessage).not.toHaveBeenCalled()
})

it('retries a rejected running message with its stable identity against the current observed run', async () => {
  const sendRunningMessage = vi
    .fn()
    .mockResolvedValueOnce({ ok: false, error: { message: '本轮状态已变化，请刷新后重新发送' } })
    .mockResolvedValue({ ok: true, value: '{}' })
  const t = await setup(true, undefined, workers, { sendRunningMessage })
  await t.push('a', 2, { status: 'running' })
  await t.edit('retry current run')
  await t.submit()
  await t.push('a', 3, { status: 'running', runId: 'next-observed-run' })
  await t.submit()
  expect(sendRunningMessage.mock.calls[1]![3]).toBe('next-observed-run')
  expect(sendRunningMessage.mock.calls[1]![4]).toBe(sendRunningMessage.mock.calls[0]![4])
})

it('clears uncertain feedback when the actual user event arrives without restoring already sent text', async () => {
  const t = await setup()
  t.followup.mockRejectedValueOnce(new Error('transport failure after admission'))
  await t.edit('accepted but receipt lost')
  await t.submit()
  expect(t.input().props.value).toBe('')
  expect(t.text()).toContain('发送结果待确认')
  await act(async () =>
    t.streams.at(-1)!.push({
      ...t.snapshot('a', 2, { runId: 'actually-admitted', status: 'completed' }),
      timeline: [{ id: 'actually-admitted:user', kind: 'user', text: 'accepted but receipt lost', time: '' }],
    }),
  )
  expect(t.text()).not.toContain('发送结果待确认')
  expect(t.r.root.findAllByProps({ className: 'cwn-message user' })).toHaveLength(1)
  expect(t.input().props.value).toBe('')
  expect(t.followup).toHaveBeenCalledOnce()
})

it('moves an interrupted queue card into the conversation immediately and keeps later input behind exact admission', async () => {
  const priority = deferred()
  const interruptQueuedFollowup = vi.fn().mockReturnValue(priority.promise)
  const sendRunningMessage = vi.fn().mockResolvedValue({ ok: true, value: '{}' })
  const t = await setup(true, undefined, workers, { interruptQueuedFollowup, sendRunningMessage })
  const items = ['first', 'second', 'third'].map((id) => ({
    id,
    prompt: id,
    createdAt: '',
    state: 'pending' as const,
  }))
  await act(async () =>
    t.streams.at(-1)!.push({ ...t.snapshot('a', 2, { status: 'running' }), queuedFollowups: items }),
  )
  await t.click('插队待发送消息 2')
  expect(t.r.root.findAllByProps({ className: 'cwn-message user' })).toHaveLength(1)
  expect(t.r.root.findByProps({ 'data-queue-id': 'second' }).props['data-exiting']).toBe(true)
  expect(
    t.r.root.findAllByProps({ className: 'cwn-followup-row' }).map((row) => row.props['data-queue-id']),
  ).toEqual(['first', 'second', 'third'])
  expect(t.text()).not.toContain('正在发送…')
  expect(t.text()).not.toContain('已提交，等待同步')
  await t.click('插队待发送消息 2')
  expect(interruptQueuedFollowup).toHaveBeenCalledOnce()
  await act(async () =>
    t.streams.at(-1)!.push({
      ...t.snapshot('a', 3, { status: 'stopping' }),
      queuedFollowups: items.map((item) => ({
        ...item,
        state: 'paused',
        pauseReason: '任务已停止，请确认后继续发送',
      })),
    }),
  )
  expect(t.input().props.disabled).toBe(false)
  expect(t.r.root.findByProps({ 'data-queue-id': 'second' }).props['data-exiting']).toBe(true)
  await t.edit('second')
  await t.submit()
  expect(t.input().props.value).toBe('')
  expect(sendRunningMessage).not.toHaveBeenCalled()
  await act(async () =>
    priority.resolve({ ok: true, value: JSON.stringify({ queuedId: 'second', revision: 4 }) }),
  )
  expect(sendRunningMessage).not.toHaveBeenCalled()
  await act(async () =>
    t.streams.at(-1)!.push({
      ...t.snapshot('a', 4, { status: 'interrupted', interruptionReason: 'user' }),
      queuedFollowups: items.map((item) => ({
        ...item,
        state: item.id === 'second' ? 'sending' : 'pending',
      })),
    }),
  )
  expect(t.r.root.findByProps({ 'data-queue-id': 'second' }).props['data-exiting']).toBe(true)
  await act(async () =>
    t.streams.at(-1)!.push({
      ...t.snapshot('a', 5, { status: 'queued', runId: 'priority-admitted' }),
      queuedFollowups: items.filter((item) => item.id !== 'second'),
      timeline: [
        { id: 'priority-admitted:1', kind: 'user', text: 'second', time: '', queuedFollowupId: 'second' },
      ],
    }),
  )
  expect(sendRunningMessage.mock.calls[0]!.slice(0, 4)).toEqual([
    'parent',
    'a',
    'second',
    'priority-admitted',
  ])
  expect(t.r.root.findAllByProps({ className: 'cwn-message user' })).toHaveLength(1)
  expect(
    t.r.root
      .findAllByProps({ className: 'cwn-followup-content' })
      .some((row) => row.findByType('p').children.includes('second')),
  ).toBe(true)
})

it('restores a promoted card only for a paused snapshot at its receipt watermark or later', async () => {
  const priority = deferred()
  const interruptQueuedFollowup = vi.fn().mockReturnValue(priority.promise)
  const t = await setup(true, undefined, workers, { interruptQueuedFollowup })
  const item = { id: 'priority', prompt: 'prepare then fail', createdAt: '', state: 'pending' as const }
  await act(async () =>
    t.streams.at(-1)!.push({ ...t.snapshot('a', 2, { status: 'running' }), queuedFollowups: [item] }),
  )
  await t.click('插队待发送消息 1')
  await act(async () =>
    t.streams.at(-1)!.push({
      ...t.snapshot('a', 3, { status: 'interrupted', interruptionReason: 'user' }),
      queuedFollowups: [{ ...item, state: 'paused', pauseReason: '任务已停止，请确认后继续发送' }],
    }),
  )
  await act(async () =>
    priority.resolve({ ok: true, value: JSON.stringify({ queuedId: item.id, revision: 5 }) }),
  )
  expect(t.r.root.findByProps({ 'data-queue-id': item.id }).props['data-exiting']).toBe(true)
  await act(async () =>
    t.streams.at(-1)!.push({
      ...t.snapshot('a', 6, { status: 'interrupted', interruptionReason: 'user' }),
      queuedFollowups: [{ ...item, state: 'paused', pauseReason: '发送已暂停：模拟权限变化' }],
    }),
  )
  expect(t.r.root.findByProps({ 'data-queue-id': item.id }).props['data-exiting']).toBe(false)
  expect(t.text()).toContain('模拟权限变化')
  expect(t.r.root.findAllByProps({ className: 'cwn-message user' })).toHaveLength(0)
})

it('retains the card tombstone after exact admission but restores it if pre-spawn authorization later fails', async () => {
  const interruptQueuedFollowup = vi
    .fn()
    .mockResolvedValue({ ok: true, value: JSON.stringify({ queuedId: 'priority', revision: 4 }) })
  const t = await setup(true, undefined, workers, { interruptQueuedFollowup })
  const item = { id: 'priority', prompt: 'same text', createdAt: '', state: 'pending' as const }
  await act(async () =>
    t.streams.at(-1)!.push({ ...t.snapshot('a', 2, { status: 'running' }), queuedFollowups: [item] }),
  )
  await t.click('插队待发送消息 1')
  const admitted = {
    ...t.snapshot('a', 5, { status: 'queued', runId: 'new-run' }),
    queuedFollowups: [{ ...item, state: 'sending' as const }],
    timeline: [
      { id: 'new-run:1', kind: 'user' as const, text: item.prompt, time: '', queuedFollowupId: item.id },
    ],
  }
  await act(async () => t.streams.at(-1)!.push(admitted))
  expect(t.r.root.findAllByProps({ className: 'cwn-message user' })).toHaveLength(1)
  expect(t.r.root.findByProps({ 'data-queue-id': item.id }).props['data-exiting']).toBe(true)
  await act(async () =>
    t.streams.at(-1)!.push({
      ...admitted,
      revision: 6,
      selected: { ...admitted.selected!, status: 'failed' },
      queuedFollowups: [{ ...item, state: 'paused', pauseReason: '账号已变化' }],
    }),
  )
  expect(t.r.root.findByProps({ 'data-queue-id': item.id }).props['data-exiting']).toBe(false)
  expect(t.text()).toContain('账号已变化')
  expect(t.r.root.findAllByProps({ className: 'cwn-message user' })).toHaveLength(1)
})

it('does not resend an uncertain priority request and keeps its persisted operation alive after closing the view', async () => {
  const priority = deferred()
  const interruptQueuedFollowup = vi.fn().mockReturnValue(priority.promise)
  const t = await setup(true, undefined, workers, { interruptQueuedFollowup })
  const item = { id: 'priority', prompt: 'persisted priority', createdAt: '', state: 'pending' as const }
  await act(async () =>
    t.streams.at(-1)!.push({ ...t.snapshot('a', 2, { status: 'running' }), queuedFollowups: [item] }),
  )
  await t.click('插队待发送消息 1')
  const signal = interruptQueuedFollowup.mock.calls[0]![4] as AbortSignal
  await act(async () => t.r.unmount())
  expect(signal.aborted).toBe(false)
  await act(async () =>
    priority.resolve({ ok: true, value: JSON.stringify({ queuedId: item.id, revision: 4 }) }),
  )
  expect(interruptQueuedFollowup).toHaveBeenCalledOnce()
})

it('keeps Stop available after a lost priority receipt while Host is still stopping', async () => {
  const interruptQueuedFollowup = vi.fn().mockRejectedValue(new Error('transport failure'))
  const stop = vi.fn().mockResolvedValue({
    ok: true,
    value: JSON.stringify({ ...workers[0], status: 'interrupted', interruptionReason: 'user' }),
  })
  const t = await setup(true, undefined, workers, { interruptQueuedFollowup, stop })
  const item = { id: 'priority', prompt: 'unknown priority', createdAt: '', state: 'pending' as const }
  await act(async () =>
    t.streams.at(-1)!.push({ ...t.snapshot('a', 2, { status: 'running' }), queuedFollowups: [item] }),
  )
  await t.click('插队待发送消息 1')
  await act(async () =>
    t.streams.at(-1)!.push({
      ...t.snapshot('a', 3, { status: 'stopping' }),
      queuedFollowups: [{ ...item, state: 'paused' }],
    }),
  )
  const stopButton = t.r.root.findAllByType('button').find((button) => button.props['aria-label'] === '停止')!
  expect(stopButton.props.disabled).toBe(false)
  expect(t.text()).toContain('发送结果待确认')
  expect(t.text()).not.toContain('未发送：发送结果待确认')
  await t.click('停止')
  expect(stop).toHaveBeenCalledOnce()
  expect(interruptQueuedFollowup).toHaveBeenCalledOnce()
  expect(t.r.root.findByProps({ 'data-queue-id': item.id }).props['data-exiting']).toBe(false)
})

it('uses an exact admission event as the watermark if a lost receipt is followed by pre-spawn failure', async () => {
  const interruptQueuedFollowup = vi.fn().mockRejectedValue(new Error('transport failure'))
  const t = await setup(true, undefined, workers, { interruptQueuedFollowup })
  const item = { id: 'priority', prompt: 'admitted then rejected', createdAt: '', state: 'pending' as const }
  await act(async () =>
    t.streams.at(-1)!.push({ ...t.snapshot('a', 2, { status: 'running' }), queuedFollowups: [item] }),
  )
  await t.click('插队待发送消息 1')
  await act(async () =>
    t.streams.at(-1)!.push({
      ...t.snapshot('a', 6, { status: 'failed', runId: 'rejected-run' }),
      queuedFollowups: [{ ...item, state: 'paused', pauseReason: '发送已暂停：模拟账号变化' }],
      timeline: [
        { id: 'rejected-run:1', kind: 'user', text: item.prompt, time: '', queuedFollowupId: item.id },
      ],
    }),
  )
  expect(t.r.root.findByProps({ 'data-queue-id': item.id }).props['data-exiting']).toBe(false)
  expect(t.text()).toContain('模拟账号变化')
  expect(t.text()).not.toContain('发送结果待确认')
  expect(t.r.root.findAllByProps({ className: 'cwn-message user' })).toHaveLength(1)
})

it('releases a priority admission wait as uncertain when its exact event has fallen outside the live window', async () => {
  const interruptQueuedFollowup = vi
    .fn()
    .mockResolvedValue({ ok: true, value: JSON.stringify({ queuedId: 'priority', revision: 4 }) })
  const sendRunningMessage = vi.fn()
  const t = await setup(true, undefined, workers, { interruptQueuedFollowup, sendRunningMessage })
  const item = { id: 'priority', prompt: 'earlier priority', createdAt: '', state: 'pending' as const }
  await act(async () =>
    t.streams.at(-1)!.push({ ...t.snapshot('a', 2, { status: 'running' }), queuedFollowups: [item] }),
  )
  await t.click('插队待发送消息 1')
  await t.edit('later local instruction')
  await t.submit()
  expect(sendRunningMessage).not.toHaveBeenCalled()
  await t.select('b')
  await t.push('b')
  await t.select('a')
  await act(async () =>
    t.streams
      .at(-1)!
      .push({
        ...t.snapshot('a', 20, { status: 'completed', runId: 'later-run' }),
        queuedFollowups: [],
        truncated: true,
      }),
  )
  expect(t.text()).toContain('插队结果待确认')
  expect(t.input().props.value).toBe('later local instruction')
  expect(sendRunningMessage).not.toHaveBeenCalled()
  const stop = t.r.root.findAllByType('button').find((button) => button.props['aria-label'] === '停止')!
  expect(stop.props.disabled).toBe(false)
})
