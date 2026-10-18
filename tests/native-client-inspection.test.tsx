import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import {
  NativePresentationProvider,
  useNativePresentation,
  workDetailsPolicy,
  type NativeChatSettings,
} from '../src/client/native-presentation.tsx'
import { ContextDetails, contextFigures } from '../src/client/telemetry.tsx'
import { WorkerProcessGroup, WorkerProcessHeader, toolDepth } from '../src/client/worker-process.tsx'
import { nativeFileDiffs, patchHunks } from '../src/client/tool-viewers.ts'
import type { Telemetry } from '../src/shared/telemetry.ts'
import type { TimelineItem, Worker } from '../src/shared/types.ts'

// SIMULATION ONLY: native primitive skins, no session, CLI or model request.
vi.mock('@deepseek-ai/dsh-client-ui-primitives', async () => ({
  ...(await import('./fixtures/process-primitives.tsx')).processPrimitives,
  IconDatabaseOutlineRegular: () => createElement('svg'),
  MarkdownText: ({ text }: any) => createElement('div', { 'data-native-markdown': true }, text),
}))
const mounted: ReactTestRenderer[] = []
async function mount(node: React.ReactNode) {
  let result!: ReactTestRenderer
  await act(async () => {
    result = create(node)
  })
  mounted.push(result)
  return result
}
afterEach(async () => {
  await act(async () => {
    for (const result of mounted.splice(0)) result.unmount()
  })
})
const at = '2026-10-16T00:00:00.000Z'
const worker = { id: 'simulated', runId: 'r', project: '/simulation', status: 'running' } as Worker
const row = (id: string, kind: TimelineItem['kind'], extra: Partial<TimelineItem> = {}): TimelineItem => ({
  id: `r:${id}`,
  kind,
  text: id,
  time: at,
  ...extra,
})
const sourceFor = (mode: string) => {
  let snapshot = { value: { transcriptView: mode } }
  const listeners = new Set<() => void>()
  const source = {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  } as NativeChatSettings
  return {
    source,
    listeners,
    set: (value: string) => {
      snapshot = { value: { transcriptView: value } }
      listeners.forEach((listener) => listener())
    },
  }
}
async function group(items: TimelineItem[], mode = 'verbose', selected = worker) {
  const state = sourceFor(mode)
  const result = await mount(
    <NativePresentationProvider source={state.source}>
      <WorkerProcessGroup items={items} rows={items} worker={selected} hidden={false} first />
    </NativePresentationProvider>,
  )
  return { result, ...state }
}
async function open(result: ReactTestRenderer, title: string) {
  const button = result.root.findByProps({ 'data-disclosure': title }).findByType('button')
  await act(async () => button.props.onClick())
}

