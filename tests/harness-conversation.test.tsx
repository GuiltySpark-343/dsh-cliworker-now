import { createElement, type ReactNode } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import {
  HarnessCapabilityNotes,
  HarnessConversation,
  harnessComposerBlock,
  readHarnessConversationBinding,
  retainHarnessComposerBlock,
} from '../src/client/harness-conversation.tsx'
import { HarnessBindingRegistry } from '../src/client/harness-binding-registry.ts'
import type { HarnessConversationBinding, Worker } from '../src/shared/types.ts'

// SIMULATION: Controller references, Host Gateway and native content output are fakes; no model or CLI runs.
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Tooltip: ({ label, children }: any) => <span data-tooltip={label}>{children}</span>,
  Button: ({ children, ...props }: any) => <button {...props}>{children}</button>,
}))
const mounted: ReactTestRenderer[] = []
const binding = (sessionId = 'harness-child'): HarnessConversationBinding => ({
  sessionId,
  parentSessionId: 'parent',
  mode: 'continuable',
  capabilities: {
    send: true,
    queue: false,
    steer: false,
    stop: false,
    model: false,
    permission: false,
    plan: false,
    attachments: false,
    fork: false,
    tools: false,
    skills: false,
  },
  reasons: { queue: '原生队列尚未接通', stop: '请使用停止 CLI 等待清理', model: '由 CLI 原生选型管理' },
})
const worker = (extra: Partial<Worker> = {}) =>
  ({
    id: 'worker',
    status: 'completed',
    conversationId: 'cli-session',
    harnessConversation: binding(),
    ...extra,
  }) as Worker
