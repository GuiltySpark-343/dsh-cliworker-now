import type { CliId, PublicToolCall } from '../shared/types.ts'
import type { EventInput } from './protocol.ts'

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key)
const text = (value: unknown): value is string => typeof value === 'string' && !!value.trim()

/** Keep only the public presentation contract, never arbitrary runner metadata. */
export function pickPublicToolCall(value: unknown): PublicToolCall | undefined {
  if (!record(value)) return
  const result: PublicToolCall = {}
  for (const key of ['callId', 'parentCallId', 'name'] as const)
    if (text(value[key])) result[key] = value[key]
  if (typeof value.command === 'string') result.command = value.command
  if (Number.isSafeInteger(value.exitCode)) result.exitCode = value.exitCode as number
  for (const key of ['input', 'output'] as const)
    if (own(value, key) && value[key] !== undefined) result[key] = value[key]
  return Object.keys(result).length ? result : undefined
}

/**
 * Read-only upgrade of documented legacy public tool shapes. Identity is taken
 * only from a native call ID; scheduling dependencies and step numbers are not
 * parent calls. Unknown detail remains available as the existing generic JSON.
 */
export function projectPublicToolCall(cli: CliId, event: EventInput): EventInput {
  if (event.kind !== 'tool') return event
  const explicit = pickPublicToolCall(event.toolCall)
  if (explicit) return { ...event, toolCall: explicit }
  if (!event.detail) return event
  let detail: unknown
  try { detail = JSON.parse(event.detail) } catch { return event }
  if (!record(detail)) return event
  let tool: PublicToolCall | undefined
  if (cli === 'codex' && text(detail.id) && text(detail.type)) {
    tool = pickPublicToolCall({
      callId: detail.id,
      name: text(detail.tool) ? detail.tool : detail.type,
      ...(own(detail, 'arguments') ? { input: detail.arguments } : {}),
      ...(detail.type === 'fileChange' && own(detail, 'changes') ? { output: detail.changes } : {}),
      ...(own(detail, 'aggregatedOutput') ? { output: detail.aggregatedOutput } : {}),
      ...(own(detail, 'result') ? { output: detail.result } : {}),
      command: detail.command,
      exitCode: detail.exitCode,
    })
  } else if (cli === 'antigravity' && text(detail.name)) {
    tool = pickPublicToolCall({
      name: detail.name,
      ...(own(detail, 'parameters') ? { input: detail.parameters } : {}),
      ...(record(detail.parameters) && typeof detail.parameters.CommandLine === 'string'
        ? { command: detail.parameters.CommandLine } : {}),
    })
  } else if ((cli === 'opencode' || cli === 'mimo') && own(detail, 'input') && text(detail.status)) {
    tool = pickPublicToolCall({
      name: event.text,
      input: detail.input,
      ...(own(detail, 'output') ? { output: detail.output } : {}),
    })
  } else if ((cli === 'kimi' || cli === 'grok') && text(detail.toolCallId)) {
    tool = pickPublicToolCall({
      callId: detail.toolCallId,
      name: detail.title,
      ...(own(detail, 'rawInput') ? { input: detail.rawInput } : {}),
      ...(own(detail, 'rawOutput') ? { output: detail.rawOutput } :
        own(detail, 'content') ? { output: detail.content } : {}),
    })
  } else if (cli === 'zcode' && text(detail.toolCallId)) {
    tool = pickPublicToolCall({ callId: detail.toolCallId, name: detail.toolName })
  }
  return tool ? { ...event, toolCall: tool } : event
}
