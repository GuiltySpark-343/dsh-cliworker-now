import { afterEach, expect, it, vi } from 'vitest'
import {
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  renameSync,
  chmodSync,
  linkSync,
  symlinkSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { PassThrough } from 'node:stream'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { WorkerRuntime } from '../src/host/runtime.ts'
import { WorkerStorage } from '../src/host/storage.ts'
import { CliWorkerService } from '../src/host/index.ts'
import { DEFAULT_CONFIG, type ProcessBackend } from '../src/host/process.ts'
import { authorizeSelection } from '../src/host/authorized-catalog.ts'
import type { Worker } from '../src/shared/types.ts'

// Synthetic account, process protocol and model checks only; no CLI/model is called.
vi.mock('../src/host/cli-account-binding.ts', () => ({
  readCliAccountBinding: async () => 'synthetic-account',
}))
vi.mock('../src/host/authorized-catalog.ts', () => ({
  ACCOUNT_CHANGED: 'synthetic account changed',
  authorizeSelection: vi.fn(async (preference: unknown) => ({ binding: 'synthetic-account', preference })),
}))
const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})
function deferred<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
function fixture(
  options: {
    cleanup?: boolean
    cleanupGate?: ReturnType<typeof deferred>
    selectionGate?: ReturnType<typeof deferred>
  } = {},
) {
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'cwn-followup-queue-')))
  cleanups.push(() => rmSync(project, { recursive: true, force: true }))
  const directory = join(project, 'state'),
    storage = new WorkerStorage(directory)
  const calls: Array<{ spec: SubprocessSpawnSpec; finish: (status?: string) => void }> = []
  const backend: ProcessBackend = {
    resolveExecutable: async () => '/synthetic/agy',
    spawn: (spec) => {
      const stdout = new PassThrough(),
        stderr = new PassThrough(),
        outcome = deferred<{ exitCode: number }>()
      const close = () => {
        stdout.end()
        stderr.end()
        outcome.resolve({ exitCode: 0 })
      }
      calls.push({
        spec,
        finish: (status = 'SUCCESS') => {
          if (status === 'UNCERTAIN')
            stdout.write(
              JSON.stringify({
                event: 'step_update',
                step_update: {
                  conversation_id: 'synthetic-session',
                  step_index: 1,
                  step_type: 'agent_response',
                  state: 'DONE',
                  text_delta: 'synthetic answer',
                },
              }) + '\n',
            )
          stdout.write(
            JSON.stringify({
              event: 'result',
              result: {
                conversation_id: 'synthetic-session',
                status: status === 'UNCERTAIN' ? 'ERROR' : status,
                response: 'synthetic answer',
                error: status === 'SUCCESS' ? undefined : 'synthetic failure',
              },
            }) + '\n',
          )
          close()
        },
      })
      spec.signal?.addEventListener('abort', close, { once: true })
      return {
        stdout,
        stderr,
        done: outcome.promise,
        terminate: close,
        waitForExit: async () => {
          await options.cleanupGate?.promise
          return options.cleanup !== false
        },
      } as SubprocessHandle
    },
  }
  const runtime = new WorkerRuntime(storage, backend, DEFAULT_CONFIG)
  cleanups.push(() => runtime.close())
  const worker: Worker = {
    id: randomUUID(),
    runId: randomUUID(),
    parentSessionId: 'parent',
    project,
    title: 'Synthetic queue',
    preference: { cli: 'antigravity', model: 'synthetic-model', effort: 'low' },
    mode: 'plan',
    status: 'completed',
    conversationId: 'synthetic-session',
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-01T00:00:00Z',
  }
  storage.save(worker)
  storage.bindAccount(worker.id, 'synthetic-account')
  const agent = {
    id: 'parent',
    ctx: {
      get: () => ({
        start: ({ run }: any) => {
          run()
          return randomUUID()
        },
      }),
    },
  }
  const service: any = Object.create(CliWorkerService.prototype)
  Object.assign(service, {
    runtime,
    backend,
    options: DEFAULT_CONFIG,
    disposed: new AbortController(),
    accounts: { isBusy: () => false },
    parent: vi.fn(async () => agent),
    project: () => project,
    assertExecution: vi.fn(),
    querySelection: vi.fn(
      async (
        preference: unknown,
        _backend: unknown,
        _config: unknown,
        _project: unknown,
        signal: AbortSignal,
      ) => {
        if (options.selectionGate) await options.selectionGate.promise
        signal.throwIfAborted()
        return { binding: 'synthetic-account', preference }
      },
    ),
  })
  runtime.setFollowupLauncher(async (current, item, admission, signal) => {
    await service.launch(
      agent,
      current.title,
      item.prompt,
      current.preference,
      current.mode,
      current.id,
      undefined,
      signal,
      undefined,
      admission,
    )
  })
  const start = () =>
    runtime.submit('parent', project, worker.title, 'initial', worker.preference, worker.mode, worker.id)
  const queue = (prompt: string, requestId = randomUUID()) =>
    runtime.queueFollowup('parent', worker.id, prompt, worker.runId, requestId)
  const items = () => runtime.snapshot('parent', worker.id).queuedFollowups!
  const ready = async (count: number) => {
    await vi.waitFor(() => expect(calls).toHaveLength(count))
    return calls[count - 1]!
  }
  return { runtime, storage, directory, worker, calls, service, start, queue, items, ready }
}

