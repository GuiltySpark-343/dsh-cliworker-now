import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { extractTelemetry, TelemetryReader } from '../src/host/telemetry.ts'
import { nativeTelemetryProjections } from '../src/client/harness-telemetry-data.ts'
// Explicitly simulated protocol records. No prompts or model calls.
const identity = { conversationId: 'SIM-session', model: 'provider/model' }
const session = { type: 'session', id: identity.conversationId, model: identity.model }
const snapshot = { type: 'message.updated', properties: { info: { id: 'SIM-reply', sessionID: identity.conversationId,
  role: 'assistant', providerID: 'provider', modelID: 'model', finish: 'stop', time: { completed: 1 },
  tokens: { input: 70, output: 10, reasoning: 0, cache: { read: 20, write: 0 } } } } }
const breakdown = { systemTokens: 22, toolTokens: 35, messageTokens: 8, estimated: true, basis: 'native-chars-per-token-4' }
const http = (cli: 'mimo' | 'opencode') => ({ type: 'cliworker.http_context_observation', cli,
  source: `${cli}.request-body.native-token-estimate`, sessionId: identity.conversationId, model: identity.model,
  requestMessageId: 'SIM-user', requestId: 'SIM-user:1', breakdown })
const pi = { type: 'cliworker.context_inspection', cli: 'pi', source: 'pi.context_with_system',
  sessionId: identity.conversationId, provider: 'provider', model: 'model', requestId: 'SIM-session:context:1',
  basis: 'native-estimate', contextCapacity: 1000,
  categories: ['System prompt', 'System tools', 'Messages'].map((name, index) => ({ name, kind: 'used', tokens: [22,35,8][index] })) }
const stats = { type: 'cliworker.rpc_usage', cli: 'pi', source: 'pi.get_session_stats', sessionId: identity.conversationId,
  usage: { total: 300, input: 270, output: 30 }, contextUsage: { tokens: 90, contextWindow: 1000 } }
function fromDisk(cli: 'pi' | 'mimo' | 'opencode', records: unknown[]) {
  const root = mkdtempSync(join(tmpdir(), 'cwn-SIM-context-'))
  try {
    const path = join(root, 'raw.jsonl')
    writeFileSync(path, records.map(record => JSON.stringify({ type: 'native', record })).join('\n') + '\n')
    return new TelemetryReader().read(path, cli, identity)
  } finally { rmSync(root, { recursive: true, force: true }) }
}
describe('actual request composition reaches the native context projection', () => {
  it.each(['mimo', 'opencode'] as const)('%s keeps estimates separate from pressure through raw reader and native projection', cli => {
    const cap = { type: 'cliworker.model_context', source: `${cli}.provider.limit.context`, providerID: 'provider', modelID: 'model', contextCapacity: 1000 }
    for (const records of [[session, cap, http(cli), snapshot], [session, cap, snapshot, http(cli)]]) {
      const direct = extractTelemetry(cli, records, identity)
      expect(direct).toMatchObject({ contextUsed: 90, contextCapacity: 1000, contextBreakdown: { systemTokens: 22, toolTokens: 35, messageTokens: 8, estimated: true } })
      expect(fromDisk(cli, records)).toEqual(direct)
      expect(nativeTelemetryProjections(cli, direct).contextBreakdown).toEqual({ systemTokens: 22, toolsTokens: 35, messageTokens: 8 })
    }
  })
  it.each(['mimo', 'opencode'] as const)('%s invalidates missing or malformed later requests without losing known totals', cli => {
    for (const next of [null, { ...breakdown, toolTokens: -1 }, { ...breakdown, basis: 'guess' }]) {
      const result = fromDisk(cli, [session, http(cli), snapshot, { ...http(cli), requestId: 'SIM-user:2', breakdown: next }])
      expect(result.contextUsed).toBe(90)
      expect(result.contextBreakdown).toBeUndefined()
    }
    for (const change of [{ sessionId: 'foreign' }, { model: 'foreign/model' }, { source: 'guess' }, { requestId: 'foreign:1' }])
      expect(fromDisk(cli, [session, snapshot, { ...http(cli), ...change }]).contextBreakdown).toBeUndefined()
    expect(fromDisk(cli, [session, http(cli)]).contextUsed).toBeUndefined()
  })
  it('Pi accepts only exact session/provider/model composition and retains independent live stats', () => {
    for (const records of [[session, pi, stats], [session, stats, pi]]) {
      const result = fromDisk('pi', records)
      expect(result).toMatchObject({ contextUsed: 90, contextCapacity: 1000, usage: { total: 300 },
        contextBreakdown: { systemTokens: 22, toolTokens: 35, messageTokens: 8, estimated: true } })
      expect(nativeTelemetryProjections('pi', result).contextBreakdown).toEqual({ systemTokens: 22, toolsTokens: 35, messageTokens: 8 })
    }
    for (const change of [{ sessionId: 'foreign' }, { provider: 'foreign' }, { model: 'foreign' }, { source: 'guess' }, { categories: pi.categories.slice(1) }])
      expect(fromDisk('pi', [session, stats, { ...pi, ...change }]).contextBreakdown).toBeUndefined()
    expect(fromDisk('pi', [session, pi]).contextUsed).toBeUndefined()
    expect(fromDisk('pi', [session, pi, stats, { ...stats, contextUsage: { tokens: null, contextWindow: 1000 } }]).contextBreakdown).toBeUndefined()
  })
})
