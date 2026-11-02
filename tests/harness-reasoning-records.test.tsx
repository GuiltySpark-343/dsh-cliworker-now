import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { SlotCore } from '@deepseek-ai/dsh-client-ui-slots'
import { CLI_IDS, type ActiveCliId } from '../src/shared/types.ts'
import { HarnessBindingRegistry } from '../src/client/harness-binding-registry.ts'
import { HarnessReasoningRecords, installHarnessReasoningRecords } from '../src/client/harness-reasoning-records.tsx'

// Simulated native leaf: actual native grouping, keyboard, Markdown safety and
// reopen behavior are checked separately against the isolated Harness UI.
const roots: ReactTestRenderer[] = []
afterEach(() => { act(() => { for (const root of roots.splice(0)) root.unmount() }) })
function fixture(cli: ActiveCliId = 'codex') {
  const bindings = new HarnessBindingRegistry()
  bindings.publish({ sessionId: 'child', parentSessionId: 'parent', mode: 'continuable', capabilities: {} },
    { id: 'worker', preference: { cli, model: 'SIMULATED-model', effort: 'default' } })
  const Native = vi.fn(() => null)
  const props: any = { sessionId: 'child', t: vi.fn((key: string) => key),
    renderSlot: vi.fn((name: string, owner: any) => <pre data-slot={name}>{owner.text}</pre>),
    node: { data: { blocks: [{ kind: 'reasoning', text: '模拟公开摘要' }, { kind: 'text', text: '模拟回复' }] } },
    groupPart: 'reasoning', turnProcess: { open: false, setOpen: vi.fn() }, useDisclosure: vi.fn(),
    useSession: (select: any) => select({ subagent: { address: { childSessionId: 'child', parentSessionId: 'parent' } } }) }
  let root!: ReactTestRenderer
  const render = (next: any) => createElement(HarnessReasoningRecords, { Native, bindings, props: next })
  act(() => { root = create(render(props)) })
  roots.push(root)
  return { root, props, bindings, Native, received: () => (Native.mock.calls as any).at(-1)[0],
    update: (next: any) => act(() => root.update(render(next))) }
}
it.each(CLI_IDS)('%s retains the actual native reasoning/process owner and changes only its presentation', cli => {
  const f = fixture(cli), received = f.received()
  expect(received.t('message.think')).toBe('思考记录')
  const otherLabel = { count: 2 }
  expect(received.t('message.stopped', otherLabel)).toBe('message.stopped')
  expect(f.props.t).toHaveBeenCalledWith('message.stopped', otherLabel)
  for (const key of Object.keys(f.props).filter(key => !['t', 'renderSlot'].includes(key)))
    expect(received[key]).toBe(f.props[key])
  const owner = { text: '原生公开摘要', running: true }, options = { entryKey: 'original' }
  const body = received.renderSlot('conversation.chat.reasoning.body', owner, options)
  expect(body.props.role).toBe('region')
  expect(body.props['aria-label']).toBe('思考记录')
  expect(f.props.renderSlot).toHaveBeenCalledWith('conversation.chat.reasoning.body', owner, options)
  expect(body.props.children.props.children).toBe('原生公开摘要')
  const image = received.renderSlot('conversation.chat.message.images', owner)
  expect(image.type).toBe('pre')
})
it('does not derive another text store or change snapshots, tool order and disclosure state', () => {
  const f = fixture()
  const state = f.props.turnProcess, disclosure = f.props.useDisclosure
  for (const blocks of [[], [{ kind: 'reasoning', text: ' ' }], [{ kind: 'reasoning', signature: 'PRIVATE' }],
    [{ kind: 'reasoning', text: '完整摘要' }, { kind: 'tool-call' }, { kind: 'reasoning', text: '第二段' }]]) {
    const node = { data: { blocks } }
    f.update({ ...f.props, node })
    expect(f.received().node).toBe(node)
    expect(f.received().turnProcess).toBe(state)
    expect(f.received().useDisclosure).toBe(disclosure)
  }
})
it('leaves main, other parent/child, retired CLI and revoked bindings unchanged', () => {
  const f = fixture()
  for (const address of [undefined, { childSessionId: 'child', parentSessionId: 'other-parent' },
    { childSessionId: 'other-child', parentSessionId: 'parent' }]) {
    f.update({ ...f.props, useSession: (select: any) => select({ subagent: address ? { address } : null }) })
    expect(f.received().t).toBe(f.props.t)
    expect(f.received().renderSlot).toBe(f.props.renderSlot)
  }
  f.update({ ...f.props, sessionId: 'parent' })
  expect(f.received().t).toBe(f.props.t)
  act(() => f.bindings.publish(f.bindings.get('child')!, { id: 'worker', preference: { cli: 'harness', model: 'old', effort: 'default' } }))
  f.update(f.props)
  expect(f.received().t).toBe(f.props.t)
  act(() => f.bindings.clear())
  expect(f.received().t).toBe(f.props.t)
  act(() => f.root.unmount())
  expect((f.bindings as any).listeners.size).toBe(0)
})
it('follows native registration replacement and releases only its own entry and subscription', () => {
  const core = new SlotCore(), bindings = new HarnessBindingRegistry()
  core.register({ name: 'root', children: { 'conversation.chat.node': { kind: 'keyed', scope: 'session' },
    'conversation.chat.turnTail': { kind: 'list', scope: 'session' } } } as any, () => null)
  const Native = () => null, Process = () => null, Tail = () => null
  core.register({ name: 'conversation.chat.node', key: 'turn-process' } as any, Process)
  core.register({ name: 'conversation.chat.turnTail', id: 'native' } as any, Tail)
  const inject = vi.fn(), locale = 'native.locale'
  const releaseNative = core.register({ name: 'conversation.chat.node', key: 'assistant-step', inject, locale,
    children: { 'conversation.chat.reasoning.body': { kind: 'single', scope: 'session' } } } as any, Native)
  const child = core.register({ name: 'conversation.chat.reasoning.body' } as any, () => null)
  const slots: any = { entries: core.entries.bind(core), register: core.register.bind(core), subscribe: core.subscribe.bind(core),
    inject: (_name: string, callback: () => () => void) => callback() }
  const release = installHarnessReasoningRecords({ slots }, bindings)
  const entries = core.entries('conversation.chat.node').filter(entry => entry.options.key === 'assistant-step')
  expect(entries).toHaveLength(2)
  expect(entries[0]!.inject).toBe(entries[1]!.inject)
  expect(entries[0]!.locale).toBe(entries[1]!.locale)
  expect(entries[0]!.children).toBe(entries[1]!.children)
  const replacement = core.register({ name: 'conversation.chat.node', key: 'assistant-step', priority: -5 } as any, () => null)
  expect(core.entries('conversation.chat.node').filter(entry => entry.options.key === 'assistant-step')).toHaveLength(3)
  expect(core.entries('conversation.chat.reasoning.body')).toHaveLength(1)
  replacement()
  expect(core.entries('conversation.chat.reasoning.body')).toHaveLength(1)
  release(); release()
  expect(core.entries('conversation.chat.node').map(entry => entry.component)).toEqual([Process, Native])
  expect(core.entries('conversation.chat.turnTail').map(entry => entry.component)).toEqual([Tail])
  expect(core.entries('conversation.chat.reasoning.body')).toHaveLength(1)
  releaseNative()
  expect(core.entries('conversation.chat.node').map(entry => entry.component)).toEqual([Process])
  child()
})
