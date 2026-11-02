import { useCallback, useRef } from 'react'

/** Scrollbar fade-out delay after the last scroll event. */
export const SCROLLBAR_HIDE_MS = 900
/**
 * Marks whichever area inside the layout is scrolling, so CSS can show its
 * scrollbar only then; timers and the listener end with the element.
 */
export function useScrollingMark() {
  const release = useRef<() => void>()
  return useCallback((element: HTMLElement | null) => {
    release.current?.()
    release.current = undefined
    if (!element) return
    const timers = new Map<HTMLElement, ReturnType<typeof setTimeout>>()
    const onScroll = (event: Event) => {
      const target = event.target as HTMLElement | null
      if (!target?.dataset) return
      target.dataset.scrolling = ''
      clearTimeout(timers.get(target))
      timers.set(
        target,
        setTimeout(() => {
          timers.delete(target)
          delete target.dataset.scrolling
        }, SCROLLBAR_HIDE_MS),
      )
    }
    element.addEventListener('scroll', onScroll, { capture: true, passive: true })
    release.current = () => {
      element.removeEventListener('scroll', onScroll, { capture: true })
      for (const [target, timer] of timers) {
        clearTimeout(timer)
        delete target.dataset.scrolling
      }
    }
  }, [])
}
