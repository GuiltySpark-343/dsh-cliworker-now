import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { SCROLLBAR_HIDE_MS, useScrollingMark } from '../src/client/scrolling-mark.ts'

// Simulated DOM: plain EventTargets with a dataset stand in for the dialog's scroll areas.
afterEach(() => vi.useRealTimers())
type FakeElement = EventTarget & { dataset: Record<string, string> }
const element = () => Object.assign(new EventTarget(), { dataset: {} as Record<string, string> }) as FakeElement
function Layout() {
  return createElement('div', { className: 'layout', ref: useScrollingMark() })
}

it('shows a scrollbar only while its area scrolls, then hides it and cleans up on unmount', () => {
  vi.useFakeTimers()
  const layout = element()
  const pane = element()
  const renderer = create(createElement(Layout), { createNodeMock: () => layout })
  const scroll = (target: FakeElement) => {
    // A capture listener on the layout sees scrolls of nested areas.
    const event = new Event('scroll')
    Object.defineProperty(event, 'target', { value: target })
    layout.dispatchEvent(event)
  }
  scroll(pane)
  expect(pane.dataset.scrolling).toBe('')
  act(() => vi.advanceTimersByTime(SCROLLBAR_HIDE_MS - 1))
  scroll(pane)
  act(() => vi.advanceTimersByTime(SCROLLBAR_HIDE_MS - 1))
  expect(pane.dataset.scrolling).toBe('')
  act(() => vi.advanceTimersByTime(1))
  expect(pane.dataset).not.toHaveProperty('scrolling')

  scroll(pane)
  act(() => renderer.unmount())
  expect(pane.dataset).not.toHaveProperty('scrolling')
  scroll(pane)
  expect(pane.dataset).not.toHaveProperty('scrolling')
  expect(vi.getTimerCount()).toBe(0)
})
