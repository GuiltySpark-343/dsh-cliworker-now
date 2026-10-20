import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inspectQoderDurableContext } from '../src/host/qoder-durable-context.mjs'
import { extractTelemetry, TelemetryReader } from '../src/host/telemetry.ts'
import { nativeTelemetryProjections } from '../src/client/harness-telemetry-data.ts'
import { nativeUsageReport } from '../src/shared/native-usage-report.ts'

// Synthetic receipts/transcripts only. No real CLI, account, native log, or model is used.
const roots: string[] = []
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })))
const identity = { conversationId: 'SIMULATED-session', model: 'SIMULATED-model' }
const promptReceipt = (cli = 'qodercn', usage: any = { inputTokens: 60, outputTokens: 7, totalTokens: 67 }) => ({
  type: `cliworker.${cli}_prompt_usage`, sessionId: identity.conversationId, model: identity.model, usage,
})
const contextReceipt = (cli = 'qodercn') => ({
  type: `cliworker.${cli}_context`, source: `${cli}.native-transcript`, basis: 'native-ratio',
  sessionId: identity.conversationId, model: identity.model, userMessageId: 'SIMULATED-user',
  contextRatio: 0.25, providerCredits: 0.28,
})

function transcript() {
  const binding = { cli: 'qodercn', home: '/SIMULATED/.qoder-cn', project: '/SIMULATED/project',
    sessionId: identity.conversationId, model: identity.model, userMessageId: 'SIMULATED-user' }
  const rows: any[] = [
    { type: 'user', uuid: binding.userMessageId, sessionId: binding.sessionId, cwd: binding.project,
      businessModelKey: binding.model, isSidechain: false, timestamp: '2026-10-19T06:00:00.000Z',
      message: { content: 'SIMULATED PRIVATE PROMPT' } },
    { type: 'assistant', uuid: 'SIMULATED-answer', parentUuid: binding.userMessageId, sessionId: binding.sessionId,
      cwd: binding.project, isSidechain: false, timestamp: '2026-10-19T06:00:10.000Z',
      message: { id: 'SIMULATED-request', model: binding.model, stop_reason: 'end_turn', content: 'SIMULATED PRIVATE ANSWER',
        usage: { input_tokens: 0, output_tokens: 0, credits: 0.28, context_usage_ratio: 0.25 } } },
  ]
  return { binding, rows }
}