it('drains two messages FIFO after clean completion without a subscribed Panel, reauthorizing each turn', async () => {
  const f = fixture(),
    first = f.start()
  await f.ready(1)
  f.queue('second')
  f.queue('third')
  expect(f.items().map((item) => item.state)).toEqual(['pending', 'pending'])
  expect(f.storage.history(f.worker.id).filter((event) => event.kind === 'user')).toHaveLength(1)
  f.calls[0]!.finish()
  expect((await first.done).status).toBe('completed')
  const second = await f.ready(2)
  expect(second.spec.argv.at(-1)).toBe('任务：\nsecond')
  expect(second.spec.argv).toContain('synthetic-session')
  expect(f.items().map((item) => item.prompt)).toEqual(['third'])
  second.finish()
  const third = await f.ready(3)
  expect(third.spec.argv.at(-1)).toBe('任务：\nthird')
  expect(f.service.querySelection).toHaveBeenCalledTimes(2)
  third.finish()
  await vi.waitFor(() => expect(f.worker.status).toBe('completed'))
  expect(f.items()).toEqual([])
})

it('waits for process-scope cleanup, and preserves messages when cleanup fails', async () => {
  const cleanupGate = deferred(),
    f = fixture({ cleanup: false, cleanupGate }),
    task = f.start()
  await f.ready(1)
  f.queue('must not run')
  f.calls[0]!.finish()
  await new Promise((resolve) => setTimeout(resolve, 10))
  expect(f.calls).toHaveLength(1)
  expect(f.items()[0]?.state).toBe('pending')
  cleanupGate.resolve()
  expect((await task.done).status).toBe('failed')
  expect(f.items()[0]).toMatchObject({ prompt: 'must not run', state: 'paused' })
  expect(f.service.querySelection).not.toHaveBeenCalled()
})

it('pauses failures and stop, keeps appended text paused, and resumes only on explicit retry', async () => {
  const f = fixture(),
    first = f.start()
  await f.ready(1)
  f.queue('after failure')
  f.calls[0]!.finish('ERROR')
  await first.done
  expect(f.items()[0]?.state).toBe('paused')
  f.queue('also paused')
  expect(f.items().map((item) => item.state)).toEqual(['paused', 'paused'])
  f.runtime.retryQueuedFollowups('parent', f.worker.id, f.worker.runId)
  await f.ready(2)
  await f.runtime.stop('parent', f.worker.id)
  expect(f.items()).toMatchObject([{ prompt: 'also paused', state: 'paused' }])
  expect(f.calls).toHaveLength(2)
})

