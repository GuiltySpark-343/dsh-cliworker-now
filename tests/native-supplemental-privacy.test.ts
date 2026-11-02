import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const asynchronous = vi.hoisted(() => ({ reads: [] as Array<{ config: any; signal: AbortSignal; resolve(value: any): void }> }))
vi.mock('../src/host/qoder-durable-context.mjs', async original => ({
  ...await original<typeof import('../src/host/qoder-durable-context.mjs')>(),
  readQoderDurableContextAsync: (config: any, options: any) => new Promise(resolve => {
    asynchronous.reads.push({ config, signal: options.signal, resolve })
  }),
}))
import { NativeSupplementalContextReader } from '../src/host/native-supplemental-context.ts'
import { qoderContextPaths } from '../src/host/qoder-durable-context.mjs'
import type { Worker } from '../src/shared/types.ts'
// Simulated asynchronous Windows ACL completion; real raw parsing, exact source
// signatures and runtime refresh/cancellation ownership. No native account/model.
const roots: string[] = []
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); asynchronous.reads.length = 0; roots.splice(0).forEach(p => rmSync(p, { recursive: true, force: true })) })
function fixture() {
  vi.stubGlobal('process', { ...process, platform: 'win32' })
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'SIMULATED-history-acl-'))); roots.push(root)
  const home = join(root, 'qoder'), project = join(root, 'project')
  vi.stubEnv('QODER_CONFIG_DIR', home)
  const binding = { home, project, sessionId: 'session', model: 'model', userMessageId: 'user' }
  const paths = qoderContextPaths(binding)
  mkdirSync(paths[2]!, { recursive: true }); writeFileSync(paths[3]!, '{}\n')
  const rawPath = join(root, 'worker.run.raw.jsonl')
  writeFileSync(rawPath, [{ type: 'session', id: 'session', model: 'model' }, { id: 'rpc', result: { stopReason: 'end_turn', userMessageId: 'user' } }]
    .map(record => JSON.stringify({ type: 'native', record })).join('\n') + '\n')
  const worker = { id: 'worker', project, preference: { cli: 'qoder', model: 'model' }, conversationId: 'session' } as Worker
  const input = { worker, runId: 'run', rawPath, storageDirectory: root }
  const observation = { type: 'cliworker.qoder_context', source: 'qoder.native-transcript', basis: 'native-ratio',
    sessionId: 'session', model: 'model', userMessageId: 'user', contextRatio: 0.25 }
  return { input, file: paths[3]!, observation }
}
const flush = () => new Promise(resolve => setImmediate(resolve))
it('refreshes unknown to verified numeric context via changed even when no journal stamp changes', async () => {
  const f = fixture(), changed = vi.fn(), reader = new NativeSupplementalContextReader(changed)
  expect(reader.read(f.input)).toEqual({}); expect(reader.read(f.input)).toEqual({})
  expect(asynchronous.reads).toHaveLength(1)
  asynchronous.reads[0]!.resolve(f.observation); await flush()
  expect(changed).toHaveBeenCalledTimes(1)
  expect(reader.read(f.input).contextRatio).toBe(0.25)
  expect(JSON.stringify([...(reader as any).completed.values()])).not.toMatch(/PRIVATE|prompt|message.content/)
  reader.clear()
})
it('clear cancels only its own proof and prevents a late promise from writing or waking a disposed owner', async () => {
  const f = fixture(), changed = vi.fn(), reader = new NativeSupplementalContextReader(changed)
  reader.read(f.input); const old = asynchronous.reads[0]!
  reader.clear(); expect(old.signal.aborted).toBe(true)
  old.resolve(f.observation); await flush()
  expect(changed).not.toHaveBeenCalled(); expect((reader as any).completed.size).toBe(0)
})
it('discards a completion after source replacement and never borrows it for a different current model', async () => {
  const f = fixture(), changed = vi.fn(), reader = new NativeSupplementalContextReader(changed)
  reader.read(f.input)
  writeFileSync(f.file, '{"SIMULATED":"replacement"}\n')
  expect(reader.read(f.input).contextRatio).toBeUndefined()
  expect(asynchronous.reads).toHaveLength(2)
  expect(asynchronous.reads[0]!.signal.aborted).toBe(true)
  expect(asynchronous.reads[1]!.signal.aborted).toBe(false)
  asynchronous.reads[0]!.resolve(f.observation); await flush()
  expect(changed).not.toHaveBeenCalled()
  expect(reader.read({ ...f.input, currentIdentity: { conversationId: 'session', model: 'foreign' } }).contextRatio).toBeUndefined()
  expect(reader.read(f.input).contextRatio).toBeUndefined(); expect(asynchronous.reads).toHaveLength(2)
  asynchronous.reads[1]!.resolve(undefined); await flush()
  expect(reader.read(f.input).contextRatio).toBeUndefined()
  reader.clear()
})

it('keeps independent runtime owners single-flight without sharing cancellation', async () => {
  const f = fixture(), firstChanged = vi.fn(), secondChanged = vi.fn()
  const first = new NativeSupplementalContextReader(firstChanged), second = new NativeSupplementalContextReader(secondChanged)
  first.read(f.input); second.read(f.input)
  expect(asynchronous.reads).toHaveLength(2)
  first.clear()
  expect(asynchronous.reads[0]!.signal.aborted).toBe(true)
  expect(asynchronous.reads[1]!.signal.aborted).toBe(false)
  for (const read of asynchronous.reads) read.resolve(f.observation)
  await flush()
  expect(firstChanged).not.toHaveBeenCalled(); expect(secondChanged).toHaveBeenCalledTimes(1)
  expect(second.read(f.input).contextRatio).toBe(0.25)
  second.clear()
})

it('does not permanently cache a fifth historical source while four proof slots are occupied', async () => {
  const f = fixture(), changed = vi.fn(), reader = new NativeSupplementalContextReader(changed)
  const inputs = Array.from({ length: 5 }, (_, i) => {
    const runId = `run${i}`, rawPath = join(f.input.storageDirectory, `worker.${runId}.raw.jsonl`)
    writeFileSync(rawPath, readFileSync(f.input.rawPath))
    return { ...f.input, runId, rawPath }
  })
  for (const input of inputs) expect(reader.read(input)).toEqual({})
  expect(asynchronous.reads).toHaveLength(4)
  for (const read of asynchronous.reads) read.resolve(f.observation)
  await flush()
  expect((reader as any).pending.size).toBe(0)
  expect(reader.read(inputs[4]!).contextRatio).toBeUndefined()
  expect(asynchronous.reads).toHaveLength(5)
  asynchronous.reads[4]!.resolve(f.observation); await flush()
  expect(reader.read(inputs[4]!).contextRatio).toBe(0.25)
  reader.clear()
})
it('retries an unchanged transient unknown on a later read after its bounded negative TTL', async () => {
  const f = fixture(), reader = new NativeSupplementalContextReader()
  reader.read(f.input); asynchronous.reads[0]!.resolve(undefined); await flush()
  expect(reader.read(f.input)).toEqual({}); expect(asynchronous.reads).toHaveLength(1)
  const future = Date.now() + 1500
  vi.spyOn(Date, 'now').mockReturnValue(future)
  expect(reader.read(f.input).contextRatio).toBeUndefined(); expect(asynchronous.reads).toHaveLength(2)
  asynchronous.reads[1]!.resolve(f.observation); await flush()
  expect(reader.read(f.input).contextRatio).toBe(0.25)
  reader.clear()
})
