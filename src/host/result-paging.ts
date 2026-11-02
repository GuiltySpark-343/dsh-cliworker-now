/**
 * Local patch: bounded paging over a finished Worker result.
 *
 * The jobs surface caps one model-facing read, so a long report needs its own
 * paged tool. Offsets are UTF-16 code units, matching JavaScript strings; the
 * caller advances with `next` until `truncated` is false.
 */
export const DEFAULT_RESULT_PAGE = 20_000
export const MAX_RESULT_PAGE = 64_000

export type ResultPage = {
  /** Total length of the complete result, in UTF-16 code units. */
  total: number
  /** Offset of the first returned character. */
  offset: number
  /** Offset to pass next; null once the end is reached. */
  next: number | null
  /** Whether characters remain after `next`. */
  truncated: boolean
  text: string
}

export function pageResult(text: string, offset = 0, limit = DEFAULT_RESULT_PAGE): ResultPage {
  const total = text.length
  const start = Number.isFinite(offset) ? Math.min(Math.max(Math.trunc(offset), 0), total) : 0
  const size = Number.isFinite(limit) ? Math.min(Math.max(Math.trunc(limit), 1), MAX_RESULT_PAGE) : DEFAULT_RESULT_PAGE
  const end = Math.min(start + size, total)
  return { total, offset: start, next: end < total ? end : null, truncated: end < total, text: text.slice(start, end) }
}
