import type { TokenUsage } from '../shared/telemetry.ts'

/** Hermes HTTP, legacy JSON and persisted CanonicalUsage counters lose provider
 * cache-field presence. Their zero means either zero or unreported. Positive
 * counters and the CLI's real inclusive prompt/output/total remain useful.
 * This is deliberately Hermes-only; other protocols may explicitly report zero.
 */
export function hermesCanonicalUsage<T extends TokenUsage>(value: T): T
export function hermesCanonicalUsage(value: TokenUsage | undefined): TokenUsage | undefined
export function hermesCanonicalUsage(value: TokenUsage | undefined): TokenUsage | undefined {
  if (!value) return
  const result = { ...value }
  if (result.cacheRead === 0) delete result.cacheRead
  if (result.cacheWrite === 0) delete result.cacheWrite
  return result
}
