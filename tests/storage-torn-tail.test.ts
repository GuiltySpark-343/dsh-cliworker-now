import { afterEach, expect, it, vi } from 'vitest'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Worker } from '../src/shared/types.ts'

// Simulated disk fault: a rewrite of an event log truncates it and then fails,
// as an ENOSPC after O_TRUNC would. Every other file system call is real.
const fault = vi.hoisted(() => ({ events: false }))
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof import('node:fs')>()
  const failing = (path: unknown) => fault.events && String(path).endsWith('.events.jsonl')
  return {
    ...actual,
    writeFileSync: ((path: any, ...rest: any[]) => {
      if (failing(path)) {
        actual.truncateSync(path, 0)
        throw Object.assign(new Error('ENOSPC: simulated no space left on device'), { code: 'ENOSPC' })
      }
      return (actual.writeFileSync as any)(path, ...rest)
    }) as typeof actual.writeFileSync,
    ftruncateSync: ((handle: number, length?: number) => {
      if (fault.events) throw Object.assign(new Error('ENOSPC: simulated'), { code: 'ENOSPC' })
      return actual.ftruncateSync(handle, length)
    }) as typeof actual.ftruncateSync,
  }
})
const { WorkerStorage } = await import('../src/host/storage.ts')

const roots: string[] = []
afterEach(() => {
  fault.events = false
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cwn-torn-tail-SIMULATED-')))
  roots.push(root)
  const project = join(root, 'project'),
    directory = join(root, 'state')
  mkdirSync(project)
  const worker: Worker = {
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
  }
  const first = new WorkerStorage(directory)
  first.save(worker)
  first.append(worker, { kind: 'user', text: '第一条' })
  first.append(worker, { kind: 'assistant', text: '第二条' })
  first.close()
  const path = join(directory, `${worker.id}.events.jsonl`)
  return { directory, worker, path, complete: readFileSync(path) }
}

it('keeps every complete event when repairing a torn tail fails', () => {
  const { directory, worker, path, complete } = fixture()
  appendFileSync(path, '{"seq":3,"kind":"assi')
  const inode = statSync(path).ino
  fault.events = true
  const storage = new WorkerStorage(directory)
  try {
    expect(() => storage.history(worker.id)).toThrow('ENOSPC')
  } finally {
    storage.close()
  }
  const after = readFileSync(path)
  expect(after.subarray(0, complete.length).equals(complete)).toBe(true)
  expect(statSync(path).ino).toBe(inode)
})

it('truncates a torn multi-byte tail to the last newline and keeps the prefix byte for byte', () => {
  const { directory, worker, path, complete } = fixture()
  const torn = Buffer.from('{"seq":3,"kind":"assistant","text":"中', 'utf8')
  appendFileSync(path, torn.subarray(0, torn.length - 1))
  const inode = statSync(path).ino
  const storage = new WorkerStorage(directory)
  try {
    expect(storage.history(worker.id).map((event) => event.text)).toEqual(['第一条', '第二条'])
    expect(readFileSync(path).equals(complete)).toBe(true)
    expect(statSync(path).ino).toBe(inode)
    storage.append(worker, { kind: 'assistant', text: '第三条' })
  } finally {
    storage.close()
  }
  const reopened = new WorkerStorage(directory)
  try {
    expect(reopened.history(worker.id).map((event) => [event.seq, event.text])).toEqual([
      [1, '第一条'],
      [2, '第二条'],
      [3, '第三条'],
    ])
  } finally {
    reopened.close()
  }
})
