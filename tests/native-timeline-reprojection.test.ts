import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, realpathSync, writeFileSync, readFileSync, rmSync, symlinkSync, linkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID, createHash } from 'node:crypto'
import { NativeTimelineReprojector } from '../src/host/native-timeline-reprojection.ts'
import { foldEvents, type Worker, type WorkerEvent } from '../src/shared/types.ts'

const mutation = vi.hoisted(() => ({ afterRead: undefined as (() => void) | undefined }))
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof import('node:fs')>()
  return { ...actual, readSync: (...args: Parameters<typeof actual.readSync>) => {
    const size = (actual.readSync as (...values: any[]) => number)(...args)
    const mutate = mutation.afterRead
    mutation.afterRead = undefined
    mutate?.()
    return size
  } }
})

// Explicit synthetic old bridge records; no account, model, or user history is accessed.
const roots: string[] = []
afterEach(() => { mutation.afterRead = undefined; for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cwn-reproject-synthetic-')))
  roots.push(root)
  const runId = randomUUID(), worker = { id: randomUUID(), preference: { cli: 'opencode' }, transport: 'opencode-http-v1' } as Worker
  const chunks = ['开发', '任务', '，', ' ', '继续']
  const events = chunks.map((text, index) => ({ kind: 'assistant', text, seq: index + 1, runId, time: '' })) as WorkerEvent[]
  events.push({ kind: 'result', text: chunks.join(''), state: 'SUCCESS', seq: 6, runId, time: '' },
    { kind: 'status', text: 'completed', state: 'completed', seq: 7, runId, time: '' })
  const info = { id: 'msg_reply', role: 'assistant', parentID: 'msg_user', sessionID: 'ses_test', time: { completed: 2 }, finish: 'stop' }
  const part = { id: 'prt_text', messageID: info.id, sessionID: info.sessionID, type: 'text', text: chunks.join(''), time: { end: 2 } }
  const records: any[] = [{ type: 'session', id: info.sessionID },
    { type: 'native', record: { type: 'message.updated', properties: { info } } },
    { type: 'native', record: { type: 'message.part.updated', properties: { part: { ...part, text: '', time: {} } } } },
    ...chunks.map((text) => ({ type: 'event', event: { kind: 'assistant', text } })),
    { type: 'native', record: { type: 'message.part.updated', properties: { part } } },
    { type: 'result', status: 'SUCCESS', response: chunks.join('') }]
  const path = join(root, runId + '.raw.jsonl')
  const save = () => writeFileSync(path, records.map((record) => JSON.stringify(record)).join('\n') + '\n', { mode: 0o600 })
  save()
  return { root, runId, worker, events, records, path, save, project: (reader = new NativeTimelineReprojector()) => reader.project(worker, events, () => path) }
}
it('repairs proven fragments without changing text, event identity, or raw file bytes', () => {
  const f = fixture(), original = JSON.stringify(f.events), digest = () => createHash('sha256').update(readFileSync(f.path)).digest('hex')
  const before = digest(), reader = new NativeTimelineReprojector()
  for (let n = 0; n < 2; n++) {
    const projected = f.project(reader)
    expect(foldEvents(projected).filter((row) => row.kind === 'assistant')).toMatchObject([{ text: '开发任务， 继续' }])
    expect(foldEvents(projected).filter((row) => row.kind === 'assistant')).toHaveLength(1)
    expect(projected.map((event) => [event.seq, event.text, event.time])).toEqual(f.events.map((event) => [event.seq, event.text, event.time]))
  }
  expect(JSON.stringify(f.events)).toBe(original)
  expect(digest()).toBe(before)
})
it.each(['multi-part', 'different-session', 'conflict', 'partial', 'events-conflict', 'failed', 'already-stepped', 'tool-boundary'])(
  'keeps %s evidence unchanged rather than guessing message boundaries', (mode) => {
    const f = fixture()
    if (mode === 'multi-part') f.records.splice(-1, 0, { type: 'native', record: { type: 'message.part.updated', properties: { part: { id: 'prt_other', type: 'text', sessionID: 'ses_test', messageID: 'msg_reply', text: 'independent', time: { end: 2 } } } } })
    if (mode === 'different-session') f.records[2].record.properties.part.sessionID = 'ses_other'
    if (mode === 'conflict') f.records.at(-2).record.properties.part.text = 'different'
    if (mode === 'events-conflict') f.events[1]!.text = 'different'
    if (mode === 'failed') f.events.at(-1)!.state = 'failed'
    if (mode === 'already-stepped') f.events[0]!.step = 3
    if (mode === 'tool-boundary') f.records.splice(5, 0, { type: 'event', event: { kind: 'tool', text: 'read', step: 0 } })
    f.save()
    if (mode === 'partial') writeFileSync(f.path, JSON.stringify(f.records[0]), { mode: 0o600 })
    expect(f.project()).toBe(f.events)
  },
)
it('never merges another run and invalidates its cache after native evidence changes', () => {
  const f = fixture(), reader = new NativeTimelineReprojector(), otherRun = randomUUID()
  f.events.push({ kind: 'assistant', text: 'other run', seq: 8, time: '', runId: otherRun })
  expect(f.project(reader).at(-1)).toBe(f.events.at(-1))
  f.records.at(-2).record.properties.part.text = 'conflict after cache'
  f.save()
  expect(f.project(reader)).toBe(f.events)
})
it('discards a native file changed during its descriptor-bound read', () => {
  const f = fixture()
  mutation.afterRead = () => writeFileSync(f.path, 'changed during read\n', { mode: 0o600 })
  expect(f.project()).toBe(f.events)
})
it.each(['symlink', 'hardlink', 'oversized'] as const)('rejects %s evidence without rewriting any source', (mode) => {
  const f = fixture(), external = join(f.root, 'external')
  if (mode === 'oversized') writeFileSync(f.path, ' '.repeat(16 * 1024 * 1024 + 1))
  else {
    writeFileSync(external, readFileSync(f.path), { mode: 0o600 })
    rmSync(f.path)
    if (mode === 'symlink') symlinkSync(external, f.path)
    else linkSync(external, f.path)
  }
  expect(f.project()).toBe(f.events)
})
