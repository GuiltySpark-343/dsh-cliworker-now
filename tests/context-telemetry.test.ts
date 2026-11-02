import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { PassThrough } from 'node:stream'
import { WorkerRuntime } from '../src/host/runtime.ts'
import { WorkerStorage } from '../src/host/storage.ts'
import { DEFAULT_CONFIG, type ProcessBackend } from '../src/host/process.ts'
import { captureContextTelemetry, withContextTelemetry } from '../src/host/context-telemetry.ts'
import type { Worker } from '../src/shared/types.ts'

// Offline simulated child records; real runtime/storage, no installed CLI/account/model.
vi.mock('../src/host/cli-account-binding.ts', () => ({ readCliAccountBinding: async () => 'mock-account' }))
vi.mock('../src/host/authorized-catalog.ts', () => ({ ACCOUNT_CHANGED: 'changed',
  authorizeSelection: async (preference: unknown) => ({ binding: 'mock-account', preference }) }))
vi.mock('../src/host/extended-adapters.ts', () => ({ isExtendedCli: () => true,
  extendedLaunch: async () => ({ argv: ['/mock/zcode'], env: {} }) }))
const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const preference = { cli: 'zcode' as const, model: 'provider/model', effort: 'default' as const }
const worker = (): Worker => ({ id: randomUUID(), parentSessionId: 'parent', project: '/mock', title: 'mock',
  preference, conversationId: 'session', mode: 'accept-edits', runId: randomUUID(), status: 'completed',
  createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
const projection = (overrides = {}) => ({ type: 'native', record: { result: { projection: { sessionId: 'session',
  contextUsed: 0, contextWindow: 200000, totalTokenCount: 0, turnCount: 0, ...overrides } } } })
function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'context-runtime-mock-')))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  const children: any[] = []
  const backend: ProcessBackend = { resolveExecutable: async () => '/mock/zcode', spawn() {
    const stdout = new PassThrough(), stderr = new PassThrough()
    let settle!: (x: { exitCode: number }) => void
    const done = new Promise<{ exitCode: number }>(resolve => { settle = resolve })
    const child = { emit: (record: any) => stdout.write(JSON.stringify(record) + '\n'),
      finish: () => { child.emit({ type: 'result', status: 'SUCCESS', response: 'mock' }); stdout.end(); stderr.end(); settle({ exitCode: 0 }) } }
    children.push(child)
    return { stdout, stderr, done, terminate() {}, waitForExit: async () => { await done; return true } } as any
  } }
  const storage = new WorkerStorage(join(root, 'state'))
  const runtime = new WorkerRuntime(storage, backend, DEFAULT_CONFIG)
  cleanups.push(() => runtime.close())
  return { root, children, storage, runtime }
}
describe('context checkpoints through WorkerRuntime', () => {
  it('invalidates the old model context on selection, after cold restore and before a new run', async () => {
    const f = setup()
    const first = f.runtime.submit('parent', f.root, 'mock', 'mock', preference, 'accept-edits')
    const id = first.worker.id
    await vi.waitFor(() => expect(f.children).toHaveLength(1))
    f.children[0].emit({ type: 'session', id: 'session', model: preference.model })
    f.children[0].emit(projection({ contextUsed: 15, totalTokenCount: 15, turnCount: 1, currentTurnId: 'turn' }))
    await vi.waitFor(() => expect(f.runtime.snapshot('parent', id).telemetry?.contextUsed).toBe(15))
    f.children[0].finish(); await first.done
    const nextPreference = { ...preference, model: 'provider/other' }
    f.runtime.configureWorker('parent', id, nextPreference)
    expect(f.runtime.snapshot('parent', id).telemetry?.contextUsed).toBeUndefined()
    expect(f.storage.workers.get(id)?.contextTelemetry).toBeUndefined()
    expect(f.storage.workers.get(id)?.observedModel).toBeUndefined()
    await f.runtime.close()
    const cold = new WorkerStorage(f.storage.directory)
    const runtime = new WorkerRuntime(cold, { resolveExecutable: async () => '/mock/zcode',
      spawn: () => { throw new Error('simulated launch stopped before execution') } } as any, DEFAULT_CONFIG)
    cleanups.push(() => runtime.close())
    expect(runtime.snapshot('parent', id).telemetry?.contextUsed).toBeUndefined()
    const next = runtime.submit('parent', f.root, 'mock', 'mock', nextPreference, 'accept-edits', id)
    expect(runtime.snapshot('parent', id).telemetry?.contextUsed).toBeUndefined()
    expect(cold.workers.get(id)?.contextTelemetry).toBeUndefined()
    await next.done
  })
  it('retains known context through three runs pending/bootstrap and accepts current real zero', async () => {
    const f = setup(); let id: string | undefined
    for (let turn = 0; turn < 3; turn++) {
      const submission = f.runtime.submit('parent', f.root, 'mock', 'mock', preference, 'accept-edits', id)
      id = submission.worker.id
      const pending = f.runtime.snapshot('parent', id).telemetry
      expect(pending?.contextUsed).toBe(turn === 0 ? undefined : turn === 1 ? 15 : 30)
      await vi.waitFor(() => expect(f.children).toHaveLength(turn + 1))
      const child = f.children[turn]
      child.emit({ type: 'session', id: 'session', model: preference.model })
      child.emit(projection())
      await vi.waitFor(() => expect(f.runtime.snapshot('parent', id).selected?.conversationId).toBe('session'))
      expect(f.runtime.snapshot('parent', id).telemetry?.contextUsed).toBe(turn === 0 ? undefined : turn === 1 ? 15 : 30)
      const used = turn === 2 ? 0 : (turn + 1) * 15
      child.emit(projection({ contextUsed: used, totalTokenCount: used, turnCount: 1, currentTurnId: `turn-${turn}` }))
      await vi.waitFor(() => expect(f.runtime.snapshot('parent', id).telemetry?.contextUsed).toBe(used))
      child.finish(); const done = await submission.done
      expect(done.status).toBe('completed')
      expect(f.storage.workers.get(id!)?.contextTelemetry?.contextUsed).toBe(used)
    }
    await f.runtime.close()
    const cold = new WorkerStorage(f.storage.directory)
    cleanups.push(() => cold.close())
    expect(cold.workers.get(id!)?.contextTelemetry?.contextUsed).toBe(0)
  })
  it('clears a checkpoint on explicit unknown and keeps it cleared on the next pending run', async () => {
    const f = setup()
    const first = f.runtime.submit('parent', f.root, 'mock', 'mock', preference, 'accept-edits')
    const id = first.worker.id
    await vi.waitFor(() => expect(f.children).toHaveLength(1))
    f.children[0].emit({ type: 'session', id: 'session', model: preference.model })
    f.children[0].emit(projection({ contextUsed: 15, totalTokenCount: 15, turnCount: 1, currentTurnId: 'turn' }))
    await vi.waitFor(() => expect(f.runtime.snapshot('parent', id).telemetry?.contextUsed).toBe(15))
    f.children[0].emit(projection({ contextUsed: null, totalTokenCount: 15, turnCount: 1, currentTurnId: 'turn' }))
    await vi.waitFor(() => expect(f.runtime.snapshot('parent', id).telemetry?.contextUsed).toBeUndefined())
    f.children[0].finish(); await first.done
    expect(f.storage.workers.get(id)?.contextTelemetry).toBeUndefined()
    const next = f.runtime.submit('parent', f.root, 'mock', 'mock', preference, 'accept-edits', id)
    expect(f.runtime.snapshot('parent', id).telemetry?.contextUsed).toBeUndefined()
    await vi.waitFor(() => expect(f.children).toHaveLength(2))
    f.children[1].emit({ type: 'session', id: 'session', model: preference.model })
    f.children[1].emit(projection()); f.children[1].finish(); await next.done
    expect(f.runtime.snapshot('parent', id).telemetry?.contextUsed).toBeUndefined()
  })
  it('does not drop a valid worker when optional checkpoint is malformed on cold restore', async () => {
    const f = setup(), w = worker(); f.storage.save(w)
    const path = join(f.storage.directory, `${w.id}.worker.json`)
    const saved = JSON.parse(readFileSync(path, 'utf8')); saved.contextTelemetry = { policy: 1, contextUsed: -1 }
    writeFileSync(path, JSON.stringify(saved))
    await f.runtime.close()
    const cold = new WorkerStorage(f.storage.directory)
    cleanups.push(() => cold.close())
    expect(cold.workers.get(w.id)?.id).toBe(w.id)
    expect(cold.workers.get(w.id)?.contextTelemetry).toBeUndefined()
  })
})
describe('context checkpoint identity and invalidation', () => {
  it('does not resurrect explicit unknown or carry stale classification into a new sample', () => {
    const w = worker()
    w.contextTelemetry = captureContextTelemetry(w, { replies: {}, contextUsed: 15, contextCapacity: 200000,
      contextBreakdown: { systemTokens: 10, messageTokens: 5 } })
    expect(withContextTelemetry(w, { replies: {} }).contextUsed).toBe(15)
    const unknown = { replies: {}, contextUsed: undefined }
    expect(withContextTelemetry(w, unknown)).toBe(unknown)
    expect(captureContextTelemetry(w, unknown)).toBeUndefined()
    expect(withContextTelemetry(w, { replies: {}, contextUsed: 0, contextBreakdown: undefined })).toEqual({ replies: {}, contextUsed: 0, contextBreakdown: undefined })
    expect(withContextTelemetry(w, { replies: {}, contextBreakdown: undefined }).contextBreakdown).toBeUndefined()
  })
  it('rejects cold-restored checkpoints after session, model, CLI or observed-model changes', () => {
    const w = worker(); w.observedModel = 'resolved-A'
    w.contextTelemetry = captureContextTelemetry(w, { replies: {}, contextUsed: 15, contextCapacity: 200000 })
    const restored = JSON.parse(JSON.stringify(w))
    for (const changed of [
      { ...restored, conversationId: 'other' }, { ...restored, preference: { ...preference, model: 'other' } },
      { ...restored, preference: { ...preference, cli: 'grok' } }, { ...restored, observedModel: 'resolved-B' },
    ]) expect(withContextTelemetry(changed, { replies: {} }).contextUsed).toBeUndefined()
    expect(withContextTelemetry({ ...restored, contextTelemetry: { ...restored.contextTelemetry, observedModel: undefined } }, { replies: {} }).contextUsed).toBeUndefined()
    expect(withContextTelemetry(restored, { replies: {}, contextCapacity: 500000 }).contextUsed).toBeUndefined()
  })
})
