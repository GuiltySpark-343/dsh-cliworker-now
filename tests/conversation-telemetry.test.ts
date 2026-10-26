import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { PassThrough } from 'node:stream'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import { WorkerRuntime } from '../src/host/runtime.ts'
import { WorkerStorage } from '../src/host/storage.ts'
import { DEFAULT_CONFIG, type ProcessBackend } from '../src/host/process.ts'
import { addSessionUsage, captureConversationTelemetry, withConversationTelemetry } from '../src/host/conversation-telemetry.ts'
import type { TokenUsage } from '../src/shared/telemetry.ts'
import type { Worker } from '../src/shared/types.ts'

// Synthetic private receipts only. This suite never reads the user's CLI database or starts a process.
vi.mock('../src/host/agy-context.ts', () => ({ AgyContextReader: class { read() {} } }))
vi.mock('../src/host/cli-account-binding.ts', () => ({ readCliAccountBinding: async () => 'synthetic-account' }))
vi.mock('../src/host/authorized-catalog.ts', () => ({
  ACCOUNT_CHANGED: 'account changed',
  authorizeSelection: async (preference: unknown) => ({ binding: 'synthetic-account', preference }),
}))
const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})
const usage = (input = 100): TokenUsage & { scope: 'session' } => ({
  total: input + 7, input, output: 7, cacheRead: 40, scope: 'session',
})

function fixture(run = false) {
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'cwn-conversation-telemetry-')))
  cleanup.push(() => rmSync(project, { recursive: true, force: true }))
  const directory = join(project, 'private-state')
  const backend: ProcessBackend = {
    resolveExecutable: vi.fn(async () => { throw new Error('No CLI query is allowed in this fixture') }),
    spawn: vi.fn(() => { throw new Error('No CLI launch is allowed in this fixture') }),
  }
  // Hold actual runtime admission in its queue, so stop and recovery exercise real lifecycle code.
  const open = () => {
    const storage = new WorkerStorage(directory)
    const runtime = new WorkerRuntime(storage, backend, { ...DEFAULT_CONFIG, maxConcurrent: run ? 1 : 0 })
    cleanup.push(() => runtime.close())
    return { storage, runtime }
  }
  const { storage, runtime } = open()
  const worker: Worker = {
    id: randomUUID(), runId: randomUUID(), parentSessionId: 'synthetic-parent', project,
    title: 'Synthetic cumulative telemetry',
    preference: { cli: 'antigravity', model: 'synthetic-model', effort: 'default' },
    conversationId: 'synthetic-cli-session', mode: 'accept-edits', status: 'completed',
    createdAt: '2026-10-16T00:00:00.000Z', updatedAt: '2026-10-16T00:00:00.000Z',
  }
  storage.save(worker)
  storage.bindAccount(worker.id, 'synthetic-account')
  const raw = (source: Worker, input = 100) => {
    const record = { event: 'result', result: {
      conversation_id: source.conversationId,
      usage: { input_tokens: input, output_tokens: 7, cache_read_tokens: 40, total_tokens: input + 7 },
      duration_seconds: 21,
    } }
    writeFileSync(storage.rawPath(source), `${JSON.stringify(record)}\n`, { mode: 0o600 })
  }
  const submit = (preparationId?: string, submissionId?: string) => runtime.submit(
    worker.parentSessionId, project, worker.title, 'synthetic continuation', worker.preference,
    worker.mode, worker.id, undefined, 'synthetic-account', undefined, preparationId, submissionId,
  )
  return { project, directory, worker, storage, runtime, backend, raw, submit, open }
}

