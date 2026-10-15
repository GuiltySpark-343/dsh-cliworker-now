import { createElement, forwardRef } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { ConversationTimeline } from '../src/client/conversation-timeline.tsx'
import { UsageIndicator } from '../src/client/telemetry.tsx'
import type { TimelineItem, Worker } from '../src/shared/types.ts'

// Synthetic conversations; only the native primitive skins are replaced.
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Tooltip: ({ children }: any) => children,
  useAnchoredPosition: () => null,
  useDismissOnOutsidePointer: () => {},
  IconDatabaseOutlineRegular: () => createElement('svg'),
  IconCopyOutlineRegular: () => createElement('svg'),
  IconCheckOutlineRegular: () => createElement('svg'),
  IconSettingsOutlineRegular: () => createElement('svg'),
  MarkdownText: ({ text }: any) => createElement('div', {}, text),
  writeClipboard: vi.fn().mockResolvedValue(true),
  Button: forwardRef(({ children, variant: _variant, size: _size, ...props }: any, ref) =>
    createElement('button', { ...props, ref }, children),
  ),
}))

const time = '2026-10-15T01:00:00.000Z'
const worker: Worker = {
  id: 'synthetic-worker',
  parentSessionId: 'synthetic-parent',
  project: '/synthetic-project',
  title: '模拟时间线',
  preference: { cli: 'antigravity', model: 'synthetic-model', effort: 'low' },
  mode: 'accept-edits',
  status: 'completed',
  runId: 'r',
  createdAt: time,
  updatedAt: time,
}
const row = (
  id: string,
  kind: TimelineItem['kind'],
  text: string,
  extra: Partial<TimelineItem> = {},
): TimelineItem => ({ id, kind, text, time, ...extra })
const mounted: ReactTestRenderer[] = []
async function render(items: TimelineItem[], selected: Worker = worker, latestItems = items) {
  let result!: ReactTestRenderer
  await act(async () => {
    result = create(<ConversationTimeline items={items} worker={selected} latestItems={latestItems} />)
  })
  mounted.push(result)
  return result
}
afterEach(async () => {
  await act(async () => {
    for (const result of mounted.splice(0)) result.unmount()
  })
})
const article = (result: ReactTestRenderer, id: string) =>
  result.root.findAllByProps({ 'data-message-id': id })
const reveal = (result: ReactTestRenderer, id: string) =>
  article(result, id)[0]!.findByProps({ className: 'cwn-message-tail' }).props['data-actions-reveal']

it.each(['', ' \n\t '])(
  'moves a DONE empty/whitespace reply into the process without losing statistics: %j',
  async (text) => {
    const usage = { total: 23, input: 20, output: 3, scope: 'response' as const }
    const items = [
      row('r:user', 'user', '模拟请求'),
      row('r:assistant:1', 'assistant', text, {
        state: 'DONE',
        usage,
        durationSeconds: 0.75,
        sessionDurationSeconds: 4100,
      }),
    ]
    const original = structuredClone(items)
    // An individual completed step can be hidden while the run continues.
    const result = await render(items, { ...worker, status: 'running' })
    expect(article(result, 'r:assistant:1')).toHaveLength(0)
    expect(article(result, 'r:user')).toHaveLength(1)
    const process = result.root.findByProps({ className: 'cwn-progress' })
    const hidden = process.findByProps({ 'data-empty-reply-id': 'r:assistant:1' })
    expect(hidden.findByType(UsageIndicator).props.usage).toEqual(usage)
    expect(hidden.findByType('time').props.dateTime).toBe(time)
    expect(JSON.stringify(result.toJSON())).toContain('0.75')
    expect(JSON.stringify(result.toJSON())).toContain('CLI 会话累计耗时：')
    expect(result.root.findAllByType(UsageIndicator)).toHaveLength(1)
    expect(items).toEqual(original)
  },
)

it('keeps a usage-less empty step observable without inventing statistics', async () => {
  const result = await render([row('r:assistant:0', 'assistant', '', { state: 'DONE' })])
  expect(result.root.findAllByType('article')).toHaveLength(0)
  expect(result.root.findByType(UsageIndicator).props.usage).toBeUndefined()
  expect(JSON.stringify(result.toJSON())).toContain('用量 — tok')
  expect(JSON.stringify(result.toJSON())).not.toContain('CLI 报告耗时')
})

