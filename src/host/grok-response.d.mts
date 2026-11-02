import type { NativeResponseUsage } from '../shared/types.ts'
import type { EventInput } from './protocol.ts'
export function grokResponseUsage(value: unknown): NativeResponseUsage | undefined
export function grokModelContext(state: unknown, modelId: string): number | undefined
export interface GrokContextObservation {
  type: 'cliworker.grok_context'
  source: 'grok.session_status' | 'grok.durable.updates'
  sessionId: string
  modelId: string
  promptId?: string
  contextUsed: number | null
  contextCapacity?: number
  basis: 'native-estimate'
}
export function grokContextStatus(message: unknown, expected: { sessionId: string; modelId: string; project: string }): GrokContextObservation | undefined
export function grokPromptUsage(value: unknown): { usage: Record<string, number>; usageIsIncomplete: boolean } | undefined
export class GrokResponseTracker {
  constructor(emit: (event: EventInput) => void, options?: { requireStart?: boolean })
  start(messageId: unknown): void
  emit(event: EventInput, key: string): void
  finish(usage?: NativeResponseUsage, complete?: boolean): void
}
