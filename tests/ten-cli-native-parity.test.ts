import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TelemetryReader, extractTelemetry } from '../src/host/telemetry.ts'
import { nativeTelemetryProjections } from '../src/client/harness-telemetry-data.ts'
import { tenCliNativeParityFixtures } from './fixtures/ten-cli-native-parity.ts'

// End-to-end offline numeric projection only; no CLI/model invocation.
describe('ten CLI native telemetry parity across the private whitelist', () => {
  it.each(tenCliNativeParityFixtures)('$cli preserves protocol scope and known/unknown context in native projection', (fixture) => {
    const { cli, records, identity, expected } = fixture
    const root = mkdtempSync(join(tmpdir(), 'cwn-SIMULATED-ten-cli-'))
    try {
      const path = join(root, 'native.raw.jsonl')
      writeFileSync(path, records.map((record: any) => JSON.stringify({ type: 'native', record: { ...record, prompt: 'SIMULATED-private-prompt', account: 'SIMULATED-private-account' } })).join('\n') + '\n')
      const direct = extractTelemetry(cli, records, identity)
      const telemetry = new TelemetryReader().read(path, cli, identity)
      expect(telemetry).toEqual(direct)
      expect(JSON.stringify(telemetry)).not.toMatch(/SIMULATED-private/)
      expect(telemetry.usage?.total).toBe(expected.total)
      expect(telemetry.contextUsed).toBe(expected.contextUsed)
      expect(telemetry.contextCapacity).toBe(expected.contextCapacity)
      expect(telemetry.finalReply).toBeUndefined()
      const projection = nativeTelemetryProjections(cli, telemetry)
      const tokens = projection.tokenUsage as any
      expect(tokens).toBeDefined()
      expect(tokens.uncachedInputTokens + tokens.outputTokens + tokens.cacheReadTokens + tokens.cacheWriteTokens).toBe(expected.nativeTotal)
      expect(projection.contextPressure?.pressureTokens).toBe(expected.contextUsed)
      expect(projection.contextPressure?.contextWindow).toBe(expected.contextCapacity)
      expect(projection.contextBreakdown).toEqual(expected.breakdown)
      if (expected.partialCategories) expect(projection.contextPressure?.externalContext?.categories).toEqual([{ name: 'Skills', tokens: 5, kind: 'used' }])
      expect(projection.externalTurnAnswer).toBeUndefined()
      expect(projection.externalTurnUsage).toBeUndefined()
      if (cli === 'antigravity') expect(telemetry.replies['0']?.scope).toBe('response')
      else expect(telemetry.replies).toEqual({})
      const foreign = new TelemetryReader().read(path, cli, { ...identity, conversationId: 'SIMULATED-foreign-session' })
      expect(foreign.usage).toBeUndefined()
      expect(foreign.runUsage).toBeUndefined()
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
  it('rejects foreign model usage and capacity when the native receipts carry model identity', () => {
    for (const fixture of tenCliNativeParityFixtures.filter(row => ['kimi', 'mimo', 'opencode', 'pi', 'omp'].includes(row.cli))) {
      const telemetry = extractTelemetry(fixture.cli, fixture.records, { ...fixture.identity, model: 'SIMULATED-other/model' })
      if (['mimo', 'opencode'].includes(fixture.cli)) expect(telemetry.contextCapacity).toBeUndefined()
      if (['kimi', 'mimo', 'opencode'].includes(fixture.cli)) expect(telemetry.usage).toBeUndefined()
    }
  })
})

it('preserves Pi/OMP capacity-only source without fabricating occupancy or categories', () => {
  for (const fixture of tenCliNativeParityFixtures.filter(row => ['pi', 'omp'].includes(row.cli))) {
    const records = fixture.records.filter((record: any) => record.type === 'cliworker.model_context')
    const telemetry = extractTelemetry(fixture.cli, records, fixture.identity)
    const projection = nativeTelemetryProjections(fixture.cli, telemetry)
    expect(projection.contextPressure?.contextWindow).toBe(1000)
    expect(projection.contextPressure?.pressureTokens).toBeUndefined()
    expect(projection.contextBreakdown).toBeUndefined()
    expect(projection.tokenUsage).toBeUndefined()
    expect(extractTelemetry(fixture.cli, records, { ...fixture.identity, model: 'SIMULATED-other/model' }).contextCapacity).toBeUndefined()
  }
})
