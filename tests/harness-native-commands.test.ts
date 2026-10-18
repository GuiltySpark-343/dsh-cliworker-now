import { afterEach, describe, expect, it, vi } from 'vitest'
import * as cordis from '@deepseek-ai/cordis'
import * as stores from '@deepseek-ai/dsh-client-store'
import * as react from 'react'
import * as jsx from 'react/jsx-runtime'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import type { InputTriggerSource } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import type { HarnessConversationBinding, Worker } from '../src/shared/types.ts'
import type { API, Snapshot } from '../src/client/workers.ts'
import { HarnessBindingRegistry } from '../src/client/harness-binding-registry.ts'
import { installHarnessNativeCommands } from '../src/client/harness-native-commands.ts'

// Load unmodified installed rc.2 browser bundles through their public exported
// factories. Real Trigger/Popup controllers and stores; synthetic Gateway,
// session lifetime and catalog. No external CLI, account or model is contacted.
const require = createRequire(import.meta.url)
function browserModule(name: string): any {
  let result: any
  const dependencies: Record<string, unknown> = {
    '@deepseek-ai/cordis': cordis,
    '@deepseek-ai/dsh-client-store': stores,
    '@deepseek-ai/dsh-client-ui-primitives': {},
    react,
    'react/jsx-runtime': jsx,
  }
  runInNewContext(readFileSync(require.resolve(`${name}/client`), 'utf8'), {
    window: {
      __ModuleLoader__: {
        load: ({ factory }: any) => {
          result = factory((id: string) => dependencies[id])
        },
      },
    },
    AbortController,
    AbortSignal,
    console: { error: () => undefined },
    setTimeout,
    clearTimeout,
  })
  return result
}
const { PopupSelectController } = browserModule('@deepseek-ai/dsh-client-ui-commands')
const { InputTriggerController } = browserModule('@deepseek-ai/dsh-client-ui-input-trigger')
const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})
const receipt = (value: unknown) => ({ ok: true as const, value: JSON.stringify(value) })
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const binding: HarnessConversationBinding = {
  sessionId: 'child',
  parentSessionId: 'parent',
  mode: 'continuable',
  capabilities: { model: true, permission: true, plan: true } as HarnessConversationBinding['capabilities'],
}
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
  harnessConversation: binding,
  createdAt: '2026-10-16T00:00:00Z',
  updatedAt: '2026-10-16T00:00:00Z',
}
const catalog = {
  cli: 'codex',
  models: [
    { id: 'first', label: 'First', efforts: ['low', 'high'] },
    { id: 'second', label: 'Second', efforts: ['medium'], variants: { medium: 'second-medium' } },
  ],
}
function fixture() {
  const sources: InputTriggerSource[] = []
  const consume = vi.fn(() => true),
    focus = vi.fn()
  const popup = new PopupSelectController({ consume, focusComposer: focus })
  const effects = new Set<() => void>()
  let nativeState = { openState: 'open', running: false, pendingSubmissions: [] as unknown[] }
  let inbox = { 'next-turn': [] as unknown[], 'next-step': [] as unknown[] }
  let snapshot: Snapshot = {
    selected: structuredClone(worker),
    workers: [],
    timeline: [],
    revision: 1,
    truncated: false,
  }
  let address = { parentSessionId: 'parent', childSessionId: 'child', mode: 'continuable' }
  const scope = {
    ctx: {
      effect: (run: () => () => void) => {
        const effect = run()
        const dispose = () => {
          if (effects.delete(dispose)) effect()
        }
        effects.add(dispose)
        return dispose
      },
    },
    session: {
      getSnapshot: () => nativeState,
      projections: { faceOf: () => ({ getSnapshot: () => inbox }) },
    },
  }
  const streams: { dispose: ReturnType<typeof vi.fn>; accept: ReturnType<typeof vi.fn> }[] = []
  const api = {
    cliworker: {
      watch: vi.fn(),
      catalogForWorker: vi.fn(async () => receipt(catalog)),
      configureWorker: vi.fn(async (_parent: string, _worker: string, preference: string) => {
        const next = JSON.parse(preference)
        return receipt({
          ...snapshot.selected!,
          preference: { ...next, model: next.model === 'second' ? 'second-medium' : next.model },
        })
      }),
      permissionForWorker: vi.fn(async () =>
        receipt({
          currentValue: snapshot.selected!.mode,
          writable: true,
          options: [
            { value: 'plan', name: '计划' },
            { value: 'accept-edits', name: '允许编辑' },
          ],
        }),
      ),
      configureWorkerPermission: vi.fn(async (_parent: string, _worker: string, mode: string) =>
        receipt({ ...snapshot.selected!, mode }),
      ),
    },
    $stream: vi.fn(() => {
      const stream = {
        dispose: vi.fn(async () => undefined),
        accept: vi.fn(),
        async *[Symbol.asyncIterator]() {
          yield { value: JSON.stringify(snapshot), accept: stream.accept }
        },
      }
      streams.push(stream)
      return stream
    }),
  }
  const bindings = new HarnessBindingRegistry()
  bindings.publish(binding, worker)
  const ctx = {
    sessions: {
      subagentAddress: (id: string) => (id === 'child' ? address : undefined),
      binding: (id: string) => (id === 'child' ? scope : undefined),
    },
    commandUi: { popupFor: vi.fn(() => popup) },
    inputTriggers: {
      sessionOf: () => trigger,
      registerSource: (source: InputTriggerSource) => {
        sources.push(source)
        return () => {
          sources.splice(sources.indexOf(source), 1)
        }
      },
    },
  }
  const dispose = installHarnessNativeCommands(ctx as any, bindings, api as unknown as API)
  cleanups.push(dispose, () => popup.dispose())
  const trigger = new InputTriggerController({
    actx: { bail: vi.fn(() => true) },
    sessionId: 'child',
    roster: { all: () => sources, sources: () => sources },
  })
  cleanups.push(() => trigger.dispose())
  const open = async (name = 'model') => {
    expect(await trigger.adjudicate(`/${name}`, new AbortController().signal, { attachments: 0 })).toBe(
      'handled',
    )
    await vi.waitFor(() => expect(popup.state.getSnapshot().status).toBe('ready'))
  }
  return {
    api,
    ctx,
    bindings,
    sources,
    popup,
    trigger,
    consume,
    focus,
    streams,
    effects,
    dispose,
    open,
    setSnapshot: (next: Partial<Snapshot>) => {
      snapshot = { ...snapshot, ...next }
    },
    setNative: (next: Partial<typeof nativeState>) => {
      nativeState = { ...nativeState, ...next }
    },
    setInbox: (next: typeof inbox) => {
      inbox = next
    },
    setAddress: (next: typeof address) => {
      address = next
    },
  }
}

