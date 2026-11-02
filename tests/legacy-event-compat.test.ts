import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { WorkerStorage } from '../src/host/storage.ts'
import type { Worker } from '../src/shared/types.ts'

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

it('loads a legacy timeline whose tool command exceeds the current display cap', () => {
  const root = mkdtempSync(join(tmpdir(), 'cwn-legacy-events-'))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  const storage = new WorkerStorage(root)
  cleanups.push(() => storage.close())
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
  }
  storage.save(worker)
  const command = 'x'.repeat(40_000)
  writeFileSync(
    join(root, `${worker.id}.events.jsonl`),
    JSON.stringify({
      kind: 'tool',
      text: 'synthetic command',
      seq: 1,
      runId: worker.runId,
      time: '2026-10-01T00:00:00Z',
      toolCall: { name: 'commandExecution', command },
    }) + '\n',
  )
  const [event] = storage.history(worker.id)
  expect(event!.toolCall?.command).toHaveLength(32_768)
})
