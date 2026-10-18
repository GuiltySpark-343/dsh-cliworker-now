import * as stores from '@deepseek-ai/dsh-client-store'
import * as react from 'react'
import * as jsx from 'react/jsx-runtime'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import { runInNewContext } from 'node:vm'

/** Load the installed, unmodified rc.2 component through its public plugin
 * registration. Callers can replace portal surfaces, but never its trigger,
 * option construction, native glyph selection or selection handler. */
export function nativePermissionSelect(primitives: Record<string, unknown>) {
  const require = createRequire(import.meta.url)
  const source = require.resolve('@deepseek-ai/dsh-client-ui-permission-presets/client', {
    paths: [dirname(require.resolve('@deepseek-ai/dsh/package.json'))],
  })
  const dependencies: Record<string, unknown> = {
    '@deepseek-ai/dsh-client-store': stores,
    '@deepseek-ai/dsh-client-ui-primitives': primitives,
    react,
    'react/jsx-runtime': jsx,
  }
  let plugin: { apply: (ctx: unknown) => void } | undefined
  runInNewContext(readFileSync(source, 'utf8'), {
    window: { __ModuleLoader__: { load: ({ factory }: any) => { plugin = factory((id: string) => dependencies[id]) } } },
    AbortController,
    AbortSignal,
  })
  const cleanup: (() => void)[] = []
  let component: react.ComponentType<any> | undefined
  const noop = () => {}
  const connection = { generation: { subscribe: () => noop, getSnapshot: () => undefined } }
  const command = { dismiss: noop, decorate: () => noop }
  plugin!.apply({
    get: (name: string) => name === 'connection' ? connection : command,
    sessions: {},
    effect: (run: () => unknown) => { const dispose = run(); if (typeof dispose === 'function') cleanup.push(dispose as () => void) },
    remote: { $on: () => noop },
    locale: { register: () => noop, bind: () => (key: string) => key },
    configForms: { describe: () => ({}) },
    slots: {
      inject: (name: string, run: () => void) => { if (name === 'conversation.input.permission') run() },
      register: (_options: unknown, native: react.ComponentType<any>) => { component = native; return noop },
    },
  })
  for (const release of cleanup.reverse()) release()
  if (!component) throw new Error('Installed native PermissionSelect did not register')
  return component
}
