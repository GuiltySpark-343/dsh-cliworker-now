import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { PassThrough } from 'node:stream'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { WorkerStorage } from '../src/host/storage.ts'
import { WorkerRuntime } from './fixtures/legacy-runtime.ts'
import { DEFAULT_CONFIG, type ProcessBackend } from '../src/host/process.ts'
import type { Worker } from '../src/shared/types.ts'

// Synthetic AGY wire fixtures and private temporary projects; no CLI, model or Git command runs.
const bindings = vi.hoisted(() => ({ directories: [] as string[] }))
vi.mock('../src/host/cli-account-binding.ts', () => ({
  readCliAccountBinding: async (_cli: string, _backend: unknown, _config: unknown, directory: string) => {
    bindings.directories.push(directory)
    return 'synthetic-own-account'
  },
}))
vi.mock('../src/host/authorized-catalog.ts', () => ({
  ACCOUNT_CHANGED: '账号已变更，请重新选择或新建任务',
  authorizeSelection: async (preference: unknown) => ({ binding: 'synthetic-own-account', preference }),
}))
// Lets a test hold or refuse copy creation; otherwise the real implementation runs.
const copying = vi.hoisted(() => ({ mode: 'real' as 'real' | 'refuse' | 'hold' }))
vi.mock('../src/host/isolated-workspace.ts', async (original) => {
  const real = await original<typeof import('../src/host/isolated-workspace.ts')>()
  return {
    ...real,
    createIsolatedWorkspace: async (input: Parameters<typeof real.createIsolatedWorkspace>[0]) => {
      if (copying.mode === 'refuse') throw new real.IsolationUnavailableError('项目文件数超过隔离副本上限（20000 个）')
      if (copying.mode === 'hold') {
        // Start a real copy so cancellation has something to clean up.
        await real.createIsolatedWorkspace(input)
        await new Promise((_, reject) => {
          if (input.signal!.aborted) reject(input.signal!.reason)
          input.signal!.addEventListener('abort', () => reject(input.signal!.reason), { once: true })
        }).catch(async (error) => {
          await real.removeIsolatedWorkspace(input.root, input.workerId)
          throw error
        })
      }
      return real.createIsolatedWorkspace(input)
    },
  }
})

const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => {
  copying.mode = 'real'
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  bindings.directories.length = 0
})
const pref = { model: 'fixture-model', effort: 'high' as const }
const line = (event: object) => JSON.stringify(event) + '\n'
const result = (id: string) => line({ event: 'result', result: { conversation_id: id, status: 'SUCCESS', response: 'done' } })
class FakeBackend implements ProcessBackend {
  calls: { spec: SubprocessSpawnSpec; stdout: PassThrough; end: (code?: number) => void }[] = []
  async resolveExecutable() {
    return '/fixture/agy'
  }
  spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    const stdout = new PassThrough(),
      stderr = new PassThrough()
    let settle!: (value: unknown) => void
    const done = new Promise((resolve) => {
      settle = resolve
    })
    const end = (exitCode = 0) => {
      stdout.end()
      stderr.end()
      settle({ exitCode })
    }
    this.calls.push({ spec, stdout, end })
    spec.signal?.addEventListener('abort', () => end(143))
    return { stdout, stderr, done, terminate: () => end(143), waitForExit: async () => (await done, true) } as SubprocessHandle
  }
  /** Completes call `index` as the CLI conversation `id`. */
  finish(index: number, id: string) {
    this.calls[index]!.stdout.write(result(id))
    this.calls[index]!.end()
  }
}
function setup(isolated: boolean) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cwn-isolated-runtime-')))
  const project = join(root, 'project')
  mkdirSync(join(project, 'src'), { recursive: true })
  writeFileSync(join(project, 'src', 'a.ts'), 'one\ntwo\nthree\n')
  const state = join(root, 'state')
  const backend = new FakeBackend()
  const storage = new WorkerStorage(state)
  const runtime = new WorkerRuntime(storage, backend, { ...DEFAULT_CONFIG, maxConcurrent: 4 })
  if (isolated) runtime.setGeneralSettings({ isolatedParallelWrites: true })
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  cleanups.push(() => runtime.close())
  return { root, project, state, backend, storage, runtime }
}
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))
const until = (check: () => void) => vi.waitFor(check, { timeout: 5000, interval: 5 })
const copyOf = (state: string, worker: Worker) => join(realpathSync(join(state, 'isolated')), worker.id, 'copy', 'project')

