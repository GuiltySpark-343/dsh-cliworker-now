import * as react from 'react'
import * as jsx from 'react/jsx-runtime'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import { runInNewContext } from 'node:vm'

/** Capture the installed, unmodified official sidebar entry via plugin apply.
 * The fixture supplies registries only; it does not reproduce its component,
 * phase selection, content factory or fixed Chat view. */
export function nativeSidebarConversation() {
  const require = createRequire(import.meta.url)
  const source = require.resolve('@deepseek-ai/dsh-client-ui-subagent/client', {
    paths: [dirname(require.resolve('@deepseek-ai/dsh/package.json'))],
  })
  const dependencies: Record<string, unknown> = {
    '@deepseek-ai/dsh-client-ui-primitives': {},
    react,
    'react-dom': {},
    'react/jsx-runtime': jsx,
  }
  let plugin: { apply: (ctx: unknown) => void } | undefined
  runInNewContext(readFileSync(source, 'utf8'), {
    window: { __ModuleLoader__: { load: ({ factory }: any) => { plugin = factory((id: string) => dependencies[id]) } } },
  })
  let entry: { options: Record<string, unknown>; component: react.ComponentType<any> } | undefined
  const noop = () => {}
  const cleanup: (() => void)[] = []
  const ctx = {
    sessions: {},
    inject: (_names: string[], run: (scope: unknown) => void) => run(ctx),
    effect: (run: () => unknown) => { const dispose = run(); if (typeof dispose === 'function') cleanup.push(dispose as () => void) },
    locale: { register: () => noop, bind: () => (key: string) => key },
    resources: { register: () => noop },
    sidebarRightTabs: { register: () => noop },
    slots: {
      inject: (name: string, run: () => unknown) => name === 'sidebar.chat.conversation' ? run() : noop,
      register: (options: Record<string, unknown>, component: react.ComponentType<any>) => {
        entry = { options, component }
        return noop
      },
    },
  }
  plugin!.apply(ctx)
  for (const release of cleanup.reverse()) release()
  if (!entry) throw new Error('Installed native sidebar Conversation did not register')
  return entry
}
