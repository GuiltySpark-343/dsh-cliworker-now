import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { captureLastRunUsageSnapshot, withConversationTelemetry } from '../src/host/conversation-telemetry.ts'
import { WorkerStorage } from '../src/host/storage.ts'
import type { Worker } from '../src/shared/types.ts'
import type { TokenUsage } from '../src/shared/telemetry.ts'

// Synthetic receipts only; no CLI/account/process/model is opened.
const roots: string[] = []
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))
const usage = (): TokenUsage & { scope: 'run' } => ({
  total: 38, input: 33, output: 5, cacheRead: 10, cacheWrite: 3, reasoning: 2, scope: 'run',
})
function worker(): Worker {
  return { id: randomUUID(), runId: randomUUID(), parentSessionId: 'synthetic-parent', project: '/synthetic-project',
    title: 'Synthetic last run receipt', preference: { cli: 'hermes', model: 'synthetic-model', effort: 'default' },
    conversationId: 'synthetic-conversation', mode: 'accept-edits', status: 'completed',
    createdAt: '2026-10-17T00:00:00Z', updatedAt: '2026-10-17T00:00:00Z' }
}

describe('last confirmed run usage stays distinct from session totals', () => {
  it('retains an explicitly run-scoped receipt across a run switch without manufacturing current accounting', () => {
    const w = worker(), source = w.runId
    w.lastRunUsageSnapshot = captureLastRunUsageSnapshot(w, { replies: {}, runUsage: usage() })
    w.runId = randomUUID(); w.status = 'running'
    const current = { replies: {}, contextUsed: 9, contextCapacity: 100 }
    const shown = withConversationTelemetry(w, current)
    expect(shown).toEqual({ ...current, usage: usage(), usageRunId: source })
    expect(shown.runUsage).toBeUndefined()
    expect(shown.finalReply).toBeUndefined()
    expect(captureLastRunUsageSnapshot(w, { replies: {} })).toEqual(w.lastRunUsageSnapshot)
  })

  it('prioritizes a session cumulative receipt, otherwise preserves current usage without summing a prior run', () => {
    const w = worker()
    w.lastRunUsageSnapshot = captureLastRunUsageSnapshot(w, { replies: {}, runUsage: usage() })
    const current = { replies: {}, usage: { total: 9, scope: 'response' as const } }
    expect(withConversationTelemetry(w, current)).toBe(current)
    const session = { ...usage(), total: 1005, input: 1000, scope: 'session' as const }
    w.conversationTelemetry = { policy: 1, cli: 'hermes', conversationId: w.conversationId!, runId: randomUUID(), usage: session }
    expect(withConversationTelemetry(w, current).usage).toEqual(session)
    expect(w.lastRunUsageSnapshot.usage.total).toBe(38)
  })

  it('replaces the last run receipt once and rejects CLI/session/unbound identity changes', () => {
    const w = worker()
    w.lastRunUsageSnapshot = captureLastRunUsageSnapshot(w, { replies: {}, runUsage: usage() })
    w.runId = randomUUID()
    const next = { ...usage(), input: 40, total: 45 }
    w.lastRunUsageSnapshot = captureLastRunUsageSnapshot(w, { replies: {}, runUsage: next })
    expect(w.lastRunUsageSnapshot?.usage.total).toBe(45)
    expect(w.lastRunUsageSnapshot?.runId).toBe(w.runId)
    for (const changed of [
      { ...w, conversationId: 'other' }, { ...w, conversationId: undefined },
      { ...w, preference: { ...w.preference, cli: 'grok' as const } },
    ]) {
      expect(withConversationTelemetry(changed, { replies: {} }).usage).toBeUndefined()
      expect(captureLastRunUsageSnapshot(changed, { replies: {} })).toBeUndefined()
    }
  })

  it('never stores incomplete run coverage or contradictory counters', () => {
    const w = worker()
    expect(captureLastRunUsageSnapshot(w, { replies: {}, usage: usage() })).toBeUndefined()
    for (const bad of [
      { ...usage(), total: 999 }, { ...usage(), cacheRead: 100 },
      { ...usage(), reasoning: 6 }, { ...usage(), input: Number.MAX_SAFE_INTEGER, total: Number.MAX_SAFE_INTEGER },
      { ...usage(), scope: 'session' as const },
    ]) expect(captureLastRunUsageSnapshot(w, { replies: {}, runUsage: bad })).toBeUndefined()
  })

  it('does not resurrect a same-run Codex placeholder while preserving explicit native zero and a previous confirmed run', () => {
    const w = worker()
    w.preference.cli = 'codex'; w.status = 'interrupted'
    const zero = { total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, scope: 'run' as const }
    w.lastRunUsageSnapshot = { policy: 1, cli: 'codex', conversationId: w.conversationId!, runId: w.runId, usage: zero }
    const unknown = { replies: {}, unsettledRunUsage: true as const }
    expect(captureLastRunUsageSnapshot(w, unknown)).toBeUndefined()
    expect(withConversationTelemetry(w, unknown).usage).toBeUndefined()
    expect(captureLastRunUsageSnapshot(w, { replies: {}, runUsage: zero })?.usage).toEqual(zero)
    w.lastRunUsageSnapshot = captureLastRunUsageSnapshot(w, { replies: {}, runUsage: usage() })
    expect(captureLastRunUsageSnapshot(w, unknown)?.usage.total).toBe(38)
    expect(withConversationTelemetry(w, unknown).usage?.total).toBe(38)
  })

  it('keeps a cold-loaded Codex placeholder unknown when the same raw run proves it was unsettled', () => {
    const root = mkdtempSync(join(tmpdir(), 'cwn-codex-unsettled-')); roots.push(root)
    const w = worker(); w.preference.cli = 'codex'; w.status = 'interrupted'
    const zero = { total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, scope: 'run' as const }
    w.lastRunUsageSnapshot = { policy: 1, cli: 'codex', conversationId: w.conversationId!, runId: w.runId, usage: zero }
    const first = new WorkerStorage(root); first.save(w); first.close()
    const reopened = new WorkerStorage(root), loaded = reopened.workers.get(w.id)!
    reopened.close()
    const unknown = { replies: {}, unsettledRunUsage: true as const }
    expect(withConversationTelemetry(loaded, unknown).usage).toBeUndefined()
    expect(captureLastRunUsageSnapshot(loaded, unknown)).toBeUndefined()
    expect(captureLastRunUsageSnapshot(loaded, { replies: {}, runUsage: zero })?.usage).toEqual(zero)
  })

  it('validates each CLI counter convention without filling missing categories with zero', () => {
    const w = worker()
    const separate = { ...usage(), input: 20 }
    w.preference.cli = 'claude'
    expect(captureLastRunUsageSnapshot(w, { replies: {}, runUsage: separate })?.usage).toEqual(separate)
    w.preference.cli = 'mimo'
    const split = { ...usage(), input: 20, output: 3 }
    expect(captureLastRunUsageSnapshot(w, { replies: {}, runUsage: split })?.usage).toEqual(split)
    expect(captureLastRunUsageSnapshot(w, { replies: {}, runUsage: { ...split, reasoning: undefined } })?.usage).toEqual({ ...split, reasoning: undefined })
  })

  it('persists across cold load and drops a malformed optional snapshot without losing the Worker', () => {
    const root = mkdtempSync(join(tmpdir(), 'cwn-last-run-snapshot-')); roots.push(root)
    const w = worker(), storage = new WorkerStorage(root)
    w.lastRunUsageSnapshot = captureLastRunUsageSnapshot(w, { replies: {}, runUsage: usage() })
    storage.save(w)
    storage.close()
    const reopened = new WorkerStorage(root)
    expect(reopened.workers.get(w.id)?.lastRunUsageSnapshot).toEqual(w.lastRunUsageSnapshot)
    reopened.close()
    const path = join(root, `${w.id}.worker.json`), data = JSON.parse(readFileSync(path, 'utf8'))
    data.lastRunUsageSnapshot.usage.cacheRead = null
    writeFileSync(path, JSON.stringify(data))
    const corruptStorage = new WorkerStorage(root), corrupt = corruptStorage.workers.get(w.id)
    corruptStorage.close()
    expect(corrupt?.conversationId).toBe(w.conversationId)
    expect(corrupt?.lastRunUsageSnapshot).toBeUndefined()
  })
})