it('never follows an uncertain native outcome automatically', async () => {
  const f = fixture(),
    first = f.start()
  await f.ready(1)
  f.queue('wait for verification')
  f.calls[0]!.finish('UNCERTAIN')
  expect((await first.done).status).toBe('uncertain')
  expect(f.items()[0]).toMatchObject({ state: 'paused', prompt: 'wait for verification' })
  expect(f.items()[0]?.pauseReason).toContain('结果待核实')
  expect(f.service.querySelection).not.toHaveBeenCalled()
})

it('retains an unsent message if no native conversation was received', async () => {
  const f = fixture()
  f.worker.conversationId = undefined
  f.queue('no invented session')
  await vi.waitFor(() => expect(f.items()[0]?.state).toBe('paused'))
  expect(f.items()[0]?.prompt).toBe('no invented session')
  expect(f.calls).toHaveLength(0)
  expect(() => f.runtime.retryQueuedFollowups('parent', f.worker.id, f.worker.runId)).toThrow('会话标识')
})

it.each(['stop', 'cancel'] as const)(
  'cannot dispatch after %s wins a metadata validation race',
  async (action) => {
    const selectionGate = deferred(),
      f = fixture({ selectionGate }),
      first = f.start()
    await f.ready(1)
    const item = f.queue('must not start')
    f.calls[0]!.finish()
    await first.done
    await vi.waitFor(() => expect(f.items()[0]?.state).toBe('sending'))
    let stopped: Promise<Worker> | undefined,
      stopResolved = false
    if (action === 'stop') {
      stopped = f.runtime.stop('parent', f.worker.id).then((worker) => {
        stopResolved = true
        return worker
      })
      await Promise.resolve()
      expect(stopResolved).toBe(false)
    } else f.runtime.cancelQueuedFollowup('parent', f.worker.id, item.id)
    selectionGate.resolve()
    await stopped
    await vi.waitFor(() => expect((f.runtime as any).followupDispatches.size).toBe(0))
    expect(f.calls).toHaveLength(1)
    expect(f.items()).toHaveLength(action === 'stop' ? 1 : 0)
    if (action === 'stop') expect(f.items()[0]?.state).toBe('paused')
  },
)

it('rejects foreign and stale operations and deduplicates submitted requests', async () => {
  const f = fixture(),
    first = f.start()
  await f.ready(1)
  const id = randomUUID(),
    item = f.queue('once', id)
  expect(f.queue('once', id)).toEqual(item)
  expect(() => f.queue('different', id)).toThrow('消息不同')
  expect(() => f.runtime.queueFollowup('other', f.worker.id, 'x', f.worker.runId, randomUUID())).toThrow(
    'belong',
  )
  expect(() => f.runtime.queueFollowup('parent', f.worker.id, 'x', randomUUID(), randomUUID())).toThrow(
    '状态已变化',
  )
  expect(() => f.runtime.cancelQueuedFollowup('other', f.worker.id, id)).toThrow('belong')
  f.runtime.cancelQueuedFollowup('parent', f.worker.id, id)
  expect(() => f.queue('once', id)).toThrow('已经处理')
  await f.runtime.stop('parent', f.worker.id)
  await first.done
  expect(f.calls).toHaveLength(1)
})

it('restores private pending text as paused after Host restart without replay', async () => {
  const f = fixture()
  f.start()
  await f.ready(1)
  f.queue('survive restart')
  await f.runtime.close()
  expect(statSync(join(f.directory, `${f.worker.id}.followups.json`)).mode & 0o777).toBe(0o600)
  const storage = new WorkerStorage(f.directory)
  const backend = { resolveExecutable: vi.fn(), spawn: vi.fn() } as unknown as ProcessBackend
  const runtime = new WorkerRuntime(storage, backend, DEFAULT_CONFIG)
  cleanups.push(() => runtime.close())
  const launcher = vi.fn(async () => {})
  runtime.setFollowupLauncher(launcher)
  expect(runtime.snapshot('parent', f.worker.id).queuedFollowups).toMatchObject([
    { prompt: 'survive restart', state: 'paused', pauseReason: 'Host 已重启，请确认后继续发送' },
  ])
  await Promise.resolve()
  expect(launcher).not.toHaveBeenCalled()
  expect(backend.spawn).not.toHaveBeenCalled()
})