function fixture(attachProjections?: (reference: any, binding: any) => () => void) {
  const references: any[] = []
  const retain = vi.fn((address, options) => {
    const reference: any = { address, options, sessionId: address.childSessionId, release: vi.fn() }
    let snapshot = { openState: 'open', openError: null } as any
    const listeners = new Set<() => void>()
    reference.session = {
      getSnapshot: () => snapshot,
      subscribe: (listener: () => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    }
    reference.publish = (value: unknown) => {
      snapshot = value
      for (const listener of listeners) listener()
    }
    reference.listeners = listeners
    reference.ready = Promise.resolve({ sessionId: reference.sessionId, session: reference.session })
    references.push(reference)
    return reference
  })
  let currentBlock: unknown
  const services: any = {
    sessions: { retain },
    uiWorkspace: { openSession: vi.fn() },
    conversation: {
      blocks: {
        set: vi.fn((_id, value) => {
          currentBlock = value
        }),
        storeFor: () => ({ getSnapshot: () => currentBlock }),
      },
    },
  }
  const ensure = vi.fn(async () => ({ ok: true, value: JSON.stringify(binding()) }))
  const api: any = { cliworker: {} }
  const bindings = new HarnessBindingRegistry()
  const frame = vi.fn((reference: any) => <section data-native-session={reference.sessionId} />)
  const node = (selected = worker()) => (
    <HarnessConversation
      services={services}
      api={api}
      parentSessionId="parent"
      worker={selected}
      bindings={bindings}
      renderConversation={frame}
      attachProjections={attachProjections}
    />
  )
  return {
    references,
    frame,
    services,
    api,
    ensure,
    retain,
    bindings,
    openSession: services.uiWorkspace.openSession,
    node,
  }
}
async function mount(node: ReactNode) {
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
it('retains the exact child and renders the native content only in the sidebar without starting or stopping a run', async () => {
  const f = fixture()
  const result = await mount(f.node())
  expect(f.retain).toHaveBeenCalledWith(
    { parentSessionId: 'parent', childSessionId: 'harness-child', mode: 'continuable' },
    expect.objectContaining({ source: 'cliworkerConversation', signal: expect.any(AbortSignal) }),
  )
  expect(f.openSession).not.toHaveBeenCalled()
  expect(f.frame).toHaveBeenLastCalledWith(f.references[0])
  expect(f.bindings.get('harness-child')).toMatchObject(binding())
  expect(f.bindings.get('parent')).toBeUndefined()
  expect(f.ensure).not.toHaveBeenCalled()
  expect(f.frame).toHaveBeenLastCalledWith(f.references[0])
  await act(async () => result.unmount())
  expect(f.references[0].release).toHaveBeenCalledTimes(1)
  expect(f.references[0].options.signal.aborted).toBe(true)
})
it('attaches the exact generation data sources before showing native content and detaches before release', async () => {
  const events: string[] = []
  const detach = vi.fn(() => events.push('detach'))
  const attach = vi.fn((reference: any, owned: any) => {
    expect(reference.sessionId).toBe(owned.sessionId)
    expect(owned.workerId).toBe('worker')
    expect(f.bindings.get(owned.sessionId)?.workerId).toBe('worker')
    events.push('attach')
    return detach
  })
  const f = fixture(attach)
  f.frame.mockImplementation((reference: any) => {
    expect(attach).toHaveBeenCalledWith(reference, expect.objectContaining({ sessionId: 'harness-child', parentSessionId: 'parent', workerId: 'worker' }))
    return <section data-native-session={reference.sessionId} />
  })
  const result = await mount(f.node())
  expect(attach).toHaveBeenCalledTimes(1)
  f.references[0].release.mockImplementation(() => events.push('release'))
  await act(async () => result.update(f.node(worker({ observedModel: 'new-observation' }))))
  expect(attach).toHaveBeenCalledTimes(1)
  await act(async () => result.unmount())
  expect(events).toEqual(['attach', 'detach', 'release'])
  expect(detach).toHaveBeenCalledTimes(1)
})
it('shows the explicit host extension error and releases a child if data-source attachment fails', async () => {
  const attach = vi.fn(() => { throw new Error('missing native projection provider') })
  const f = fixture(attach)
  f.api.cliworker.repairHarnessConversation = vi.fn()
  const result = await mount(f.node())
  expect(result.root.findByProps({ role: 'alert' }).children.join('')).not.toBe('')
  expect(JSON.stringify(result.toJSON())).toContain('missing native projection provider')
  expect(f.references[0].release).toHaveBeenCalledTimes(1)
  expect(f.frame).not.toHaveBeenCalled()
  expect(result.root.findAllByType('button').some(button => button.children.includes('修复显示会话'))).toBe(false)
  const retry = result.root.findAllByType('button').find(button => button.children.includes('重新打开'))!
  await act(async () => retry.props.onClick())
  expect(attach).toHaveBeenCalledTimes(2)
  expect(f.api.cliworker.repairHarnessConversation).not.toHaveBeenCalled()
})
it('requests the Host binding and never submits a prompt to create the view', async () => {
  const f = fixture()
  f.api.cliworker.ensureHarnessConversation = f.ensure
  await mount(f.node(worker({ harnessConversation: undefined })))
  expect(f.ensure).toHaveBeenCalledExactlyOnceWith('parent', 'worker')
  expect(f.retain).toHaveBeenCalledTimes(1)
  expect(Object.keys(f.api ?? {})).not.toContain('prompt')
})
it('ignores a late binding receipt after switching Workers', async () => {
  const f = fixture()
  f.api.cliworker.ensureHarnessConversation = f.ensure
  let resolve!: (value: any) => void
  f.ensure.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done
      }),
  )
  const result = await mount(f.node(worker({ harnessConversation: undefined })))
  f.api.cliworker.ensureHarnessConversation = undefined
  await act(async () =>
    result.update(f.node(worker({ id: 'other', harnessConversation: binding('other-child') }))),
  )
  await act(async () => resolve({ ok: true, value: JSON.stringify(binding()) }))
  expect(f.retain).toHaveBeenCalledTimes(1)
  expect(f.references[0].sessionId).toBe('other-child')
  expect(f.openSession).not.toHaveBeenCalledWith(expect.objectContaining({ childSessionId: 'harness-child' }))
})
it('shows a real acquisition failure and never borrows the parent binding', async () => {
  const f = fixture()
  f.retain.mockImplementationOnce(() => {
    throw new Error('子会话读取被拒绝')
  })
  const result = await mount(f.node())
  expect(result.root.findByProps({ role: 'alert' }).findByType('p').children).toEqual(['子会话读取被拒绝'])
  expect(f.openSession).not.toHaveBeenCalled()
})
it('repairs an unreadable display only after the explicit action and opens the returned identity despite a late old snapshot', async () => {
  const f = fixture()
  const release = vi.fn()
  f.retain.mockReturnValueOnce({
    sessionId: 'harness-child',
    ready: Promise.reject(new Error('corrupt display')),
    release,
  } as any)
  f.api.cliworker.repairHarnessConversation = vi.fn(async () => ({
    ok: true,
    value: JSON.stringify(binding('repaired-child')),
  }))
  const result = await mount(f.node())
  expect(f.api.cliworker.repairHarnessConversation).not.toHaveBeenCalled()
  expect(release).toHaveBeenCalledTimes(1)
  await act(async () =>
    result.root
      .findAllByType('button')
      .find((button) => button.children.includes('修复显示会话'))!
      .props.onClick(),
  )
  expect(f.api.cliworker.repairHarnessConversation).toHaveBeenCalledWith(
    'parent',
    'worker',
    'harness-child',
    expect.any(AbortSignal),
  )
  expect(f.frame).toHaveBeenLastCalledWith(expect.objectContaining({ sessionId: 'repaired-child' }))
  expect(f.openSession).not.toHaveBeenCalled()
  expect(f.ensure).not.toHaveBeenCalled()
  expect(f.retain).toHaveBeenCalledTimes(2)
})
it('cleans up a rejected retained reference and keeps the failure visible', async () => {
  const f = fixture()
  const release = vi.fn()
  f.retain.mockReturnValueOnce({
    sessionId: 'harness-child',
    ready: Promise.reject(new Error('读取失败')),
    release,
  } as any)
  const result = await mount(f.node())
  expect(release).toHaveBeenCalledTimes(1)
  expect(result.root.findByProps({ role: 'alert' })).toBeTruthy()
})
it('offers explicit repair when ready resolves with a native history error instead of rejecting', async () => {
  const f = fixture()
  const retain = f.retain.getMockImplementation()!
  f.retain.mockImplementationOnce((address, options) => {
    const held = retain(address, options)
    held.publish({
      openState: 'error',
      openError: {
        code: 'session/history-error',
        message: 'SessionFormatError: step/end has unresolved tool call',
      },
    })
    return held
  })
  f.api.cliworker.repairHarnessConversation = vi.fn(async () => ({
    ok: true,
    value: JSON.stringify(binding('repaired-child')),
  }))
  const result = await mount(f.node())
  expect(JSON.stringify(result.toJSON())).toContain('unresolved tool call')
  expect(f.openSession).not.toHaveBeenCalledWith(expect.objectContaining({ childSessionId: 'harness-child' }))
  expect(f.api.cliworker.repairHarnessConversation).not.toHaveBeenCalled()
  const held = f.references[0]!
  await act(async () =>
    result.root
      .findAllByType('button')
      .find((button) => button.children.includes('修复显示会话'))!
      .props.onClick(),
  )
  expect(f.api.cliworker.repairHarnessConversation).toHaveBeenCalledWith(
    'parent',
    'worker',
    'harness-child',
    expect.any(AbortSignal),
  )
  expect(held.listeners.size).toBe(0)
  expect(held.release).toHaveBeenCalledOnce()
  expect(f.frame).toHaveBeenLastCalledWith(expect.objectContaining({ sessionId: 'repaired-child' }))
  expect(f.openSession).not.toHaveBeenCalled()
})
it('surfaces a later native history-stream error without replacing the binding or replaying a prompt', async () => {
  const f = fixture()
  f.api.cliworker.repairHarnessConversation = vi.fn()
  const result = await mount(f.node())
  const held = f.references[0]!
  await act(async () =>
    held.publish({
      openState: 'error',
      openError: {
        code: 'session/history-error',
        message: 'Synthetic stream history failed',
      },
    }),
  )
  expect(JSON.stringify(result.toJSON())).toContain('Synthetic stream history failed')
  expect(result.root.findAllByType('button').some((button) => button.children.includes('修复显示会话'))).toBe(
    true,
  )
  expect(f.api.cliworker.repairHarnessConversation).not.toHaveBeenCalled()
  expect(f.retain).toHaveBeenCalledOnce()
  await act(async () => result.unmount())
  expect(held.listeners.size).toBe(0)
  expect(held.release).toHaveBeenCalledOnce()
})
it('keeps the same native input generation when the watch later confirms its binding', async () => {
  const f = fixture()
  f.api.cliworker.ensureHarnessConversation = f.ensure
  const result = await mount(f.node(worker({ harnessConversation: undefined })))
  const held = f.references[0]
  await act(async () => result.update(f.node(worker({ harnessConversation: { ...binding() } }))))
  expect(f.retain).toHaveBeenCalledTimes(1)
  expect(held.release).not.toHaveBeenCalled()
  expect(f.frame).toHaveBeenLastCalledWith(f.references[0])
})
it('follows an atomic Host display-binding recovery without resending or retaining the retired reference', async () => {
  const f = fixture()
  const result = await mount(f.node())
  const retired = f.references[0]!
  await act(async () => result.update(f.node(worker({ harnessConversation: binding('recovered-child') }))))
  expect(retired.release).toHaveBeenCalledTimes(1)
  expect(f.retain).toHaveBeenCalledTimes(2)
  expect(f.retain.mock.calls.at(-1)?.[0].childSessionId).toBe('recovered-child')
  expect(f.frame).toHaveBeenLastCalledWith(expect.objectContaining({ sessionId: 'recovered-child' }))
  expect(f.openSession).not.toHaveBeenCalled()
  expect(f.ensure).not.toHaveBeenCalled()
})
it('releases an opening reference once and ignores ready after the occurrence closes', async () => {
  const f = fixture()
  let opened!: (value: { sessionId: string }) => void
  const release = vi.fn()
  f.retain.mockReturnValueOnce({
    sessionId: 'harness-child',
    ready: new Promise((resolve) => {
      opened = resolve
    }),
    release,
  } as any)
  const result = await mount(f.node())
  await act(async () => result.unmount())
  await act(async () => opened({ sessionId: 'harness-child' }))
  expect(release).toHaveBeenCalledTimes(1)
  expect(f.openSession).not.toHaveBeenCalled()
})
it('rejects a parent identity, cross-parent receipt and incomplete capability roster', () => {
  expect(() => readHarnessConversationBinding(binding('parent'), 'parent')).toThrow('身份')
  expect(() => readHarnessConversationBinding(binding(), 'other')).toThrow('身份')
  expect(() =>
    readHarnessConversationBinding({ ...binding(), capabilities: { send: true } }, 'parent'),
  ).toThrow('能力')
})
it('keeps native sending and queue available when the CLI cannot steer, even while Worker is stopping', async () => {
  const f = fixture()
  await mount(f.node(worker({ status: 'stopping' })))
  expect(f.services.conversation.blocks.set).not.toHaveBeenCalled()
  expect(harnessComposerBlock(binding())).toBeUndefined()
  expect(
    harnessComposerBlock({ ...binding(), capabilities: { ...binding().capabilities, send: false } }),
  ).toContain('发送')
})
it('refreshes a stored old capability binding before opening the native content', async () => {
  const f = fixture()
  const old = binding()
  old.capabilities.send = false
  f.api.cliworker.ensureHarnessConversation = f.ensure
  await mount(f.node(worker({ harnessConversation: old })))
  expect(f.ensure).toHaveBeenCalledExactlyOnceWith('parent', 'worker')
  expect(f.bindings.get('harness-child')?.capabilities.send).toBe(true)
  expect(f.frame).toHaveBeenCalled()
  expect(f.openSession).not.toHaveBeenCalled()
})
it('keeps independent composer holds and restores a preexisting native block', () => {
  const f = fixture()
  const previous = { reason: '宿主只读' }
  f.services.conversation.blocks.set('harness-child', previous)
  const first = retainHarnessComposerBlock(f.services.conversation, 'harness-child', '准备中')
  const second = retainHarnessComposerBlock(f.services.conversation, 'harness-child', '清理中')
  first()
  expect(f.services.conversation.blocks.set).toHaveBeenLastCalledWith('harness-child', { reason: '清理中' })
  second()
  expect(f.services.conversation.blocks.set).toHaveBeenLastCalledWith('harness-child', previous)
  const idle = retainHarnessComposerBlock(f.services.conversation, 'harness-child')
  idle()
  expect(f.services.conversation.blocks.set).toHaveBeenLastCalledWith('harness-child', previous)
})
it('does not navigate a pending history read or mount a second conversation renderer', async () => {
  const f = fixture()
  let open!: (binding: unknown) => void
  const base = f.retain.getMockImplementation()!
  f.retain.mockImplementationOnce((address, options) => {
    const reference = base(address, options)
    reference.ready = new Promise((resolve) => {
      open = resolve
    })
    return reference
  })
  const result = await mount(f.node())
  expect(f.openSession).not.toHaveBeenCalled()
  expect(result.root.findAllByType('textarea')).toHaveLength(0)
  await act(async () => open({ sessionId: 'harness-child', session: f.references[0].session }))
  expect(f.frame).toHaveBeenCalled()
  expect(f.openSession).not.toHaveBeenCalled()
  expect(result.root.findAllByType('textarea')).toHaveLength(0)
})
it('lists Chinese capability reasons in Worker details without adding composer buttons', async () => {
  const result = await mount(<HarnessCapabilityNotes binding={binding()} />)
  expect(result.root.findAllByType('button')).toHaveLength(0)
  expect(
    result.root.findAllByType('dd').some((reason) => reason.children.join('') === '请使用停止 CLI 等待清理'),
  ).toBe(true)
  expect(result.root.findByProps({ 'aria-label': '原生功能支持范围' }).type).toBe('div')
  expect(JSON.stringify(result.toJSON())).toContain(
    '共享工具、MCP 与技能以当前子 Agent 获准的目录及 CLI 接入能力为准',
  )
})
it('reports only Host-issued capability values instead of enabling features in the Client', async () => {
  const available = binding()
  available.capabilities.tools = true
  const result = await mount(<HarnessCapabilityNotes binding={available} />)
  expect(JSON.stringify(result.toJSON())).toContain('实际回复由当前 CLI Agent 生成')
  expect(result.root.findAllByType('dt').map((item) => item.children.join(''))).not.toContain('工具共享')
  expect(result.root.findAllByType('dt').map((item) => item.children.join(''))).toContain('原生引导')
})
it('explains the real next-step boundary when native steering is supported', async () => {
  const available = binding()
  available.capabilities.steer = true
  available.reasons = {
    ...available.reasons,
    steer: '插话在当前 CLI 运行完成清理后的下一执行步接收，不停止并重启当前运行。',
  }
  const result = await mount(<HarnessCapabilityNotes binding={available} />)
  expect(JSON.stringify(result.toJSON())).toContain(available.reasons.steer)
  expect(result.root.findAllByType('dt').map((item) => item.children.join(''))).not.toContain('原生引导')
})
