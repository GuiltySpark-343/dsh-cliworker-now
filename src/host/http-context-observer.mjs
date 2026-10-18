// Numeric estimate from actual native provider request sections only.
// OpenCode v1.19.0 core/src/util/token.ts and installed MiMo 0.1.15 both use
// Math.max(0, Math.round(text.length / 4)); estimates are never billed tokens.
const object = value => value && typeof value === 'object' && !Array.isArray(value)
export const nativeHttpTokenEstimate = input => Math.max(0, Math.round(input.length / 4))
const contentText = value => typeof value === 'string' ? value : Array.isArray(value) && value.every(part => object(part) && typeof part.text === 'string') ? value.map(part => part.text).join('\n') : undefined

export function estimateHttpRequestComposition(body, expectedSystem) {
  if (!object(body) || !Array.isArray(body.messages) || !body.messages.every(object) ||
    (body.tools !== undefined && !Array.isArray(body.tools))) return
  const system = body.messages.filter(message => ['system', 'developer'].includes(message.role))
  const messages = body.messages.filter(message => !['system', 'developer'].includes(message.role))
  if (!messages.length || messages.some(message => !['user', 'assistant', 'tool'].includes(message.role))) return
  const pieces = system.map(message => contentText(message.content))
  if (body.system !== undefined) pieces.unshift(contentText(body.system))
  if (pieces.some(value => value === undefined) || pieces.join('\n') !== expectedSystem) return
  const systemValue = body.system === undefined ? system : { system: body.system, messages: system }
  return {
    systemTokens: system.length === 0 && body.system === undefined ? 0 : nativeHttpTokenEstimate(JSON.stringify(systemValue)),
    toolTokens: body.tools === undefined || body.tools.length === 0 ? 0 : nativeHttpTokenEstimate(JSON.stringify(body.tools)),
    messageTokens: nativeHttpTokenEstimate(JSON.stringify(messages)),
    estimated: true, basis: 'native-chars-per-token-4',
  }
}

