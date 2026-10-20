import type { Context } from '@deepseek-ai/cordis'
import type { SlotCore, StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'cliworker.native.sidebar': {
      kind: 'single'
      scope: 'session'
      owner: { composerPresentation?: 'default' | 'main'; commandSource?: string; childImageUploads?: boolean }
    }
  }
}

/**
 * The official child sidebar owns the complete conversation presentation.
 * Register that exact component in our Worker body seat; the renderer supplies
 * its standard hooks from the real child SessionProvider on every render.
 */
export function installHarnessNativeContent(ctx: Pick<Context, 'slots'>): () => void {
  const ledger: Pick<SlotCore, 'entriesOfSlot' | 'subscribe'> = ctx.slots
  return ctx.slots.inject('cliworker.native.sidebar', () => {
    let disposed = false
    let current: StoredEntry | undefined
    let release: (() => void) | undefined
    const sync = () => {
      if (disposed) return
      const next = ledger.entriesOfSlot('sidebar.chat.conversation')[0]
      if (next === current) return
      release?.()
      release = undefined
      current = undefined
      if (!next) return
      // rc.2's official entry renders the public content factory and declares
      // no child slots. A changed ownership contract must not be transplanted.
      if (Object.keys(next.children ?? {}).length)
        throw new Error('Harness 原生侧栏对话入口的 Slot 合同已变更')
      release = ctx.slots.register({
        name: 'cliworker.native.sidebar',
        ...next.options,
        ...(next.inject && { inject: next.inject }),
        ...(next.store && { store: next.store }),
        ...(next.locale && { locale: next.locale }),
      } as never, next.component as never)
      current = next
    }
    const unsubscribe = ledger.subscribe('sidebar.chat.conversation', sync)
    const dispose = () => {
      if (disposed) return
      disposed = true
      unsubscribe()
      release?.()
      release = undefined
      current = undefined
    }
    try {
      sync()
    } catch (error) {
      dispose()
      throw error
    }
    return dispose
  })
}