describe('same CLI conversation cumulative telemetry', () => {
  it.each([false, true])('never checkpoints a legacy raw receipt rejected for another session (prior receipt=%s)', async (prior) => {
    const f = fixture(true)
    if (prior) f.raw(f.worker)
    vi.mocked(f.backend.resolveExecutable).mockResolvedValue('/synthetic/agy')
    vi.mocked(f.backend.spawn).mockImplementation(() => {
      const stdout = new PassThrough(), stderr = new PassThrough()
      const done = Promise.resolve({ exitCode: 0 })
      queueMicrotask(() => {
        stdout.end([
          { event: 'init', conversation_id: f.worker.conversationId },
          { event: 'result', result: {
            conversation_id: 'different-synthetic-session', status: 'ERROR', response: 'untrusted result',
            usage: { input_tokens: 900, output_tokens: 9, cache_read_tokens: 40, total_tokens: 909 },
          } },
        ].map((value) => JSON.stringify(value)).join('\n') + '\n')
        stderr.end()
      })
      return { stdout, stderr, done, terminate() {}, waitForExit: async () => true } as SubprocessHandle
    })
    const rejected = await f.submit().done
    expect(rejected.status).toBe('failed')
    expect(rejected.error).toContain('conversation_id')
    expect(readFileSync(f.storage.rawPath(f.worker), 'utf8')).toContain('different-synthetic-session')
    expect(f.runtime.snapshot(f.worker.parentSessionId, f.worker.id).telemetry?.usage)
      .toEqual(prior ? usage() : undefined)
    expect(f.worker.conversationTelemetry?.usage).toEqual(prior ? usage() : undefined)
    // A subsequent admission must not re-label the rejected old raw data with the expected session ID.
    const next = f.submit()
    await f.runtime.stop(f.worker.parentSessionId, f.worker.id)
    await next.done
    await f.runtime.close()
    const reopened = f.open()
    expect(reopened.runtime.snapshot(f.worker.parentSessionId, f.worker.id).telemetry?.usage)
      .toEqual(prior ? usage() : undefined)
  })

  it('captures an existing historical receipt before native follow-up changes runId and survives stop/reload', async () => {
    const f = fixture()
    const sourceRunId = f.worker.runId
    f.raw(f.worker)
    expect(f.worker.conversationTelemetry).toBeUndefined()
    expect(f.runtime.snapshot(f.worker.parentSessionId, f.worker.id).telemetry)
      .toMatchObject({ usage: usage(), usageRunId: sourceRunId })
    const submitted = await f.runtime.prepareFollowup(
      f.worker.parentSessionId, f.worker.id, new AbortController().signal,
      async (_signal, preparationId) => f.submit(preparationId, randomUUID()),
    )
    expect(submitted.worker.runId).not.toBe(sourceRunId)
    for (let i = 0; i < 3; i++)
      expect(f.runtime.snapshot(f.worker.parentSessionId, f.worker.id).telemetry)
        .toMatchObject({ usage: usage(), usageRunId: sourceRunId, sessionDurationSeconds: 21 })
    expect(f.worker.conversationTelemetry).toMatchObject({
      cli: 'antigravity', conversationId: f.worker.conversationId, runId: sourceRunId, usage: usage(),
    })
    await f.runtime.stop(f.worker.parentSessionId, f.worker.id)
    await submitted.done
    await f.runtime.close()
    // A persisted checkpoint remains sufficient even when the source raw receipt is no longer available.
    rmSync(join(f.directory, `${f.worker.id}.${sourceRunId}.raw.jsonl`))
    const reopened = f.open()
    expect(reopened.runtime.snapshot(f.worker.parentSessionId, f.worker.id).telemetry)
      .toMatchObject({ usage: usage(), usageRunId: sourceRunId })
    expect(f.backend.spawn).not.toHaveBeenCalled()
    expect(f.backend.resolveExecutable).not.toHaveBeenCalled()
  })

  it('replaces the cumulative receipt once, keeps history response usage scoped, and persists the new source', async () => {
    const f = fixture()
    f.raw(f.worker)
    const firstRun = f.worker.runId
    const pending = f.submit()
    const nextRun = f.worker.runId
    f.raw(f.worker, 250)
    const before = f.runtime.snapshot(f.worker.parentSessionId, f.worker.id).telemetry
    expect(before).toMatchObject({ usage: usage(250), usageRunId: nextRun })
    expect(f.runtime.snapshot(f.worker.parentSessionId, f.worker.id).telemetry).toEqual(before)
    // Completion/stop captures the actual new receipt, rather than summing it with the old 107 tokens.
    await f.runtime.stop(f.worker.parentSessionId, f.worker.id)
    await pending.done
    expect(f.worker.conversationTelemetry?.usage.total).toBe(257)
    await f.runtime.close()
    rmSync(join(f.directory, `${f.worker.id}.${firstRun}.raw.jsonl`))
    rmSync(join(f.directory, `${f.worker.id}.${nextRun}.raw.jsonl`))
    const reopened = f.open()
    const snapshot = reopened.runtime.snapshot(f.worker.parentSessionId, f.worker.id)
    expect(snapshot.telemetry).toMatchObject({ usage: usage(250), usageRunId: nextRun })
    expect(snapshot.timeline.every((row) => row.usage === undefined)).toBe(true)
  })

  it('does not carry a checkpoint to another CLI, conversation, or unbound Worker', () => {
    const f = fixture()
    f.worker.conversationTelemetry = captureConversationTelemetry(f.worker, { replies: {}, usage: usage() })
    for (const changed of [
      { ...f.worker, preference: { ...f.worker.preference, cli: 'codex' as const } },
      { ...f.worker, conversationId: 'another-synthetic-session' },
      { ...f.worker, conversationId: undefined },
    ]) {
      expect(withConversationTelemetry(changed, { replies: {} }).usage).toBeUndefined()
      expect(captureConversationTelemetry(changed, { replies: {} })).toBeUndefined()
    }
    // A display-session repair does not change the external CLI conversation identity.
    expect(withConversationTelemetry({ ...f.worker, harnessConversation: undefined }, { replies: {} }).usage)
      .toEqual(usage())
  })

  it.each(['response', 'run', 'reported'] as const)('does not turn %s accounting into cumulative session usage', (scope) => {
    const f = fixture()
    const receipt = { replies: {}, usage: { ...usage(), scope } }
    expect(captureConversationTelemetry(f.worker, receipt)).toBeUndefined()
    expect(withConversationTelemetry(f.worker, receipt).usage?.scope).toBe(scope)
    f.worker.conversationTelemetry = captureConversationTelemetry(f.worker, { replies: {}, usage: usage() })
    f.worker.runId = randomUUID()
    // A current response is not added to the prior cumulative total and remains separately addressable.
    const reply = { ...usage(20), scope: 'response' as const }
    const visible = withConversationTelemetry(f.worker, { ...receipt, replies: { '2': reply } })
    expect(visible.usage).toEqual(usage())
    expect(visible.replies['2']).toEqual(reply)
  })

  it('does not fabricate missing buckets or treat cumulative tokens as context', () => {
    const f = fixture()
    f.worker.conversationTelemetry = captureConversationTelemetry(f.worker, {
      replies: {}, usage: usage(), contextUsed: 90, contextCapacity: 200,
    })
    f.worker.runId = randomUUID()
    const current = withConversationTelemetry(f.worker, { replies: {} })
    expect(current.contextUsed).toBeUndefined()
    expect(current.contextCapacity).toBeUndefined()
    const partial = withConversationTelemetry(f.worker, {
      replies: {}, usage: { total: 300, scope: 'session' }, contextUsed: 45, contextCapacity: 200,
    })
    expect(partial.usage).toEqual({ total: 300, scope: 'session' })
    expect(partial.contextUsed).toBe(45)
    expect(partial.usageRunId).toBe(f.worker.runId)
  })

  it('keeps an otherwise valid Worker readable if its optional checkpoint is malformed', async () => {
    const f = fixture()
    f.worker.conversationTelemetry = captureConversationTelemetry(f.worker, { replies: {}, usage: usage() })
    f.storage.save(f.worker)
    await f.runtime.close()
    const path = join(f.directory, `${f.worker.id}.worker.json`)
    const json = JSON.parse(readFileSync(path, 'utf8'))
    json.conversationTelemetry.usage.total = -1
    writeFileSync(path, JSON.stringify(json), { mode: 0o600 })
    const reopened = f.open()
    expect(reopened.storage.workers.get(f.worker.id)?.conversationTelemetry).toBeUndefined()
    expect(reopened.runtime.snapshot(f.worker.parentSessionId, f.worker.id).selected?.conversationId)
      .toBe('synthetic-cli-session')
  })
})

