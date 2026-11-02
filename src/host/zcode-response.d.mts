import type { NativeResponseUsage } from '../shared/types.ts'
import type { EventInput } from './protocol.ts'
export function zcodeResponseUsage(value: unknown): NativeResponseUsage | undefined
export class ZcodeToolInputs {
  remember(payload: unknown): void
  read(toolCallId: unknown, assistantMessageId: unknown): unknown
}
export class ZcodeResponseTracker {
  constructor(emit: (event: EventInput) => void)
  emit(event: EventInput, assistantMessageId: unknown, blockId: string, index: number): void
  tool(event: EventInput): void
  complete(payload: unknown): boolean
  finish(usage?: NativeResponseUsage): void
}
