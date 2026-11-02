// Read only the selected Worker's native rollout. Never infer categories from
// billed tokens or distribute a total by the wire's character percentages.
import { constants, lstatSync, realpathSync, openSync, fstatSync, readSync, closeSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
const object = value => value && typeof value === 'object' && !Array.isArray(value)
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\x00-\x1f]/.test(value)
const count = value => Number.isSafeInteger(value) && value >= 0
const maximumBytes = 8 * 1024 * 1024, maximumLineBytes = 2 * 1024 * 1024, maximumRecords = 4096
const sum = values => { const total = values.reduce((a, b) => a + b, 0); return values.every(count) && count(total) ? total : undefined }
/** Installed official ZCode 0.16.9 context/utils.js; shared divisor is 3.
 * JS .length is UTF-16, matching the native implementation, including CJK weight.
 */
export function zcodeNativeTokenEstimate(value) {
  if (typeof value !== 'string') return
  const chinese = (value.match(/[一-鿿]/g) || []).length
  return Math.ceil((chinese * 2 + value.length - chinese) / 3)
}
function textSections(value) {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value) && value.every(part => object(part) && part.type === 'text' && typeof part.text === 'string'))
    return value.map(part => part.text)
}
export function estimateZcodeRequestComposition(record, binding) {
  if (!validBinding(binding) || !object(record) || record.type !== 'model_io' ||
    record.querySource !== 'main_turn' || record.sessionId !== binding.sessionId || record.turnId !== binding.turnId ||
    record.requestId !== binding.requestId || record.traceId !== binding.traceId ||
    `${record.model?.providerId}/${record.model?.modelId}` !== binding.model) return
  const request = record.request, body = request?.body
  if (!object(request) || !object(body) || request.messagesKind !== 'full' || request.messageOffset !== 0 ||
    !Array.isArray(request.messages) || request.messages.length > 50000 || request.messageCount !== request.messages.length ||
    !request.messages.every(message => object(message) && ['system', 'user', 'assistant', 'tool'].includes(message.role)) ||
    !Array.isArray(body.tools) || body.tools.some(tool => !object(tool)) ||
    body.model !== record.model.modelId) return
  const systemMessages = request.messages.filter(message => message.role === 'system')
  const sections = body.system === undefined
    ? systemMessages.flatMap(message => textSections(message.content) ?? [undefined]) : textSections(body.system)
  if (!sections || sections.some(section => typeof section !== 'string')) return
  const messages = request.messages.filter(message => message.role !== 'system')
  if (!messages.length) return
  const systemTokens = sum(sections.map(zcodeNativeTokenEstimate))
  const toolTokens = sum(body.tools.map(tool => zcodeNativeTokenEstimate(JSON.stringify(tool))))
  const messageTokens = sum(messages.map(message => zcodeNativeTokenEstimate(JSON.stringify(message))))
  if (![systemTokens, toolTokens, messageTokens].every(count)) return
  return { systemTokens, toolTokens, messageTokens, estimated: true,
    basis: 'zcode.estimateTokens.v1.actual-request' }
}
function validBinding(binding) {
  return object(binding) && /^sess_[A-Za-z0-9-]{1,180}$/.test(binding.sessionId ?? '') &&
    [binding.turnId, binding.requestId, binding.traceId, binding.model].every(text) && binding.model.includes('/')
}
export function zcodeContextBinding(event, identity) {
  if (!object(event) || event.type !== 'session.updated' || event.sessionId !== identity?.sessionId ||
    !text(event.turnId) || (identity.turnId && event.turnId !== identity.turnId)) return
  const p = event.payload
  if (!object(p) || p.type !== 'model_request_started' || p.querySource !== 'main_turn' ||
    p.sessionId !== event.sessionId || !text(p.requestId) || !text(event.traceId) ||
    (p.traceId !== undefined && p.traceId !== event.traceId) || `${p.providerId}/${p.modelId}` !== identity.model) return
  return { sessionId: event.sessionId, turnId: event.turnId, requestId: p.requestId, traceId: event.traceId, model: identity.model }
}
/** Works with raw envelopes or sanitized native records; no message text leaves. */
export function zcodeContextBindings(records, identity) {
  if (!Array.isArray(records) || records.length > 20000) return []
  const bindings = [], ids = new Set()
  for (const envelope of records) {
    const value = envelope?.type === 'native' ? envelope.record : envelope
    if (value?.method !== 'session/event') continue
    const binding = zcodeContextBinding(value.params, identity)
    if (binding && !ids.has(binding.requestId)) { ids.add(binding.requestId); bindings.push(binding) }
  }
  return bindings
}
function identityFor(binding) {
  return { type: 'cliworker.zcode_context_observation', cli: 'zcode', source: 'zcode.native-model-io',
    sessionId: binding.sessionId, turnId: binding.turnId, requestId: binding.requestId,
    traceId: binding.traceId, model: binding.model }
}
export function unknownZcodeContextInspection(binding) {
  return validBinding(binding) ? { ...identityFor(binding), breakdown: null } : undefined
}
function readRollout(nativeDirectory, sessionId) {
  if (!isAbsolute(nativeDirectory) || !/^sess_[A-Za-z0-9-]{1,180}$/.test(sessionId)) return
  const root = resolve(nativeDirectory)
  // The only allowed path is this selected Worker's known native storage tree.
  if (realpathSync(root) !== root) return
  let directory = root
  const ancestors = []
  for (const component of ['', 'storage', 'cli', 'rollout']) {
    if (component) directory = join(directory, component)
    const info = lstatSync(directory)
    if (!info.isDirectory() || info.isSymbolicLink()) return
    ancestors.push({ path: directory, dev: info.dev, ino: info.ino })
  }
  const path = join(directory, `model-io-${sessionId}.jsonl`), before = lstatSync(path)
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > maximumBytes) return
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
  try {
    const opened = fstatSync(fd)
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) return
    const buffer = Buffer.alloc(opened.size), length = readSync(fd, buffer, 0, buffer.length, 0)
    const after = fstatSync(fd), current = lstatSync(path)
    if (length !== opened.size || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs ||
      current.dev !== opened.dev || current.ino !== opened.ino || current.size !== opened.size || current.nlink !== 1 || current.isSymbolicLink()) return
    for (const ancestor of ancestors) {
      const now = lstatSync(ancestor.path)
      if (!now.isDirectory() || now.isSymbolicLink() || now.dev !== ancestor.dev || now.ino !== ancestor.ino) return
    }
    const raw = buffer.toString('utf8')
    if (raw && !raw.endsWith('\n')) return // Do not use a torn in-flight request record.
    const lines = raw.split('\n').filter(Boolean)
    if (lines.length > maximumRecords || lines.some(line => Buffer.byteLength(line) > maximumLineBytes)) return
    return lines.map(line => JSON.parse(line))
  } finally { closeSync(fd) }
}
/** Every exact requested identity yields a numeric observation or explicit null.
 * Missing/rotated/delta/duplicate records cannot silently retain old categories.
 */
export function readZcodeContextInspections({ nativeDirectory, bindings }) {
  if (!Array.isArray(bindings) || bindings.length > maximumRecords || !bindings.every(validBinding)) return []
  if (!bindings.length || bindings.some(binding => binding.sessionId !== bindings[0].sessionId || binding.model !== bindings[0].model)) return []
  let records
  try { records = readRollout(nativeDirectory, bindings[0].sessionId) } catch {}
  return bindings.map(binding => {
    const matches = records?.filter(record => record?.requestId === binding.requestId) ?? []
    const breakdown = matches.length === 1 ? estimateZcodeRequestComposition(matches[0], binding) : undefined
    return { ...identityFor(binding), breakdown: breakdown ?? null }
  })
}