describe('scheduling with the isolated-copy switch', () => {
  it('keeps same-directory writers serial when the switch is off', async () => {
    const { runtime, backend, project, state } = setup(false)
    expect(runtime.generalSettings().isolatedParallelWrites).toBe(false)
    const a = runtime.submit('p', project, 'a', 'a', pref, 'accept-edits')
    const b = runtime.submit('p', project, 'b', 'b', pref, 'accept-edits')
    await tick()
    expect(backend.calls).toHaveLength(1)
    expect(b.worker.status).toBe('queued')
    expect(existsSync(join(state, 'isolated'))).toBe(false)
    backend.finish(0, 'a')
    await a.done
    await until(() => expect(backend.calls).toHaveLength(2))
    expect(backend.calls[1]!.spec.cwd).toBe(project)
    expect(b.worker.isolation).toBeUndefined()
  })

  it('runs a conflicting new writer in its own copy and leaves non-conflicting work in place', async () => {
    const { runtime, backend, project, state } = setup(true)
    const preparations: { isolated?: boolean }[] = []
    runtime.setHarnessPreparation(async (_worker, _signal, input) => {
      preparations.push(input)
      return undefined
    })
    const a = runtime.submit('p', project, 'a', 'a', pref, 'accept-edits')
    await tick()
    expect(backend.calls[0]!.spec.cwd).toBe(project)
    expect(a.worker.isolation).toBeUndefined()
    const b = runtime.submit('p', project, 'b', 'edit a.ts', pref, 'accept-edits')
    await until(() => expect(backend.calls).toHaveLength(2))
    const copy = copyOf(state, b.worker)
    const spec = backend.calls[1]!.spec
    expect(spec.cwd).toBe(copy)
    // AGY's own workspace flag points at the copy; the prompt explains the copy.
    expect(spec.argv.slice(1, 3)).toEqual(['--add-dir', copy])
    expect(spec.argv.at(-1)).toContain('【隔离副本】')
    expect(spec.argv.at(-1)).toContain(project)
    expect(spec.argv.at(-1)).toContain('edit a.ts')
    expect(b.worker.isolation).toMatchObject({ state: 'ready', path: copy })
    expect(readFileSync(join(copy, 'src', 'a.ts'), 'utf8')).toBe('one\ntwo\nthree\n')
    // Account verification used the directory the CLI actually reads.
    expect(bindings.directories).toContain(copy)
    // The DSH tool bridge acts on the parent's project, so an isolated run does not get it.
    expect(preparations.map((input) => !!input.isolated)).toEqual([false, true])
    backend.finish(0, 'a')
    backend.finish(1, 'b')
    expect((await a.done).status).toBe('completed')
    expect((await b.done).status).toBe('completed')
  })

  it('does not move read-only work or existing main-directory conversations into a copy', async () => {
    const { runtime, backend, project } = setup(true)
    const a = runtime.submit('p', project, 'a', 'a', pref, 'accept-edits')
    const reader = runtime.submit('p', project, 'r', 'r', pref, 'plan')
    await tick()
    expect(backend.calls).toHaveLength(1)
    expect(reader.worker.status).toBe('queued')
    backend.finish(0, 'a')
    await a.done
    await until(() => expect(backend.calls).toHaveLength(2))
    backend.finish(1, 'r')
    await reader.done
    // `a` now owns a main-directory CLI session; its next turn may not change directory.
    const blocker = runtime.submit('p', project, 'c', 'c', pref, 'accept-edits')
    await until(() => expect(backend.calls).toHaveLength(3))
    const followup = runtime.submit('p', project, 'a', 'again', pref, 'accept-edits', a.worker.id)
    await tick()
    expect(followup.worker.status).toBe('queued')
    expect(followup.worker.isolation).toBeUndefined()
    backend.finish(2, 'c')
    await blocker.done
    await until(() => expect(backend.calls).toHaveLength(4))
    expect(backend.calls[3]!.spec.cwd).toBe(project)
    backend.finish(3, 'a')
    await followup.done
  })

  it('falls back to the serial queue with a visible reason when the copy is refused', async () => {
    const { runtime, backend, project, storage } = setup(true)
    copying.mode = 'refuse'
    const a = runtime.submit('p', project, 'a', 'a', pref, 'accept-edits')
    await tick()
    const b = runtime.submit('p', project, 'b', 'b', pref, 'accept-edits')
    await until(() => expect(storage.workers.get(b.worker.id)?.isolationNotice).toContain('隔离副本上限'))
    expect(b.worker.status).toBe('queued')
    expect(b.worker.isolation).toBeUndefined()
    expect(backend.calls).toHaveLength(1)
    expect(runtime.snapshot('p', b.worker.id).timeline.some((row) => row.text === '未创建隔离副本')).toBe(true)
    backend.finish(0, 'a')
    await a.done
    await until(() => expect(backend.calls).toHaveLength(2))
    expect(backend.calls[1]!.spec.cwd).toBe(project)
    backend.finish(1, 'b')
    await b.done
  })

  it('removes a partial copy and never starts the CLI when stopped while copying', async () => {
    const { runtime, backend, project, state } = setup(true)
    copying.mode = 'hold'
    const a = runtime.submit('p', project, 'a', 'a', pref, 'accept-edits')
    await tick()
    const b = runtime.submit('p', project, 'b', 'b', pref, 'accept-edits')
    await until(() => expect(existsSync(join(state, 'isolated', b.worker.id))).toBe(true))
    expect(b.worker.isolation?.state).toBe('preparing')
    const stopped = await runtime.stop('p', b.worker.id)
    expect(stopped).toMatchObject({ status: 'interrupted', interruptionReason: 'user' })
    expect(existsSync(join(state, 'isolated', b.worker.id))).toBe(false)
    expect(b.worker.isolation).toBeUndefined()
    expect(backend.calls).toHaveLength(1)
    backend.finish(0, 'a')
    await a.done
  })
})

