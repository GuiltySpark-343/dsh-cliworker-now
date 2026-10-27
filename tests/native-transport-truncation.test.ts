import { describe, expect, it } from 'vitest'
import { createNativeIO } from '../src/host/native-transport.mjs'

// Synthetic in-process bridge; no CLI process is spawned.
function fixture(overflow: 'truncate' | 'fail') {
  const frames: any[] = []
  const config = { maxLineBytes: 1024, maxRunBytes: 2048, overflow }
  const io = createNativeIO(config, (line: string) => frames.push(JSON.parse(line)), undefined)
  return { frames, io }
}

describe('native bridge volume policy', () => {
  it('keeps the run alive and flags the result when the mirror budget is exceeded', async () => {
    const { frames, io } = fixture('truncate')
    io.session('session-1', 'model-1')
    for (let index = 0; index < 20; index++) io.event({ kind: 'assistant', text: 'x'.repeat(300) })
    io.result('SUCCESS', 'done', undefined, 'response')
    await io.close()
    const result = frames.find((frame) => frame.type === 'result')
    expect(result).toMatchObject({ status: 'SUCCESS', truncated: true })
    expect(frames.filter((frame) => frame.type === 'event').length).toBeLessThan(20)
  })

  it('keeps the legacy kill behavior when overflow is set to fail', () => {
    const { io } = fixture('fail')
    io.session('session-1', 'model-1')
    expect(() => {
      for (let index = 0; index < 20; index++) io.event({ kind: 'assistant', text: 'x'.repeat(300) })
    }).toThrow('Native bridge output exceeds run limit')
  })

  it('drops an oversized single frame in truncate mode instead of failing', async () => {
    const { frames, io } = fixture('truncate')
    io.session('session-1', 'model-1')
    io.event({ kind: 'assistant', text: 'x'.repeat(1200) })
    io.result('SUCCESS', 'done', undefined, 'response')
    await io.close()
    expect(frames.filter((frame) => frame.type === 'event')).toHaveLength(0)
    expect(frames.find((frame) => frame.type === 'result')).toMatchObject({ truncated: true })
  })
})
