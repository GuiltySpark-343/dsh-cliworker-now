import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  appendFileSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { extractTelemetry, TelemetryReader } from '../src/host/telemetry.ts'
import { WorkerRuntime } from '../src/host/runtime.ts'
import { WorkerStorage } from '../src/host/storage.ts'
import { DEFAULT_CONFIG, type ProcessBackend } from '../src/host/process.ts'
import { foldEvents, type Worker, type WorkerEvent } from '../src/shared/types.ts'

// Synthetic native metadata only. No real prompts, conversation files or account material.
const dirs: string[] = []
const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
  for (const path of dirs.splice(0)) rmSync(path, { recursive: true, force: true })
})
const dir = () => {
  const value = mkdtempSync(join(tmpdir(), 'cwn-native-context-'))
  dirs.push(value)
  return value
}
const native = (record: unknown) => ({ type: 'native', record })
const session = { type: 'session', id: 'synthetic-session', model: 'provider/model' }
const message = (id: string, input: number, extra: Record<string, unknown> = {}) => ({
  type: 'message.updated',
  properties: {
    info: {
      id,
      role: 'assistant',
      sessionID: session.id,
      providerID: 'provider',
      modelID: 'model',
      tokens: { total: input + 110, input, output: 50, reasoning: 10, cache: { read: 30, write: 20 } },
      ...extra,
    },
  },
})
const codex = (last: unknown, total: number, threadId = session.id) => ({
  method: 'thread/tokenUsage/updated',
  params: {
    threadId,
    tokenUsage: {
      total: { inputTokens: total - 5, outputTokens: 5, totalTokens: total, cachedInputTokens: 100 },
      last: { totalTokens: last, inputTokens: 100, outputTokens: 10, cachedInputTokens: 80 },
      modelContextWindow: 1000,
    },
  },
})