describe('owned CLI commands through actual native trigger and Popup controllers', () => {
  it('offers only exact owned child settings and leaves parent/foreign sources untouched', async () => {
    const f = fixture(),
      source = f.sources[0]!
    const req = {
      query: '',
      position: 'leading' as const,
      drilled: false,
      signal: new AbortController().signal,
    }
    expect((await source.candidates({ sessionId: 'child' } as any, req)).map((item) => item.name)).toEqual([
      'model',
      'permission',
      'plan',
    ])
    expect(await source.candidates({ sessionId: 'parent' } as any, req)).toEqual([])
    expect(
      await source.matchEnter!({ sessionId: 'parent' } as any, '/model', req.signal, { attachments: 0 }),
    ).toBeUndefined()
    f.setAddress({ parentSessionId: 'foreign', childSessionId: 'child', mode: 'continuable' })
    expect(await source.candidates({ sessionId: 'child' } as any, req)).toEqual([])
    expect(f.api.$stream).not.toHaveBeenCalled()
  })
  it('routes an actual native menu keyboard pick into the same popup without consuming the draft early', async () => {
    const f = fixture()
    f.trigger.track('/mod', 4, { tier: 'plain' }, 7)
    await vi.waitFor(() => expect(f.trigger.menu.getSnapshot().groups[0]?.status).toBe('ready'))
    f.trigger.arbitrate('enter', false)
    await vi.waitFor(() => expect(f.popup.state.getSnapshot().status).toBe('ready'))
    expect(f.popup.state.getSnapshot().command).toBe('model')
    expect(f.consume).not.toHaveBeenCalled()
    await f.popup.select(1)
    expect(f.consume.mock.calls[0]?.[0]).toMatchObject({ via: 'menu', span: { draftRev: 7 } })
    expect(f.focus).toHaveBeenCalledOnce()
  })
  it('preserves true model/effort identities and lets the native popup single-flight selection and token CAS settle', async () => {
    const f = fixture()
    await f.open()
    const state = f.popup.state.getSnapshot()
    expect(state.options.map((option: any) => JSON.parse(option.id))).toEqual([
      ['codex', 'first', 'low'],
      ['codex', 'first', 'high'],
      ['codex', 'second', 'medium'],
    ])
    expect(state.options[0].active).toBe(true)
    const gate = deferred<ReturnType<typeof receipt>>()
    f.api.cliworker.configureWorker.mockImplementationOnce(() => gate.promise)
    const selecting = f.popup.select(2)
    await vi.waitFor(() => expect(f.api.cliworker.configureWorker).toHaveBeenCalledOnce())
    await f.popup.select(1)
    expect(f.api.cliworker.configureWorker).toHaveBeenCalledTimes(1)
    expect(f.api.cliworker.configureWorker.mock.calls[0]).toEqual([
      'parent',
      'worker',
      JSON.stringify({ cli: 'codex', model: 'second', effort: 'medium' }),
      expect.any(AbortSignal),
    ])
    gate.resolve(
      receipt({ ...worker, preference: { cli: 'codex', model: 'second-medium', effort: 'medium' } }),
    )
    await selecting
    expect(f.consume).toHaveBeenCalledExactlyOnceWith({ via: 'enter', token: '/model' })
    expect(f.popup.state.getSnapshot().open).toBe(false)
    expect(f.effects.size).toBe(0)
    expect(f.streams.every((stream) => stream.dispose.mock.calls.length === 1)).toBe(true)
  })
  it.each(['permission', 'plan'])(
    'uses the real permission contract for /%s without touching DSH parent permissions',
    async (command) => {
      const f = fixture()
      await f.open(command)
      expect(f.popup.state.getSnapshot().options.map((item: any) => item.id)).toEqual([
        'plan',
        'accept-edits',
      ])
      await f.popup.select(0)
      expect(f.api.cliworker.configureWorkerPermission).toHaveBeenCalledExactlyOnceWith(
        'parent',
        'worker',
        'plan',
        expect.any(AbortSignal),
      )
      expect(f.api.cliworker.configureWorker).not.toHaveBeenCalled()
      expect(f.consume).toHaveBeenCalledOnce()
    },
  )
  it('surfaces foreign catalog, identity and unsupported plan failures in the native popup', async () => {
    const f = fixture()
    f.api.cliworker.catalogForWorker.mockResolvedValueOnce(receipt({ ...catalog, cli: 'claude' }))
    await f.trigger.adjudicate('/model', new AbortController().signal, { attachments: 0 })
    await vi.waitFor(() => expect(f.popup.state.getSnapshot().status).toBe('failed'))
    expect(f.popup.state.getSnapshot().error).toContain('不匹配')
    f.setSnapshot({ selected: { ...worker, parentSessionId: 'foreign' } })
    f.popup.retry()
    await vi.waitFor(() => expect(f.popup.state.getSnapshot().status).toBe('failed'))
    f.setSnapshot({ selected: worker })
    f.api.cliworker.permissionForWorker.mockResolvedValueOnce(
      receipt({
        writable: true,
        currentValue: 'accept-edits',
        options: [{ value: 'accept-edits', name: '允许编辑' }],
      }),
    )
    await f.trigger.adjudicate('/plan', new AbortController().signal, { attachments: 0 })
    await vi.waitFor(() => expect(f.popup.state.getSnapshot().status).toBe('failed'))
    expect(f.popup.state.getSnapshot().error).toContain('不支持规划')
    expect(f.consume).not.toHaveBeenCalled()
  })
  it('checks both real native Inbox placements and local submissions before reading or saving settings', async () => {
    const f = fixture()
    for (const placement of ['next-turn', 'next-step'] as const) {
      f.setInbox({ 'next-turn': [], 'next-step': [], [placement]: [{ id: 'keep-original-id' }] })
      await f.trigger.adjudicate('/model', new AbortController().signal, { attachments: 0 })
      await vi.waitFor(() => expect(f.popup.state.getSnapshot().status).toBe('failed'))
    }
    expect(f.api.$stream).not.toHaveBeenCalled()
    f.setInbox({ 'next-turn': [], 'next-step': [] })
    await f.open()
    f.setNative({ pendingSubmissions: [{ id: 'native-pending' }] })
    await f.popup.select(1)
    expect(f.popup.state.getSnapshot().error).toContain('待发')
    expect(f.api.cliworker.configureWorker).not.toHaveBeenCalled()
    expect(f.consume).not.toHaveBeenCalled()
  })
  it('rechecks paused Worker outbox and Host refusal at selection, keeping the draft and allowing native retry', async () => {
    const f = fixture()
    await f.open('permission')
    f.setSnapshot({ queuedFollowups: [{ id: 'paused', paused: true }] as any })
    await f.popup.select(0)
    expect(f.api.cliworker.configureWorkerPermission).not.toHaveBeenCalled()
    f.setSnapshot({ queuedFollowups: [] })
    f.api.cliworker.configureWorkerPermission.mockResolvedValueOnce({
      ok: false,
      error: { message: 'Host queue lock' },
    } as any)
    await f.popup.select(0)
    expect(f.popup.state.getSnapshot()).toMatchObject({
      open: true,
      submitting: false,
      error: expect.stringContaining('Host queue lock'),
    })
    expect(f.consume).not.toHaveBeenCalled()
    await f.popup.select(0)
    expect(f.consume).toHaveBeenCalledOnce()
  })
  it('aborts dismissed discovery and ignores its stale response after a different native popup opens', async () => {
    const f = fixture(),
      gate = deferred<ReturnType<typeof receipt>>()
    f.api.cliworker.catalogForWorker.mockImplementationOnce(() => gate.promise)
    await f.trigger.adjudicate('/model', new AbortController().signal, { attachments: 0 })
    await vi.waitFor(() => expect(f.api.cliworker.catalogForWorker).toHaveBeenCalledOnce())
    const signal = (f.api.cliworker.catalogForWorker.mock.calls[0] as any)[2] as AbortSignal
    f.popup.dismiss({ focusComposer: true })
    expect(signal.aborted).toBe(true)
    expect(f.effects.size).toBe(0)
    await f.open('permission')
    gate.resolve(receipt(catalog))
    await Promise.resolve()
    expect(f.popup.state.getSnapshot().command).toBe('permission')
    expect(f.popup.state.getSnapshot().options[0].id).toBe('plan')
    expect(f.consume).not.toHaveBeenCalled()
  })
  it.each(['scope', 'registry', 'plugin'])(
    'revokes pending save settlement on %s disposal without consuming another session draft',
    async (kind) => {
      const f = fixture(),
        gate = deferred<ReturnType<typeof receipt>>()
      await f.open('permission')
      f.api.cliworker.configureWorkerPermission.mockImplementationOnce(() => gate.promise)
      const selecting = f.popup.select(0)
      await vi.waitFor(() => expect(f.api.cliworker.configureWorkerPermission).toHaveBeenCalledOnce())
      const signal = (f.api.cliworker.configureWorkerPermission.mock.calls[0] as any)[3] as AbortSignal
      if (kind === 'scope') for (const effect of [...f.effects]) effect()
      else if (kind === 'registry') f.bindings.clear()
      else f.dispose()
      expect(signal.aborted).toBe(true)
      gate.resolve(receipt({ ...worker, mode: 'plan' }))
      await selecting
      expect(f.consume).not.toHaveBeenCalled()
      expect(f.popup.state.getSnapshot().open).toBe(false)
      expect(f.effects.size).toBe(0)
    },
  )
  it('refuses unsupported command arguments and attachments through native adjudication without discarding either', async () => {
    const f = fixture()
    await expect(
      f.trigger.adjudicate('/permission danger-full-access', new AbortController().signal, {
        attachments: 0,
      }),
    ).rejects.toThrow('原生选项')
    await expect(
      f.trigger.adjudicate('/model', new AbortController().signal, { attachments: 1 }),
    ).rejects.toThrow('不接受附件')
    expect(f.consume).not.toHaveBeenCalled()
    expect(f.api.$stream).not.toHaveBeenCalled()
  })
})
