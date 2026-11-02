import { createElement, useMemo, type ComponentType, type ReactNode } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { PropsRuntime, StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'
import { CLI_IDS } from '../shared/types.ts'
import { useHarnessSessionBinding, type HarnessBindingRegistry } from './harness-binding-registry.ts'
import { useT } from './i18n.ts'

// Chat owns this optional keyed seat. Keep its native renderer, injected hooks,
// grouping and owner props intact without importing private Chat components.
export type ReasoningRecordsProps = PropsRuntime<'conversation.session.header.utilities'> & {
  t: (key: string, ...args: unknown[]) => string
  renderSlot: (name: string, owner: unknown, ...args: unknown[]) => ReactNode
}
type NativeAssistant = ComponentType<ReasoningRecordsProps>

/** The native ReasoningRow stays INSIDE its Turn process and in tool-step order.
 * Only its label and expanded body's scrolling change. Native public blocks own
 * content, streaming previews, disclosure/reset state and historical persistence.
 */
export function HarnessReasoningRecords({ Native, bindings, props }: {
  Native: NativeAssistant; bindings: HarnessBindingRegistry; props: ReasoningRecordsProps
}) {
  const binding = useHarnessSessionBinding(bindings, props.sessionId)
  const address = props.useSession(session => session.subagent?.address)
  const cli = binding?.cliSelection?.cli
  const enabled = !!binding?.workerId && binding.mode === 'continuable'
    && !!cli && CLI_IDS.some(id => id === cli)
    && binding.sessionId === props.sessionId && binding.parentSessionId !== props.sessionId
    && address?.childSessionId === binding.sessionId && address.parentSessionId === binding.parentSessionId
  const own = useT()
  const t = useMemo(() => (key: string, ...args: unknown[]) =>
    key === 'message.think' ? own('思考记录') : props.t(key, ...args), [props.t, own])
  const renderSlot = useMemo(() => (name: string, owner: unknown, ...args: unknown[]) => {
    const content = props.renderSlot(name, owner, ...args)
    return name === 'conversation.chat.reasoning.body'
      ? <div className="cwn-reasoning-records-body" data-reasoning-records role="region" aria-label={own('思考记录')}>{content}</div>
      : content
  }, [props.renderSlot])
  return createElement(Native, enabled ? { ...props, t, renderSlot } : props)
}

export function installHarnessReasoningRecords(ctx: Pick<Context, 'slots'>, bindings: HarnessBindingRegistry): () => void {
  const name = 'conversation.chat.node'
  return ctx.slots.inject(name as never, () => {
    let original: StoredEntry | undefined, own: StoredEntry | undefined, release: (() => void) | undefined
    let updating = false, disposed = false
    const sync = () => {
      if (updating || disposed) return
      const next = ctx.slots.entries(name as never).find(entry => entry !== own && entry.options.key === 'assistant-step')
      if (next === original) return
      updating = true
      try {
        release?.()
        release = undefined
        own = undefined
        original = next
        if (!next) return
        const Native = next.component as NativeAssistant
        const Bound = (props: ReasoningRecordsProps) => <HarnessReasoningRecords Native={Native} props={props} bindings={bindings} />
        const unregister = ctx.slots.register({
          name, key: 'assistant-step', priority: (next.options.priority ?? 0) - 1,
          ...(next.inject && { inject: next.inject }), ...(next.locale && { locale: next.locale }),
          ...(next.store && { store: next.store }), ...(next.select && { select: next.select }),
        } as never, Bound as never)
        own = ctx.slots.entries(name as never).find(entry => entry.component === Bound)
        // Borrow the native render kit; its original entry alone owns the child
        // declarations. Dropping borrowed metadata before disposal preserves them.
        const shadow = own
        if (shadow && next.children) shadow.children = next.children
        release = () => {
          if (shadow && shadow.children === next.children) delete shadow.children
          unregister()
        }
      } finally { updating = false }
    }
    const unsubscribe = ctx.slots.subscribe(name as never, sync)
    const dispose = () => {
      if (disposed) return
      disposed = true
      unsubscribe()
      release?.()
    }
    try { sync() } catch (error) { dispose(); throw error }
    return dispose
  })
}

export const reasoningRecordsStyles = `
.cwn-reasoning-records-body{min-width:0;max-height:min(400px,50vh);overflow:auto;overscroll-behavior:contain;overflow-wrap:anywhere;scrollbar-gutter:stable}
`