describe('native context occupancy stays separate from cumulative usage', () => {
  it.each(['opencode', 'mimo'] as const)(
    '%s uses its latest request input/cache buckets and exact model capacity',
    (cli) => {
      const capacity = {
        type: 'cliworker.model_context',
        source: `${cli}.provider.limit.context`,
        providerID: 'provider',
        modelID: 'model',
        contextCapacity: 5000,
      }
      const result = extractTelemetry(
        cli,
        [
          session,
          capacity,
          message('one', 500),
          message('one', 500),
          message('two', 40),
          { ...capacity, modelID: 'foreign-model', contextCapacity: 9999 },
          message('foreign', 9999, { sessionID: 'foreign-session' }),
          message('foreign-model', 9999, { modelID: 'foreign-model' }),
        ],
        { conversationId: session.id, model: session.model },
      )
      expect(result.contextUsed).toBe(cli === 'mimo' ? 70 : 90)
      expect(result.contextCapacity).toBe(5000)
      expect(result.contextEstimated).toBe(true)
      expect(result.contextBreakdown).toBeUndefined()
      expect(result.usage?.total).toBeGreaterThan(result.contextUsed!)
      expect(extractTelemetry(cli, [message('no-capacity', 5)]).contextCapacity).toBeUndefined()
    },
  )
  it('Codex uses last.totalTokens and never total counters or adds cached input again', () => {
    const result = extractTelemetry('codex', [
      session,
      codex(110, 5000),
      codex(110, 5000),
      { type: 'turn.completed', usage: { total_tokens: 5000, input_tokens: 4995, output_tokens: 5 } },
      codex(9999, 99999, 'foreign-session'),
    ])
    expect(result.usage).toMatchObject({ total: 5000, cacheRead: 100, scope: 'session' })
    expect(result.contextUsed).toBe(110)
    expect(result.contextCapacity).toBe(1000)
    expect(result.finalReply).toBeUndefined()
    expect(extractTelemetry('codex', [session, codex(0, 5000)]).contextUsed).toBe(0)
    expect(extractTelemetry('codex', [session, codex(null, 5000)]).contextUsed).toBeUndefined()
  })
  it.each(['kimi', 'grok'] as const)('%s only uses explicit session-bound ACP usage_update', (cli) => {
    const update = (used: unknown, id = session.id) => ({
      method: 'session/update',
      params: {
        sessionId: id,
        update: { sessionUpdate: 'usage_update', used, size: 4096 },
      },
    })
    const result = extractTelemetry(cli, [
      session,
      update(100),
      update(100),
      update(9999, 'other'),
      update(0),
    ])
    expect(result).toMatchObject({ contextUsed: 0, contextCapacity: 4096, contextEstimated: true })
    expect(result.usage).toBeUndefined()
    expect(result.contextBreakdown).toBeUndefined()
    expect(extractTelemetry(cli, [session, update(-1)]).contextUsed).toBeUndefined()
  })
  it('ZCode separates this process total from matching native context and rejects unknown sessions', () => {
    const snapshot = (id: string, used: number) => ({
      id: randomUUID(),
      result: {
        projection: { sessionId: id, contextUsed: used, contextWindow: 2048, totalTokenCount: 9000 },
      },
    })
    const result = extractTelemetry('zcode', [
      session,
      snapshot('unknown', 999),
      snapshot(session.id, 80),
      snapshot('foreign', 1000),
      snapshot(session.id, 0),
    ])
    expect(result).toMatchObject({
      contextUsed: 0,
      contextCapacity: 2048,
      usage: { total: 9000, scope: 'run' },
    })
    expect(result.contextBreakdown).toBeUndefined()
  })
  it('ZCode keeps main request context distinct from run buckets and ignores auxiliary model requests', () => {
    const usage = {
      inputTokens: 100,
      outputTokens: 10,
      totalTokens: 110,
      cacheReadTokens: 80,
      cacheWriteTokens: 0,
    }
    const update = {
      method: 'session/event',
      params: {
        sessionId: session.id,
        type: 'session.updated',
        payload: {
          type: 'model_request_completed',
          querySource: 'main_turn',
          providerId: 'provider',
          modelId: 'model',
          usage,
        },
      },
    }
    const terminal = {
      method: 'session/event',
      params: {
        sessionId: session.id,
        type: 'turn.completed',
        payload: { usage: { ...usage, inputTokens: 1000, totalTokens: 1010, reasoningTokens: 3 } },
      },
    }
    const result = extractTelemetry('zcode', [
      session,
      update,
      {
        ...update,
        params: {
          ...update.params,
          payload: {
            ...update.params.payload,
            querySource: 'auxiliary',
            usage: { ...usage, inputTokens: 9999 },
          },
        },
      },
      terminal,
      {
        result: {
          projection: { sessionId: session.id, contextUsed: 110, contextWindow: 2048, totalTokenCount: 9000 },
        },
      },
    ])
    expect(result.contextUsed).toBe(110)
    expect(result.usage).toMatchObject({
      total: 1010,
      input: 1000,
      output: 10,
      cacheRead: 80,
      cacheWrite: 0,
      reasoning: 3,
      scope: 'run',
    })
  })
  it.each(['pi', 'omp'] as const)(
    '%s retains session stats without treating post-compaction unknown as zero',
    (cli) => {
      const stats = (tokens: number | null, id = session.id) => ({
        type: 'cliworker.rpc_usage',
        cli,
        source: `${cli}.get_session_stats`,
        sessionId: id,
        usage: { total: 10000, input: 8000, output: 500, cacheRead: 1000, cacheWrite: 500 },
        contextUsage: { tokens, contextWindow: 16384 },
      })
      const result = extractTelemetry(cli, [session, stats(100), stats(100)])
      expect(result).toMatchObject({
        contextUsed: 100,
        contextCapacity: 16384,
        contextEstimated: true,
        usage: { total: 10000, scope: cli === 'omp' ? 'reported' : 'session' },
      })
      expect(extractTelemetry(cli, [session, stats(100), stats(null)]).contextUsed).toBeUndefined()
      expect(extractTelemetry(cli, [session, stats(0)]).contextUsed).toBe(0)
      expect(extractTelemetry(cli, [session, stats(9000, 'foreign')]).contextUsed).toBeUndefined()
    },
  )
  it('Claude latest request includes its separate cache buckets, not accumulated result input', () => {
    const result = extractTelemetry('claude', [
      {
        type: 'assistant',
        message: {
          usage: {
            input_tokens: 10,
            cache_read_input_tokens: 80,
            cache_creation_input_tokens: 8,
            output_tokens: 5,
          },
        },
      },
      {
        type: 'result',
        usage: {
          input_tokens: 1000,
          output_tokens: 500,
          cache_read_input_tokens: 800,
          cache_creation_input_tokens: 80,
        },
        modelUsage: { model: { contextWindow: 8192 } },
      },
    ])
    expect(result).toMatchObject({
      contextUsed: 98,
      contextCapacity: 8192,
      usage: { total: 2380, scope: 'run' },
    })
    expect(result.finalReply).toBeUndefined()
    expect(
      extractTelemetry('claude', [{ type: 'assistant', message: { usage: { input_tokens: 10 } } }])
        .contextUsed,
    ).toBeUndefined()
  })
  it('Claude summary accepts only native used categories and never fills missing categories by difference', () => {
    const summary = {
      type: 'cliworker.context_inspection',
      cli: 'claude',
      sessionId: session.id,
      source: 'claude.get_context_usage.summary',
      model: session.model,
      contextUsed: 1000,
      contextCapacity: 8192,
      categories: [
        { name: 'System prompt', tokens: 200, kind: 'used' },
        { name: 'System tools', tokens: 300, kind: 'used' },
        { name: 'MCP tools', tokens: 50, kind: 'used' },
        { name: 'Messages', tokens: 400, kind: 'used' },
        { name: 'Memory files', tokens: 50, kind: 'used' },
        { name: 'System tools (deferred)', tokens: 9000, kind: 'deferred' },
      ],
    }
    const result = extractTelemetry('claude', [session, summary])
    expect(result.contextBreakdown).toMatchObject({
      systemTokens: 200,
      toolTokens: 350,
      messageTokens: 400,
      estimated: true,
    })
    const partial = extractTelemetry('claude', [
      session,
      { ...summary, categories: [{ name: 'System prompt', tokens: 200, kind: 'used' }] },
    ])
    expect(partial.contextBreakdown?.messageTokens).toBeUndefined()
    expect(partial.contextBreakdown?.toolTokens).toBeUndefined()
    expect(
      extractTelemetry('claude', [session, { ...summary, sessionId: 'other' }]).contextUsed,
    ).toBeUndefined()
  })
  it('ignores Claude child assistants, foreign sessions and models while retaining main-only usage after raw projection', () => {
    const path = join(dir(), 'claude.raw.jsonl'),
      reader = new TelemetryReader()
    const assistant = (input: number, extra: Record<string, unknown> = {}, model = session.model) => ({
      type: 'assistant',
      session_id: session.id,
      parent_tool_use_id: null,
      message: {
        model,
        usage: { input_tokens: input, cache_read_input_tokens: 20, cache_creation_input_tokens: 5 },
      },
      ...extra,
    })
    writeFileSync(
      path,
      [
        session,
        assistant(10),
        assistant(9000, { parent_tool_use_id: 'child-call' }),
        assistant(8000, {}, 'foreign-model'),
        assistant(7000, { session_id: 'foreign-session' }),
        assistant(6000, { parent_tool_use_id: 'x'.repeat(1025) }),
      ]
        .map((value) => JSON.stringify(native(value)))
        .join('\n') + '\n',
    )
    expect(
      reader.read(path, 'claude', { conversationId: session.id, model: session.model }).contextUsed,
    ).toBe(35)
    expect(
      reader.read(path, 'claude', { conversationId: session.id, model: 'unconfirmed-alias' }).contextUsed,
    ).toBeUndefined()
  })
  it('Hermes HTTP throughput never invents a context meter or three-way breakdown', () => {
    const result = extractTelemetry('hermes', [
      {
        type: 'hermes.run',
        run_id: 'synthetic',
        usage: { total_tokens: 100000, input_tokens: 99900, output_tokens: 100 },
      },
    ])
    expect(result.usage?.total).toBe(100000)
    expect(result.contextUsed).toBeUndefined()
    expect(result.contextCapacity).toBeUndefined()
    expect(result.contextBreakdown).toBeUndefined()
  })
})

