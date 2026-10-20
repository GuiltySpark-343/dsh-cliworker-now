import type { Context } from '@deepseek-ai/cordis'
import type { StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'

/** Borrow a native cell's metadata, leaving its child declarations with the owner. */
export function shadowHarnessSlot(
  slots: Context['slots'],
  name: Parameters<Context['slots']['entries']>[0],
  id: string | undefined,
  replace: (original: StoredEntry) => Pick<StoredEntry, 'component' | 'inject'>,
) {
  let original: StoredEntry | undefined, own: StoredEntry | undefined
  let unregister: (() => void) | undefined
  let updating = false
  const sync = () => {
    if (updating) return
    const next = slots
      .entries(name)
      .filter((entry) => entry !== own && entry.options.id === id)
      .sort((a, b) => (a.options.priority ?? 0) - (b.options.priority ?? 0))[0]
    if (next === original) return
    updating = true
    unregister?.()
    own = undefined
    original = next
    if (next) {
      const replacement = replace(next)
      const dispose = slots.register(
        {
          ...next.options,
          name,
          priority: (next.options.priority ?? 0) - 1,
          ...(next.locale ? { locale: next.locale } : {}),
          ...(next.store ? { store: next.store } : {}),
          ...(replacement.inject ? { inject: replacement.inject } : {}),
        } as never,
        replacement.component as never,
      )
      const shadow = slots.entries(name).find((entry) => entry.component === replacement.component)
      if (shadow && next.children) shadow.children = next.children
      own = shadow
      unregister = () => {
        if (shadow && shadow.children === next.children) delete shadow.children
        dispose()
      }
    } else unregister = undefined
    updating = false
  }
  const off = slots.subscribe(name, sync)
  sync()
  return () => {
    updating = true
    off()
    unregister?.()
  }
}
