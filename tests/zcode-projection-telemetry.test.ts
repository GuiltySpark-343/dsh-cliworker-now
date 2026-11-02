import { afterEach, describe, expect, it } from 'vitest'
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { extractTelemetry, TelemetryReader } from '../src/host/telemetry.ts'

// Offline synthetic shapes copied from the three real run boundaries; no user text/account access.
const roots: string[] = []
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })))
const identity = { conversationId: 'session', model: 'provider/model' }
const snapshot = (overrides = {}) => ({ result: { projection: { sessionId: 'session',
  contextUsed: 0, contextWindow: 200000, totalTokenCount: 0, turnCount: 0, ...overrides } } })
const row = (type: string, payload: unknown) => ({ method: 'session/event', params: { sessionId: 'session', turnId: 'turn', type, payload } })
function file() {
  const root = mkdtempSync(join(tmpdir(), 'zcode-projection-mock-')); roots.push(root)
  const path = join(root, 'mock.raw.jsonl'); writeFileSync(path, '')
  const reader = new TelemetryReader()
  return { read: () => reader.read(path, 'zcode', identity), append: (records: unknown[]) =>
    appendFileSync(path, records.map(record => JSON.stringify({ type: 'native', record })).join('\n') + '\n') }
}
describe('ZCode per-process projection telemetry', () => {
  it.each([[0, 15727, 4], [2, 15734, 19], [4, 15756, 28]])('keeps three-run initial empty projection unknown (%i persisted messages)', (messages, input, output) => {
    const f = file(), initial = { result: { ...snapshot().result, messages: Array.from({ length: messages }, () => ({ content: 'mock' })) } }
    f.append([initial, snapshot(), snapshot(), snapshot()])
    expect(f.read().contextUsed).toBeUndefined()
    expect(f.read().usage).toBeUndefined()
    const usage = { inputTokens: input, outputTokens: output, totalTokens: input + output, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }
    const records = [row('turn.completed', { usage }), snapshot({ contextUsed: input + output, totalTokenCount: input + output, turnCount: 1, currentTurnId: 'turn' })]
    f.append(records)
    expect(f.read().usage).toMatchObject({ total: input + output, input, output, scope: 'run' })
    expect(f.read().runUsage).toMatchObject({ total: input + output, input, output, scope: 'run' })
    expect(f.read().contextUsed).toBe(input + output)
    expect(f.read()).toEqual(extractTelemetry('zcode', [initial, snapshot(), snapshot(), snapshot(), ...records], identity))
  })
  it('labels projection-only totals as run, never cross-process session totals', () => {
    const f = file(); f.append([snapshot({ contextUsed: 12, totalTokenCount: 12, turnCount: 1, currentTurnId: 'turn' })])
    expect(f.read().usage).toEqual({ total: 12, scope: 'run' })
    expect(f.read().runUsage).toBeUndefined() // Total-only projection is not a complete bill.
  })
  it('preserves identified native zero and does not erase a valid snapshot with bootstrap zero', () => {
    const f = file()
    f.append([snapshot({ contextUsed: 12, totalTokenCount: 12, turnCount: 1, currentTurnId: 'turn' }), snapshot()])
    expect(f.read().contextUsed).toBe(12)
    expect(f.read().usage?.total).toBe(12)
    f.append([snapshot({ currentTurnId: 'turn' })])
    expect(f.read().contextUsed).toBe(0)
    expect(f.read().usage).toEqual({ total: 0, scope: 'run' })
    f.append([row('turn.completed', { usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 } })])
    expect(f.read().runUsage).toMatchObject({ total: 0, input: 0, output: 0, scope: 'run' })
  })
  it('preserves explicit post-compact zero without a current turn when projection has completed turns', () => {
    const f = file(); f.append([snapshot({ turnCount: 1, totalTokenCount: 42, contextUsed: 0 })])
    expect(f.read().contextUsed).toBe(0)
    expect(f.read().usage).toEqual({ total: 42, scope: 'run' })
  })
})
