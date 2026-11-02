export interface KimiDurableTokens {
  inputOther: number
  output: number
  inputCacheRead: number
  inputCacheCreation: number
}
export interface KimiJournalBaseline {
  turns: Set<number>
  promptIds: Set<string>
}
export function kimiDurableUsage(value: unknown): KimiDurableTokens | undefined
export function kimiWorkspaceKey(project: string): string
export function kimiJournalBaseline(records: unknown[]): KimiJournalBaseline | undefined
export function inspectKimiDurableTurn(baseline: KimiJournalBaseline | undefined, appended: unknown[], expected: {
  prompt: string; model: string; hasChildren?: boolean
}): { turnId: string; responses: Array<{ stepId: string; responseId: string; usage: KimiDurableTokens }>;
  usage?: KimiDurableTokens; scope?: 'run' | 'reported' } | undefined
export class KimiDurableUsageObserver {
  constructor(config: unknown)
  prepare(sessionId: string, signal?: AbortSignal): void | Promise<void>
  finish(result: unknown, sessionId: string, io: { signal?: AbortSignal; native(record: unknown): void }): Promise<void>
}
