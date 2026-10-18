import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { SessionBinding, SessionReference } from '@deepseek-ai/dsh-api-session-controller/client'
import { HarnessBindingRegistry, type HarnessNativeBinding } from '../src/client/harness-binding-registry.ts'
import { installHarnessNativeTelemetry, type HarnessProjectionSources } from '../src/client/harness-native-telemetry.tsx'
import type { WorkerSnapshot } from '../src/shared/types.ts'

// Synthetic Gateway snapshots and public HostObservable contracts. The exact
// generation cleanup below uses real Cordis; no React leaf or model is copied.
const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose() })
const binding: HarnessNativeBinding = {
  sessionId: 'child', parentSessionId: 'parent', workerId: 'worker', mode: 'continuable',
  capabilities: {} as HarnessNativeBinding['capabilities'],
}
function snapshot(): WorkerSnapshot {
  return {
    selected: { id: 'worker', parentSessionId: 'parent', harnessConversation: binding,
      preference: { cli: 'codex', model: 'synthetic-model', effort: 'default' } } as WorkerSnapshot['selected'],
    workers: [], timeline: [], revision: 1, truncated: false,
    telemetry: { usage: { total: 110, input: 100, output: 10, cacheRead: 80, scope: 'session' },
      contextUsed: 250, contextCapacity: 1000,
      contextBreakdown: { systemTokens: 20, toolTokens: 30, messageTokens: 200 } },
  }
}
function gatewayStream() {
  const controller = new AbortController()
  const queue: Array<{ value: string; accept: ReturnType<typeof vi.fn> }> = []
  let wake: (() => void) | undefined
  let ended = false
  const stream = {
    push(value: unknown) { queue.push({ value: typeof value === 'string' ? value : JSON.stringify(value), accept: vi.fn() }); wake?.() },
    end() { ended = true; wake?.() },
    dispose: vi.fn(async () => { controller.abort(); stream.end() }),
    signal: controller.signal,
    async *[Symbol.asyncIterator]() {
      while (true) {
        if (queue.length) { yield queue.shift()!; continue }
        if (ended) return
        await new Promise<void>((resolve) => { wake = resolve })
      }
    },
  }
  return stream
}
function fixture() {
  const registry = new HarnessBindingRegistry()
  registry.publish(binding, snapshot().selected!)
  const streams: ReturnType<typeof gatewayStream>[] = []
  const registrations: Array<{ reference: SessionReference; sources: HarnessProjectionSources; dispose: ReturnType<typeof vi.fn> }> = []
  const service = { provideProjections: vi.fn((reference: SessionReference, sources: HarnessProjectionSources) => {
    const dispose = vi.fn()
    registrations.push({ reference, sources, dispose })
    return dispose
  }) }
  const api = {
    cliworker: { watch: vi.fn(async () => undefined) },
    $stream: vi.fn((options: { open(signal: AbortSignal): unknown }) => {
      const stream = gatewayStream()
      options.open(stream.signal)
      streams.push(stream)
      return stream
    }),
  }
  const manager = installHarnessNativeTelemetry({ uiSession: service } as any, registry, api as any)
  cleanup.push(() => manager.dispose())
  const generation = (sessionId = 'child') => {
    const ctx = new Context()
    cleanup.push(() => ctx.fiber.dispose())
    return { ctx, sessionId } as unknown as SessionBinding
  }
  const reference = (value: SessionBinding) => ({ sessionId: value.sessionId, binding: value }) as SessionReference
  return { registry, service, api, manager, registrations, streams, generation, reference }
}
const token = { uncachedInputTokens: 20, outputTokens: 10, cacheReadTokens: 80, cacheWriteTokens: 0 }

