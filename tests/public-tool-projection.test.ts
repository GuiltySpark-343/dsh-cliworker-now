import { describe, expect, it } from 'vitest'
import { BridgeProtocol } from '../src/host/bridge-protocol.ts'
import { pickPublicToolCall, projectPublicToolCall } from '../src/host/public-tool-projection.ts'
import { foldEvents, type WorkerEvent } from '../src/shared/types.ts'

describe('native public tool projection (synthetic transcripts, no models)', () => {
  it('keeps only public fields and explicit identity, preserving literal JSON and HTML text', () => {
    expect(pickPublicToolCall({ callId: 'call', parentCallId: 'parent', name: 'Read',
      input: { file_path: '<script>literal</script>' }, output: null,
      command: '', exitCode: 0, internalSecret: 'must not escape',
    })).toEqual({ callId: 'call', parentCallId: 'parent', name: 'Read',
      input: { file_path: '<script>literal</script>' }, output: null, command: '', exitCode: 0 })
    expect(pickPublicToolCall({ callId: 1, parentCallId: '', exitCode: NaN, hidden: 'no' })).toBeUndefined()
  })

  it('carries native tools through framing and folding, retaining start input at completion', () => {
    const events: WorkerEvent[] = []
    const bridge = new BridgeProtocol((event) => events.push({ ...event, seq: events.length + 1,
      runId: 'run', time: '2026-10-16T05:00:00Z' }), () => {}, 16_384)
    const send = (value: unknown) => bridge.feed(JSON.stringify(value) + '\n')
    send({ type: 'session', id: 'synthetic' })
    send({ type: 'event', event: { kind: 'tool', step: 0, text: 'Read', state: 'RUNNING',
      toolCall: { callId: 'child', parentCallId: 'root', name: 'Read', input: { file_path: 'demo.txt' }, privateFrame: 'omit' } } })
    send({ type: 'event', event: { kind: 'tool', step: 0, text: 'Read', state: 'COMPLETED',
      toolCall: { callId: 'child', output: 'actual output' } } })
    send({ type: 'event', event: { kind: 'assistant', step: 1, text: '  Hello' } })
    send({ type: 'event', event: { kind: 'assistant', step: 2, text: '  Hello again' } })
    send({ type: 'result', status: 'SUCCESS', response: '  Hello again', resultScope: 'response' })
    bridge.end()
    const rows = foldEvents(events, undefined, 'codex')
    expect(rows.filter((row) => row.kind === 'tool')).toMatchObject([{ state: 'COMPLETED', toolCall: {
      callId: 'child', parentCallId: 'root', name: 'Read', input: { file_path: 'demo.txt' }, output: 'actual output',
    } }])
    expect(rows.filter((row) => row.kind === 'assistant').map((row) => row.text)).toEqual(['  Hello', '  Hello again'])
    expect(JSON.stringify(rows)).not.toContain('privateFrame')
    expect(events.at(-1)?.resultScope).toBe('response')
  })

  it('upgrades only verified historical shapes without inventing identities or rewriting detail', () => {
    const detail = JSON.stringify({ name: 'run_command', parameters: { CommandLine: 'echo literal' } })
    expect(projectPublicToolCall('antigravity', { kind: 'tool', text: 'run_command', step: 7, detail }))
      .toEqual({ kind: 'tool', text: 'run_command', step: 7, detail,
        toolCall: { name: 'run_command', input: { CommandLine: 'echo literal' }, command: 'echo literal' } })
    expect(projectPublicToolCall('zcode', { kind: 'tool', text: 'read', detail: JSON.stringify({
      toolCallId: 'child', toolName: 'read', dependencies: ['other'], inputRef: 'private://do-not-read',
    }) }).toolCall).toEqual({ callId: 'child', name: 'read' })
    const unknown = { kind: 'tool', text: 'unknown', step: 2, detail: '{"parent":"guessed","output":"opaque"}' } as const
    expect(projectPublicToolCall('pi', unknown)).toBe(unknown)
    expect(projectPublicToolCall('claude', { kind: 'assistant', text: 'reply', detail })).toEqual({ kind: 'assistant', text: 'reply', detail })
  })

  it('drops tool metadata on other kinds and ignores unsupported result scopes', () => {
    const events: any[] = []
    const bridge = new BridgeProtocol((event) => events.push(event), () => {}, 4096)
    bridge.feed(JSON.stringify({ type: 'session', id: 'synthetic' }) + '\n')
    bridge.feed(JSON.stringify({ type: 'event', event: { kind: 'assistant', text: 'text', toolCall: { callId: 'fake' } } }) + '\n')
    bridge.feed(JSON.stringify({ type: 'result', status: 'SUCCESS', response: 'text', resultScope: 'guessed' }) + '\n')
    expect(events.at(-2)).not.toHaveProperty('toolCall')
    expect(events.at(-1)).not.toHaveProperty('resultScope')
  })
})
