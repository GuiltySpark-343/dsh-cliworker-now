import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { syntheticNativeAcl, exposeSyntheticNativePath } from './fixtures/native-file-privacy.ts'
import { qoderContextPaths, qoderProjectKey, readQoderDurableContextAsync, inspectQoderDurableContext } from '../src/host/qoder-durable-context.mjs'
import { qoderPromptUsage } from '../src/host/native-qoder.mjs'
import { extractTelemetry, TelemetryReader } from '../src/host/telemetry.ts'
import { nativeTelemetryProjections } from '../src/client/harness-telemetry-data.ts'
import { privateWindowsAcl } from '../src/host/native-file-privacy.mjs'

// Explicit synthetic native records and private Windows ACLs; no CLI/account/model requests.
const roots: string[] = []
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })))
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'qoder-SIMULATED-meter-'))); roots.push(root)
  const home = join(root, '模拟 Qoder'), project = join(root, '中文 项目')
  mkdirSync(home, { mode: 0o755 }); mkdirSync(project)
  const binding = { home, project, sessionId: 'session-SIMULATED', model: 'model-SIMULATED', userMessageId: 'user-SIMULATED' }
  const paths = qoderContextPaths(binding)
  for (const path of paths.slice(1, -1)) mkdirSync(path, { mode: 0o700 })
  const rows: any[] = [
    { type: 'user', uuid: binding.userMessageId, sessionId: binding.sessionId, cwd: project, isSidechain: false,
      businessModelKey: binding.model, timestamp: '2026-10-18T06:00:00.000Z' },
    { type: 'assistant', uuid: 'answer-SIMULATED', parentUuid: binding.userMessageId, sessionId: binding.sessionId,
      cwd: project, isSidechain: false, timestamp: '2026-10-18T06:00:10.000Z',
      message: { id: 'request-SIMULATED', model: binding.model, stop_reason: 'end_turn',
        usage: { input_tokens: 0, output_tokens: 0, credits: 0.28, context_usage_ratio: 0.25 } } },
  ]
  const write = () => writeFileSync(paths[3]!, rows.map(r => JSON.stringify(r)).join('\n') + '\n', { mode: 0o600 })
  write(); syntheticNativeAcl(paths.map((path, i) => ({ path, public: i === 0 })))
  const logDirectory = join(home, 'logs', 'runs', 'SIMULATED-run')
  const logFile = join(logDirectory, 'qodercli.log')
  const log = (text: string) => {
    mkdirSync(logDirectory, { recursive: true, mode: 0o700 })
    writeFileSync(logFile, text, { mode: 0o600 })
    syntheticNativeAcl([join(home, 'logs'), join(home, 'logs', 'runs'), logDirectory, logFile].map(path => ({ path })))
  }
  return { root, binding, paths, rows, write, log, logFile }
}

it('carries credits and native occupancy independently from hidden token buckets through raw replay and native projection', async () => {
  const f = fixture(), observation = (await readQoderDurableContextAsync(f.binding))!
  expect(observation).toMatchObject({ providerCredits: 0.28, contextRatio: 0.25 })
  const path = join(f.root, 'run.raw.jsonl')
  writeFileSync(path, [observation, observation].map(record => JSON.stringify({ type: 'native', record })).join('\n') + '\n')
  const reader = new TelemetryReader(), identity = { conversationId: f.binding.sessionId, model: f.binding.model }
  for (let i = 0; i < 2; i++) {
    const data = reader.read(path, 'qoder', identity)
    expect(data.providerCredits).toBe(0.28); expect(data.usage).toBeUndefined()
    const projected = nativeTelemetryProjections('qoder', data, undefined, 'run-SIMULATED', { busy: false })
    expect(projected.tokenUsage).toMatchObject({ externalCredits: 0.28, externalScope: 'run', externalRunId: 'run-SIMULATED' })
    expect(projected.contextPressure?.externalContext?.ratio).toBe(0.25)
    expect(projected.tokenUsage).not.toHaveProperty('uncachedInputTokens')
  }
  expect(reader.read(path, 'qoder', { ...identity, model: 'OTHER' }).providerCredits).toBeUndefined()
})

it('sums distinct native requests once and uses the final block of each request', () => {
  const f = fixture(), first = f.rows[1]
  first.message.stop_reason = 'tool_use'
  const repeat = { ...first, uuid: 'same-request-block', parentUuid: first.uuid,
    message: { ...first.message, usage: { ...first.message.usage, credits: 0.3 } } }
  const final = { ...first, uuid: 'last-request', parentUuid: repeat.uuid,
    message: { ...first.message, id: 'second-request', stop_reason: 'end_turn', usage: { credits: 0.2, context_usage_ratio: 0.5 } } }
  f.rows.push(repeat, final)
  expect(inspectQoderDurableContext(f.rows, f.binding)).toMatchObject({ providerCredits: 0.5, contextRatio: 0.5 })
  f.rows.push({ ...f.rows[0], uuid: 'later-user' }, { ...final, uuid: 'later-answer', parentUuid: 'later-user',
    message: { ...final.message, usage: { credits: 999, context_usage_ratio: 0.9 } } })
  expect(inspectQoderDurableContext(f.rows, f.binding)?.providerCredits).toBe(0.5)
})

it.each([0, 0.28])('displays explicit native credits without requiring a context percentage (%s)', async credits => {
  const f = fixture(); f.rows[1].message.usage = { credits }; f.write()
  const observed = await readQoderDurableContextAsync(f.binding)
  expect(observed?.providerCredits).toBe(credits); expect(observed?.contextRatio).toBeUndefined()
})

