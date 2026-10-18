import { syntheticNativeAcl, exposeSyntheticNativePath, recordSyntheticNativePrivacy } from './fixtures/native-file-privacy.ts'
import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, chmodSync, rmSync, symlinkSync, realpathSync, linkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const race = vi.hoisted(() => ({ path: '', beforeOpen: undefined as undefined | (() => void), afterRead: undefined as undefined | (() => void), fd: -1, reads: 0 }))
vi.mock('node:fs', async original => {
  const fs = await original<typeof import('node:fs')>()
  return { ...fs,
    openSync: (...args: Parameters<typeof fs.openSync>) => {
      const targeted = args[0] === race.path
      if (targeted) { const mutate = race.beforeOpen; race.beforeOpen = undefined; mutate?.() }
      const fd = fs.openSync(...args); if (targeted) race.fd = fd
      return fd
    },
    readSync: (...args: any[]) => {
      const result = (fs.readSync as any)(...args)
      if (args[0] === race.fd) { race.reads++; const mutate = race.afterRead; race.afterRead = undefined; mutate?.() }
      return result
    },
  }
})
import { readGrokDurableContextAsync as readGrokDurableContext } from '../src/host/grok-durable-context.mjs'
const roots: string[] = []
afterEach(() => { race.path = ''; race.fd = -1; race.reads = 0; race.beforeOpen = race.afterRead = undefined; for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture() {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'grok-SIMULATED-file-safety-'))); roots.push(parent)
  const home = join(parent, 'owned', 'home'), dir = join(home, 'sessions', encodeURIComponent('/SIMULATED'), 'session')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  writeFileSync(join(dir, 'summary.json'), JSON.stringify({ info: { id: 'session', cwd: '/SIMULATED' }, current_model_id: 'model' }), { mode: 0o600 })
  writeFileSync(join(dir, 'signals.json'), JSON.stringify({ contextTokensUsed: 12, contextWindowTokens: 1000 }), { mode: 0o600 })
  const path = join(dir, 'updates.jsonl')
  writeFileSync(path, [
    { method: 'session/update', params: { sessionId: 'session', _meta: { promptId: 'prompt', totalTokens: 12 }, update: { sessionUpdate: 'agent_message_chunk' } } },
    { method: 'session/update', params: { sessionId: 'session', update: { sessionUpdate: 'turn_completed', prompt_id: 'prompt', stop_reason: 'end_turn' } } },
  ].map(r => JSON.stringify(r)).join('\n') + '\n', { mode: 0o600 })
  syntheticNativeAcl([home, join(home, 'sessions'), join(home, 'sessions', encodeURIComponent('/SIMULATED')), dir,
    ...['summary.json', 'signals.json', 'updates.jsonl'].map(name => join(dir, name))].map(path => ({ path })))
  race.path = path
  return { parent, home, path, read: async () => (await readGrokDurableContext({ home, project: '/SIMULATED', sessionId: 'session', modelId: 'model', promptId: 'prompt' })) }
}
it('refuses a file that grows beyond its bound between entry check and open, before reading payload', async () => {
  const f = fixture(); race.beforeOpen = () => appendFileSync(f.path, ' '.repeat(16 * 1024 * 1024))
  expect((await f.read())).toBeUndefined(); expect(race.reads).toBe(0)
})
it.each(['public','hardlink'])('rechecks %s security after open before reading', async kind => {
  const f = fixture(); race.beforeOpen = () => kind === 'public' ? exposeSyntheticNativePath(f.path) : linkSync(f.path, f.path + '.alias')
  expect((await f.read())).toBeUndefined(); expect(race.reads).toBe(0)
})
it('rejects privacy changes while reading instead of publishing the parsed numeric result', async () => {
  const f = fixture(); race.afterRead = () => exposeSyntheticNativePath(f.path)
  expect((await f.read())).toBeUndefined(); expect(race.reads).toBe(1)
})
it('refuses a symlink above the home, while an ordinary canonical private home remains readable', async () => {
  const f = fixture(); expect((await f.read())).toMatchObject({ contextUsed: 12, contextCapacity: 1000 })
  const alias = join(f.parent, 'alias'); symlinkSync(join(f.parent, 'owned'), alias)
  expect((await readGrokDurableContext({ home: join(alias, 'home'), project: '/SIMULATED', sessionId: 'session', modelId: 'model', promptId: 'prompt' }))).toBeUndefined()
})
it('numeric telemetry cache drops malformed Grok basis payloads while retaining the official enum', async () => {
  const { TelemetryReader } = await import('../src/host/telemetry.ts')
  const f = fixture(), reader = new TelemetryReader()
  const path = join(f.parent, 'SIMULATED.raw.jsonl')
  const observation = { type: 'cliworker.grok_context', source: 'grok.session_status', sessionId: 'session', modelId: 'model', contextUsed: 12, contextCapacity: 1000 }
  const write = (basis: unknown) => writeFileSync(path, JSON.stringify({ type: 'native', record: { ...observation, basis } }) + '\n', { mode: 0o600 })
  write({ privateContent: 'SIMULATED_PRIVATE_PAYLOAD_MUST_NOT_BE_CACHED' })
  expect((await reader.read(path, 'grok', { conversationId: 'session', model: 'model' })).contextUsed).toBeUndefined()
  expect(JSON.stringify([...(reader as any).cache.values()])).not.toContain('SIMULATED_PRIVATE_PAYLOAD_MUST_NOT_BE_CACHED')
  write('native-estimate')
  expect((await reader.read(path, 'grok', { conversationId: 'session', model: 'model' }))).toMatchObject({ contextUsed: 12, contextCapacity: 1000 })
})

afterEach(() => recordSyntheticNativePrivacy('grok-safety'))
