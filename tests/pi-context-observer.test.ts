import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'
import { TelemetryReader } from '../src/host/telemetry.ts'
import { resolve } from 'node:path'
import { PI_CONTEXT_ENV, estimatePiContextCategories, preparePiContextObserver, readPiContextObservation, registerPiContextObserver } from '../src/host/pi-context-observer.mjs'

// Explicitly simulated SDK primitives. Installed official primitives are checked
// separately offline; no test performs account discovery or model generation.
const primitives = () => ({
  getCurrentSystemMessage: vi.fn(() => ({ role: 'system', content: 'SIMULATED-prompt', sections: { policy: 'SIMULATED-policy' },
    toolsAdded: [{ name: 'SIMULATED-read' }], timestamp: 0 })),
  estimateTokens: vi.fn((message: any) => message.role === 'user' ? 11 : message.content ? 17 : message.toolsAdded?.length ? 23 : 0),
})
const record = () => ({ type: 'cliworker.pi_context_observation', nonce: 'SIMULATED-nonce', sequence: 1,
  sessionId: 'SIMULATED-session', provider: 'SIMULATED-provider', model: 'SIMULATED-model', contextCapacity: 1000,
  categories: [{ name: 'System prompt', tokens: 17, kind: 'used' }, { name: 'System tools', tokens: 23, kind: 'used' }, { name: 'Messages', tokens: 11, kind: 'used' }] })
const binding = { nonce: 'SIMULATED-nonce', sessionId: 'SIMULATED-session', provider: 'SIMULATED-provider', model: 'SIMULATED-model', sequence: 0, active: true }

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

