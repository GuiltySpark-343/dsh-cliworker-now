import { createElement, useSyncExternalStore, type ComponentType } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { HarnessBindingRegistry } from './harness-binding-registry.ts'
import { HARNESS_COMMAND_SOURCE } from './harness-native-commands.ts'
import { shadowHarnessSlot } from './harness-slot-shadow.ts'

/** All native Conversation occurrences share this public composer seat.
 * The shipped runtime's commandSource owner prop selects the existing menu
 * controller; ordinary Sessions keep their original source and injection. */
export function installHarnessNativeCommandMenu(
  ctx: Pick<Context, 'slots'>,
  bindings: HarnessBindingRegistry,
): () => void {
  return shadowHarnessSlot(ctx.slots, 'conversation.composer.bar', undefined, (original) => {
    const Native = original.component as ComponentType<Record<string, unknown>>
    function CommandMenu(props: Record<string, unknown> & { sessionId?: string }) {
      const binding = useSyncExternalStore(bindings.subscribe, () =>
        props.sessionId ? bindings.get(props.sessionId) : undefined,
      )
      return createElement(Native, binding?.workerId
        ? { ...props, commandSource: HARNESS_COMMAND_SOURCE }
        : props)
    }
    return { component: CommandMenu, inject: original.inject }
  })
}
