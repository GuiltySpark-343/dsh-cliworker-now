import type { NativeResponseIdentity, NativeResponseUsage } from '../shared/types.ts'
import type { EventInput } from './protocol.ts'
export function claudeResponseUsage(value: unknown): NativeResponseUsage | undefined
export class ClaudeResponseTracker {
  constructor(emit: (event: EventInput) => void)
  id?: string
  start(id: unknown, usage?: unknown): void
  delta(usage: unknown): void
  emit(event: EventInput, id: unknown, index: number): NativeResponseIdentity | undefined
  finish(final?: boolean): void
}
