import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { WorkerRuntime } from '../src/host/runtime.ts'
import { WorkerStorage } from '../src/host/storage.ts'
import { DEFAULT_CONFIG, type ProcessBackend } from '../src/host/process.ts'
import { OWN_ACCOUNT_BUSY } from '../src/host/own-account-lease.mjs'
import type { Worker } from '../src/shared/types.ts'

// Synthetic private state only. The busy account is simulated at run authorization;
// executable resolution then fails on purpose, so no CLI is ever started.
const busy = vi.hoisted(() => ({ until: 0, calls: [] as string[] }))
vi.mock('../src/host/agy-context.ts', () => ({ AgyContextReader: class { read() {} } }))
vi.mock('../src/host/cli-account-binding.ts', () => ({ readCliAccountBinding: async () => 'synthetic-account' }))
vi.mock('../src/host/authorized-catalog.ts', async (actual) => ({
  ...(await actual<typeof import('../src/host/authorized-catalog.ts')>()),
  authorizeSelection: async (preference: { cli: string }) => {
    busy.calls.push(preference.cli)
    if (preference.cli === 'omp' && Date.now() < busy.until) throw new Error(OWN_ACCOUNT_BUSY)
    return { binding: 'synthetic-account', preference }
  },
}))
const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
  busy.until = 0
  busy.calls = []
})
function fixture(maxConcurrent: number) {
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'cwn-account-busy-')))
  cleanup.push(() => rmSync(project, { recursive: true, force: true }))
  const storage = new WorkerStorage(join(project, 'private-state'))
  const backend: ProcessBackend = {
    resolveExecutable: vi.fn(async () => {
      throw new Error('Synthetic stop after authorization')
    }),
    spawn: vi.fn(() => {
      throw new Error('No CLI launch is allowed in this fixture')
    }),
  }
  const runtime = new WorkerRuntime(storage, backend, { ...DEFAULT_CONFIG, maxConcurrent })
  cleanup.push(() => runtime.close())
  const submit = (cli: 'omp' | 'antigravity') => {
    const worker: Worker = {
      id: randomUUID(), runId: randomUUID(), parentSessionId: 'synthetic-parent', project,
      title: `Synthetic ${cli} task`,
      preference: { cli, model: 'synthetic-model', effort: 'default' },
      conversationId: 'synthetic-cli-session', mode: 'plan', status: 'completed',
      createdAt: '2026-10-25T00:00:00.000Z', updatedAt: '2026-10-25T00:00:00.000Z',
    }
    storage.save(worker)
    storage.bindAccount(worker.id, 'synthetic-account')
    runtime.submit(worker.parentSessionId, project, worker.title, 'synthetic continuation', worker.preference,
      worker.mode, worker.id, undefined, 'synthetic-account')
    return worker.id
  }
  return { storage, backend, runtime, submit, events: (id: string) => storage.history(id).map((event) => event.text) }
}

it('a busy OMP account waits in the queue without a slot, then runs instead of failing', async () => {
  const f = fixture(1)
  busy.until = Date.now() + 1500
  const omp = f.submit('omp')
  await vi.waitFor(() => expect(f.events(omp)).toContain('账号正被另一个任务使用，排队等待'))
  expect(f.storage.workers.get(omp)?.status).toBe('queued')
  // The only slot is free for other work while OMP waits for its account.
  const other = f.submit('antigravity')
  await vi.waitFor(() => expect(f.storage.workers.get(other)?.status).toBe('failed'))
  expect(f.storage.workers.get(omp)?.status).toBe('queued')
  // Once the account is free, the waiting turn is authorized afresh and continues.
  await vi.waitFor(() => expect(f.storage.workers.get(omp)?.status).toBe('failed'), { timeout: 6000 })
  expect(f.storage.workers.get(omp)?.error).toContain('Synthetic stop after authorization')
  expect(f.storage.workers.get(omp)?.error).not.toContain(OWN_ACCOUNT_BUSY)
  expect(f.events(omp).filter((text) => text === '账号正被另一个任务使用，排队等待')).toHaveLength(1)
  expect(f.backend.spawn).not.toHaveBeenCalled()
})

it('a stop while waiting for the account ends the queued turn as stopped, with no further attempt', async () => {
  const f = fixture(2)
  busy.until = Date.now() + 60_000
  const omp = f.submit('omp')
  await vi.waitFor(() => expect(f.events(omp)).toContain('账号正被另一个任务使用，排队等待'))
  expect(f.storage.workers.get(omp)?.status).toBe('queued')
  await f.runtime.stop('synthetic-parent', omp)
  expect(f.storage.workers.get(omp)).toMatchObject({ status: 'interrupted', interruptionReason: 'user' })
  const attempts = busy.calls.length
  await new Promise((resolve) => setTimeout(resolve, 2500))
  expect(busy.calls).toHaveLength(attempts)
  expect(f.backend.resolveExecutable).not.toHaveBeenCalled()
})
