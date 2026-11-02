import { describe, expect, it } from 'vitest'
import { ZcodeToolInputs } from '../src/host/zcode-response.mjs'

describe('ZCode structured tool input identity (explicit synthetic frames)', () => {
  const input = { file_path: 'synthetic.json', content: 'synthetic' }
  it('uses the actual call and assistant pair and never parses a delta', () => {
    const tracker = new ZcodeToolInputs()
    tracker.remember({ toolCallId: 'call', assistantMessageId: 'assistant', input, done: false })
    expect(tracker.read('call', 'assistant')).toEqual(input)
    expect(tracker.read('call', 'foreign')).toBeUndefined()
    expect(tracker.read('foreign', 'assistant')).toBeUndefined()
    expect(tracker.read('call', undefined)).toBeUndefined()
    tracker.remember({ toolCallId: 'text-only', assistantMessageId: 'assistant', delta: JSON.stringify(input) })
    expect(tracker.read('text-only', 'assistant')).toBeUndefined()
  })
  it('rejects ambiguous reused call IDs rather than carrying another response input', () => {
    const tracker = new ZcodeToolInputs()
    tracker.remember({ toolCallId: 'reused', assistantMessageId: 'first', input })
    tracker.remember({ toolCallId: 'reused', assistantMessageId: 'second', input: { path: 'foreign' } })
    expect(tracker.read('reused', 'first')).toBeUndefined()
    expect(tracker.read('reused', 'second')).toBeUndefined()
  })
  it('does not accept unscoped or string-encoded input snapshots', () => {
    for (const payload of [{ toolCallId: 'call', input }, { assistantMessageId: 'assistant', input },
      { toolCallId: 'call', assistantMessageId: 'assistant', input: JSON.stringify(input) }]) {
      const tracker = new ZcodeToolInputs()
      tracker.remember(payload)
      expect(tracker.read('call', 'assistant')).toBeUndefined()
    }
  })
})
