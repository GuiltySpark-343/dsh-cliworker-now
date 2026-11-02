import { describe, expect, it } from 'vitest'
import { ClaudeResponseTracker, claudeResponseUsage } from '../src/host/primary-response.mjs'
import { CliProtocol } from '../src/host/cli-protocol.ts'
import { runNativeClaude } from '../src/host/native-claude.mjs'
import { parseNativeResponse } from '../src/host/native-response.mjs'
import { AgyProtocol } from '../src/host/protocol.ts'
import { foldEvents } from '../src/shared/types.ts'

// All frames below are explicit offline protocol simulations; no account/model is used.
const start = { type: 'message_start', message: { id: 'synthetic-response', usage: { input_tokens: 12, output_tokens: 1, cache_read_input_tokens: 20, cache_creation_input_tokens: 3 } } }
const frames = [
  { type: 'stream_event', event: start },
  { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } } },
  { type: 'assistant', message: { id: 'synthetic-response', content: [{ type: 'thinking', thinking: '公开模拟思考' }] } },
  { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } },
  { type: 'stream_event', event: { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } } },
  { type: 'assistant', message: { id: 'synthetic-response', content: [{ type: 'text', text: '模拟回答' }] } },
  { type: 'stream_event', event: { type: 'content_block_stop', index: 1 } },
  { type: 'stream_event', event: { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'synthetic-tool', name: 'Read' } } },
  { type: 'assistant', message: { id: 'synthetic-response', content: [{ type: 'tool_use', id: 'synthetic-tool', name: 'Read', input: { file_path: 'synthetic.txt' } }] } },
  { type: 'stream_event', event: { type: 'content_block_stop', index: 2 } },
  { type: 'stream_event', event: { type: 'message_delta', usage: { output_tokens: 5 } } },
  { type: 'stream_event', event: { type: 'message_delta', usage: { output_tokens: 8 } } },
  { type: 'stream_event', event: { type: 'message_stop' } },
  { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'synthetic-tool', content: '模拟工具结果' }] } },
  { type: 'result', subtype: 'success', result: '模拟回答', usage: { input_tokens: 9999, output_tokens: 9999 } },
].map((frame) => ({ session_id: 'synthetic-session', ...frame }))

function folded(events: any[]) {
  return foldEvents(events.map((event, index) => ({ ...event, runId: 'synthetic-run', seq: index + 1, time: '' })))
}

async function native(transcript = frames) {
  const events: any[] = [], records: any[] = []
  let listener: (frame: any) => void = () => {}
  let result: any
  const waits: { predicate: (frame: any) => boolean; resolve: (frame: any) => void }[] = []
  const deliver = (frame: any) => {
    listener(frame)
    for (const waiter of [...waits]) if (waiter.predicate(frame)) {
      waits.splice(waits.indexOf(waiter), 1)
      waiter.resolve(frame)
    }
  }
  const peer = {
    onMessage(callback: typeof listener) { listener = callback; return () => {} },
    waitFor(predicate: (frame: any) => boolean) { return new Promise((resolve) => waits.push({ predicate, resolve })) },
    send(frame: any) {
      if (frame.request?.subtype === 'initialize') deliver({ type: 'control_response', response: { request_id: frame.request_id, subtype: 'success', response: { models: [{ value: 'synthetic-model', resolvedModel: 'synthetic-model' }] } } })
      else if (frame.request?.subtype === 'get_context_usage') deliver({ type: 'control_response', response: { request_id: frame.request_id, subtype: 'error' } })
      else if (frame.type === 'user') {
        deliver({ type: 'system', subtype: 'init', session_id: 'synthetic-session', model: 'synthetic-model' })
        for (const item of transcript) deliver(item)
      }
    },
    end() {}, close: async () => {}, done: Promise.resolve({ exitCode: 0 }),
  }
  await runNativeClaude({ argv: ['synthetic', '--print', '--output-format', 'stream-json', '--model', 'synthetic-model', '--permission-mode', 'acceptEdits', '任务：\nsynthetic'], preference: { model: 'synthetic-model', effort: 'default' }, mode: 'accept-edits', prompt: 'synthetic', project: '/tmp', timeoutMs: 1000 }, {
    openStdio: async () => peer, event: (event: any) => events.push(event), native: (record: any) => records.push(record), session() {}, result: (...args: any[]) => { result = args },
  })
  return { events, records, result }
}

