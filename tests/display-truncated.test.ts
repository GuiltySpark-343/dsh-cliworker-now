import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { WorkerStorage } from '../src/host/storage.ts'
import type { Worker } from '../src/shared/types.ts'

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

it('persists the run-level truncation marker across a reload', () => {
  const root = mkdtempSync(join(tmpdir(), 'cwn-display-truncated-'))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  const worker: Worker = {
    id: randomUUID(),
    runId: randomUUID(),
    parentSessionId: 'parent',
    project: join(root, 'project'),
    title: 'synthetic',
    preference: { cli: 'codex', model: 'synthetic-model', effort: 'low' },
    mode: 'plan',
    status: 'completed',
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-01T00:00:00Z',
    displayTruncated: true,
  }
  const first = new WorkerStorage(root)
  first.save(worker)
  first.close()
  const reopened = new WorkerStorage(root)
  cleanups.push(() => reopened.close())
  expect(reopened.workers.get(worker.id)?.displayTruncated).toBe(true)
})
