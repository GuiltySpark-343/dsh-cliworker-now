import type { NativeUsageReport } from './native-usage-report.ts'
/** Exact settled CLI-run totals, separate from individual native model responses. */
interface ExternalRunTurnUsageBase {
  basis: 'external-run'
  runIds: readonly string[]
  label?: string
  /** Confirmed run-local CLI/provider/model, independent of internal routing. */
  displayRoutes?: readonly string[]
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
  { usage?: never; externalUsage: NativeUsageReport } |
  { usage?: never; externalUsage?: never; usageUnit: 'credits'; credits?: number } |
  { usage?: never; externalUsage?: never; nativeUsage: true }
)
/** Missing keys preserve complete native response receipts; null marks known unavailable run totals. */
export type ExternalTurnUsage = Readonly<Record<string, ExternalRunTurnUsage | null>>
