import { expect, it } from 'vitest'
import { CliProtocol } from '../src/host/cli-protocol.ts'
import { foldEvents } from '../src/shared/types.ts'

// Offline, synthetic MiMo JSONL fixtures. These do not invoke a CLI or model.
const tokens = { input: 12, output: 8, reasoning: 4, cache: { read: 20, write: 3 }, total: 47 }
function fixture() {
  const events: any[] = []
  const parser = new CliProtocol('mimo', (event) => events.push(event), () => {}, 1_000_000)
  const send = (type: string, part: any) => parser.feed(JSON.stringify({ type, sessionID: 'synthetic-session', part }) + '\n')
  const part = (id: string, value: any = {}, messageID = 'synthetic-message') => ({ id, sessionID: 'synthetic-session', messageID, ...value })
  return { parser, events, send, part }
}

it('groups legacy MiMo public reasoning/text/tool by the explicit API message and settles step_finish usage once', () => {
  const f = fixture()
  f.send('step_start', f.part('start', { type: 'step-start' }))
  f.send('reasoning', f.part('thinking', { type: 'reasoning', text: '模拟公开思考' }))
  f.send('text', f.part('text', { type: 'text', text: '模拟回答' }))
  f.send('tool_use', f.part('tool', { type: 'tool', callID: 'synthetic-call', tool: 'Read', state: { status: 'completed', input: { path: 'synthetic' }, output: '模拟工具结果' } }))
  f.send('step_finish', f.part('finish', { type: 'step-finish', reason: 'stop', tokens }))
  f.send('step_finish', f.part('finish', { type: 'step-finish', reason: 'stop', tokens }))
  f.parser.end()
  const rows = foldEvents(f.events.map((event, index) => ({ ...event, seq: index + 1, runId: 'synthetic-run', time: '' }))).filter((row) => row.response)
  expect(rows.map((row) => row.kind)).toEqual(['reasoning', 'assistant', 'tool'])
  expect(new Set(rows.map((row) => row.response?.id))).toEqual(new Set(['mimo:synthetic-message']))
  expect(f.events.filter((event) => event.response?.usage)).toHaveLength(1)
  expect(rows[1]?.response).toMatchObject({ complete: true, usage: { inputTokens: 12, outputTokens: 12, reasoningTokens: 4, cacheReadTokens: 20, cacheWriteTokens: 3, totalTokens: 47 } })
  expect(rows[2]?.toolCall).toMatchObject({ callId: 'synthetic-call', input: { path: 'synthetic' }, output: '模拟工具结果' })
  expect(f.parser.result?.status).toBe('SUCCESS')
})

it('leaves absent message identity and invalid usage unknown', () => {
  const f = fixture()
  f.send('text', { id: 'old-fixture', text: '旧格式模拟回答' })
  expect(f.events.at(-1)?.response).toBeUndefined()
  f.send('text', f.part('text', { text: '有身份的模拟回答' }))
  f.send('step_finish', f.part('finish', { reason: 'stop', tokens: { ...tokens, total: 999999 } }))
  expect(f.events.some((event) => event.response?.complete)).toBe(true)
  expect(f.events.every((event) => !event.response?.usage)).toBe(true)
})

it('never turns redacted reasoning or generic metadata into public thinking', () => {
  const f = fixture()
  f.send('reasoning', f.part('redacted', { type: 'reasoning', text: 'PRIVATE', redacted: true }))
  f.send('reasoning', f.part('metadata', { type: 'metadata', text: 'PRIVATE' }))
  f.send('reasoning', { id: 'unscoped', type: 'reasoning', text: 'PRIVATE' })
  expect(f.events.every((event) => event.kind !== 'reasoning')).toBe(true)
  expect(JSON.stringify(f.events)).not.toContain('PRIVATE')
})

it('rejects a foreign part identity and preserves independently identified model responses', () => {
  const f = fixture()
  expect(() => f.send('text', f.part('foreign', { sessionID: 'other-session', text: 'PRIVATE' }))).toThrow('identity')
  for (const id of ['first', 'second']) {
    f.send('text', f.part('text', { text: `模拟${id}` }, id))
    f.send('step_finish', f.part('finish', { reason: 'stop', tokens }, id))
  }
  expect(f.events.filter((event) => event.response?.usage).map((event) => event.response.id)).toEqual(['mimo:first', 'mimo:second'])
})

it('keeps a completed tool update on its original response block', () => {
  const f = fixture()
  f.send('tool_use', f.part('tool', { callID: 'synthetic-call', tool: 'Read', state: { status: 'running', input: { path: 'synthetic' } } }))
  f.send('step_finish', f.part('finish', { reason: 'tool-calls', tokens }))
  f.send('tool_use', f.part('tool', { callID: 'synthetic-call', tool: 'Read', state: { status: 'completed', output: '模拟结果' } }))
  const tools = f.events.filter((event) => event.kind === 'tool')
  expect(tools[0]?.state).toBe('RUNNING')
  expect(tools.at(-1)).toMatchObject({ state: 'COMPLETED', response: { id: 'mimo:synthetic-message', blockId: 'tool' }, toolCall: { callId: 'synthetic-call', output: '模拟结果' } })
})