it.each([
  ['compact', 'collapsed', false, false],
  ['standard', 'collapsed', true, true],
  ['detailed', 'history', true, true],
  ['verbose', 'none', false, true],
] as const)('inherits native %s policy', (mode, grouping, live, preview) => {
  expect(workDetailsPolicy(mode)).toMatchObject({
    mode,
    stepGrouping: grouping,
    liveProcessDetail: live,
    settledReasoningPreview: preview,
  })
})
it('uses native legacy/default modes and cleans up a readonly settings subscription', async () => {
  expect(workDetailsPolicy('normal').mode).toBe('detailed')
  expect(workDetailsPolicy('expanded').mode).toBe('detailed')
  expect(workDetailsPolicy(undefined, true).mode).toBe('standard')
  expect(workDetailsPolicy(undefined, false).mode).toBe('compact')
  const state = sourceFor('compact')
  function Probe() {
    return <span>{useNativePresentation().mode}</span>
  }
  const result = await mount(
    <NativePresentationProvider source={state.source}>
      <Probe />
    </NativePresentationProvider>,
  )
  expect(state.listeners.size).toBe(1)
  await act(async () => state.set('verbose'))
  expect(result.root.findByType('span').children).toEqual(['verbose'])
  await act(async () => result.unmount())
  mounted.splice(mounted.indexOf(result), 1)
  expect(state.listeners.size).toBe(0)
  expect(Object.keys(state.source).sort()).toEqual(['getSnapshot', 'subscribe'])
})
it('keeps public Markdown and structured tool payloads inert inside native disclosures', async () => {
  const html = '<img src=x onerror="simulation()">'
  const { result } = await group([
    row('reasoning', 'reasoning', { detail: `**公开摘要**\n\n${html}`, state: 'COMPLETED' }),
    row('tool', 'tool', {
      toolCall: { callId: 'a', name: '模拟工具', input: { html }, output: { ok: true } },
      state: 'COMPLETED',
    }),
  ])
  expect(result.root.findAllByType('pre')).toHaveLength(0)
  await open(result, '思考')
  await open(result, '模拟工具')
  expect(result.root.findByProps({ 'data-native-markdown': true }).children.join('')).toContain(html)
  expect(result.root.findAllByProps({ 'data-native-viewer': 'json' })).toHaveLength(2)
  expect(result.root.findAllByType('img')).toHaveLength(0)
  expect(JSON.stringify(result.toJSON())).not.toContain('COMPLETED')
})
it('uses terminal component only for an explicit command and preserves its native exit code', async () => {
  const { result } = await group([
    row('tool', 'tool', {
      toolCall: {
        name: 'commandExecution',
        command: 'printf simulation',
        output: 'simulation\n',
        exitCode: 7,
      },
      state: 'FAILED',
    }),
  ])
  await open(result, 'commandExecution')
  const terminal = result.root.findByProps({ 'data-native-viewer': 'terminal' })
  expect(terminal.props['data-exit-code']).toBe(7)
  expect(terminal.children.join('')).toContain('printf simulation\nsimulation\n')
})
it('only indents explicit verified parents and rejects missing/cyclic identities', () => {
  const parent = row('p', 'tool', { toolCall: { callId: 'parent' } }),
    child = row('c', 'tool', { toolCall: { callId: 'child', parentCallId: 'parent' } })
  expect(toolDepth(child, [parent, child])).toEqual({ depth: 1, unresolved: false })
  expect(toolDepth(child, [child])).toEqual({ depth: 0, unresolved: true })
  expect(toolDepth(parent, [parent, child])).toEqual({ depth: 0, unresolved: false })
  parent.toolCall!.parentCallId = 'child'
  expect(toolDepth(child, [parent, child])).toEqual({ depth: 0, unresolved: true })
})
it('keeps unfinished stopped tools warning and does not invent success', async () => {
  const { result } = await group(
    [
      row('unfinished', 'tool', {
        state: 'RUNNING',
        runEndedAt: at,
        runOutcome: 'interrupted',
        toolCall: { name: '模拟未结束工具' },
      }),
    ],
    'verbose',
    { ...worker, status: 'interrupted' },
  )
  expect(result.root.findByProps({ 'data-native-state': 'warning' })).toBeDefined()
  expect(result.root.findAllByProps({ 'data-native-state': 'done' })).toHaveLength(0)
})
it('retains native event order and only gives verified children indentation', async () => {
  const items = [
    row('reason', 'reasoning', { detail: '模拟公开摘要', state: 'COMPLETED' }),
    row('parent', 'tool', { toolCall: { callId: 'p', name: '模拟父调用' }, state: 'COMPLETED' }),
    row('child', 'tool', {
      toolCall: { callId: 'c', parentCallId: 'p', name: '模拟子调用' },
      state: 'COMPLETED',
    }),
    row('unknown', 'tool', {
      toolCall: { callId: 'u', parentCallId: 'absent', name: '模拟孤立调用' },
      state: 'COMPLETED',
    }),
  ]
  const { result } = await group(items)
  const tools = result.root.findAll((node) => node.type === 'div' && node.props['data-tool-call-id'])
  expect(tools.map((node) => node.props['data-tool-call-id'])).toEqual(['p', 'c', 'u'])
  expect(tools.map((node) => node.props.style?.marginLeft)).toEqual([undefined, '22px', undefined])
  expect(
    result.root
      .findAll((node) => node.type === 'section' && node.props['data-disclosure'])
      .map((node) => node.props['data-disclosure']),
  ).toEqual(['思考', '模拟父调用', '模拟子调用', '模拟孤立调用'])
})
it('switches native grouping live without reading another session', async () => {
  const { result, set } = await group([row('tool', 'tool', { detail: 'simulation' })], 'compact')
  expect(result.root.findAllByType('pre')).toHaveLength(0)
  await act(async () => set('detailed'))
  expect(result.root.findAllByProps({ 'data-disclosure': 'tool' })).toHaveLength(1)
  await open(result, 'tool')
  expect(result.root.findByType('pre').children).toEqual(['simulation'])
})
it.each([
  ['completed', 'COMPLETED', '已完成分析'],
  ['running', 'RUNNING', '正在分析请求'],
] as const)(
  'matches native %s reasoning-only group title separately from the reasoning row',
  async (status, state, title) => {
    const items = [
      row('reasoning-only', 'reasoning', {
        state,
        detail: '模拟公开摘要\n\n明确公开正文',
        ...(status === 'completed' ? { runOutcome: 'completed' as const, runEndedAt: at } : {}),
      }),
    ]
    const { result } = await group(items, 'compact', { ...worker, status })
    const header = result.root.findByProps({ className: 'cwn-process-group-title' })
    expect(JSON.stringify(result.toJSON())).toContain(title)
    await act(async () => header.props.onClick({ currentTarget: { focus() {} } }))
    expect(result.root.findAllByProps({ 'data-disclosure': '思考' })).toHaveLength(1)
    expect(result.root.findAllByProps({ className: 'cwn-process-group-title' })).toHaveLength(1)
  },
)
it('uses recorded boundaries for completion and native stopped/error labels without elapsed text', async () => {
  for (const status of ['completed', 'interrupted', 'failed', 'uncertain'] as const) {
    const rows = [
      row('user', 'user', { runStartedAt: at }),
      row('tool', 'tool', { runEndedAt: '2026-10-16T00:00:05.000Z', runOutcome: status }),
    ]
    const result = await mount(
      <WorkerProcessHeader rows={rows} worker={{ ...worker, status }} open={false} toggle={() => {}} />,
    )
    const text = JSON.stringify(result.toJSON())
    expect(text.includes('用时 5秒')).toBe(status === 'completed')
    if (status !== 'completed') expect(result.root.findByType('button').props.disabled).toBe(true)
  }
})
it('adapts only valid Codex unified patch hunks to the native DiffBlock data shape', () => {
  const patch = '--- a/simulation.txt\n+++ b/simulation.txt\n@@ -7,2 +7,2 @@\n same\n-old\n+new\n'
  const diffs = nativeFileDiffs({
    name: 'fileChange',
    output: [{ path: 'simulation.txt', kind: { type: 'update' }, diff: patch }],
  })
  expect(diffs).toEqual([{ path: 'simulation.txt', oldText: 'same\nold', newText: 'same\nnew' }])
  expect(patchHunks('x', '@@ -1,2 +1 @@\n-old\n+new')).toBeUndefined()
  expect(
    nativeFileDiffs({ name: 'unknown', output: [{ path: 'x', kind: 'update', diff: patch }] }),
  ).toBeUndefined()
  expect(patchHunks('x', 'x'.repeat(200001))).toBeUndefined()
})
it('shows valid native partial diffs without reading or claiming a complete file', async () => {
  const { result } = await group([
    row('diff', 'tool', {
      toolCall: {
        name: 'fileChange',
        output: [{ path: 'x', kind: 'update', diff: '@@ -1 +1 @@\n-old\n+new' }],
      },
      state: 'COMPLETED',
    }),
  ])
  await open(result, 'fileChange')
  expect(result.root.findAllByProps({ 'data-native-viewer': 'diff' })).toHaveLength(1)
  expect(JSON.stringify(result.toJSON())).toContain('非文件完整内容')
})
it('retains provider total and independently estimated context composition without forcing a sum', async () => {
  const telemetry: Telemetry = {
    contextUsed: 300,
    contextCapacity: 1000,
    contextBreakdown: {
      systemTokens: 100,
      toolTokens: 200,
      messageTokens: 300,
      estimated: true,
      source: '模拟原生分类估算',
    },
  }
  const figures = contextFigures(telemetry)
  expect(figures.percent).toBe(30)
  expect(figures.segments.map((x) => x.width)).toEqual([5, 10, 15])
  const result = await mount(<ContextDetails telemetry={telemetry} />)
  const text = JSON.stringify(result.toJSON())
  expect(text).toContain('~100')
  expect(text).toContain('~200')
  expect(text).toContain('~300')
  expect(text).toContain('系统提示词')
  expect(text).toContain('工具定义')
  expect(text).toContain('对话消息')
})
it.each([
  undefined,
  { contextUsed: 0 },
  { contextCapacity: 1000 },
  { contextUsed: 10, contextCapacity: 0 },
  { contextUsed: NaN, contextCapacity: -1 },
])('retains independent known values without inventing an unknown percentage: %j', async (telemetry) => {
  const figures = contextFigures(telemetry)
  expect(figures.percent).toBeUndefined()
  expect(figures.segments).toEqual([])
  const result = await mount(<ContextDetails telemetry={telemetry} />)
  expect(result.root.findAllByType('dd').map((x) => x.children.join(''))).toEqual(['—', '—', '—'])
})
it('does not color incomplete categories or infer the missing remainder', () => {
  const figures = contextFigures({
    contextUsed: 30,
    contextCapacity: 100,
    contextBreakdown: { systemTokens: 0, toolTokens: 7 },
  })
  expect(figures.rows.map((row) => row.value)).toEqual([0, 7, undefined])
  expect(figures.segments).toEqual([{ key: 'total', color: undefined, width: 30 }])
})
it('accepts explicit zero category counts and zero use as evidence', () => {
  const figures = contextFigures({
    contextUsed: 0,
    contextCapacity: 100,
    contextBreakdown: { systemTokens: 0, toolTokens: 0, messageTokens: 0 },
  })
  expect(figures).toMatchObject({ used: 0, capacity: 100, percent: 0, complete: true })
  expect(figures.rows.map((row) => row.value)).toEqual([0, 0, 0])
})
