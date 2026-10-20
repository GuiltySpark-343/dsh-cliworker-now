import { syntheticNativeAcl, exposeSyntheticNativePath, recordSyntheticNativePrivacy } from './fixtures/native-file-privacy.ts'
import { afterEach, expect, it, vi } from 'vitest'
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { qoderContextPaths, qoderProjectKey, readQoderDurableContextAsync as readQoderDurableContext } from '../src/host/qoder-durable-context.mjs'
import { extractTelemetry, TelemetryReader } from '../src/host/telemetry.ts'
import { NativeSupplementalContextReader } from '../src/host/native-supplemental-context.ts'
import { captureContextTelemetry, withContextTelemetry, withoutContextTelemetry } from '../src/host/context-telemetry.ts'
import { nativeTelemetryProjections } from '../src/client/harness-telemetry-data.ts'
import { nativeUsageReport } from '../src/shared/native-usage-report.ts'
import type { Worker } from '../src/shared/types.ts'

// Entirely synthetic native transcript and ACP receipts; no Qoder/account/model is used.
const roots: string[] = []
afterEach(() => { vi.unstubAllEnvs(); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })) })
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'qoder-SIMULATED-context-'))); roots.push(root)
  const home = join(root, 'qoder'), project = join(root, 'project')
  mkdirSync(home, { mode: 0o755 }); mkdirSync(project)
  const config = { home, project, sessionId: 'session-SIMULATED', model: 'native-model', userMessageId: 'user-SIMULATED' }
  const paths = qoderContextPaths(config)
  for (const path of paths.slice(1, -1)) mkdirSync(path, { mode: 0o700 })
  const rows: any[] = [
    { type: 'workspace-directories', sessionId: config.sessionId },
    { type: 'user', uuid: config.userMessageId, sessionId: config.sessionId, cwd: project, isSidechain: false, businessModelKey: config.model,
      message: { role: 'user', content: [{ type: 'text', text: 'SYNTHETIC PRIVATE PROMPT MUST NOT BE RETAINED' }] } },
    { type: 'attachment', uuid: 'attachment-SIMULATED', parentUuid: config.userMessageId, sessionId: config.sessionId },
    { type: 'assistant', uuid: 'assistant-SIMULATED', parentUuid: 'attachment-SIMULATED', sessionId: config.sessionId,
      cwd: project, isSidechain: false, message: { model: config.model, stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'SYNTHETIC PRIVATE ANSWER' }],
        usage: { input_tokens: 0, output_tokens: 0, credits: 0.28, context_usage_ratio: 0.17617777777777777 } } },
  ]
  const write = () => writeFileSync(paths.at(-1)!, rows.map(row => JSON.stringify(row)).join('\n') + '\n', { mode: 0o600 })
  write()
  syntheticNativeAcl(paths.map((path, index) => ({ path, public: index === 0 })))
  return { root, config, paths, rows, write, file: paths.at(-1)! }
}
it('projects an exact native ratio without inferring token numerator, capacity, billing, or composition', async () => {
  const f = fixture(), before = readFileSync(f.file)
  const observed = (await readQoderDurableContext(f.config))!
  expect(observed).toMatchObject({ contextRatio: 0.17617777777777777, userMessageId: f.config.userMessageId, source: 'qoder.native-transcript' })
  const telemetry = extractTelemetry('qoder', [observed], { conversationId: f.config.sessionId, model: f.config.model })
  expect(telemetry).toMatchObject({ contextRatio: observed.contextRatio, contextEstimated: true })
  for (const field of ['contextUsed', 'contextCapacity', 'contextBreakdown', 'usage']) expect(telemetry).not.toHaveProperty(field)
  expect(nativeTelemetryProjections('qoder', telemetry).contextPressure).toEqual({ externalContext: {
    ratio: observed.contextRatio, source: 'Qoder 原生会话上下文比例', estimated: true } })
  expect(readFileSync(f.file)).toEqual(before)
  expect(JSON.stringify(observed)).not.toContain('PRIVATE')
})
it.each(['session', 'model', 'project', 'user', 'sidechain', 'parent', 'unfinished', 'invalid-ratio', 'aborted'])(
  'refuses mismatched or unconfirmed transcript evidence (%s)', async kind => {
    const f = fixture(), answer = f.rows.at(-1)
    if (kind === 'session') answer.sessionId = 'foreign'
    if (kind === 'model') answer.message.model = 'foreign'
    if (kind === 'project') answer.cwd = 'foreign'
    if (kind === 'user') f.config.userMessageId = 'foreign'
    if (kind === 'sidechain') answer.isSidechain = true
    if (kind === 'parent') answer.parentUuid = 'foreign'
    if (kind === 'unfinished') answer.message.stop_reason = null
    if (kind === 'invalid-ratio') answer.message.usage.context_usage_ratio = 1.1
    if (kind === 'aborted') answer.aborted = true
    f.write(); expect((await readQoderDurableContext(f.config))).toBeUndefined()
  },
)
it('never borrows a later turn ratio and supports a verified zero native proportion', async () => {
  const f = fixture()
  f.rows.at(-1).message.usage.context_usage_ratio = 0
  f.rows.push({ ...f.rows[1], uuid: 'new-user' }, { ...f.rows.at(-1), uuid: 'new-assistant', parentUuid: 'new-user',
    message: { ...f.rows.at(-1).message, usage: { context_usage_ratio: 0.95 } } })
  f.write(); expect((await readQoderDurableContext(f.config))?.contextRatio).toBe(0)
  f.rows[3].message.stop_reason = null
  f.write(); expect((await readQoderDurableContext(f.config))).toBeUndefined()
})
it.each(['file-symlink', 'directory-symlink', 'public-file', 'public-directory', 'oversized', 'torn', 'malformed'])(
  'refuses unsafe, partial, or over-limit native storage (%s)', async kind => {
    const f = fixture()
    if (kind === 'file-symlink') { const copy = f.file + '.copy'; writeFileSync(copy, readFileSync(f.file), { mode: 0o600 }); rmSync(f.file); symlinkSync(copy, f.file) }
    if (kind === 'directory-symlink') { const original = f.paths[2]!; const moved = original + '-moved'; mkdirSync(moved, { mode: 0o700 }); writeFileSync(join(moved, 'session-SIMULATED.jsonl'), readFileSync(f.file), { mode: 0o600 }); rmSync(original, { recursive: true }); symlinkSync(moved, original) }
    if (kind === 'public-file') process.platform === 'win32' ? syntheticNativeAcl([{ path: f.file, public: true, write: true }]) : exposeSyntheticNativePath(f.file)
    if (kind === 'public-directory') process.platform === 'win32' ? syntheticNativeAcl([{ path: f.paths[2]!, public: true, write: true }]) : exposeSyntheticNativePath(f.paths[2]!)
    if (kind === 'oversized') writeFileSync(f.file, ' '.repeat(16 * 1024 * 1024 + 1))
    if (kind === 'torn') writeFileSync(f.file, JSON.stringify(f.rows[0]))
    if (kind === 'malformed') writeFileSync(f.file, 'malformed\n')
    expect((await readQoderDurableContext(f.config))).toBeUndefined()
  },
)
it('treats masked all-zero ACP accounting as unknown, including old cached snapshots', () => {
  const receipt = { type: 'cliworker.qoder_prompt_usage', sessionId: 'session', model: 'model', usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } }
  expect(extractTelemetry('qoder', [receipt], { conversationId: 'session' }).usage).toBeUndefined()
  expect(nativeUsageReport('qoder', { scope: 'run', total: 0, input: 0, output: 0 })).toBeUndefined()
  expect(nativeTelemetryProjections('qoder', { usage: { scope: 'run', total: 0, input: 0, output: 0 } }, undefined, undefined, { busy: false }).tokenUsage).toBeUndefined()
  const known = nativeUsageReport('qoder', { scope: 'run', total: 63, input: 60, output: 3 })
  expect(known).toMatchObject({ totalTokens: 63, inputBasis: 'reported' })
  expect(known).not.toHaveProperty('cacheReadTokens')
  expect(known).not.toHaveProperty('cacheWriteTokens')
  expect(nativeUsageReport('qoder', { scope: 'run', total: 63, input: 60, output: 3, cacheRead: 0 })).toBeUndefined()
})
it('supplements a proven historical run, invalidates by source changes, and keeps model selection separate', async () => {
  const f = fixture(); vi.stubEnv('QODER_CONFIG_DIR', f.config.home)
  const worker = { id: 'worker-SIMULATED', project: f.config.project, preference: { cli: 'qoder', model: f.config.model },
    conversationId: f.config.sessionId } as Worker
  const rawPath = join(f.root, `${worker.id}.run-SIMULATED.raw.jsonl`)
  writeFileSync(rawPath, [ { type: 'session', id: f.config.sessionId, model: f.config.model },
    { id: 'rpc-SIMULATED', result: { stopReason: 'end_turn', userMessageId: f.config.userMessageId } } ]
    .map(record => JSON.stringify({ type: 'native', record })).join('\n') + '\n')
  const input = { worker, runId: 'run-SIMULATED', rawPath, storageDirectory: f.root }
  const reader = new NativeSupplementalContextReader()
  await vi.waitFor(() => expect(reader.read(input).contextRatio).toBeCloseTo(0.17617, 4), { timeout: 12000 })
  await vi.waitFor(() => expect(reader.read(input).contextRatio).toBeCloseTo(0.17617, 4), { timeout: 12000 })
  expect((await reader.read({ ...input, currentIdentity: { conversationId: f.config.sessionId, model: 'OTHER' } }))).toHaveProperty('contextRatio', undefined)
  f.rows.at(-1).message.usage.context_usage_ratio = 0.25; f.write()
  await vi.waitFor(() => expect(reader.read(input).contextRatio).toBe(0.25), { timeout: 12000 })
  rmSync(f.file); expect((await reader.read(input))).toEqual({})
})
it('persists only the ratio with exact model identity and clears it with context invalidation', () => {
  const f = fixture()
  const worker = { preference: { cli: 'qoder', model: f.config.model }, conversationId: f.config.sessionId,
    runId: '11111111-1111-4111-8111-111111111111' } as Worker
  worker.contextTelemetry = captureContextTelemetry(worker, { replies: {}, contextRatio: 0.25, contextSource: 'native' })
  expect(worker.contextTelemetry).toMatchObject({ contextRatio: 0.25 })
  expect(withContextTelemetry(worker, { replies: {} }).contextRatio).toBe(0.25)
  expect(withContextTelemetry({ ...worker, preference: { ...worker.preference, model: 'OTHER' } }, { replies: {} }).contextRatio).toBeUndefined()
  expect(withoutContextTelemetry({ replies: {}, contextRatio: 0.25 })).toHaveProperty('contextRatio', undefined)
})
it('retains numeric-only native ratio in the incremental telemetry reader without double adding', async () => {
  const f = fixture(), observation = (await readQoderDurableContext(f.config))!, raw = join(f.root, 'raw.jsonl')
  writeFileSync(raw, JSON.stringify({ type: 'native', record: observation }) + '\n')
  const reader = new TelemetryReader(), identity = { conversationId: f.config.sessionId, model: f.config.model }
  expect((await reader.read(raw, 'qoder', identity)).contextRatio).toBe(observation.contextRatio)
  expect((await reader.read(raw, 'qoder', identity)).contextRatio).toBe(observation.contextRatio)
  expect((await reader.read(raw, 'qoder', { ...identity, model: 'OTHER' })).contextRatio).toBeUndefined()
})
it('uses the official deterministic project key and long-path hash without directory scanning', () => {
  expect(qoderProjectKey('/Users/SIMULATED/project')).toBe('-Users-SIMULATED-project')
  expect(qoderProjectKey('/' + 'x'.repeat(220))).toMatch(/^-.{199}-[a-z0-9]+$/)
})

afterEach(() => recordSyntheticNativePrivacy('qoder'))