describe('primary CLI response audit (offline protocol simulations)', () => {
  it('keeps Anthropic cache buckets separate and unknown categories absent', () => {
    expect(claudeResponseUsage({ input_tokens: 12, output_tokens: 8, cache_read_input_tokens: 20, cache_creation_input_tokens: 3 })).toEqual({ inputTokens: 12, outputTokens: 8, cacheReadTokens: 20, cacheWriteTokens: 3, totalTokens: 43 })
    expect(claudeResponseUsage({ input_tokens: 12, output_tokens: 8 })).toEqual({ inputTokens: 12, outputTokens: 8 })
    expect(claudeResponseUsage({ input_tokens: 12, output_tokens: 8, cache_read_input_tokens: -1 })).toBeUndefined()
    expect(claudeResponseUsage({ input_tokens: 12 })).toBeUndefined()
  })
  it('does not complete or settle usage at a content-block boundary', () => {
    const events: any[] = [], tracker = new ClaudeResponseTracker((event) => events.push(event))
    tracker.start(start.message.id, start.message.usage)
    tracker.emit({ kind: 'assistant', text: '模拟', step: 0 }, start.message.id, 0)
    tracker.delta({ output_tokens: 8 })
    expect(events[0].response.complete).toBeUndefined()
    tracker.finish(true)
    expect(events.at(-1).response.usage.totalTokens).toBe(43)
    events.forEach((event) => expect(() => parseNativeResponse(event.response)).not.toThrow())
  })
  it('preserves final published thinking counters as an output subset without adding tokens', () => {
    const events: any[] = [], tracker = new ClaudeResponseTracker((event) => events.push(event))
    tracker.start(start.message.id, start.message.usage)
    tracker.emit({ kind: 'assistant', text: '模拟' }, start.message.id, 0)
    tracker.delta({ output_tokens: 6, output_tokens_details: { thinking_tokens: 2 } })
    tracker.delta({ output_tokens: 8, output_tokens_details: { thinking_tokens: 5 } })
    tracker.finish(true)
    expect(events.at(-1).response.usage).toEqual({ inputTokens: 12, outputTokens: 8,
      cacheReadTokens: 20, cacheWriteTokens: 3, reasoningTokens: 5, totalTokens: 43 })
    expect(() => parseNativeResponse(events.at(-1).response)).not.toThrow()
  })
  it.each([undefined, null, -1, 9, 0.5, Number.NaN, Number.POSITIVE_INFINITY])('keeps absent or invalid thinking subcounts unknown: %s', (thinking_tokens) => {
    const usage = claudeResponseUsage({ input_tokens: 12, output_tokens: 8,
      output_tokens_details: { thinking_tokens } })
    expect(usage).toEqual({ inputTokens: 12, outputTokens: 8 })
  })
  it('does not infer usage if a final message_stop or message_delta is missing', () => {
    for (const final of [true, false]) {
      const events: any[] = [], tracker = new ClaudeResponseTracker((event) => events.push(event))
      tracker.start(start.message.id, start.message.usage)
      tracker.emit({ kind: 'assistant', text: '模拟' }, start.message.id, 0)
      if (!final) tracker.delta({ output_tokens: 8 })
      tracker.finish(final)
      expect(events.at(-1).response.usage).toBeUndefined()
    }
  })
  it('never assigns undefined message identities or child-agent content to the main response', () => {
    const events: any[] = [], tracker = new ClaudeResponseTracker((event) => events.push(event))
    tracker.emit({ kind: 'assistant', text: '无身份' }, undefined, 0)
    tracker.start('main')
    tracker.emit({ kind: 'assistant', text: '子任务' }, 'child', 0)
    expect(events.every((event) => event.response === undefined)).toBe(true)
  })
  it.each([{ updates: [{}] }, { updates: [{ output_tokens: 8 }, { output_tokens: 4 }] }])('rejects incomplete or decreasing final cumulative usage %j', ({ updates }) => {
    const events: any[] = [], tracker = new ClaudeResponseTracker((event) => events.push(event))
    tracker.start(start.message.id, start.message.usage)
    tracker.emit({ kind: 'assistant', text: '模拟' }, start.message.id, 0)
    for (const update of updates) tracker.delta(update)
    tracker.finish(true)
    expect(events.at(-1).response.usage).toBeUndefined()
  })
  it.each(['native', 'legacy'])('%s keeps reasoning, text and tool on one API message and settles final cumulative usage exactly once', async (transport) => {
    let events: any[]
    if (transport === 'native') {
      const output = await native()
      events = output.events
      expect(output.result[0]).toBe('SUCCESS')
    } else {
      events = []
      const parser = new CliProtocol('claude', (event) => events.push(event), () => {}, 1_000_000)
      for (const frame of frames) parser.feed(JSON.stringify(frame) + '\n')
      parser.end()
      expect(parser.result?.status).toBe('SUCCESS')
    }
    const rows = folded(events).filter((row) => row.response)
    expect(rows.map((row) => row.kind)).toEqual(['reasoning', 'assistant', 'tool'])
    expect(rows.map((row) => row.response?.index)).toEqual([0, 1, 2])
    expect(new Set(rows.map((row) => row.response?.id)).size).toBe(1)
    const settlements = events.filter((event) => event.response?.usage)
    expect(settlements).toHaveLength(1)
    expect(settlements[0].response.usage).toEqual({ inputTokens: 12, outputTokens: 8, cacheReadTokens: 20, cacheWriteTokens: 3, totalTokens: 43 })
    expect(rows[2]?.toolCall?.output).toBe('模拟工具结果')
    expect(JSON.stringify(settlements)).not.toContain('9999')
  })
  it('isolates interleaved child-agent stream identities from the main response', async () => {
    const child = (event: any) => ({ type: 'stream_event', session_id: 'synthetic-session', parent_tool_use_id: 'synthetic-parent-tool', event })
    const interleaved = [
      frames[0], frames[1],
      child({ type: 'message_start', message: { id: 'synthetic-child', usage: { input_tokens: 9999 } } }),
      child({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '模拟子进度' } }),
      child({ type: 'message_stop' }),
      ...frames.slice(2),
    ]
    const { events, result } = await native(interleaved as any)
    expect(result[0]).toBe('SUCCESS')
    const main = events.filter((event) => event.response?.id === 'claude:synthetic-response')
    expect(new Set(main.map((event) => event.response.index))).toEqual(new Set([0, 1, 2]))
    expect(events.find((event) => event.text === '模拟子进度')?.response).toBeUndefined()
    expect(events.findIndex((event) => event.text === '模拟子进度')).toBeGreaterThan(events.findIndex((event) => event.response?.complete && event.response?.usage))
    expect(events.filter((event) => event.response?.usage)).toHaveLength(1)
    expect(events.find((event) => event.response?.usage)?.response.usage.totalTokens).toBe(43)
  })
  it('legacy streams without partial-message evidence preserve unknown response usage', () => {
    const events: any[] = [], parser = new CliProtocol('claude', (event) => events.push(event), () => {}, 1_000_000)
    for (const frame of frames.filter((frame) => frame.type !== 'stream_event')) parser.feed(JSON.stringify(frame) + '\n')
    expect(events.every((event) => !event.response)).toBe(true)
  })
  it('Codex exec terminal total never becomes a last-response usage', () => {
    const events: any[] = [], parser = new CliProtocol('codex', (event) => events.push(event), () => {}, 1_000_000)
    for (const frame of [{ type: 'thread.started', thread_id: 'synthetic-thread' }, { type: 'item.completed', item: { type: 'reasoning', id: 'r', text: '模拟公开摘要', raw: 'PRIVATE' } }, { type: 'item.completed', item: { type: 'agent_message', id: 'a', text: '模拟回答' } }, { type: 'turn.completed', usage: { input_tokens: 200, output_tokens: 100 } }]) parser.feed(JSON.stringify(frame) + '\n')
    expect(events.every((event) => !event.response)).toBe(true)
    expect(JSON.stringify(events)).not.toContain('PRIVATE')
  })
  it('preserves verified Codex exec snake_case tool results and declined status', () => {
    const events: any[] = [], parser = new CliProtocol('codex', (event) => events.push(event), () => {}, 1_000_000)
    parser.feed(JSON.stringify({ type: 'thread.started', thread_id: 'synthetic-thread' }) + '\n')
    parser.feed(JSON.stringify({ type: 'item.completed', item: { id: 'synthetic-tool', type: 'command_execution', command: 'synthetic read', aggregated_output: '模拟工具结果', exit_code: 1, status: 'declined' } }) + '\n')
    expect(events.at(-1)).toMatchObject({ kind: 'tool', state: 'FAILED', toolCall: { callId: 'synthetic-tool', command: 'synthetic read', output: '模拟工具结果', exitCode: 1 } })
  })
  it('AGY legacy uses DONE step usage and never reassigns its conversation aggregate', () => {
    const events: any[] = [], parser = new AgyProtocol((event) => events.push(event), () => {}, 1_000_000)
    for (const frame of [{ event: 'init', conversation_id: 'synthetic-agy' }, { event: 'step_update', step_update: { step_type: 'agent_response', step_index: 12, state: 'DONE', text_delta: '模拟回答', usage: { input_tokens: 12, output_tokens: 8, cache_read_tokens: 20, total_tokens: 20 } } }, { event: 'result', result: { conversation_id: 'synthetic-agy', status: 'SUCCESS', response: '模拟回答', usage: { input_tokens: 9999, output_tokens: 9999, total_tokens: 19998 } } }]) parser.feed(JSON.stringify(frame) + '\n')
    expect(events.find((event) => event.response)?.response).toEqual({ id: 'agy:12', blockId: 'text', index: 0, complete: true, usage: { inputTokens: 12, outputTokens: 8, cacheReadTokens: 20, cacheWriteTokens: 0, totalTokens: 40 } })
    expect(events.every((event) => event.kind !== 'reasoning')).toBe(true)
  })
})
