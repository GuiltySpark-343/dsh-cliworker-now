import { expect, it, vi } from 'vitest'
import { adoptNativeHarnessLease, createNativeHarnessTools } from '../src/host/native-harness-tools.ts'

// Synthetic bridge binding and tool grant; a real local listener is created.
const binding = { parentSessionId: 'parent', harnessSessionId: 'child', workerId: 'worker', runId: 'run', cli: 'codex' }
const grant = { name: 'read_file', description: '模拟文件工具', inputSchema: { type: 'object' }, execution: 'host' as const }
const open = () =>
  createNativeHarnessTools({ binding, tools: [grant], execute: async () => ({}), authorize: async () => {}, executionReady: true })
const reachable = async (url: string) => {
  try {
    await fetch(url, { method: 'POST', body: '{}', signal: AbortSignal.timeout(2000) })
    return true
  } catch {
    return false
  }
}

it('closes the listening bridge and restores presentation when saving capabilities fails', async () => {
  const lease = await open()
  expect(await reachable(lease.connection.url)).toBe(true)
  const resetPresentation = vi.fn()
  await expect(
    adoptNativeHarnessLease(lease, resetPresentation, () => {
      throw new Error('Simulated storage.save failure')
    }),
  ).rejects.toThrow('Simulated storage.save failure')
  expect(resetPresentation).toHaveBeenCalledOnce()
  expect(await reachable(lease.connection.url)).toBe(false)
})

it('reports both errors when the bridge cannot confirm cleanup after a failed publication', async () => {
  const resetPresentation = vi.fn()
  const failure = adoptNativeHarnessLease(
    { connection: undefined, close: async () => { throw new Error('Simulated close failure') } },
    resetPresentation,
    () => { throw new Error('Simulated changed failure') },
  )
  await expect(failure).rejects.toBeInstanceOf(AggregateError)
  await expect(failure).rejects.toMatchObject({ errors: [{ message: 'Simulated changed failure' }, { message: 'Simulated close failure' }] })
  expect(resetPresentation).toHaveBeenCalledOnce()
})

it('hands ownership to the caller only after publication succeeds', async () => {
  const lease = await open()
  const resetPresentation = vi.fn()
  const adopted = await adoptNativeHarnessLease(lease, resetPresentation, () => {})
  expect(adopted.connection).toBe(lease.connection)
  expect(resetPresentation).not.toHaveBeenCalled()
  expect(await reachable(lease.connection.url)).toBe(true)
  await adopted.close()
  expect(resetPresentation).toHaveBeenCalledOnce()
  expect(await reachable(lease.connection.url)).toBe(false)
})
