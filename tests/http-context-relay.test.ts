import { afterEach, describe, expect, it } from 'vitest'
import { createServer, request as httpRequest } from 'node:http'
import { gzipSync } from 'node:zlib'
import { nativeHttpEndpoint, nativeHttpMainRequest, startHttpContextRelay } from '../src/host/http-context-relay.mjs'
const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
// Explicit local simulated provider requests. No native CLI, account or model.
const selected = { providerID: 'SIMULATED-provider', modelID: 'SIMULATED-model' }
const model = { api: { id: 'SIMULATED-api-model', npm: '@ai-sdk/openai-compatible', url: 'https://SIMULATED.invalid/v1' } }
const prompt = 'SIMULATED private current user text'
const body = { model: model.api.id, messages: [{ role: 'system', content: 'SIMULATED private system' }, { role: 'user', content: prompt }], tools: [{ type: 'function', function: { name: 'Read', parameters: { type: 'object' } } }] }
const headers = { 'x-session-affinity': 'SIMULATED-session', authorization: 'Bearer SIMULATED-private-key', 'content-type': 'application/json' }
async function provider(handler: Parameters<typeof createServer>[0]) {
  const server = createServer(handler as any)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanup.push(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) })
  return { server, base: `http://127.0.0.1:${(server.address() as any).port}/native/v1` }
}
async function relay(upstream: string, options = {}) {
  const records: any[] = []
  const env = { HOME: '/SIMULATED-original-home', MIMOCODE_PURE: '1', OPENCODE_PURE: '1', MIMOCODE_HOME: '/SIMULATED-native-data', OPENCODE_CONFIG_CONTENT: JSON.stringify({ provider: { [selected.providerID]: { options: { baseURL: upstream, temperature: 0.2 } } }, permission: { bash: 'ask' }, plugin: ['SIMULATED-disabled-user-plugin'] }) }
  const config = { preference: { model: `${selected.providerID}/${selected.modelID}` }, project: '/SIMULATED-cwd', env }
  const value = await startHttpContextRelay(config, 'opencode', selected, { url: upstream, apiModel: model.api.id }, record => records.push(record), options)
  cleanup.push(() => value.close())
  value.bind('SIMULATED-session', 'SIMULATED-user', prompt)
  return { value, records, config }
}
function rawRequest(url: string, value: unknown, extraHeaders = headers, raw = false) {
  return new Promise<{ status: number; body: Buffer; headers: any }>((resolve, reject) => {
    const bytes = Buffer.from(raw ? String(value) : JSON.stringify(value))
    const request = httpRequest(url, { method: 'POST', headers: { ...extraHeaders, 'content-length': String(bytes.length) } }, response => {
      const chunks: Buffer[] = []; response.on('data', chunk => chunks.push(chunk)); response.on('end', () => resolve({ status: response.statusCode!, body: Buffer.concat(chunks), headers: response.headers })); response.on('error', reject)
    }); request.on('error', reject); request.end(bytes)
  })
}
describe('run-owned native provider context relay', () => {
  it('takes only exact native effective endpoints and refuses unsupported or conflicting sources', () => {
    expect(nativeHttpEndpoint({}, model, {}, selected)).toEqual({ url: new URL(model.api.url).href, apiModel: model.api.id })
    const configured = { provider: { [selected.providerID]: { options: { baseURL: 'https://SIMULATED-route.invalid/v2' } } } }
    expect(nativeHttpEndpoint({}, model, configured, selected)?.url).toBe('https://simulated-route.invalid/v2')
    expect(nativeHttpEndpoint({ options: { baseURL: 'https://SIMULATED-other.invalid' } }, model, configured, selected)).toBeUndefined()
    for (const url of ['file:///SIMULATED', 'https://user:secret@SIMULATED.invalid', 'https://SIMULATED.invalid/?apiKey=SIMULATED', 'not-a-url']) expect(nativeHttpEndpoint({}, { ...model, api: { ...model.api, url } }, {}, selected)).toBeUndefined()
    expect(nativeHttpEndpoint({}, { api: { ...model.api, npm: 'SIMULATED-unsupported-sdk' } }, {}, selected)).toBeUndefined()
  })
  it('preserves original HOME/PURE/cwd/data/permissions and other provider settings in the child-only route', async () => {
    const upstream = await provider((_req, res) => res.end('SIMULATED'))
    const f = await relay(upstream.base), env = f.value.config.env
    for (const key of ['HOME', 'MIMOCODE_HOME', 'MIMOCODE_PURE', 'OPENCODE_PURE']) expect(env[key]).toBe(f.config.env[key])
    expect(f.value.config.project).toBe(f.config.project)
    const original = JSON.parse(f.config.env.OPENCODE_CONFIG_CONTENT), changed = JSON.parse(env.OPENCODE_CONFIG_CONTENT)
    expect(changed.permission).toEqual(original.permission); expect(changed.plugin).toEqual(original.plugin)
    expect(changed.provider[selected.providerID].options.temperature).toBe(0.2)
    expect(original.provider[selected.providerID].options.baseURL).toBe(upstream.base)
    expect(changed.provider[selected.providerID].options.baseURL).toBe(f.value.baseURL)
  })
  it('forwards compressed SSE bytes, status, end-to-end headers and request bytes without recording payloads or credentials', async () => {
    const encoded = gzipSync(Buffer.from('data: {"SIMULATED":"stream"}\n\ndata: [DONE]\n\n'))
    let observed: any
    const upstream = await provider(async (req, res) => {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk)
      observed = { url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() }
      res.writeHead(201, { 'content-type': 'text/event-stream', 'content-encoding': 'gzip', 'x-simulated-provider': 'preserved', 'content-length': encoded.length }); res.write(encoded.subarray(0, 8)); res.end(encoded.subarray(8))
    })
    const f = await relay(upstream.base), received = await rawRequest(f.value.baseURL + '/chat/completions?SIMULATED=1', body)
    expect(observed.url).toBe('/native/v1/chat/completions?SIMULATED=1')
    expect(observed.body).toBe(JSON.stringify(body)); expect(observed.headers.authorization).toBe(headers.authorization)
    expect(observed.headers['x-session-affinity']).toBe(headers['x-session-affinity'])
    expect(received.status).toBe(201); expect(received.headers['content-encoding']).toBe('gzip'); expect(received.headers['x-simulated-provider']).toBe('preserved'); expect(received.body).toEqual(encoded)
    expect(f.records).toHaveLength(2); expect(f.records[0].breakdown).toBeNull(); expect(f.records[1].requestId).toBe(f.records[0].requestId)
    expect(f.records[1].breakdown.toolTokens).toBeGreaterThan(0)
    expect(JSON.stringify(f.records)).not.toMatch(/private current|private system|private-key|parameters/)
  })
  it('rejects foreign session/model, title/summary no-tool payloads and substring-only user text', () => {
    const binding = { sessionId: headers['x-session-affinity'], apiModel: model.api.id, prompt }
    expect(nativeHttpMainRequest(body, headers, binding)).toBe(true)
    expect(nativeHttpMainRequest(body, { ...headers, 'x-session-affinity': 'SIMULATED-other-session' }, binding)).toBe(false)
    expect(nativeHttpMainRequest({ ...body, model: 'SIMULATED-other-model' }, headers, binding)).toBe(false)
    expect(nativeHttpMainRequest({ ...body, tools: [] }, headers, binding)).toBe(false)
    expect(nativeHttpMainRequest({ ...body, tools: [{ name: 'StructuredOutput' }] }, {}, binding)).toBe(false)
    expect(nativeHttpMainRequest({ ...body, messages: [{ role: 'user', content: 'Generate a title:\n' + prompt }] }, headers, binding)).toBe(false)
  })
  it('emits a newer unknown boundary when a bound main request has an unsupported body instead of retaining old categories', async () => {
    const upstream = await provider((_req, res) => res.end('SIMULATED'))
    const f = await relay(upstream.base)
    await rawRequest(f.value.baseURL + '/chat/completions', body)
    await rawRequest(f.value.baseURL + '/responses', { model: model.api.id, tools: body.tools, input: [{ role: 'user', content: prompt }] })
    expect(f.records).toHaveLength(3)
    expect(f.records[0].requestId).toBe(f.records[1].requestId)
    expect(f.records[2]).toMatchObject({ requestId: 'SIMULATED-user:2', breakdown: null })
  })
  it('clears old buckets on same-session oversized, malformed or transformed requests, while foreign and title calls do not supply categories', async () => {
    let forwarded = 0
    const upstream = await provider(async (req, res) => { for await (const _chunk of req) {} forwarded++; res.end('SIMULATED') })
    const f = await relay(upstream.base, { maxObservationBytes: 2048 })
    await rawRequest(f.value.baseURL + '/chat/completions', body)
    expect(f.records.at(-1).breakdown).not.toBeNull()
    await rawRequest(f.value.baseURL + '/chat/completions', { ...body, padding: 'SIMULATED-private-' + 'x'.repeat(3000) })
    expect(f.records.at(-1)).toMatchObject({ requestId: 'SIMULATED-user:2', breakdown: null })
    await rawRequest(f.value.baseURL + '/chat/completions', '{SIMULATED malformed JSON', headers, true)
    expect(f.records.at(-1)).toMatchObject({ requestId: 'SIMULATED-user:3', breakdown: null })
    await rawRequest(f.value.baseURL + '/chat/completions', { ...body, messages: [{ role: 'user', content: 'SIMULATED transformed main input' }] })
    expect(f.records.at(-1)).toMatchObject({ requestId: 'SIMULATED-user:4', breakdown: null })
    const before = f.records.length
    await rawRequest(f.value.baseURL + '/chat/completions', '{SIMULATED malformed foreign', { ...headers, 'x-session-affinity': 'SIMULATED-foreign' }, true)
    await rawRequest(f.value.baseURL + '/chat/completions', { ...body, tools: [] })
    expect(f.records).toHaveLength(before)
    expect(forwarded).toBe(6)
    expect(JSON.stringify(f.records)).not.toMatch(/private-|malformed JSON|transformed main/)
  })
  it('rejects an unowned loopback path and closes upstream work on caller abort', async () => {
    let forwarded = 0, closed = false
    const upstream = await provider((req, _res) => { forwarded++; req.on('close', () => { closed = true }) })
    const f = await relay(upstream.base)
    const unowned = new URL(f.value.baseURL); unowned.pathname = '/SIMULATED-unowned'
    const rejected = await rawRequest(unowned.href, body)
    expect(rejected.status).toBe(404); expect(forwarded).toBe(0)
    const request = httpRequest(f.value.baseURL + '/chat/completions', { method: 'POST', headers }, () => {})
    request.on('error', () => {}); request.write('{"SIMULATED":"partial request"}')
    await new Promise(resolve => setTimeout(resolve, 20)); request.destroy()
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(forwarded).toBe(1); expect(closed).toBe(true)
  })
})
