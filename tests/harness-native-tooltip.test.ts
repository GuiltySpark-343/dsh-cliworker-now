import { expect, it, vi } from 'vitest'
import { bindHarnessTooltipAnchor } from '../src/client/harness-native-tooltip.tsx'
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({ Tooltip: () => null }))

// SIMULATION: native Tooltip's injected handlers are bound to an already-owned DOM anchor.
it('attaches hover and focus to the existing node without inserting or moving any native element', () => {
  const listeners = new Map<string, EventListener>()
  const inner = {}
  const element = {
    contains: (target: unknown) => target === inner,
    addEventListener: (name: string, fn: EventListener) => listeners.set(name, fn),
    removeEventListener: (name: string) => listeners.delete(name),
  } as unknown as HTMLElement
  const enter = vi.fn(),
    leave = vi.fn(),
    focus = vi.fn(),
    blur = vi.fn()
  const dispose = bindHarnessTooltipAnchor(element, {
    onMouseEnter: enter,
    onMouseLeave: leave,
    onFocus: focus,
    onBlur: blur,
  })
  const event = { relatedTarget: null, stopPropagation: vi.fn() }
  listeners.get('mouseover')!(event as unknown as Event)
  listeners.get('focus')!(event as unknown as Event)
  expect(enter).toHaveBeenCalledOnce()
  expect(focus).toHaveBeenCalledOnce()
  expect(event.stopPropagation).toHaveBeenCalledOnce()
  listeners.get('mouseover')!({ ...event, relatedTarget: inner } as unknown as Event)
  expect(enter).toHaveBeenCalledOnce()
  listeners.get('mouseout')!(event as unknown as Event)
  listeners.get('blur')!(event as unknown as Event)
  expect(leave).toHaveBeenCalledOnce()
  expect(blur).toHaveBeenCalledOnce()
  dispose()
  expect(listeners.size).toBe(0)
  expect(Object.keys(element).sort()).toEqual(['addEventListener', 'contains', 'removeEventListener'])
})
