import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { WorkerCard } from '../src/client/worker-card.tsx'
import { setLanguagePreference } from '../src/client/i18n.ts'
import type { Worker } from '../src/shared/types.ts'

// Explicit simulation: host primitives are stand-ins.
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Button: ({ children, onClick, disabled }: any) => createElement('button', { onClick, disabled }, children),
  Menu: ({ anchor }: any) => anchor,
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
const card = (target: Worker) =>
  render(
    createElement(WorkerCard, {
      worker: target,
      collapsed: false,
      unavailable: false,
      busy: false,
      onOpen: vi.fn(),
      onManage: vi.fn(),
    }),
  )

it.each([
  ['an idle copy', worker({ isolation: { state: 'ready', path: '/simulation/copy' } })],
  ['a running copy', worker({ status: 'running', isolation: { state: 'ready', path: '/simulation/copy' } })],
  ['a conflict', worker({ isolation: { state: 'conflict', path: '/c', conflicts: [{ path: 'a.ts', reason: 'x' }] } })],
  ['a queued notice', worker({ status: 'queued', isolationNotice: '项目文件数超过隔离副本上限；已改为排队' })],
])('keeps the task card free of copy status and merge buttons for %s', (_name, target) => {
  setLanguagePreference('en')
  const view = card(target)
  for (const text of ['隔离副本', '排队', 'isolated', 'Merge', 'Discard']) expect(view.text()).not.toContain(text)
  expect(view.button('合并')).toBeUndefined()
  expect(view.button('丢弃')).toBeUndefined()
})