describe('private raw metric projection and runtime forwarding', () => {
  it.each(['kimi', 'grok', 'zcode', 'pi', 'omp', 'claude', 'opencode', 'mimo'] as const)(
    'retains the %s native context metadata whitelist through the private raw reader',
    (cli) => {
      const path = join(dir(), 'synthetic.raw.jsonl')
      const record =
        cli === 'kimi' || cli === 'grok'
          ? {
              method: 'session/update',
              params: {
                sessionId: session.id,
                update: { sessionUpdate: 'usage_update', used: 25, size: 1000 },
              },
            }
          : cli === 'zcode'
            ? { result: { projection: { sessionId: session.id, contextUsed: 25, contextWindow: 1000 } } }
            : cli === 'pi' || cli === 'omp'
              ? {
                  type: 'cliworker.rpc_usage',
                  cli,
                  sessionId: session.id,
                  source: `${cli}.get_session_stats`,
                  usage: { total: 500 },
                  contextUsage: { tokens: 25, contextWindow: 1000 },
                }
              : cli === 'claude'
                ? {
                    type: 'cliworker.context_inspection',
                    cli,
                    sessionId: session.id,
                    model: session.model,
                    source: 'claude.get_context_usage.summary',
                    contextUsed: 25,
                    contextCapacity: 1000,
                    categories: [{ name: 'Messages', tokens: 25, kind: 'used' }],
                  }
                : {
                    type: 'cliworker.model_context',
                    source: `${cli}.provider.limit.context`,
                    providerID: 'provider',
                    modelID: 'model',
                    contextCapacity: 1000,
                  }
      writeFileSync(path, [session, native(record)].map((value) => JSON.stringify(value)).join('\n') + '\n')
      const result = new TelemetryReader().read(path, cli, {
        conversationId: session.id,
        model: session.model,
      })
      expect(result.contextCapacity).toBe(1000)
      if (cli !== 'opencode' && cli !== 'mimo') expect(result.contextUsed).toBe(25)
      if (cli === 'claude') expect(result.contextBreakdown?.messageTokens).toBe(25)
    },
  )
  it('whitelists new native envelopes incrementally and scopes caches by session and CLI', () => {
    const path = join(dir(), 'synthetic.raw.jsonl'),
      reader = new TelemetryReader()
    writeFileSync(path, [session, native(codex(110, 5000))].map((v) => JSON.stringify(v)).join('\n') + '\n')
    expect(reader.read(path, 'codex').contextUsed).toBe(110)
    expect(reader.read(path, 'hermes').contextUsed).toBeUndefined()
    expect(reader.read(path, 'codex', { conversationId: 'foreign' }).contextUsed).toBeUndefined()
    appendFileSync(path, JSON.stringify(native(codex(30, 6000))) + '\n')
    expect(reader.read(path, 'codex').contextUsed).toBe(30)
    expect(reader.read(path, 'codex').usage?.total).toBe(6000)
    expect(reader.read(path, 'codex').usage?.total).toBe(6000)
  })
  it('rejects symbolic/hard links and refreshes a replacement inode without writing raw files', () => {
    const directory = dir(),
      path = join(directory, 'run.raw.jsonl'),
      reader = new TelemetryReader()
    const data = JSON.stringify(native(codex(10, 20))) + '\n'
    writeFileSync(path, data)
    const before = readFileSync(path)
    expect(reader.read(path, 'codex').contextUsed).toBe(10)
    expect(readFileSync(path)).toEqual(before)
    symlinkSync(path, join(directory, 'linked.raw.jsonl'))
    expect(reader.read(join(directory, 'linked.raw.jsonl'), 'codex').contextUsed).toBeUndefined()
    linkSync(path, join(directory, 'hard.raw.jsonl'))
    expect(reader.read(path, 'codex').contextUsed).toBeUndefined()
    rmSync(join(directory, 'hard.raw.jsonl'))
    const next = join(directory, 'replacement.raw.jsonl')
    writeFileSync(next, JSON.stringify(native(codex(30, 40))) + '\n')
    renameSync(next, path)
    expect(reader.read(path, 'codex').contextUsed).toBe(30)
  })
  it('keeps prompt/body fields outside cached metric projection and rejects oversized partial lines', () => {
    const path = join(dir(), 'run.raw.jsonl'),
      reader = new TelemetryReader()
    writeFileSync(
      path,
      JSON.stringify(
        native({
          ...codex(10, 20),
          body: 'synthetic private body',
          credential: 'synthetic private credential',
        }),
      ) + '\n',
    )
    expect(reader.read(path, 'codex').contextUsed).toBe(10)
    expect(JSON.stringify([...(reader as any).cache.values()])).not.toContain('synthetic private')
    appendFileSync(path, 'x'.repeat(1024 * 1024 + 1))
    expect(reader.read(path, 'codex').contextUsed).toBe(10)
  })
  it('forwards all safe meter metadata without exposing reply bookkeeping or borrowing another worker', () => {
    const project = dir(),
      storage = new WorkerStorage(join(project, 'state'))
    const backend: ProcessBackend = { resolveExecutable: vi.fn(), spawn: vi.fn() }
    const runtime = new WorkerRuntime(storage, backend, DEFAULT_CONFIG)
    cleanup.push(() => runtime.close())
    const worker: Worker = {
      id: randomUUID(),
      runId: randomUUID(),
      parentSessionId: 'parent',
      project,
      title: 'Synthetic context',
      preference: { cli: 'antigravity', model: 'confirmed', effort: 'low' },
      conversationId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      mode: 'accept-edits',
      status: 'completed',
      createdAt: '2026-10-16T00:00:00Z',
      updatedAt: '2026-10-16T00:00:01Z',
    }
    storage.save(worker)
    ;(runtime as any).agyContextReader.read = (id: string) =>
      id === worker.conversationId
        ? {
            contextUsed: 300,
            contextCapacity: 1000,
            contextEstimated: true,
            contextSource: 'synthetic native estimate',
            contextBreakdown: {
              systemTokens: 100,
              toolTokens: 150,
              messageTokens: 50,
              estimated: true,
              source: 'synthetic native categories',
            },
          }
        : undefined
    const snapshot = runtime.snapshot('parent', worker.id)
    expect(snapshot.telemetry?.contextBreakdown).toMatchObject({
      systemTokens: 100,
      toolTokens: 150,
      messageTokens: 50,
    })
    expect(snapshot.telemetry?.contextEstimated).toBe(true)
    expect(snapshot.telemetry).not.toHaveProperty('replies')
    expect(runtime.snapshot('parent').telemetry).toBeUndefined()
    expect(backend.spawn).not.toHaveBeenCalled()
  })
})

