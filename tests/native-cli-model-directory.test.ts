import { afterEach, describe, expect, it, vi } from 'vitest'
import { NativeCliModelDirectory } from '../src/client/native-cli-model-directory.ts'
import type { API } from '../src/client/workers.ts'
import type { Worker } from '../src/shared/types.ts'

// Synthetic catalog and Gateway receipts; the directory and its observable
// state are real. No external CLI, account or model is contacted.
const disposers: Array<() => void> = []
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose()
})
const worker: Worker = {
  id: 'worker',
  parentSessionId: 'parent',
  project: '/synthetic/project',
  title: 'Synthetic worker',
  preference: { cli: 'codex', model: 'first', effort: 'low' },
  mode: 'accept-edits',
  status: 'completed',
  runId: 'run',
  conversationId: 'cli-conversation',
  createdAt: '2026-10-16T00:00:00Z',
  updatedAt: '2026-10-16T00:00:00Z',
}
const catalog = {
  cli: 'codex',
  models: [
    { id: 'first', label: 'First actual catalog item', efforts: ['low', 'high'] },
    {
      id: 'second',
      label: 'Second actual catalog item',
      efforts: ['medium', 'high'],
      variants: { high: 'second-high' },
    },
  ],
}
const receipt = (value: unknown) => ({ ok: true as const, value: JSON.stringify(value) })
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
function fixture() {
  const api = {
    cliworker: {
      catalogForWorker: vi.fn(async () => receipt(catalog)),
      configureWorker: vi.fn(async (_parent: string, _worker: string, selection: string) => {
        const preference = JSON.parse(selection)
        return receipt({
          ...worker,
          preference: {
            ...preference,
            model:
              preference.model === 'second' && preference.effort === 'high'
                ? 'second-high'
                : preference.model,
          },
        })
      }),
    },
  }
  const directory = new NativeCliModelDirectory(api as unknown as API, 'parent', worker)
  directory.sync(worker, false)
  disposers.push(() => directory.dispose())
  const load = async () => {
    directory.load()
    await vi.waitFor(() => expect(directory.store.getSnapshot().status).toBe('ready'))
  }
  return { api, directory, load }
}

