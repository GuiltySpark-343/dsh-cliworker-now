import { afterEach, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { WorkerStorage } from '../src/host/storage.ts'
import type { Worker } from '../src/shared/types.ts'

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})
function fixture(retention?: { runs: number; bytes: number }) {
  const root = mkdtempSync(join(tmpdir(), 'cwn-retention-'))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  const state = join(root, 'state'),
    project = join(root, 'project')
  mkdirSync(state, { recursive: true })
  mkdirSync(project, { recursive: true })
  const storage = new WorkerStorage(state, { retention })
  cleanups.push(() => storage.close())
  return { root, state, project, storage }
}
const worker = (project: string, status: Worker['status'] = 'completed'): Worker => ({
  id: randomUUID(),
  runId: randomUUID(),
  parentSessionId: 'parent',
  project,
  title: 'synthetic',
  preference: { model: 'synthetic-model', effort: 'low' },
  mode: 'plan',
  status,
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-01T00:00:00Z',
})

it('keeps only the newest runs per Worker', () => {
  const { project, storage } = fixture({ runs: 1, bytes: 1_000_000 })
  const target = worker(project)
  storage.save(target)
  const directory = storage.logDirectory(project)
  const runs = ['run-a', 'run-b', 'run-c']
  runs.forEach((runId, index) => {
    writeFileSync(join(directory, `${target.id}.${runId}.raw.jsonl`), 'x'.repeat(10))
  })
  // Distinct mtimes keep the newest deterministic.
  runs.forEach((runId, index) => {
    const path = join(directory, `${target.id}.${runId}.raw.jsonl`)
    const time = new Date(2026, 0, 1 + index)
    utimesSync(path, time, time)
  })
  storage.pruneRunLogs()
  expect(existsSync(join(directory, `${target.id}.run-c.raw.jsonl`))).toBe(true)
  expect(existsSync(join(directory, `${target.id}.run-a.raw.jsonl`))).toBe(false)
  expect(existsSync(join(directory, `${target.id}.run-b.raw.jsonl`))).toBe(false)
})

it('never deletes the active run', () => {
  const { project, storage } = fixture({ runs: 1, bytes: 1_000_000 })
  const target = worker(project, 'running')
  storage.save(target)
  const directory = storage.logDirectory(project)
  for (const runId of ['old', target.runId]) {
    const path = join(directory, `${target.id}.${runId}.raw.jsonl`)
    writeFileSync(path, 'x'.repeat(10))
    const time = runId === target.runId ? new Date(2026, 1, 1) : new Date(2026, 0, 1)
    utimesSync(path, time, time)
  }
  storage.pruneRunLogs()
  expect(existsSync(join(directory, `${target.id}.${target.runId}.raw.jsonl`))).toBe(true)
  expect(existsSync(join(directory, `${target.id}.old.raw.jsonl`))).toBe(false)
})