describe('Qoder CN telemetry isolation (simulated native evidence)', () => {
  it('attributes and deduplicates only its own prompt receipt without inventing cache/context buckets', () => {
    const receipt = promptReceipt(), data = extractTelemetry('qodercn', [receipt, receipt], identity)
    expect(data.usage).toEqual({ input: 60, output: 7, total: 67, scope: 'run' })
    expect(data.runUsage).toEqual(data.usage)
    expect(data.replies).toEqual({})
    for (const field of ['contextUsed', 'contextCapacity', 'contextRatio']) expect(data[field as keyof typeof data]).toBeUndefined()
    expect(data.usage?.cacheRead).toBeUndefined(); expect(data.usage?.cacheWrite).toBeUndefined()
  })

  it.each(['qoder', 'qodercn'] as const)('rejects the opposite brand even when session/model IDs coincide (%s)', cli => {
    const other = cli === 'qoder' ? 'qodercn' : 'qoder'
    const data = extractTelemetry(cli, [promptReceipt(other), contextReceipt(other)], identity)
    expect(data.usage).toBeUndefined(); expect(data.contextRatio).toBeUndefined(); expect(data.providerCredits).toBeUndefined()
  })

  it.each(['source', 'session', 'model', 'user', 'basis'])('rejects CN context with invalid provenance (%s)', kind => {
    const receipt = contextReceipt()
    if (kind === 'source') receipt.source = 'qoder.native-transcript'
    if (kind === 'session') receipt.sessionId = 'foreign-session'
    if (kind === 'model') receipt.model = 'foreign-model'
    if (kind === 'user') receipt.userMessageId = ''
    if (kind === 'basis') receipt.basis = 'unproven'
    const data = extractTelemetry('qodercn', [receipt], identity)
    expect(data.contextRatio).toBeUndefined(); expect(data.providerCredits).toBeUndefined()
  })

  it('keeps masked CN token counters unknown while allowing independently explicit zero ratio and Credits', () => {
    const receipt = { ...contextReceipt(), contextRatio: 0, providerCredits: 0 }
    const data = extractTelemetry('qodercn', [promptReceipt('qodercn', { inputTokens: 0, outputTokens: 0, totalTokens: 0 }), receipt], identity)
    expect(data.usage).toBeUndefined(); expect(data.contextRatio).toBe(0); expect(data.providerCredits).toBe(0)
    expect(nativeUsageReport('qodercn', { scope: 'run', total: 0, input: 0, output: 0 })).toBeUndefined()
    const projected = nativeTelemetryProjections('qodercn', data, undefined, 'SIMULATED-run', { busy: false })
    expect(projected.contextPressure?.externalContext?.ratio).toBe(0)
    expect(projected.tokenUsage).toMatchObject({ externalCredits: 0, externalScope: 'run' })
    expect(projected.tokenUsage).not.toHaveProperty('uncachedInputTokens')
    expect(nativeTelemetryProjections('qodercn', { usage: { scope: 'run', total: 0, input: 0, output: 0 } }, undefined, undefined, { busy: false }).tokenUsage).toBeUndefined()
  })

  it.each([
    { inputTokens: 60, outputTokens: 7, totalTokens: 68 },
    { inputTokens: 60, totalTokens: 60 },
    { inputTokens: -1, outputTokens: 7, totalTokens: 6 },
  ])('leaves incomplete or inconsistent CN usage unknown: %j', usage => {
    expect(extractTelemetry('qodercn', [promptReceipt('qodercn', usage)], identity).usage).toBeUndefined()
  })

  it('emits CN transcript provenance and excludes private prompt/answer content', () => {
    const { rows, binding } = transcript()
    const observed = inspectQoderDurableContext(rows, binding)
    expect(observed).toMatchObject({ type: 'cliworker.qodercn_context', source: 'qodercn.native-transcript',
      basis: 'native-ratio', contextRatio: 0.25, providerCredits: 0.28 })
    expect(JSON.stringify(observed)).not.toContain('PRIVATE')
    const data = extractTelemetry('qodercn', [observed], identity)
    expect(data).toMatchObject({ contextRatio: 0.25, providerCredits: 0.28, contextEstimated: true })
    expect(data.usage).toBeUndefined(); expect(data.contextCapacity).toBeUndefined()
  })

  it.each([undefined, {}])('keeps total Credits unknown when an earlier native request has no accounting: %j', usage => {
    const { rows, binding } = transcript()
    rows.splice(1, 0, { ...rows[1], uuid: 'SIMULATED-tool-answer', parentUuid: binding.userMessageId,
      message: { ...rows[1].message, id: 'SIMULATED-earlier-request', stop_reason: 'tool_use', usage } })
    rows[2].parentUuid = 'SIMULATED-tool-answer'
    const observed = inspectQoderDurableContext(rows, binding)
    expect(observed?.contextRatio).toBe(0.25)
    expect(observed?.providerCredits).toBeUndefined()
  })

  it('retains known accounting across content-only blocks of the same native request', () => {
    const { rows, binding } = transcript()
    rows.splice(1, 0, { ...rows[1], uuid: 'SIMULATED-first-block', parentUuid: binding.userMessageId,
      message: { ...rows[1].message, stop_reason: 'tool_use' } })
    rows[2].parentUuid = 'SIMULATED-first-block'
    rows[2].message.usage = undefined
    expect(inspectQoderDurableContext(rows, binding)?.providerCredits).toBe(0.28)
  })

  it.each(['qodercn.native-runtime-config', 'qodercn.native-session-log'])('accepts only owned CN window evidence (%s)', contextCapacitySource => {
    const receipt = { ...contextReceipt(), contextCapacity: 128000, contextUsed: 32000, contextCapacitySource }
    expect(extractTelemetry('qodercn', [receipt], identity)).toMatchObject({ contextRatio: 0.25, contextCapacity: 128000, contextUsed: 32000 })
    const crossed = extractTelemetry('qodercn', [{ ...receipt, contextCapacitySource: contextCapacitySource.replace('qodercn.', 'qoder.') }], identity)
    expect(crossed.contextRatio).toBe(0.25); expect(crossed.contextCapacity).toBeUndefined(); expect(crossed.contextUsed).toBeUndefined()
  })

  it('uses CN runtime-config provenance when deriving occupancy from an observed ratio', () => {
    const { rows, binding } = transcript()
    rows.push({ type: 'runtime-config', sessionId: binding.sessionId, model: binding.model,
      timestamp: '2026-10-19T06:00:05.000Z', contextWindow: 128000 })
    expect(inspectQoderDurableContext(rows, binding)).toMatchObject({ type: 'cliworker.qodercn_context',
      contextCapacitySource: 'qodercn.native-runtime-config', contextCapacity: 128000, contextUsed: 32000 })
  })

  it('preserves brand ownership and deduplication during incremental raw replay', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'qodercn-SIMULATED-telemetry-'))); roots.push(root)
    const path = join(root, 'run.raw.jsonl')
    const records = [promptReceipt(), contextReceipt(), contextReceipt()]
    writeFileSync(path, records.map(record => JSON.stringify({ type: 'native', record })).join('\n') + '\n')
    const reader = new TelemetryReader()
    for (let i = 0; i < 2; i++) expect(reader.read(path, 'qodercn', identity)).toMatchObject({
      usage: { input: 60, output: 7, total: 67, scope: 'run' }, contextRatio: 0.25, providerCredits: 0.28,
    })
    expect(reader.read(path, 'qoder', identity).providerCredits).toBeUndefined()
    expect(reader.read(path, 'qodercn', { ...identity, model: 'foreign-model' }).contextRatio).toBeUndefined()
  })
})
