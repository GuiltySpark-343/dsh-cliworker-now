import { expect, it, vi } from 'vitest'
import { installHarnessModelGuard, withinCliTool } from '../src/host/harness-model-guard.ts'
import type { Context } from '@deepseek-ai/cordis'

it('blocks unattributed auxiliary model calls from CLI tools without blocking ordinary DSH calls', async () => {
  let listener: any
  const dispose = vi.fn()
  const context = {
    on: (_name: string, callback: unknown) => {
      listener = callback
      return dispose
    },
  } as unknown as Context
  expect(installHarnessModelGuard(context)).toBe(dispose)
  const backend = vi.fn(async function* () {
    yield { type: 'finish', reason: { kind: 'stop' } }
  })
  const drain = async () => {
    for await (const _chunk of listener({}, backend)) {
      /* synthetic stream */
    }
  }
  await expect(
    withinCliTool('current-run', async () => {
      await Promise.resolve()
      await drain()
    }),
  ).rejects.toThrow('禁止 DSH 模型 API')
  expect(backend).not.toHaveBeenCalled()
  await drain()
  expect(backend).toHaveBeenCalledOnce()
})