describe('usage across sessions of one task after an account change', () => {
  it('adds only buckets both sessions reported and keeps the session scope', () => {
    expect(addSessionUsage(undefined, usage())).toEqual(usage())
    expect(addSessionUsage(usage(), usage(200))).toEqual({
      total: 314, input: 300, output: 14, cacheRead: 80, scope: 'session',
    })
    // An unknown bucket on one side is not counted as zero.
    expect(addSessionUsage({ total: 50, input: 40, scope: 'session' }, usage()))
      .toEqual({ total: 157, input: 140, scope: 'session' })
    expect(addSessionUsage(
      { total: 10, scope: 'session', orchestration: { input: 3, output: 1 } },
      { total: 20, scope: 'session', orchestration: { input: 5 } },
    )).toEqual({ total: 30, scope: 'session', orchestration: { input: 8 } })
  })

  it('adds the left sessions to session usage, shows them alone before a receipt, and leaves run usage alone', () => {
    const f = fixture()
    f.worker.previousSessionUsage = usage(200)
    expect(withConversationTelemetry(f.worker, { replies: {}, usage: usage() }).usage).toEqual({
      total: 314, input: 300, output: 14, cacheRead: 80, scope: 'session',
    })
    expect(withConversationTelemetry(f.worker, { replies: {} }).usage).toEqual(usage(200))
    const run = { ...usage(), scope: 'run' as const }
    expect(withConversationTelemetry(f.worker, { replies: {}, usage: run }).usage).toEqual(run)
    // Context occupancy stays the current session's own figure.
    const current = withConversationTelemetry(f.worker, {
      replies: {}, usage: usage(), contextUsed: 45, contextCapacity: 200,
    })
    expect(current.contextUsed).toBe(45)
    f.worker.previousSessionUsage = { total: -1 } as TokenUsage
    expect(withConversationTelemetry(f.worker, { replies: {}, usage: usage() }).usage).toEqual(usage())
  })
})
