// Run-owned loopback byte relay for the exact effective native provider endpoint.
// HOME, native data, PURE, permissions, request bodies and account sources stay
// unchanged. Only the owned server's native provider baseURL is overridden.
import { createServer } from 'node:http'
import { request as httpRequest, Agent as HttpAgent } from 'node:http'
import { request as httpsRequest, Agent as HttpsAgent } from 'node:https'
import { randomBytes } from 'node:crypto'
import { estimateHttpRequestComposition } from './http-context-observer.mjs'
const object = value => value && typeof value === 'object' && !Array.isArray(value)
const text = value => typeof value === 'string' && value.length > 0
const hop = new Set(['host', 'connection', 'proxy-connection', 'transfer-encoding', 'keep-alive', 'upgrade', 'te', 'trailer'])
export function nativeHttpEndpoint(provider, model, effective, selected) {
  const configured = effective?.provider?.[selected.providerID]?.options?.baseURL
  const loaded = provider?.options?.baseURL
  const fallback = model?.api?.url
  if (configured !== undefined && typeof configured !== 'string') return
  if (loaded !== undefined && typeof loaded !== 'string') return
  // Provider.list is the native loaded provider; explicit disagreement is not
  // resolved by guessing which source a later auth loader might prefer.
  if (loaded && configured && loaded !== configured) return
  const value = loaded || configured || fallback
  if (!text(value) || !text(model?.api?.id) || !['@ai-sdk/openai-compatible', '@ai-sdk/openai', '@ai-sdk/anthropic'].includes(model?.api?.npm)) return
  try {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || url.search) return
    return { url: url.href.replace(/\/$/, ''), apiModel: model.api.id }
  } catch { return }
}
function exactUser(body, prompt) {
  const messages = Array.isArray(body.messages) ? body.messages : Array.isArray(body.input) ? body.input : []
  return messages.some(message => message?.role === 'user' && (message.content === prompt ||
    Array.isArray(message.content) && message.content.some(part => ['text', 'input_text'].includes(part?.type) && part.text === prompt)))
}
function systemText(body) {
  const collect = value => typeof value === 'string' ? value : Array.isArray(value) && value.every(part => object(part) && typeof part.text === 'string') ? value.map(part => part.text).join('\n') : undefined
  const pieces = Array.isArray(body.messages) ? body.messages.filter(message => ['system', 'developer'].includes(message?.role)).map(message => collect(message.content)) : []
  if (body.system !== undefined) pieces.unshift(collect(body.system))
  return pieces.some(value => value === undefined) ? undefined : pieces.join('\n')
}
/** OpenCode 1.19.0 title/compaction calls have tools:{}; MiMo 0.1.15
 * genTitle is ephemeral:true and omits x-session-affinity, even when it uses a
 * StructuredOutput tool. Both wrap user text. Main requests retain the native
 * session header, current user text and actual tools. Unsupported no-tool main
 * requests stay unknown rather than borrowing a title or summary's composition.
 */
