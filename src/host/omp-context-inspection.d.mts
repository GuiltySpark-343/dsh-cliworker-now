export function hasOmpNativeContextCommand(commands: unknown): boolean
export interface OmpContextReport {
  contextCapacity: number
  contextUsed?: number
  basis: 'native-estimate'
  categories: Array<{ name: string; tokens: number; kind: 'used' | 'buffer' | 'free' }>
}
export function parseOmpNativeContextReport(text: unknown, contextUsage?: unknown): OmpContextReport | undefined
export class OmpContextInspection {
  constructor(options: { send: (record: object) => void; emit: (record: object) => void; done: () => void; timeoutMs?: number })
  observeCommands(commands: unknown): void
  start(sessionId: string, contextUsage?: unknown): void
  consume(record: unknown): boolean
  dispose(): void
}
