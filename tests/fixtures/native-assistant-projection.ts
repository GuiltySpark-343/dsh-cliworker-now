import * as React from 'react'
import * as ReactJsx from 'react/jsx-runtime'
import * as ReactDom from 'react-dom'
import * as Cordis from '@deepseek-ai/cordis'
import * as Stores from '@deepseek-ai/dsh-client-store'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import { selectBuildDependencies } from '../../scripts/build-dependencies.mjs'

/** Capture the installed, unmodified official assistant Definition. The
 * fixture stops registration immediately after capture, before any UI/remote
 * setup; the native final-node producer itself remains the real package code.
 */
export function nativeAssistantProjection(blocks: readonly { type: 'text' | 'reasoning'; text: string }[]) {
  const sdk = selectBuildDependencies(resolve('.'), {})
  const requireDsh = createRequire(sdk.require.resolve('@deepseek-ai/dsh/package.json'))
  const source = requireDsh.resolve('@deepseek-ai/dsh-client-ui-chat/client')
  const dependencies: Record<string, unknown> = {
    react: React, 'react/jsx-runtime': ReactJsx, 'react-dom': ReactDom,
    '@deepseek-ai/cordis': Cordis, '@deepseek-ai/dsh-client-store': Stores,
    '@deepseek-ai/dsh-client-ui-primitives': new Proxy({}, { get: () => () => null }),
  }
  let plugin: any, definition: any
  runInNewContext(readFileSync(source, 'utf8'), {
    window: { __ModuleLoader__: { load: ({ factory }: any) => { plugin = factory((id: string) => dependencies[id]) } } },
    AbortController, AbortSignal,
  })
  const captured = new Error('Captured official assistant Definition')
  try {
    plugin.apply({ effect: () => () => {}, uiConversation: { events: { register(value: any) {
      if (value.kind === 'assistant-step') { definition = value; throw captured }
    } } } })
  } catch (error) { if (error !== captured) throw error }
  if (!definition) throw new Error('Official assistant Definition was not registered')
  const start = { event: { type: 'step/start', seq: 2, time: 1000, data: { turn: 1, step: 1 } } }
  const message = { event: {
    type: 'assistant/message', seq: 5, time: 2000, surfaceOp: 'append', data: {
      turn: 1, step: 1, message: {
        role: 'assistant', id: 'message-SIMULATED', content: blocks,
        source: { kind: 'model', provider: 'cliworker-native', model: 'worker/worker' },
      }, stream: [],
    },
  } }
  const context: any = { start, matches: [start, message], current: new Map() }
  context.state = definition.start(context, start, {})
  context.state = definition.update(context, message, {})
  return definition.buildLocationData(context, 'step', undefined).value
}
