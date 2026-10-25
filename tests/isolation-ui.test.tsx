import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { WorkerCard } from '../src/client/worker-card.tsx'
import { IsolationDialog } from '../src/client/isolation-dialog.tsx'
import type { API } from '../src/client/workers.ts'
import { setLanguagePreference } from '../src/client/i18n.ts'
import type { Worker } from '../src/shared/types.ts'

// Explicit simulation: host primitives are stand-ins and the Remote calls are fakes.
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Button: ({ children, onClick, disabled }: any) => createElement('button', { onClick, disabled }, children),
  Menu: ({ anchor }: any) => anchor,
  Modal: ({ open, title, children }: any) =>
    open ? createElement('section', { role: 'dialog', 'aria-label': title }, children) : null,
  StateDot: () => createElement('svg'),
}))
vi.mock('../src/client/name-copy.tsx', () => ({ NameCopy: ({ name }: any) => createElement('span', null, name) }))

const renderers: ReactTestRenderer[] = []
afterEach(() => {
  for (const renderer of renderers.splice(0)) act(() => renderer.unmount())
  setLanguagePreference('zh')
})
const worker = (patch: Partial<Worker> = {}): Worker => ({
  id: '00000000-0000-4000-8000-000000000001',
  parentSessionId: 'simulation-parent',
  project: '/simulation/project',
  title: '模拟任务',
  agentName: 'ZCode-1',
  preference: { cli: 'zcode', model: 'simulation-model', effort: 'default' },
  mode: 'accept-edits',
  status: 'completed',
  createdAt: '2026-10-25T00:00:00.000Z',
  updatedAt: '2026-10-25T00:00:00.000Z',
  runId: '00000000-0000-4000-8000-000000000002',
  ...patch,
})
function render(element: ReturnType<typeof createElement>) {
  let renderer!: ReactTestRenderer
  act(() => {
    renderer = create(element)
  })
  renderers.push(renderer)
  const text = () => JSON.stringify(renderer.toJSON())
  const button = (label: string) => renderer.root.findAllByType('button').find((b) => b.children.includes(label))
  return { renderer, text, button }
}
const card = (target: Worker, onIsolation = vi.fn()) =>
  render(
    createElement(WorkerCard, {
      worker: target,
      collapsed: false,
      unavailable: false,
      busy: false,
      onOpen: vi.fn(),
      onManage: vi.fn(),
      onIsolation,
    }),
  )

it('offers merge and discard only for an idle Worker with a copy', () => {
  const onIsolation = vi.fn()
  const idle = card(worker({ isolation: { state: 'ready', path: '/simulation/copy' } }), onIsolation)
  expect(idle.text()).toContain('隔离副本待合并')
  act(() => idle.button('合并')!.props.onClick())
  act(() => idle.button('丢弃')!.props.onClick())
  expect(onIsolation.mock.calls).toEqual([['merge'], ['discard']])

  const running = card(worker({ status: 'running', isolation: { state: 'ready', path: '/simulation/copy' } }))
  expect(running.text()).toContain('在隔离副本中运行')
  expect(running.button('合并')).toBeUndefined()

  const conflict = card(
    worker({ isolation: { state: 'conflict', path: '/c', conflicts: [{ path: 'a.ts', reason: 'x' }] } }),
  )
  expect(conflict.text()).toContain('合并冲突：1 个文件，项目未改动')
  expect(conflict.button('合并')).toBeDefined()

  const released = card(worker({ isolation: { state: 'released', path: '/c' } }))
  expect(released.button('合并')).toBeUndefined()
  expect(released.text()).not.toContain('隔离副本')
})

it('shows the real reason a queued task did not get a copy', () => {
  const queued = card(worker({ status: 'queued', isolationNotice: '项目文件数超过隔离副本上限；已改为排队' }))
  expect(queued.text()).toContain('项目文件数超过隔离副本上限')
  expect(queued.button('合并')).toBeUndefined()
})

it('merges only after the explicit button and lists conflicts with the copy location', async () => {
  const mergeIsolation = vi.fn(async () => ({
    ok: true,
    value: JSON.stringify({
      status: 'conflict',
      copy: '/simulation/copy',
      conflicts: [{ path: 'src/a.ts', reason: '两边改动了相同或相邻的行' }],
    }),
  }))
  const api = { cliworker: { mergeIsolation } } as unknown as API
  const dialog = render(
    createElement(IsolationDialog, { api, sessionId: 'simulation-parent', worker: worker(), action: 'merge', onClose: vi.fn() }),
  )
  expect(mergeIsolation).not.toHaveBeenCalled()
  expect(dialog.text()).toContain('不会创建提交')
  await act(async () => dialog.button('合并')!.props.onClick())
  expect(mergeIsolation).toHaveBeenCalledWith('simulation-parent', worker().id, expect.any(AbortSignal))
  expect(dialog.text()).toContain('项目没有任何改动')
  expect(dialog.text()).toContain('src/a.ts')
  expect(dialog.text()).toContain('/simulation/copy')
})

it('discards only after confirmation and closes once the Host reports the copy is gone', async () => {
  const discardIsolation = vi.fn(async () => ({ ok: true, value: undefined }))
  const onClose = vi.fn()
  const api = { cliworker: { discardIsolation } } as unknown as API
  const dialog = render(
    createElement(IsolationDialog, { api, sessionId: 'simulation-parent', worker: worker(), action: 'discard', onClose }),
  )
  expect(dialog.text()).toContain('永久删除')
  expect(discardIsolation).not.toHaveBeenCalled()
  await act(async () => dialog.button('丢弃')!.props.onClick())
  expect(discardIsolation).toHaveBeenCalledTimes(1)
  expect(onClose).toHaveBeenCalledTimes(1)
})

it('shows the card, Host notices and conflict reasons in English when the plugin language is English', async () => {
  setLanguagePreference('en')
  const ready = card(worker({ isolation: { state: 'ready', path: '/simulation/copy' } }))
  expect(ready.text()).toContain('Isolated copy ready to merge')
  expect(ready.button('Merge')).toBeDefined()
  expect(ready.button('Discard')).toBeDefined()
  const queued = card(
    worker({ status: 'queued', isolationNotice: '项目文件数超过隔离副本上限（20000 个）；已改为排队，等待主目录空闲' }),
  )
  expect(queued.text()).toContain('queued instead until the main folder is free')
  const mergeIsolation = vi.fn(async () => ({
    ok: true,
    value: JSON.stringify({
      status: 'conflict',
      copy: '/simulation/copy',
      conflicts: [{ path: 'src/a.ts', reason: '两边改动了相同或相邻的行' }],
    }),
  }))
  const api = { cliworker: { mergeIsolation } } as unknown as API
  const dialog = render(
    createElement(IsolationDialog, { api, sessionId: 'simulation-parent', worker: worker(), action: 'merge', onClose: vi.fn() }),
  )
  expect(dialog.text()).toContain('no commit is created')
  await act(async () => dialog.button('Merge')!.props.onClick())
  expect(dialog.text()).toContain('src/a.ts — Both sides changed the same or adjacent lines')
  expect(dialog.text()).not.toMatch(/[\u4e00-\u9fff]/)
})
