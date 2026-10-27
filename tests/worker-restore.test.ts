import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { WorkerStorage } from '../src/host/storage.ts'
import { WorkerRuntime } from './fixtures/legacy-runtime.ts'
import { DEFAULT_CONFIG, type ProcessBackend } from '../src/host/process.ts'
import type { Worker } from '../src/shared/types.ts'

// Synthetic Workers only; restoring never spawns a CLI.
const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close()
})
const backend = {
  resolveExecutable: async () => '/synthetic/cli',
  spawn: () => {
    throw new Error('restore must not spawn a process')
  },
} as unknown as ProcessBackend

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'cwn-restore-'))
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }))
  const storage = new WorkerStorage(directory)
  const runtime = new WorkerRuntime(storage, backend, DEFAULT_CONFIG)
  cleanups.push(() => runtime.close())
  return { storage, runtime }
}
const worker = (agentName: string, extra: Partial<Worker> = {}): Worker =>
  ({
    id: randomUUID(),
    parentSessionId: 'parent',
    project: '/project',
    title: 'fixture',
    agentName,
    agentNameOrigin: 'custom',
    preference: { cli: 'codex', model: 'm', effort: 'low' },
    mode: 'accept-edits',
    status: 'completed',
    createdAt: '',
    updatedAt: '',
    runId: randomUUID(),
    ...extra,
  }) as Worker

it('restores a deleted agent with its original name when nobody reused it', () => {
  const { storage, runtime } = fixture()
  const deleted = worker('模板1', { archivedAt: '2026-01-01T00:00:00.000Z' })
  storage.save(deleted)
  runtime.restoreWorker('parent', deleted.id)
  const restored = storage.workers.get(deleted.id)!
  expect(restored.archivedAt).toBeUndefined()
  expect(restored.agentName).toBe('模板1')
})

it('renames on restore when the released name already belongs to a new agent', () => {
  const { storage, runtime } = fixture()
  const deleted = worker('模板1', { archivedAt: '2026-01-01T00:00:00.000Z' })
  storage.save(deleted)
  storage.save(worker('模板1'))
  runtime.restoreWorker('parent', deleted.id)
  const restored = storage.workers.get(deleted.id)!
  expect(restored.archivedAt).toBeUndefined()
  expect(restored.agentName).toBe('模板1-1')
  expect(restored.agentNameOrigin).toBe('custom')
})