it.each([undefined, -1, '0.28', Infinity])('keeps invalid or missing credits unknown and retains a valid ratio (%s)', credits => {
  const f = fixture(); f.rows[1].message.usage.credits = credits
  const observed = inspectQoderDurableContext(f.rows, f.binding)
  expect(observed?.providerCredits).toBeUndefined(); expect(observed?.contextRatio).toBe(0.25)
})

it('does not publish an invocation total when a native request has missing credits', () => {
  const f = fixture(), last = f.rows[1]
  const first = { ...last, uuid: 'first', parentUuid: f.binding.userMessageId,
    message: { ...last.message, id: 'first-request', stop_reason: 'tool_use', usage: { input_tokens: 0 } } }
  last.parentUuid = first.uuid; f.rows.splice(1, 0, first)
  expect(inspectQoderDurableContext(f.rows, f.binding)?.providerCredits).toBeUndefined()
})

it('supplements a proven same-turn native log window and marks only context quantity as estimated', async () => {
  const f = fixture()
  f.log(`2026-10-18T06:00:05.000Z INFO [auto-compact][session:${f.binding.sessionId}][main] threshold check: window=128000\n`)
  const observed = (await readQoderDurableContextAsync(f.binding))!
  expect(observed).toMatchObject({ providerCredits: 0.28, contextRatio: 0.25, contextCapacity: 128000, contextUsed: 32000 })
  const data = extractTelemetry('qoder', [observed], { conversationId: f.binding.sessionId, model: f.binding.model })
  expect(data).toMatchObject({ contextUsed: 32000, contextCapacity: 128000, contextEstimated: true, providerCredits: 0.28 })
  expect(data.usage).toBeUndefined()
})

it.each(['foreign-session', 'subagent', 'later-turn', 'foreign-model', 'private-failure', 'partial'])('optional rejected log does not erase ratio or credits (%s)', async kind => {
  const f = fixture()
  let line = `2026-10-18T06:00:05.000Z INFO [auto-compact][session:${f.binding.sessionId}][main] window=128000 model=${f.binding.model}\n`
  if (kind === 'foreign-session') line = line.replace(f.binding.sessionId, 'foreign')
  if (kind === 'subagent') line = line.replace('[main]', '[subagent]')
  if (kind === 'later-turn') line = line.replace('06:00:05', '06:00:15')
  if (kind === 'foreign-model') line = line.replace(`model=${f.binding.model}`, 'model=OTHER')
  if (kind === 'partial') line = line.trimEnd()
  f.log(line); if (kind === 'private-failure') process.platform === 'win32'
    ? syntheticNativeAcl([{ path: f.logFile, public: true, write: true }]) : exposeSyntheticNativePath(f.logFile)
  const observed = await readQoderDurableContextAsync(f.binding)
  expect(observed).toMatchObject({ providerCredits: 0.28, contextRatio: 0.25 })
  expect(observed?.contextCapacity).toBeUndefined()
})

it('accepts independently complete quota counters and rejects inconsistent/hidden token receipts', () => {
  expect(qoderPromptUsage({ input_tokens: 41, output_tokens: 5 })).toEqual({ inputTokens: 41, outputTokens: 5, totalTokens: 46 })
  expect(qoderPromptUsage({ input_tokens: 41, output_tokens: 5, total_tokens: 45 })).toBeUndefined()
  expect(qoderPromptUsage({ input_tokens: 0, output_tokens: 0 })).toBeUndefined()
})

it('keeps the official project key for Windows drives, Chinese, spaces and long paths', () => {
  expect(qoderProjectKey('C:\\Users\\模拟 用户\\project.name')).toBe('C--Users-------project-name')
  expect(qoderProjectKey('C:\\'+ 'x'.repeat(240))).toMatch(/^C--.{197}-[a-z0-9]+$/)
})

it('cancels native proof without publishing a receipt', async () => {
  const f = fixture(); expect(await readQoderDurableContextAsync(f.binding, { signal: AbortSignal.abort() })).toBeUndefined()
})

it('allows native administrator ownership only with direct current-user control and no untrusted writers', () => {
  const current='S-1-5-21-100-200-300-1001'
  const acl={ owner:'S-1-5-32-544',nullDacl:false,control:4,descriptor:'SIMULATED-descriptor',aces:[
    {type:0,flags:0,sid:current,mask:0x1f01ff},
    {type:0,flags:0,sid:'S-1-5-32-544',mask:0x1f01ff},
    {type:0,flags:0,sid:'S-1-1-0',mask:0x1200a9},
  ]}
  expect(privateWindowsAcl(acl,current,0o022)).toBe(false)
  expect(privateWindowsAcl(acl,current,0o022,true)).toBe(true)
  expect(privateWindowsAcl({...acl,aces:acl.aces.slice(1)},current,0o022,true)).toBe(false)
  expect(privateWindowsAcl({...acl,owner:'S-1-5-21-999'},current,0o022,true)).toBe(false)
  expect(privateWindowsAcl({...acl,aces:[...acl.aces,{type:0,flags:0,sid:'S-1-1-0',mask:2}]},current,0o022,true)).toBe(false)
  expect(privateWindowsAcl({...acl,aces:[{...acl.aces[0],flags:8},...acl.aces.slice(1)]},current,0o022,true)).toBe(false)
})