it('preserves an empty active stream, then its text and completed reply', async () => {
  const first = row('r:assistant:1', 'assistant', '', { state: 'ACTIVE' })
  const running = { ...worker, status: 'running' as const }
  const result = await render([first], running)
  expect(article(result, first.id)).toHaveLength(1)
  expect(result.root.findAllByProps({ 'data-empty-reply-id': first.id })).toHaveLength(0)
  const partial = { ...first, text: '模拟流式正文' }
  await act(async () => {
    result.update(<ConversationTimeline items={[partial]} worker={running} />)
  })
  expect(JSON.stringify(result.toJSON())).toContain(partial.text)
  expect(reveal(result, first.id)).toBe('hover')
  await act(async () => {
    result.update(<ConversationTimeline items={[{ ...partial, state: 'DONE' }]} worker={worker} />)
  })
  expect(article(result, first.id)).toHaveLength(1)
  expect(reveal(result, first.id)).toBe('always')
})

it('keeps the final visible reply tail after hidden steps and respects user/tool boundaries', async () => {
  const items = [
    row('r:assistant:1', 'assistant', '模拟最终正文', { state: 'DONE' }),
    row('r:assistant:2', 'assistant', '', { state: 'DONE' }),
  ]
  const result = await render(items)
  expect(reveal(result, items[0]!.id)).toBe('always')
  for (const kind of ['user', 'tool'] as const) {
    await act(async () => {
      result.update(
        <ConversationTimeline
          items={items}
          latestItems={[...items, row(`next:${kind}`, kind, '模拟后续内容')]}
          worker={worker}
        />,
      )
    })
    expect(reveal(result, items[0]!.id)).toBe('hover')
  }
})

it('does not promote a history page tail to the live end, or hide its error/tool records', async () => {
  const items = [
    row('old:user', 'user', '模拟旧请求'),
    row('old:assistant:1', 'assistant', '模拟历史正文', { state: 'DONE' }),
    row('old:assistant:2', 'assistant', '', { state: 'DONE', usage: { total: 11, scope: 'response' } }),
    row('old:tool:3', 'tool', '模拟写入', { state: 'DONE', detail: '模拟工具结果' }),
    row('old:error', 'diagnostic', '模拟错误', { detail: '模拟 EOF 错误证据' }),
  ]
  const result = await render(items, worker, [
    row('r:user', 'user', '模拟新请求'),
    row('r:reply', 'assistant', '模拟新回复'),
  ])
  expect(reveal(result, 'old:assistant:1')).toBe('hover')
  expect(article(result, 'old:assistant:2')).toHaveLength(0)
  expect(result.root.findAllByProps({ className: 'cwn-tool' })).toHaveLength(2)
  expect(JSON.stringify(result.toJSON())).toContain('模拟工具结果')
  expect(JSON.stringify(result.toJSON())).toContain('模拟 EOF 错误证据')
  expect(
    result.root.findByProps({ 'data-empty-reply-id': 'old:assistant:2' }).findByType(UsageIndicator).props
      .usage.total,
  ).toBe(11)
})

it.each(['completed', 'failed', 'interrupted', 'uncertain'] as const)(
  'keeps the process and %s outcome when all output is empty',
  async (status) => {
    const items = [
      row('r:user', 'user', '模拟请求', { runStartedAt: time }),
      row('r:assistant:1', 'assistant', ' ', {
        state: 'ACTIVE',
        runStartedAt: time,
        runEndedAt: '2026-10-15T01:00:05.000Z',
        runOutcome: status,
        sessionDurationSeconds: 4100,
      }),
      row('r:status', 'status', status),
    ]
    const result = await render(items, { ...worker, status })
    expect(article(result, 'r:assistant:1')).toHaveLength(0)
    const progress = result.root.findByProps({ className: 'cwn-progress' })
    expect(progress.findByProps({ 'data-empty-reply-id': 'r:assistant:1' })).toBeDefined()
    const text = JSON.stringify(result.toJSON())
    expect(text).toContain('用时 5秒')
    expect(text).toContain('4100')
    if (status === 'uncertain') expect(text).toContain('结果待核实')
  },
)