describe('native CLI model directory behavior', () => {
  it('publishes only the current CLI catalog and saves model and effort without changing the CLI conversation', async () => {
    const { api, directory, load } = fixture()
    await load()
    expect(api.cliworker.catalogForWorker).toHaveBeenCalledWith('parent', 'worker', expect.any(AbortSignal))
    expect(directory.store.getSnapshot().groups).toMatchObject([
      {
        id: 'cliworker:codex',
        models: [
          { id: 'first', reasoning: { efforts: [{ id: 'low' }, { id: 'high' }] } },
          { id: 'second', reasoning: { efforts: [{ id: 'medium' }, { id: 'high' }] } },
        ],
      },
    ])
    expect(
      await directory.select({ provider: 'cliworker:codex', model: 'second', reasoningEffort: 'high' }),
    ).toEqual({ ok: true, value: undefined })
    expect(api.cliworker.configureWorker).toHaveBeenCalledExactlyOnceWith(
      'parent',
      'worker',
      JSON.stringify({ cli: 'codex', model: 'second', effort: 'high' }),
      expect.any(AbortSignal),
    )
    expect(directory.store.getSnapshot()).toMatchObject({
      current: { provider: 'cliworker:codex', model: 'second', reasoningEffort: 'high' },
      retainedEffort: 'High',
      pending: null,
      status: 'ready',
    })
  })
  it('rejects foreign providers, absent models and unadvertised efforts before any save', async () => {
    const { api, directory, load } = fixture()
    await load()
    for (const selection of [
      { provider: 'deepseek', model: 'first', reasoningEffort: 'low' },
      { provider: 'cliworker:claude', model: 'first', reasoningEffort: 'low' },
      { provider: 'cliworker:codex', model: 'missing', reasoningEffort: 'low' },
      { provider: 'cliworker:codex', model: 'first', reasoningEffort: 'ultra' },
    ])
      expect((await directory.select(selection)).ok).toBe(false)
    expect(api.cliworker.configureWorker).not.toHaveBeenCalled()
    expect(directory.store.getSnapshot().current).toEqual({
      provider: 'cliworker:codex',
      model: 'first',
      reasoningEffort: 'low',
    })
  })
  it('does not save while the Worker is locked', async () => {
    const { api, directory, load } = fixture()
    await load()
    directory.sync(worker, true)
    expect(
      (await directory.select({ provider: 'cliworker:codex', model: 'second', reasoningEffort: 'medium' }))
        .ok,
    ).toBe(false)
    expect(api.cliworker.configureWorker).not.toHaveBeenCalled()
    directory.sync(worker, false)
    expect(
      (await directory.select({ provider: 'cliworker:codex', model: 'second', reasoningEffort: 'medium' }))
        .ok,
    ).toBe(true)
  })
  it('admits at most one in-flight selection and exposes its native pending state', async () => {
    const { api, directory, load } = fixture()
    await load()
    const gate = deferred<ReturnType<typeof receipt>>()
    api.cliworker.configureWorker.mockImplementationOnce(() => gate.promise)
    const pending = directory.select({
      provider: 'cliworker:codex',
      model: 'second',
      reasoningEffort: 'high',
    })
    expect(directory.store.getSnapshot()).toMatchObject({
      status: 'selecting',
      pending: { model: 'second', reasoningEffort: 'high' },
    })
    const repeated = await directory.select({
      provider: 'cliworker:codex',
      model: 'first',
      reasoningEffort: 'low',
    })
    expect(repeated.ok).toBe(false)
    expect(api.cliworker.configureWorker).toHaveBeenCalledTimes(1)
    gate.resolve(
      receipt({ ...worker, preference: { ...worker.preference, model: 'second-high', effort: 'high' } }),
    )
    expect((await pending).ok).toBe(true)
  })
  it('keeps a newer watched model when an older pending selection returns after that observation', async () => {
    const { api, directory, load } = fixture()
    await load()
    const gate = deferred<ReturnType<typeof receipt>>()
    api.cliworker.configureWorker.mockImplementationOnce(() => gate.promise)
    const pending = directory.select({
      provider: 'cliworker:codex',
      model: 'second',
      reasoningEffort: 'high',
    })
    expect(directory.store.getSnapshot()).toMatchObject({ status: 'selecting' })
    // Another native control saved B after this control submitted A, while A's
    // Gateway response was still in flight. The watch is authoritative for B.
    directory.sync({ ...worker, preference: { ...worker.preference, model: 'first', effort: 'high' } }, false)
    expect(directory.store.getSnapshot()).toMatchObject({
      current: { provider: 'cliworker:codex', model: 'first', reasoningEffort: 'high' },
      status: 'selecting',
      pending: { model: 'second', reasoningEffort: 'high' },
    })
    gate.resolve(
      receipt({ ...worker, preference: { ...worker.preference, model: 'second-high', effort: 'high' } }),
    )
    expect((await pending).ok).toBe(true)
    expect(directory.store.getSnapshot()).toMatchObject({
      current: { provider: 'cliworker:codex', model: 'first', reasoningEffort: 'high' },
      retainedEffort: 'High',
      status: 'ready',
      pending: null,
      error: null,
    })
    expect(api.cliworker.configureWorker).toHaveBeenCalledTimes(1)
  })
  it('ignores stale directory results and aborts superseded discovery', async () => {
    const { api, directory } = fixture()
    const first = deferred<ReturnType<typeof receipt>>()
    api.cliworker.catalogForWorker.mockImplementationOnce(() => first.promise)
    directory.load()
    const oldSignal = api.cliworker.catalogForWorker.mock.calls[0]![2]
    directory.load()
    await vi.waitFor(() => expect(directory.store.getSnapshot().status).toBe('ready'))
    expect(oldSignal.aborted).toBe(true)
    const current = directory.store.getSnapshot()
    first.resolve(receipt({ cli: 'claude', models: [{ id: 'foreign', label: 'Foreign', efforts: ['low'] }] }))
    await Promise.resolve()
    expect(directory.store.getSnapshot()).toBe(current)
  })
  it('rejects a foreign CLI directory instead of making a provider fallback', async () => {
    const { api, directory } = fixture()
    api.cliworker.catalogForWorker.mockResolvedValueOnce(receipt({ ...catalog, cli: 'claude' }))
    directory.load()
    await vi.waitFor(() => expect(directory.store.getSnapshot().status).toBe('error'))
    expect(directory.store.getSnapshot().groups).toEqual([])
    expect(api.cliworker.configureWorker).not.toHaveBeenCalled()
  })
  it('does not publish a response after dispose or accept another selection', async () => {
    const { api, directory, load } = fixture()
    await load()
    const gate = deferred<ReturnType<typeof receipt>>()
    api.cliworker.configureWorker.mockImplementationOnce(() => gate.promise)
    const pending = directory.select({
      provider: 'cliworker:codex',
      model: 'second',
      reasoningEffort: 'high',
    })
    const beforeDispose = directory.store.getSnapshot()
    const saveSignal = api.cliworker.configureWorker.mock.calls[0]![3] as AbortSignal
    directory.dispose()
    expect(saveSignal.aborted).toBe(true)
    gate.resolve(
      receipt({ ...worker, preference: { ...worker.preference, model: 'second-high', effort: 'high' } }),
    )
    expect((await pending).ok).toBe(false)
    expect(directory.store.getSnapshot()).toBe(beforeDispose)
    expect(
      (await directory.select({ provider: 'cliworker:codex', model: 'first', reasoningEffort: 'low' })).ok,
    ).toBe(false)
    expect(api.cliworker.configureWorker).toHaveBeenCalledTimes(1)
  })
  it('rejects a save receipt for a different parent or Worker', async () => {
    const { api, directory, load } = fixture()
    await load()
    for (const changed of [{ id: 'other-worker' }, { parentSessionId: 'other-parent' }]) {
      api.cliworker.configureWorker.mockResolvedValueOnce(receipt({ ...worker, ...changed }))
      expect(
        (await directory.select({ provider: 'cliworker:codex', model: 'first', reasoningEffort: 'low' })).ok,
      ).toBe(false)
    }
  })
})
