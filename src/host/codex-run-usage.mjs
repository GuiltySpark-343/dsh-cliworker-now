const object = (value) => value && typeof value === 'object' && !Array.isArray(value)
const count = (value) => Number.isSafeInteger(value) && value >= 0
const fields = ['inputTokens', 'outputTokens', 'totalTokens', 'cachedInputTokens', 'reasoningOutputTokens']
const zero = () => Object.fromEntries([...fields, 'cacheWriteInputTokens'].map((field) => [field, 0]))
const terminal = new Set(['completed', 'failed', 'interrupted'])

/** Codex input includes cache buckets; reasoning is a subset of output. */
export function codexUsageSnapshot(value) {
  if (!object(value) || !fields.every((field) => count(value[field]))) return
  if (value.cacheWriteInputTokens !== undefined && !count(value.cacheWriteInputTokens)) return
  const total = value.inputTokens + value.outputTokens
  const cached = value.cachedInputTokens + (value.cacheWriteInputTokens ?? 0)
  if (!count(total) || !count(cached) || value.totalTokens !== total || cached > value.inputTokens || value.reasoningOutputTokens > value.outputTokens) return
  return { ...Object.fromEntries(fields.map((field) => [field, value[field]])),
    ...(value.cacheWriteInputTokens === undefined ? {} : { cacheWriteInputTokens: value.cacheWriteInputTokens }) }
}

/** A native run aggregate, never a provider-response/attempt or a `last` counter. */
export class CodexRunUsage {
  constructor(expectedSessionId) { this.sessionId = expectedSessionId }
  beforeStart(method, params) {
    if (this.sealed || !this.sessionId || params?.threadId !== this.sessionId) return
    if (method === 'turn/started' || (method === 'thread/status/changed' && params.status?.type === 'active')) {
      this.raced = true
      return
    }
    if (method !== 'thread/tokenUsage/updated' || typeof params.turnId !== 'string' || !params.turnId) return
    const tokens = codexUsageSnapshot(params.tokenUsage?.total)
    if (!tokens) { this.raced = true; return }
    this.replay = { turnId: params.turnId, tokens }
  }
  prepare(sessionId, fresh, metadata, latest) {
    if (this.sealed || (this.sessionId && sessionId !== this.sessionId)) return
    this.sessionId = sessionId
    if (fresh) this.baseline = zero()
    else if (!this.raced && this.replay && metadata?.thread?.id === sessionId && metadata.thread.status?.type === 'idle' &&
      Array.isArray(latest?.data) && latest.data.length === 1 && terminal.has(latest.data[0]?.status) &&
      latest.data[0].id === this.replay?.turnId) this.baseline = this.replay.tokens
  }
  start() { this.sealed = true; if (this.raced) this.baseline = undefined }
  active(params) {
    if (!this.sealed || params?.threadId !== this.sessionId || typeof params.turnId !== 'string' || !params.turnId) return
    if (!this.turnId) this.turnId = params.turnId
    if (params.turnId !== this.turnId) return
    const tokens = codexUsageSnapshot(params.tokenUsage?.total)
    if (!tokens) { this.invalid = true; return }
    const previous = this.final ?? this.baseline
    if (previous && [...fields, 'cacheWriteInputTokens'].some((field) => previous[field] !== undefined && tokens[field] !== undefined && tokens[field] < previous[field])) this.invalid = true
    this.final = tokens
  }
  finish(turnId) {
    if (!this.sealed || this.invalid || this.raced || !this.baseline || !this.final || this.turnId !== turnId) return
    const usage = {}
    for (const field of [...fields, 'cacheWriteInputTokens']) {
      if (this.baseline[field] === undefined || this.final[field] === undefined) continue
      const delta = this.final[field] - this.baseline[field]
      if (!count(delta)) return
      usage[field] = delta
    }
    // An interrupted turn can replay unchanged session totals before billing
    // settles. A zero delta proves no counter advance, not a zero-cost run.
    return usage.totalTokens > 0 ? codexUsageSnapshot(usage) : undefined
  }
}
