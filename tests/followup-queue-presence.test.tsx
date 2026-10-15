import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { FollowupQueuePresence } from '../src/client/followup-queue-presence.tsx'
import type { QueuedFollowup } from '../src/shared/types.ts'

const views: ReactTestRenderer[] = []
afterEach(async () => {
  for (const view of views.splice(0)) await act(async () => view.unmount())
  vi.useRealTimers()
  vi.unstubAllGlobals()
})
const item = (id: string, prompt = `模拟消息 ${id}`): QueuedFollowup => ({
  id,
  prompt,
  state: 'pending',
  createdAt: '2026-10-15T12:00:00Z',
})
const props = (items: QueuedFollowup[], scopeKey = 'worker-a') => ({
  scopeKey,
  items,
  expanded: true,
  bodyId: 'synthetic-queue',
  heading: (count: number) => <span>待发送 · {count}</span>,
  renderItem: (message: QueuedFollowup) => <button>{message.prompt}</button>,
})
async function fixture(items: QueuedFollowup[]) {
  let view!: ReactTestRenderer
  await act(async () => {
    view = create(<FollowupQueuePresence {...props(items)} />)
  })
  views.push(view)
  return {
    view,
    update: async (items: QueuedFollowup[], scopeKey?: string) => {
      await act(async () => view.update(<FollowupQueuePresence {...props(items, scopeKey)} />))
    },
    ids: () => view.root.findAllByType('li').map((row) => row.props['data-queue-id']),
    row: (id: string) => view.root.findByProps({ 'data-queue-id': id }),
  }
}

it('keeps the exiting row in place, disables its interactions and removes it once without restarting on snapshots', async () => {
  vi.useFakeTimers()
  const f = await fixture([item('a'), item('b'), item('c')])
  await f.update([item('a'), item('c')])
  expect(f.ids()).toEqual(['a', 'b', 'c'])
  expect(f.row('b').props).toMatchObject({ 'data-exiting': true, 'aria-hidden': true, inert: '' })
  expect(f.row('c').props['data-exiting']).toBe(false)
  await act(async () => vi.advanceTimersByTime(150))
  await f.update([item('a'), item('c')])
  await act(async () => vi.advanceTimersByTime(110))
  expect(f.ids()).toEqual(['a', 'c'])
  expect(vi.getTimerCount()).toBe(0)
})

it('retains the final shell and heading during exit, then removes the empty queue', async () => {
  vi.useFakeTimers()
  const f = await fixture([item('a')])
  await f.update([])
  expect(f.view.root.findByProps({ 'aria-label': '待发送消息' }).props).toMatchObject({
    'aria-hidden': true,
    inert: '',
  })
  expect(f.view.root.findByType('span').children.join('')).toBe('待发送 · 1')
  await act(async () => vi.advanceTimersByTime(260))
  expect(f.view.toJSON()).toBeNull()
})

it('cancels removal when the same queued identity returns after a failed interruption', async () => {
  vi.useFakeTimers()
  const f = await fixture([item('a'), item('b')])
  await f.update([item('b')])
  await act(async () => vi.advanceTimersByTime(120))
  await f.update([{ ...item('a'), state: 'paused', pauseReason: '模拟拒绝' }, item('b')])
  expect(f.row('a').props['data-exiting']).toBe(false)
  expect(f.row('a').props.inert).toBeUndefined()
  await act(async () => vi.advanceTimersByTime(300))
  expect(f.ids()).toEqual(['a', 'b'])
  expect(vi.getTimerCount()).toBe(0)
})

it('does not carry an exiting row or its timer into another worker', async () => {
  vi.useFakeTimers()
  const f = await fixture([item('a')])
  await f.update([])
  expect(vi.getTimerCount()).toBe(1)
  await f.update([item('other')], 'worker-b')
  expect(f.ids()).toEqual(['other'])
  expect(vi.getTimerCount()).toBe(0)
  await act(async () => vi.advanceTimersByTime(300))
  expect(f.ids()).toEqual(['other'])
})

it('removes rows immediately with reduced motion and releases the preference listener', async () => {
  vi.useFakeTimers()
  const remove = vi.fn()
  vi.stubGlobal('window', {
    matchMedia: () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: remove }),
  })
  const f = await fixture([item('a'), item('b')])
  await f.update([item('b')])
  expect(f.ids()).toEqual(['b'])
  expect(vi.getTimerCount()).toBe(0)
  await f.update([])
  expect(f.view.toJSON()).toBeNull()
  await act(async () => f.view.unmount())
  expect(remove).toHaveBeenCalledWith('change', expect.any(Function))
})

it('clears pending removal when the component unmounts', async () => {
  vi.useFakeTimers()
  const f = await fixture([item('a')])
  await f.update([])
  expect(vi.getTimerCount()).toBe(1)
  await act(async () => f.view.unmount())
  expect(vi.getTimerCount()).toBe(0)
})