describe('copy lifecycle', () => {
  async function isolatedWorker() {
    const context = setup(true)
    const { runtime, backend, project } = context
    const a = runtime.submit('p', project, 'a', 'a', pref, 'accept-edits')
    await tick()
    const b = runtime.submit('p', project, 'b', 'b', pref, 'accept-edits')
    await until(() => expect(backend.calls).toHaveLength(2))
    const copy = backend.calls[1]!.spec.cwd!
    return { ...context, a, b, copy }
  }

  it('returns follow-ups to the same copy until it is merged, then recreates it at the same path', async () => {
    const { runtime, backend, project, a, b, copy } = await isolatedWorker()
    // The isolated CLI edits its copy while the main-directory writer edits main.
    writeFileSync(join(copy, 'src', 'a.ts'), 'one\ntwo\nthree\nfour\n')
    writeFileSync(join(project, 'src', 'a.ts'), 'ONE\ntwo\nthree\n')
    backend.finish(1, 'conversation-b')
    await b.done
    const next = runtime.submit('p', project, 'b', 'more', pref, 'accept-edits', b.worker.id)
    await until(() => expect(backend.calls).toHaveLength(3))
    expect(backend.calls[2]!.spec.cwd).toBe(copy)
    expect(backend.calls[2]!.spec.argv).toEqual(expect.arrayContaining(['--conversation', 'conversation-b']))
    backend.finish(2, 'conversation-b')
    await next.done
    // A main-directory writer is still running: merging would race it.
    await expect(runtime.mergeIsolation('p', b.worker.id)).rejects.toThrow('主目录中有写任务正在运行')
    backend.finish(0, 'a')
    await a.done
    expect(await runtime.mergeIsolation('p', b.worker.id)).toEqual({ status: 'merged', written: ['src/a.ts'], deleted: [] })
    expect(readFileSync(join(project, 'src', 'a.ts'), 'utf8')).toBe('ONE\ntwo\nthree\nfour\n')
    expect(existsSync(copy)).toBe(false)
    expect(b.worker.isolation).toEqual({ state: 'released', path: copy })
    // The native session is tied to the copy path, so the next turn runs there again.
    const after = runtime.submit('p', project, 'b', 'after merge', pref, 'accept-edits', b.worker.id)
    await until(() => expect(backend.calls).toHaveLength(4))
    expect(backend.calls[3]!.spec.cwd).toBe(copy)
    expect(readFileSync(join(copy, 'src', 'a.ts'), 'utf8')).toBe('ONE\ntwo\nthree\nfour\n')
    backend.finish(3, 'conversation-b')
    await after.done
  })

  it('keeps the copy and the project unchanged on conflict, then discards on request', async () => {
    const { runtime, backend, project, a, b, copy, storage } = await isolatedWorker()
    writeFileSync(join(copy, 'src', 'a.ts'), 'one\nCOPY\nthree\n')
    writeFileSync(join(project, 'src', 'a.ts'), 'one\nMAIN\nthree\n')
    backend.finish(0, 'a')
    backend.finish(1, 'conversation-b')
    await Promise.all([a.done, b.done])
    const outcome = await runtime.mergeIsolation('p', b.worker.id)
    expect(outcome).toMatchObject({ status: 'conflict', copy, conflicts: [{ path: 'src/a.ts' }] })
    expect(readFileSync(join(project, 'src', 'a.ts'), 'utf8')).toBe('one\nMAIN\nthree\n')
    expect(storage.workers.get(b.worker.id)?.isolation?.state).toBe('conflict')
    await runtime.discardIsolation('p', b.worker.id)
    expect(existsSync(copy)).toBe(false)
    expect(b.worker.isolation).toEqual({ state: 'released', path: copy })
    expect(readFileSync(join(project, 'src', 'a.ts'), 'utf8')).toBe('one\nMAIN\nthree\n')
    await expect(runtime.discardIsolation('p', b.worker.id)).rejects.toThrow('没有待合并')
  })

  it('refuses merge or discard while the conversation is busy and refuses forks of copies', async () => {
    const { runtime, backend, a, b } = await isolatedWorker()
    await expect(runtime.mergeIsolation('p', b.worker.id)).rejects.toThrow('请等待本轮结束')
    await expect(runtime.discardIsolation('p', b.worker.id)).rejects.toThrow('请等待本轮结束')
    backend.finish(0, 'a')
    backend.finish(1, 'conversation-b')
    await Promise.all([a.done, b.done])
    await expect(
      runtime.forkWorker({ id: 'p' } as Agent, b.worker.id, '', {} as never, new AbortController().signal),
    ).rejects.toThrow('暂不支持分支')
  })

  it('recovers copy metadata after a Host restart', async () => {
    const { runtime, backend, state, a, b, copy } = await isolatedWorker()
    backend.finish(0, 'a')
    backend.finish(1, 'conversation-b')
    await Promise.all([a.done, b.done])
    await runtime.close()
    // Simulate a crash in the middle of a merge and an unfinished copy of another Worker.
    const unfinished: Worker = {
      ...b.worker,
      id: randomUUID(),
      conversationId: undefined,
      isolation: { state: 'preparing', path: join(state, 'isolated', 'x') },
    }
    let storage = new WorkerStorage(state)
    storage.save({ ...storage.workers.get(b.worker.id)!, isolation: { state: 'merging', path: copy } })
    storage.save(unfinished)
    mkdirSync(join(state, 'isolated', unfinished.id, 'copy'), { recursive: true })
    storage.close()
    storage = new WorkerStorage(state)
    const restarted = new WorkerRuntime(storage, backend, { ...DEFAULT_CONFIG })
    cleanups.push(() => restarted.close())
    expect(storage.workers.get(b.worker.id)?.isolation).toMatchObject({ state: 'ready', path: copy })
    expect(storage.workers.get(b.worker.id)?.isolation?.message).toContain('上次合并')
    expect(storage.workers.get(unfinished.id)?.isolation).toBeUndefined()
    expect(existsSync(join(state, 'isolated', unfinished.id))).toBe(false)
    expect(existsSync(copy)).toBe(true)
  })
})

it('persists the switch and rejects a non-boolean value', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cwn-isolated-settings-')))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  let storage = new WorkerStorage(join(root, 'state'))
  expect(storage.setGeneralSettings({ isolatedParallelWrites: true })).toEqual({ isolatedParallelWrites: true })
  expect(() => storage.setGeneralSettings({ isolatedParallelWrites: 'yes' })).toThrow()
  storage.close()
  storage = new WorkerStorage(join(root, 'state'))
  cleanups.push(() => storage.close())
  expect(storage.generalSettings()).toEqual({ isolatedParallelWrites: true })
  expect(storage.setGeneralSettings({ isolatedParallelWrites: null })).toEqual({})
})