it('preserves text when the actual launch rejects changed account, model or planning permission', async () => {
  const f = fixture(),
    first = f.start()
  await f.ready(1)
  f.queue('retain rejected message')
  f.service.querySelection.mockRejectedValueOnce(new Error('账号或模型已变更'))
  f.calls[0]!.finish()
  await first.done
  await vi.waitFor(() => expect(f.items()[0]?.state).toBe('paused'))
  expect(f.items()[0]?.pauseReason).toContain('账号或模型已变更')
  f.service.assertExecution.mockImplementation(() => {
    throw new Error('规划模式不可执行')
  })
  f.runtime.retryQueuedFollowups('parent', f.worker.id, f.worker.runId)
  await vi.waitFor(() => expect(f.items()[0]?.pauseReason).toContain('规划模式不可执行'))
  expect(f.calls).toHaveLength(1)
})

it('keeps the original queued item when execution-time authorization fails after Host admission', async () => {
  const f = fixture(),
    first = f.start()
  await f.ready(1)
  const item = f.queue('keep original request identity')
  vi.mocked(authorizeSelection).mockRejectedValueOnce(new Error('执行时模型目录已失效'))
  f.calls[0]!.finish()
  await first.done
  await vi.waitFor(() => expect(f.worker.status).toBe('failed'))
  expect(f.items()).toMatchObject([{ id: item.id, prompt: item.prompt, state: 'paused' }])
  expect(f.worker.error).toContain('执行时模型目录已失效')
  expect(f.calls).toHaveLength(1)
  f.runtime.retryQueuedFollowups('parent', f.worker.id, f.worker.runId)
  const resumed = await f.ready(2)
  expect(f.items()).toEqual([])
  resumed.finish()
})

it('rejects idle legacy history without account binding before persisting a queue', () => {
  const f = fixture()
  rmSync(join(f.directory, `${f.worker.id}.account-binding.json`))
  expect(() => f.queue('must not bypass account binding')).toThrow('账号')
  expect(f.items()).toEqual([])
})

it.each(['hardlink', 'symlink'] as const)(
  'rejects a %s outbox without changing its external target',
  async (kind) => {
    const f = fixture()
    f.start()
    await f.ready(1)
    f.queue('private queued text')
    await f.runtime.close()
    const path = join(f.directory, `${f.worker.id}.followups.json`),
      external = join(f.worker.project, 'external.json')
    renameSync(path, external)
    chmodSync(external, 0o644)
    if (kind === 'hardlink') linkSync(external, path)
    else symlinkSync(external, path)
    const storage = new WorkerStorage(f.directory)
    expect(
      () =>
        new WorkerRuntime(
          storage,
          { resolveExecutable: vi.fn(), spawn: vi.fn() } as unknown as ProcessBackend,
          DEFAULT_CONFIG,
        ),
    ).toThrow('无法核验')
    expect(statSync(external).mode & 0o777).toBe(0o644)
  },
)

it('rechecks parent execution permissions after waiting behind another write task', async () => {
  const f = fixture(),
    first = f.start()
  await f.ready(1)
  f.queue('must retain while plan blocks execution')
  const blocker = f.runtime.submit(
    'other-parent',
    f.worker.project,
    'Synthetic blocker',
    'hold directory',
    f.worker.preference,
    'accept-edits',
  )
  let planning = false
  f.runtime.setQueuedExecutionGuard(() => {
    if (planning) throw new Error('宿主已切换规划模式')
  })
  f.calls[0]!.finish()
  await first.done
  await f.ready(2)
  await vi.waitFor(() => expect(f.worker.status).toBe('queued'))
  planning = true
  f.calls[1]!.finish()
  await blocker.done
  await vi.waitFor(() => expect(f.worker.status).toBe('failed'))
  expect(f.worker.error).toContain('规划模式')
  expect(f.items()).toMatchObject([{ prompt: 'must retain while plan blocks execution', state: 'paused' }])
  expect(f.calls).toHaveLength(2)
})
