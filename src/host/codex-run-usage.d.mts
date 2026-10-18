export interface CodexUsageSnapshot {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  cachedInputTokens: number
  reasoningOutputTokens: number
  cacheWriteInputTokens?: number
}
export function codexUsageSnapshot(value: unknown): CodexUsageSnapshot | undefined
export class CodexRunUsage {
  constructor(expectedSessionId?: string)
  beforeStart(method: string, params: unknown): void
  prepare(sessionId: string, fresh: boolean, metadata?: unknown, latest?: unknown): void
  start(): void
  active(params: unknown): void
  finish(turnId: string): CodexUsageSnapshot | undefined
}