export function nativeHttpMainRequest(body, headers, binding) {
  if (!object(body) || !binding?.sessionId || body.model !== binding.apiModel ||
    !Array.isArray(body.tools) || body.tools.length === 0 || !exactUser(body, binding.prompt)) return false
  const session = headers['x-session-affinity'] ?? headers['x-session-id'] ?? headers['x-opencode-session-id']
  return typeof session === 'string' && session === binding.sessionId
}
export async function startHttpContextRelay(config, cli, selected, endpoint, emit, options = {}) {
  const upstreamBase = new URL(endpoint.url), nonce = randomBytes(24).toString('hex'), prefix = '/' + nonce
  const sockets = new Set(), upstreams = new Set()
  const httpAgent = new HttpAgent({ keepAlive: true }), httpsAgent = new HttpsAgent({ keepAlive: true })
  let binding, sequence = 0, closed = false
  const maximum = options.maxObservationBytes ?? 8 * 1024 * 1024
  const server = createServer((incoming, outgoing) => {
    if (closed || !incoming.url?.startsWith(prefix + '/') || incoming.url.includes('\\') || incoming.url.split('?')[0].split('/').some(value => { try { const decoded = decodeURIComponent(value); return decoded === '..' || decoded === '.' || decoded.includes('/') || decoded.includes('\\') } catch { return true } })) { outgoing.writeHead(404); outgoing.end(); return }
    const suffix = incoming.url.slice(prefix.length)
    const target = new URL(upstreamBase.href)
    target.pathname = upstreamBase.pathname.replace(/\/$/, '') + suffix.split('?')[0]
    target.search = suffix.includes('?') ? suffix.slice(suffix.indexOf('?')) : ''
    const headers = Object.fromEntries(Object.entries(incoming.headers).filter(([key]) => !hop.has(key.toLowerCase())))
    headers.host = target.host
    const upstream = (target.protocol === 'https:' ? httpsRequest : httpRequest)(target, { method: incoming.method, headers, agent: target.protocol === 'https:' ? httpsAgent : httpAgent }, response => {
      const forwarded = Object.fromEntries(Object.entries(response.headers).filter(([key]) => !hop.has(key.toLowerCase())))
      outgoing.writeHead(response.statusCode ?? 502, response.statusMessage, forwarded)
      response.pipe(outgoing)
      response.on('error', () => outgoing.destroy())
    })
    upstreams.add(upstream)
    upstream.once('close', () => upstreams.delete(upstream))
    upstream.on('error', () => outgoing.destroy())
    incoming.once('aborted', () => upstream.destroy())
    incoming.on('error', () => upstream.destroy())
    outgoing.on('error', () => upstream.destroy())
    outgoing.once('close', () => { if (!outgoing.writableEnded) upstream.destroy() })
    let size = 0, chunks = [], observing = incoming.method === 'POST'
    incoming.on('data', chunk => {
      if (!observing) return
      size += chunk.length
      if (size > maximum) { observing = false; chunks = []; return }
      chunks.push(chunk)
    })
    incoming.once('end', () => {
      const current = binding
      const session = incoming.headers['x-session-affinity'] ?? incoming.headers['x-session-id'] ?? incoming.headers['x-opencode-session-id']
      const ownSession = current && typeof session === 'string' && session === current.sessionId
      const unknown = () => {
        if (!ownSession) return
        const identity = { type: 'cliworker.http_context_observation', cli,
          source: `${cli}.request-body.native-token-estimate`, sessionId: current.sessionId,
          model: config.preference.model, requestMessageId: current.userID,
          requestId: `${current.userID}:${++sequence}` }
        emit({ ...identity, breakdown: null })
        return identity
      }
      try {
        if (incoming.method !== 'POST') return
        if (!observing) { unknown(); return }
        let body
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) }
        catch { unknown(); return }
        if (!nativeHttpMainRequest(body, incoming.headers, current)) {
          // Same-session/model tool-bearing calls with a transformed/omitted
          // current user block are unclassifiable main candidates, not evidence
          // that the prior request's composition remains current.
          if (ownSession && body?.model === current.apiModel && Array.isArray(body.tools) && body.tools.length) unknown()
          return
        }
        const identity = unknown()
        const system = systemText(body)
        const breakdown = system === undefined ? undefined : estimateHttpRequestComposition(body, system)
        if (identity && breakdown) emit({ ...identity, breakdown })
      } catch { /* Observation never changes provider request/response semantics. */ }
      finally { chunks = [] }
    })
    incoming.pipe(upstream)
  })
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)) })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const baseURL = `http://127.0.0.1:${server.address().port}${prefix}`
  const name = cli === 'mimo' ? 'MIMOCODE' : 'OPENCODE', env = { ...(config.env ?? process.env) }
  try {
    const previous = JSON.parse(env[`${name}_CONFIG_CONTENT`] || '{}')
    if (!object(previous)) throw new Error('原生 provider 配置无效')
    const provider = { ...(previous.provider ?? {}) }, chosen = { ...(provider[selected.providerID] ?? {}) }
    chosen.options = { ...(chosen.options ?? {}), baseURL }
    provider[selected.providerID] = chosen
    env[`${name}_CONFIG_CONTENT`] = JSON.stringify({ ...previous, provider })
  } catch (error) {
    httpAgent.destroy(); httpsAgent.destroy()
    await new Promise(resolve => server.close(resolve)); throw error
  }
  return {
    baseURL, config: { ...config, env },
    bind(sessionId, userID, prompt) { binding = { sessionId, userID, prompt, apiModel: endpoint.apiModel } },
    async close() {
      if (closed) return
      closed = true
      for (const request of upstreams) request.destroy()
      httpAgent.destroy(); httpsAgent.destroy()
      for (const socket of sockets) socket.destroy()
      await new Promise(resolve => server.close(resolve))
    },
  }
}
