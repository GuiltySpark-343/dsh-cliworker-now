import { forwardRef, useImperativeHandle, useLayoutEffect, type HTMLAttributes } from 'react'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { GuardedNativeControl } from './harness-dom-guard.ts'

type AnchorProps = Pick<
  HTMLAttributes<HTMLElement>,
  'onMouseEnter' | 'onMouseLeave' | 'onFocus' | 'onBlur' | 'onClick'
> & { element: HTMLElement }
export function bindHarnessTooltipAnchor(
  element: HTMLElement,
  handlers: Omit<AnchorProps, 'element'>,
): () => void {
  const bindings = [
    ['mouseover', handlers.onMouseEnter],
    ['mouseout', handlers.onMouseLeave],
    ['focus', handlers.onFocus],
    ['blur', handlers.onBlur],
    ['click', handlers.onClick],
  ] as const
  const removers = bindings.flatMap(([eventName, handler]) => {
    if (!handler) return []
    const listener = (event: Event) => {
      if (
        (eventName === 'mouseover' || eventName === 'mouseout') &&
        (event as MouseEvent).relatedTarget &&
        element.contains((event as MouseEvent).relatedTarget as Node)
      )
        return
      if (eventName === 'mouseover' || eventName === 'mouseout') event.stopPropagation()
      handler(event as never)
    }
    element.addEventListener(eventName, listener, true)
    return [() => element.removeEventListener(eventName, listener, true)]
  })
  return () => {
    for (const remove of removers) remove()
  }
}
/** Bind the public Tooltip primitive to an existing native element without moving or rendering it. */
const ExistingNativeAnchor = forwardRef<HTMLElement, AnchorProps>(function ExistingNativeAnchor(
  { element, ...handlers },
  ref,
) {
  useImperativeHandle(ref, () => element, [element])
  useLayoutEffect(
    () => bindHarnessTooltipAnchor(element, handlers),
    [
      element,
      handlers.onMouseEnter,
      handlers.onMouseLeave,
      handlers.onFocus,
      handlers.onBlur,
      handlers.onClick,
    ],
  )
  return null
})

export function HarnessNativeTooltips({ targets }: { targets: readonly Pick<GuardedNativeControl, 'element' | 'reason'>[] }) {
  return (
    <>
      {targets.map(({ element, reason }, index) => (
        <Tooltip key={index} label={reason} side="top" portal>
          <ExistingNativeAnchor element={element} />
        </Tooltip>
      ))}
    </>
  )
}
