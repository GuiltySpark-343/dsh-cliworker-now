import { afterEach, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { WorkerStorage } from '../src/host/storage.ts'
import { StateLayout, projectLogDirectory } from '../src/host/state-layout.ts'
import type { Worker } from '../src/shared/types.ts'

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'cwn-layout-'))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  const state = join(root, 'state'),
    project = join(root, 'project')
  mkdirSync(state, { recursive: true })
  mkdirSync(project, { recursive: true })
  return { root, state, project }
}
const worker = (project: string): Worker => ({
  id: randomUUID(),
  runId: randomUUID(),
  parentSessionId: 'parent',
  project,
  title: 'synthetic',
  preference: { model: 'synthetic-model', effort: 'low' },
  mode: 'plan',
  status: 'completed',
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-01T00:00:00Z',
})

it('writes run logs under the project and keeps the project state out of git', () => {
  const { state, project } = fixture()
  const layout = new StateLayout(state)
  expect(layout.directoryFor(project)).toBe(projectLogDirectory(project))
  expect(existsSync(join(project, '.dsh', '.gitignore'))).toBe(true)
  expect(readFileSync(join(project, '.dsh', '.gitignore'), 'utf8')).toBe('*\n')
})

it('falls back to the global directory when the project cannot hold logs', () => {
  const { root, state } = fixture()
  const blocker = join(root, 'blocker')
  writeFileSync(blocker, 'not a directory')
  const onFallback = vi.fn()
  const layout = new StateLayout(state, 'project', onFallback)
  expect(layout.directoryFor(join(blocker, 'project'))).toBe(state)
  expect(onFallback).toHaveBeenCalledTimes(1)
})

it('reads a legacy global run log until the project copy exists', () => {
  const { state, project } = fixture()
  const layout = new StateLayout(state)
  writeFileSync(join(state, 'worker.run.raw.jsonl'), 'legacy')
  expect(layout.pathFor(project, 'worker.run.raw.jsonl', true)).toBe(join(state, 'worker.run.raw.jsonl'))
  expect(layout.pathFor(project, 'worker.run.raw.jsonl', false)).toBe(
    join(projectLogDirectory(project), 'worker.run.raw.jsonl'),
  )
})

it('moves the legacy timeline into the project before the first append', () => {
  const { state, project } = fixture()
  const storage = new WorkerStorage(state)
  cleanups.push(() => storage.close())
  const target = worker(project)
  storage.save(target)
  // A pre-split record: its timeline still lives in the global state directory.
  writeFileSync(
    join(state, `${target.id}.events.jsonl`),
    JSON.stringify({ kind: 'user', text: 'legacy', seq: 1, runId: target.runId, time: '2026-10-01T00:00:00Z' }) +
      '\n',
  )
  storage.append(target, { kind: 'assistant', text: 'new' })
  expect(existsSync(join(state, `${target.id}.events.jsonl`))).toBe(false)
  expect(existsSync(join(projectLogDirectory(project), `${target.id}.events.jsonl`))).toBe(true)
  expect(storage.history(target.id).map((event) => event.text)).toEqual(['legacy', 'new'])
})

it('keeps everything in the state directory when the mode is global', () => {
  const { state, project } = fixture()
  const layout = new StateLayout(state, 'global')
  expect(layout.directoryFor(project)).toBe(state)
  expect(existsSync(join(project, '.dsh'))).toBe(false)
})