describe('public tool snapshots and terminal response scope', () => {
  const rows = (events: Partial<WorkerEvent>[]) =>
    foldEvents(
      events.map((event, index) => ({
        runId: 'run',
        seq: index,
        time: '',
        kind: 'tool',
        text: '',
        ...event,
      })) as WorkerEvent[],
    )
  it('merges explicit snapshots with zero exit status and missing fields preserved without inventing parents', () => {
    const result = rows([
      { step: 1, toolCall: { callId: 'tool', input: { path: 'synthetic' }, name: 'read' } },
      {
        step: 1,
        state: 'COMPLETED',
        toolCall: { output: 'synthetic output', input: undefined, exitCode: 0 },
      },
      { step: 2, toolCall: { name: 'unknown', input: '<script>synthetic</script>' } },
    ])
    expect(result[0]?.toolCall).toEqual({
      callId: 'tool',
      input: { path: 'synthetic' },
      name: 'read',
      output: 'synthetic output',
      exitCode: 0,
    })
    expect(result[1]?.toolCall?.parentCallId).toBeUndefined()
  })
  it('restores explicit tool metadata and terminal scope after reopening the private store', () => {
    const project = dir(),
      directory = join(project, 'state'),
      storage = new WorkerStorage(directory)
    const worker: Worker = {
      id: randomUUID(),
      runId: randomUUID(),
      parentSessionId: 'parent',
      project,
      title: 'Synthetic persisted tool',
      preference: { cli: 'codex', model: 'confirmed', effort: 'low' },
      mode: 'accept-edits',
      status: 'completed',
      createdAt: '2026-10-16T00:00:00Z',
      updatedAt: '2026-10-16T00:00:01Z',
    }
    storage.save(worker)
    storage.append(worker, {
      kind: 'tool',
      text: 'Synthetic command',
      step: 1,
      toolCall: {
        callId: 'call',
        parentCallId: 'parent-call',
        command: 'synthetic command',
        input: { value: 0 },
        output: '<script>inert synthetic text</script>',
        exitCode: 0,
      },
    })
    storage.append(worker, { kind: 'result', text: '  Synthetic answer\n', resultScope: 'response' })
    storage.close()
    const reopened = new WorkerStorage(directory)
    cleanup.push(() => reopened.close())
    const history = reopened.history(worker.id)
    expect(history[0]?.toolCall).toEqual(storage.history(worker.id)[0]?.toolCall)
    expect(history[1]?.resultScope).toBe('response')
    expect(foldEvents(history)[1]?.text).toBe('  Synthetic answer\n')
  })
  it('preserves single-response whitespace and never strips a shared prefix from a response-scoped result', () => {
    expect(
      rows([
        { kind: 'assistant', step: 1, text: '  answer\n' },
        { kind: 'result', text: '  answer\n', resultScope: 'response' },
      ])[0]?.text,
    ).toBe('  answer\n')
    const result = rows([
      { kind: 'assistant', step: 1, text: 'Hello' },
      { step: 2 },
      { kind: 'assistant', step: 3, text: 'Hello again' },
      { kind: 'result', text: 'Hello again', resultScope: 'response' },
    ])
    expect(result.filter((row) => row.kind === 'assistant').map((row) => row.text)).toEqual([
      'Hello',
      'Hello again',
    ])
  })
  it('strips only a fully verified run aggregate and keeps the final segment whitespace', () => {
    const result = rows([
      { kind: 'assistant', step: 1, text: 'First. ' },
      { step: 2 },
      { kind: 'assistant', step: 3, text: '  Last.\n' },
      { kind: 'result', text: 'First.   Last.\n', resultScope: 'run' },
    ])
    expect(result.filter((row) => row.kind === 'assistant').map((row) => row.text)).toEqual([
      'First. ',
      '  Last.\n',
    ])
  })
  it('does not erase an observed final segment when the terminal aggregate omits or contradicts it', () => {
    for (const text of ['First.', 'First.Wrong.', '']) {
      const result = rows([
        { kind: 'assistant', step: 1, text: 'First.' },
        { step: 2 },
        { kind: 'assistant', step: 3, text: 'Last.' },
        { kind: 'result', text, resultScope: 'run' },
      ])
      expect(result.filter((row) => row.kind === 'assistant').map((row) => row.text)).toEqual([
        'First.',
        'Last.',
      ])
    }
  })
})