describe('native session telemetry sources', () => {
  it('uses the explicitly injected Cordis uiSession face and cleans up when the consumer unloads', async () => {
    const f = fixture(), root = new Context()
    cleanup.push(() => root.fiber.dispose())
    root.provide('uiSession', f.service as never)
    let attach: ReturnType<typeof installHarnessNativeTelemetry>['attach'] | undefined
    const consumer = await root.plugin({
      name: 'synthetic-native-telemetry-consumer', inject: ['uiSession'],
      apply(scope: Context) {
        const manager = installHarnessNativeTelemetry(scope, f.registry, f.api as any)
        attach = manager.attach
        scope.effect(() => () => manager.dispose())
      },
    })
    attach!(f.reference(f.generation()), binding)
    expect(f.service.provideProjections).toHaveBeenCalledTimes(1)
    await consumer.dispose()
    expect(f.streams[0]!.dispose).toHaveBeenCalledTimes(1)
    expect(f.registrations[0]!.dispose).toHaveBeenCalledTimes(1)
  })

  it('owns native session and turn sources before the first Gateway receipt and publishes only real CLI values', async () => {
    const f = fixture()
    const detach = f.manager.attach(f.reference(f.generation()), binding)
    const { sources } = f.registrations[0]!
    expect(Object.keys(sources).sort()).toEqual(['contextBreakdown', 'contextPressure', 'externalRequestState', 'externalTurnAnswer', 'externalTurnUsage', 'telemetryAvailability', 'tokenUsage'])
    for (const [key, source] of Object.entries(sources)) if (key !== 'telemetryAvailability') expect(source.getSnapshot()).toBeUndefined()
    expect(sources.telemetryAvailability.getSnapshot()?.tokenUsage).toEqual({ state: 'pending', reason: 'awaiting-data' })
    expect(f.api.cliworker.watch).toHaveBeenCalledExactlyOnceWith('parent', 'worker', f.streams[0]!.signal)
    const changed = vi.fn()
    const unsubscribe = sources.tokenUsage.subscribe(changed)
    f.streams[0]!.push(snapshot())
    await vi.waitFor(() => expect(sources.tokenUsage.getSnapshot()).toEqual(token))
    expect(sources.contextPressure.getSnapshot()).toEqual({ pressureTokens: 250, contextWindow: 1000,
      externalContext: { breakdown: { systemTokens: 20, toolsTokens: 30, messageTokens: 200 } } })
    expect(sources.contextBreakdown.getSnapshot()).toEqual({ systemTokens: 20, toolsTokens: 30, messageTokens: 200 })
    const stable = sources.tokenUsage.getSnapshot()
    f.streams[0]!.push(snapshot())
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(sources.tokenUsage.getSnapshot()).toBe(stable)
    expect(changed).toHaveBeenCalledTimes(1)
    unsubscribe()
    detach()
  })

  it('passes exact run totals into the native turn source without changing unknown and fallback semantics', async () => {
    const f = fixture()
    f.manager.attach(f.reference(f.generation()), binding)
    const { sources } = f.registrations[0]!
    const externalTurnUsage = {
      '1': { basis: 'external-run', runIds: ['observed-run'], usage: { uncachedInputTokens: 20, outputTokens: 10, cacheReadTokens: 80, cacheWriteTokens: 0, totalTokens: 110 } },
      '2': null,
    }
    f.streams[0]!.push({ ...snapshot(), externalTurnUsage })
    await vi.waitFor(() => expect(sources.externalTurnUsage.getSnapshot()).toEqual(externalTurnUsage))
    expect(sources.externalTurnUsage.getSnapshot()?.['3']).toBeUndefined()
    f.streams[0]!.push(snapshot())
    await vi.waitFor(() => expect(sources.externalTurnUsage.getSnapshot()).toBeUndefined())
  })

  it('keeps proven historical answer anchors while the next run is busy and clears on lost ownership', async () => {
    const f = fixture()
    f.manager.attach(f.reference(f.generation()), binding)
    const { sources } = f.registrations[0]!
    const externalTurnAnswer = { '1': { answerSeq: 14, answerStep: 1, messageId: 'synthetic-answer', turnEndSeq: 27 } }
    f.streams[0]!.push({ ...snapshot(), externalTurnAnswer, selectedBusy: true })
    await vi.waitFor(() => expect(sources.externalTurnAnswer.getSnapshot()).toEqual(externalTurnAnswer))
    f.streams[0]!.push({ ...snapshot(), selected: { ...snapshot().selected, id: 'another-worker' }, externalTurnAnswer })
    await vi.waitFor(() => expect(sources.externalTurnAnswer.getSnapshot()).toBeUndefined())
  })

  it.each(['disconnect', 'wrong-worker', 'invalid-json'] as const)('retains only bound Turn unknowns after %s without leaking across owners or generations', async (failure) => {
    const f = fixture(), generation = f.generation()
    const detach = f.manager.attach(f.reference(generation), binding)
    const { sources, dispose } = f.registrations[0]!
    const externalTurnUsage = {
      '1': { basis: 'external-run', runIds: ['observed-run'], usage: { ...token, totalTokens: 110 } },
      '2': null,
    }
    f.streams[0]!.push({ ...snapshot(), externalTurnUsage })
    await vi.waitFor(() => expect(sources.externalTurnUsage.getSnapshot()).toEqual(externalTurnUsage))
    if (failure === 'disconnect') f.streams[0]!.end()
    else if (failure === 'invalid-json') f.streams[0]!.push('invalid json')
    else f.streams[0]!.push({ ...snapshot(), selected: { ...snapshot().selected, id: 'another-worker' },
      externalTurnUsage: { '9': null } })
    await vi.waitFor(() => expect(sources.externalTurnUsage.getSnapshot()).toEqual({ '1': null, '2': null }))
    for (const [key, source] of Object.entries(sources))
      if (!['telemetryAvailability', 'externalTurnUsage'].includes(key)) expect(source.getSnapshot()).toBeUndefined()
    expect(sources.externalTurnUsage.getSnapshot()?.['3']).toBeUndefined()
    expect(sources.externalTurnUsage.getSnapshot()?.['9']).toBeUndefined()
    expect(dispose).not.toHaveBeenCalled()
    expect(f.streams[0]!.dispose).toHaveBeenCalledTimes(1)
    f.streams[0]!.push({ ...snapshot(), externalTurnUsage })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(sources.externalTurnUsage.getSnapshot()).toEqual({ '1': null, '2': null })

    const nextGeneration = f.generation()
    f.manager.attach(f.reference(nextGeneration), binding)
    expect(f.registrations[1]!.sources.externalTurnUsage.getSnapshot()).toBeUndefined()
    f.registry.publish({ ...binding, parentSessionId: 'another-parent' }, snapshot().selected!)
    expect(sources.externalTurnUsage.getSnapshot()).toBeUndefined()
    expect(f.registrations[1]!.sources.externalTurnUsage.getSnapshot()).toBeUndefined()
    detach()
    expect(dispose).toHaveBeenCalledTimes(1)
  })

  it('releases disconnected Turn unknowns with the last reference and does not restore removed bindings', async () => {
    const f = fixture(), generation = f.generation()
    const detach = f.manager.attach(f.reference(generation), binding)
    const { sources, dispose } = f.registrations[0]!
    f.streams[0]!.push({ ...snapshot(), externalTurnUsage: { '1': null, '2': null } })
    await vi.waitFor(() => expect(sources.externalTurnUsage.getSnapshot()).toEqual({ '1': null, '2': null }))
    f.streams[0]!.push({ ...snapshot(), externalTurnUsage: { '2': null } })
    await vi.waitFor(() => expect(sources.externalTurnUsage.getSnapshot()).toEqual({ '2': null }))
    f.streams[0]!.end()
    await vi.waitFor(() => expect(sources.tokenUsage.getSnapshot()).toBeUndefined())
    expect(sources.externalTurnUsage.getSnapshot()).toEqual({ '2': null })
    detach()
    expect(sources.externalTurnUsage.getSnapshot()).toBeUndefined()
    expect(dispose).toHaveBeenCalledTimes(1)
  })

  it('shares one watch/provider across references to the same generation and releases only the final owner', () => {
    const f = fixture(), generation = f.generation()
    const one = f.manager.attach(f.reference(generation), binding)
    const two = f.manager.attach(f.reference(generation), { ...binding })
    expect(f.service.provideProjections).toHaveBeenCalledTimes(1)
    expect(f.api.$stream).toHaveBeenCalledTimes(1)
    one(); one()
    expect(f.streams[0]!.dispose).not.toHaveBeenCalled()
    expect(f.registrations[0]!.dispose).not.toHaveBeenCalled()
    two(); two()
    expect(f.streams[0]!.dispose).toHaveBeenCalledTimes(1)
    expect(f.registrations[0]!.dispose).toHaveBeenCalledTimes(1)
  })

  it.each(['disconnect', 'wrong-worker', 'invalid-json'] as const)('keeps explicit unknown overrides after %s instead of reverting to native estimates', async (failure) => {
    const f = fixture()
    f.manager.attach(f.reference(f.generation()), binding)
    const { sources, dispose } = f.registrations[0]!
    f.streams[0]!.push(snapshot())
    await vi.waitFor(() => expect(sources.tokenUsage.getSnapshot()).toEqual(token))
    if (failure === 'disconnect') f.streams[0]!.end()
    else if (failure === 'invalid-json') f.streams[0]!.push('invalid json')
    else f.streams[0]!.push({ ...snapshot(), selected: { ...snapshot().selected, id: 'another-worker' } })
    await vi.waitFor(() => expect(sources.tokenUsage.getSnapshot()).toBeUndefined())
    for (const [key, source] of Object.entries(sources)) if (key !== 'telemetryAvailability') expect(source.getSnapshot()).toBeUndefined()
    expect(sources.telemetryAvailability.getSnapshot()?.tokenUsage).toEqual({ state: 'unavailable', reason: 'disconnected' })
    expect(dispose).not.toHaveBeenCalled()
    expect(f.streams[0]!.dispose).toHaveBeenCalledTimes(1)
    f.streams[0]!.push(snapshot())
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(sources.tokenUsage.getSnapshot()).toBeUndefined()
  })

  it('rejects incorrect references before registering and clears an owner whose registry binding changes', async () => {
    const f = fixture()
    expect(() => f.manager.attach(f.reference(f.generation('parent')), binding)).toThrow('不一致')
    expect(() => f.manager.attach(f.reference(f.generation()), { ...binding, workerId: 'other' })).toThrow('不一致')
    expect(f.api.$stream).not.toHaveBeenCalled()
    f.manager.attach(f.reference(f.generation()), binding)
    const { sources } = f.registrations[0]!
    f.streams[0]!.push(snapshot())
    await vi.waitFor(() => expect(sources.tokenUsage.getSnapshot()).toEqual(token))
    f.registry.publish({ ...binding, parentSessionId: 'another-parent' }, snapshot().selected!)
    expect(sources.tokenUsage.getSnapshot()).toBeUndefined()
    expect(f.streams[0]!.signal.aborted).toBe(true)
  })

  it('separates generations of the same child and disposes sources with the actual Cordis generation', async () => {
    const f = fixture(), oldGeneration = f.generation(), nextGeneration = f.generation()
    const detachOld = f.manager.attach(f.reference(oldGeneration), binding)
    f.manager.attach(f.reference(nextGeneration), binding)
    expect(f.registrations).toHaveLength(2)
    f.streams[1]!.push(snapshot())
    await vi.waitFor(() => expect(f.registrations[1]!.sources.tokenUsage.getSnapshot()).toEqual(token))
    await oldGeneration.ctx.fiber.dispose()
    expect(f.streams[0]!.dispose).toHaveBeenCalledTimes(1)
    expect(f.registrations[0]!.dispose).toHaveBeenCalledTimes(1)
    expect(f.streams[1]!.dispose).not.toHaveBeenCalled()
    expect(f.registrations[1]!.sources.tokenUsage.getSnapshot()).toEqual(token)
    detachOld()
    f.manager.dispose(); f.manager.dispose()
    expect(f.streams[1]!.dispose).toHaveBeenCalledTimes(1)
    expect(() => f.manager.attach(f.reference(nextGeneration), binding)).toThrow('已卸载')
  })

  it('reports a missing host extension explicitly and releases registration when opening the Gateway throws', () => {
    const f = fixture()
    const missing = installHarnessNativeTelemetry({ uiSession: {} } as any, f.registry, f.api as any)
    cleanup.push(() => missing.dispose())
    expect(() => missing.attach(f.reference(f.generation()), binding)).toThrow('缺少原生会话统计数据接口')
    expect(f.api.$stream).not.toHaveBeenCalled()
    f.api.$stream.mockImplementation(() => { throw new Error('synthetic Gateway unavailable') })
    expect(() => f.manager.attach(f.reference(f.generation()), binding)).toThrow('Gateway unavailable')
    expect(f.registrations[0]!.dispose).toHaveBeenCalledTimes(1)
  })
})