describe('Pi actual-transcript context observer', () => {
  it('uses the supplied official primitives for prompt, resolved tools and individual messages without billing input', () => {
    const sdk = primitives(), messages = [{ role: 'system', content: 'SIMULATED-first' }, { role: 'user', content: 'SIMULATED-user' }]
    expect(estimatePiContextCategories(messages, sdk)).toEqual(record().categories)
    expect(sdk.getCurrentSystemMessage).toHaveBeenCalledWith(messages)
    expect(sdk.estimateTokens.mock.calls[0][0]).toMatchObject({ content: 'SIMULATED-prompt', sections: { policy: 'SIMULATED-policy' } })
    expect(sdk.estimateTokens.mock.calls[0][0]).not.toHaveProperty('toolsAdded')
    expect(sdk.estimateTokens.mock.calls[1][0]).toMatchObject({ content: '', toolsAdded: [{ name: 'SIMULATED-read' }] })
  })
  it('preserves explicit native zero tools while refusing unknown system and invalid estimates', () => {
    const sdk = primitives()
    expect(estimatePiContextCategories([{ role: 'UNSUPPORTED_NATIVE_ROLE' }], sdk)).toBeUndefined()
    sdk.getCurrentSystemMessage.mockReturnValue({ role: 'system', content: 'SIMULATED-prompt', timestamp: 0 } as any)
    expect(estimatePiContextCategories([], sdk)?.[1].tokens).toBe(0)
    sdk.getCurrentSystemMessage.mockReturnValue(undefined as any)
    expect(estimatePiContextCategories([], sdk)).toBeUndefined()
    sdk.getCurrentSystemMessage.mockReturnValue({ role: 'system' } as any)
    sdk.estimateTokens.mockReturnValue(Number.NaN)
    expect(estimatePiContextCategories([], sdk)).toBeUndefined()
  })
  it('does not mutate or return the request transcript, and emits counts without private content', () => {
    const handlers = new Map<string, Function>(), emitted: any[] = [], sdk = primitives()
    registerPiContextObserver({ on: (name: string, handler: Function) => handlers.set(name, handler) }, sdk, binding.nonce, (event: any) => emitted.push(event))
    const messages = [{ role: 'user', content: 'PRIVATE_REQUEST_DO_NOT_EMIT' }], before = structuredClone(messages)
    const context = { mode: 'rpc', model: { provider: binding.provider, id: binding.model, contextWindow: 1000 }, sessionManager: { getSessionId: () => binding.sessionId } }
    expect(handlers.get('context_with_system')!({ messages }, context)).toBeUndefined()
    expect(messages).toEqual(before)
    expect(emitted).toEqual([record()])
    expect(JSON.stringify(emitted)).not.toContain('PRIVATE_REQUEST_DO_NOT_EMIT')
    handlers.get('context_with_system')!({ messages }, context)
    expect(emitted[1].sequence).toBe(2)
  })
  it('invalidates old categories on a new unknown or throwing request while preserving occupancy and later recovery', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cwn-SIMULATED-pi-invalidation-')); roots.push(root)
    const path = join(root, 'raw.jsonl'), sdk = primitives(), emitted: any[] = []
    let handler: Function = () => {}
    registerPiContextObserver({ on: (_: string, callback: Function) => { handler = callback } }, sdk, binding.nonce, (event: any) => emitted.push(event))
    const context = { mode: 'rpc', model: { provider: binding.provider, id: binding.model, contextWindow: 1000 }, sessionManager: { getSessionId: () => binding.sessionId } }
    handler({ messages: [{ role: 'user', content: 'SIMULATED REQUEST ONE' }] }, context)
    handler({ messages: [{ role: 'UNSUPPORTED_NATIVE_ROLE', content: 'PRIVATE_UNKNOWN' }] }, context)
    sdk.estimateTokens.mockImplementationOnce(() => { throw new Error('PRIVATE_ESTIMATE_FAILURE') })
    handler({ messages: [{ role: 'user', content: 'SIMULATED REQUEST THREE' }] }, context)
    handler({ messages: [{ role: 'user', content: 'SIMULATED REQUEST FOUR' }] }, context)
    expect(emitted.map(row => row.sequence)).toEqual([1, 2, 3, 4])
    expect(emitted.map(row => row.categories === null)).toEqual([false, true, true, false])
    expect(JSON.stringify(emitted)).not.toMatch(/PRIVATE_UNKNOWN|PRIVATE_ESTIMATE_FAILURE/)
    const observations = emitted.map((row, index) => readPiContextObservation(row, { ...binding, sequence: index }))
    expect(observations.every(Boolean)).toBe(true)
    const stats = { type: 'cliworker.rpc_usage', cli: 'pi', source: 'pi.get_session_stats', sessionId: binding.sessionId,
      contextUsage: { tokens: 120, contextWindow: 1000 } }
    const readThrough = async (count: number) => {
      const rows = [...observations.slice(0, count), stats]
      await writeFile(path, rows.map(record => JSON.stringify({ type: 'native', record })).join('\n') + '\n')
      return new TelemetryReader().read(path, 'pi', { conversationId: binding.sessionId, model: `${binding.provider}/${binding.model}` })
    }
    expect((await readThrough(1)).contextBreakdown).toMatchObject({ systemTokens: 17, toolTokens: 23, messageTokens: 11 })
    for (const count of [2, 3]) {
      const result = await readThrough(count)
      expect(result.contextUsed).toBe(120); expect(result.contextCapacity).toBe(1000)
      expect(result.contextBreakdown).toBeUndefined()
    }
    expect((await readThrough(4)).contextBreakdown).toMatchObject({ systemTokens: 17, toolTokens: 23, messageTokens: 11 })
    expect(readPiContextObservation(emitted[1], { ...binding, active: false, sequence: 1 })).toBeUndefined()
  })
  it('keeps optional observer failures and non-RPC contexts independent from generation', () => {
    let handler: Function = () => {}; const emit = vi.fn(), sdk = primitives()
    registerPiContextObserver({ on: (_: string, fn: Function) => { handler = fn } }, sdk, binding.nonce, emit)
    expect(handler({ messages: [] }, { mode: 'tui' })).toBeUndefined()
    expect(handler({ messages: [] }, { mode: 'rpc', model: { contextWindow: 1000 }, sessionManager: { getSessionId: () => { throw new Error('PRIVATE_ERROR') } } })).toBeUndefined()
    expect(emit).not.toHaveBeenCalled()
  })
  it.each(['nonce', 'sessionId', 'provider', 'model', 'sequence'])('rejects a foreign or replayed %s binding', key => {
    expect(readPiContextObservation({ ...record(), [key]: 'FOREIGN' }, binding)).toBeUndefined()
  })
  it('rejects observations before prompt admission and after settle/stop, including valid late receipts', () => {
    expect(readPiContextObservation(record(), { ...binding, active: false })).toBeUndefined()
    expect(readPiContextObservation(record(), { ...binding, active: undefined })).toBeUndefined()
    expect(readPiContextObservation(record(), { ...binding, sequence: 1 })).toBeUndefined()
    expect(readPiContextObservation({ ...record(), sequence: 3 }, binding)).toBeUndefined()
  })
  it.each(['9.9.9', '1.0.4'])('leaves unsupported version or missing observer capability %s unchanged', async version => {
    const root = await mkdtemp(join(tmpdir(), 'cwn-SIMULATED-pi-observer-')); roots.push(root)
    const packageRoot = join(root, 'node_modules/@earendil-works/pi-coding-agent'), dist = join(packageRoot, 'dist')
    await mkdir(join(dist, 'core/extensions'), { recursive: true })
    await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-coding-agent', version }))
    for (const name of ['cli.js', 'index.js', 'core/model-runtime.js', 'core/auth-storage.js'])
      await writeFile(join(dist, name), '// SIMULATED INSTALLATION METADATA; never execute')
    await writeFile(join(dist, 'core/extensions/types.d.ts'), '// SIMULATED OLD SDK: no context hook')
    expect(await preparePiContextObserver(join(dist, 'cli.js'))).toEqual({ argv: [], env: {} })
  })
  it('sanitizes output and rejects category substitution/negative counts without affecting usage', () => {
    expect(readPiContextObservation({ ...record(), prompt: 'PRIVATE', usage: { total: 123456 } }, binding)).toEqual({
      type: 'cliworker.context_inspection', cli: 'pi', source: 'pi.context_with_system', sessionId: binding.sessionId,
      provider: binding.provider, model: binding.model, requestId: 'SIMULATED-session:context:1', basis: 'native-estimate', contextCapacity: 1000, categories: record().categories,
    })
    expect(readPiContextObservation({ ...record(), categories: [{ name: 'Other', tokens: 5 }, ...record().categories.slice(1)] }, binding)).toBeUndefined()
    expect(readPiContextObservation({ ...record(), contextCapacity: 0 }, binding)).toBeUndefined()
  })
  it('uses only its dedicated numeric pipe even when RPC guards stdout before extension loading', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cwn-SIMULATED-pi-writer-')); roots.push(root)
    const estimator = join(root, 'SIMULATED-estimator.mjs'), transcript = join(root, 'SIMULATED-transcript.mjs')
    await writeFile(estimator, 'export const estimateTokens = () => 7; // SIMULATED PRIMITIVE')
    await writeFile(transcript, 'export const getCurrentSystemMessage = messages => messages[0]; // SIMULATED PRIMITIVE')
    const code = `
      import observer from ${JSON.stringify(pathToFileURL(resolve('src/host/pi-context-observer.mjs')).href)};
      process.stdout.write = () => { throw Error('SIMULATED RPC stdout guard'); };
      let handler; await observer({ on: (_name, callback) => { handler = callback; } });
      handler({ messages: [{ role: 'system', content: 'PRIVATE_PROMPT', timestamp: 0 }, { role: 'user', content: 'PRIVATE_USER' }] },
        { mode: 'rpc', model: { provider: 'SIMULATED-provider', id: 'SIMULATED-model', contextWindow: 1000 }, sessionManager: { getSessionId: () => 'SIMULATED-session' } });
    `
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
      env: { ...process.env, [PI_CONTEXT_ENV]: JSON.stringify({ nonce: 'a'.repeat(48), outputFd: 3, estimator: pathToFileURL(estimator).href, transcript: pathToFileURL(transcript).href }) } })
    let numeric = '', stdout = '', stderr = ''
    child.stdio[3]!.on('data', chunk => { numeric += chunk })
    child.stdout!.on('data', chunk => { stdout += chunk }); child.stderr!.on('data', chunk => { stderr += chunk })
    const exit = await new Promise(resolve => child.on('close', resolve))
    expect(exit).toBe(0); expect(stdout).toBe(''); expect(stderr).toBe('')
    const record = JSON.parse(numeric)
    expect(record.categories.map((row: any) => row.tokens)).toEqual([7, 7, 7])
    expect(numeric).not.toMatch(/PRIVATE_PROMPT|PRIVATE_USER/)
  })
  it('leaves an unsupported installation unchanged rather than inventing a fallback estimator', async () => {
    expect(await preparePiContextObserver('/SIMULATED/missing/pi')).toEqual({ argv: [], env: {} })
  })
})
