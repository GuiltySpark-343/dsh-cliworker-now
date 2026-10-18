import type { NativeUsageReport } from './native-usage-report.ts'
/** Exact settled CLI-run totals, separate from individual native model responses. */
interface ExternalRunTurnUsageBase {
  basis: 'external-run'
  runIds: readonly string[]
  label?: string
}
export interface NativeRunBuckets {
    uncachedInputTokens: number
    outputTokens: number
    totalTokens: number
    cacheReadTokens?: number
    cacheWriteTokens?: number
    reasoningTokens?: number
}
export type ExternalRunTurnUsage = ExternalRunTurnUsageBase & (
  { usage: NativeRunBuckets; externalUsage?: never } |
  { usage?: never; externalUsage: NativeUsageReport }
)
/** Missing keys preserve complete native response receipts; null marks known unavailable run totals. */
export type ExternalTurnUsage = Readonly<Record<string, ExternalRunTurnUsage | null>>
