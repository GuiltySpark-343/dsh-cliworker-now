import type { CliId } from './types.ts'
import type { TokenUsage } from './telemetry.ts'

export interface NativeTokenBuckets {
  uncachedInputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}
const count = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

/**
 * Translate the CLI's billing buckets, never sum successive snapshots. The
 * Host already labels run/session/reported scope and deduplicates receipts.
 * Unsupported or inconsistent accounting remains absent in the native UI.
 */
export function nativeTokenUsage(cli: CliId, usage?: TokenUsage): NativeTokenBuckets | undefined {
  if (usage?.orchestration && Object.values(usage.orchestration).some((value) => value > 0)) return
  if (!usage || !['response', 'run', 'session', 'reported'].includes(usage.scope)) return
  if (usage.reasoning !== undefined && (!count(usage.reasoning) ||
    (!['mimo', 'opencode'].includes(cli) && usage.output !== undefined && usage.reasoning > usage.output))) return
  if (!count(usage.total) || !count(usage.input) || !count(usage.output) || !count(usage.cacheRead)) return
  // Older Codex protocols omitted cache-write; current Codex explicitly reports
  // it and the observed value wins. AGY JSONUsage has no cache-write bucket.
  // This default describes these verified protocols, not another CLI.
  const cacheWriteTokens =
    (cli === 'codex' || cli === 'antigravity') && usage.cacheWrite === undefined ? 0 : usage.cacheWrite
  if (!count(cacheWriteTokens)) return
  if (cli === 'antigravity') {
    // AGY reports uncached input and cache reads separately. Its reported
    // total is input + output, while DSH's native total includes cache reads.
    // Do not subtract the cache from AGY input or compare those two totals.
    const reportedTotal = usage.input + usage.output
    const nativeTotal = reportedTotal + usage.cacheRead + cacheWriteTokens
    if (cacheWriteTokens !== 0 || !count(reportedTotal) || usage.total !== reportedTotal || !count(nativeTotal)) return
    return {
      uncachedInputTokens: usage.input,
      outputTokens: usage.output,
      cacheReadTokens: usage.cacheRead,
      cacheWriteTokens,
    }
  }
  let uncachedInputTokens: number
  let outputTokens = usage.output
  switch (cli) {
    // Host telemetry preserves these CLIs' aggregate input, including cache.
    case 'codex':
    case 'hermes':
    case 'grok':
    case 'zcode':
      uncachedInputTokens = usage.input - usage.cacheRead - cacheWriteTokens
      break
    // Claude, Kimi durable receipts and Pi/OMP expose separate input/cache buckets.
    case 'claude':
    case 'kimi':
    case 'pi':
    case 'omp':
      uncachedInputTokens = usage.input
      break
    // OpenCode/MiMo split reasoning out of output as well as splitting cache.
    case 'mimo':
    case 'opencode':
      if (!count(usage.reasoning)) return
      uncachedInputTokens = usage.input
      outputTokens += usage.reasoning
      break
    default:
      return
  }
  if (!count(uncachedInputTokens) || !count(outputTokens)) return
  const total = uncachedInputTokens + outputTokens + usage.cacheRead + cacheWriteTokens
  if (!count(total) || total !== usage.total) return
  return { uncachedInputTokens, outputTokens, cacheReadTokens: usage.cacheRead, cacheWriteTokens }
}

