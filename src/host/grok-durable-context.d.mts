import type { GrokContextObservation } from './grok-response.mjs'
export interface GrokDurableIdentity {
  home?: string
  env?: Record<string, string | undefined>
  project: string
  sessionId: string
  modelId: string
  promptId: string
}
export function inspectGrokDurableContext(records: unknown, config: Pick<GrokDurableIdentity, 'sessionId' | 'modelId' | 'promptId'>): GrokContextObservation | undefined
export function readGrokDurableContext(config: GrokDurableIdentity): GrokContextObservation | undefined
export class GrokDurableContextObserver {
  constructor(config: { home?: string; project: string; env?: Record<string, string | undefined>; preference: { model: string } })
  prepare(sessionId: string, signal?: AbortSignal): void | Promise<void>
  finish(result: unknown, sessionId: string, io: { signal?: AbortSignal; native(record: GrokContextObservation): void }): Promise<void>
}

export function readGrokDurableContextAsync(config: GrokDurableIdentity, baseline?: unknown, options?: { signal?: AbortSignal; budgetMs?: number }): Promise<GrokContextObservation | undefined>
