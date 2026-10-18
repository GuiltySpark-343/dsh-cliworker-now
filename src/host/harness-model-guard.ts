import { AsyncLocalStorage } from 'node:async_hooks'
import type { Context } from '@deepseek-ai/cordis'

const executions = new AsyncLocalStorage<string>()
/** Retains attribution for model-powered tools that omit sessionId and purpose. */
export function withinCliTool<T>(runId: string, execute: () => Promise<T>): Promise<T> {
  return executions.run(runId, execute)
}
export function installHarnessModelGuard(ctx: Context): () => void {
  return ctx.on(
    'llm/stream',
    async function* (_options, next) {
      if (executions.getStore())
        throw new Error('此工具需要额外模型生成，尚未接入 CLI；已禁止 DSH 模型 API 回退')
      yield* next()
    },
    { global: true, prepend: true },
  )
}
