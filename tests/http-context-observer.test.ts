import { expect, it } from 'vitest'
import { estimateHttpRequestComposition, nativeHttpTokenEstimate } from '../src/host/http-context-observer.mjs'
// Explicit synthetic payloads; no native config, account or provider request.
it('uses the installed native UTF-16 length estimate, actual separate sections and a real empty tools bucket', () => {
  const body = { messages: [{ role: 'system', content: 'SIMULATED system' }, { role: 'user', content: 'SIMULATED 你好🙂' }], tools: [] }
  expect(nativeHttpTokenEstimate('你好🙂')).toBe(1)
  expect(estimateHttpRequestComposition(body, 'SIMULATED system')).toEqual({ systemTokens: nativeHttpTokenEstimate(JSON.stringify([body.messages[0]])), toolTokens: 0, messageTokens: nativeHttpTokenEstimate(JSON.stringify([body.messages[1]])), estimated: true, basis: 'native-chars-per-token-4' })
})
it('accepts native Anthropic system blocks and leaves unsupported inputs unknown', () => {
  const body = { system: [{ type: 'text', text: 'SIMULATED system' }], messages: [{ role: 'user', content: 'SIMULATED input' }], tools: [{ name: 'Read', input_schema: { type: 'object' } }] }
  expect(estimateHttpRequestComposition(body, 'SIMULATED system')?.toolTokens).toBeGreaterThan(0)
  expect(estimateHttpRequestComposition(body, 'another system')).toBeUndefined()
  expect(estimateHttpRequestComposition({ ...body, tools: {} }, 'SIMULATED system')).toBeUndefined()
  expect(estimateHttpRequestComposition({ ...body, messages: [{ role: 'system', content: [{ type: 'image' }] }] }, '')).toBeUndefined()
})
