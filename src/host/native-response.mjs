const count = (value) => Number.isSafeInteger(value) && value >= 0
const object = (value) => !!value && typeof value === 'object' && !Array.isArray(value)

/** AGY JSONUsage input excludes cache reads; its reported total excludes them too. */
export function agyResponseUsage(value) {
  if (!object(value)) return
  const {
    input_tokens: input,
    output_tokens: output,
    cache_read_tokens: cacheRead,
    total_tokens: total,
  } = value
  if (
    ![input, output, cacheRead, total].every(count) ||
    total !== input + output ||
    !count(total + cacheRead)
  )
    return
  return {
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: 0,
    totalTokens: total + cacheRead,
  }
}

/** Internal transport validation: identity is explicit and usage is never inferred. */
export function parseNativeResponse(value) {
  if (
    !object(value) ||
    !['id', 'blockId'].every(
      (key) => typeof value[key] === 'string' && value[key].length > 0 && value[key].length <= 512,
    ) ||
    !count(value.index) ||
    value.index > 4096 ||
    (value.complete !== undefined && value.complete !== true)
  )
    throw new Error('Invalid CLI response identity')
  let usage
  if (value.usage !== undefined) {
    const raw = value.usage
    if (!object(raw) || !count(raw.inputTokens) || !count(raw.outputTokens))
      throw new Error('Invalid CLI response usage')
    usage = { inputTokens: raw.inputTokens, outputTokens: raw.outputTokens }
    for (const key of ['totalTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens']) {
      if (raw[key] === undefined) continue
      if (!count(raw[key])) throw new Error('Invalid CLI response usage')
      usage[key] = raw[key]
    }
    const known =
      raw.inputTokens + raw.outputTokens + (raw.cacheReadTokens ?? 0) + (raw.cacheWriteTokens ?? 0)
    if (
      !count(known) ||
      (raw.reasoningTokens !== undefined && raw.reasoningTokens > raw.outputTokens) ||
      (raw.totalTokens !== undefined &&
        (raw.totalTokens < known ||
          (raw.cacheReadTokens !== undefined &&
            raw.cacheWriteTokens !== undefined &&
            raw.totalTokens !== known)))
    )
      throw new Error('Contradictory CLI response usage')
  }
  return {
    id: value.id,
    blockId: value.blockId,
    index: value.index,
    ...(value.complete ? { complete: true } : {}),
    ...(usage ? { usage } : {}),
  }
}
