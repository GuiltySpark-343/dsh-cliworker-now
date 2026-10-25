/** Line-based three-way merge. Pure functions; callers own all file I/O. */

/** A changed base range and its replacement range on the other side. */
interface Hunk {
  baseStart: number
  baseLength: number
  sideStart: number
  sideLength: number
}

/** Upper bound for the Myers edit distance; larger rewrites are reported as unmergeable. */
export const MAX_EDIT_DISTANCE = 2000

/** Splits text into lines that keep their terminators, so joining is byte exact. */
export function splitLines(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? []
}

/** Myers O(ND) diff over line arrays; undefined when the distance exceeds the bound. */
export function diffHunks(base: readonly string[], side: readonly string[], limit = MAX_EDIT_DISTANCE): Hunk[] | undefined {
  let prefix = 0
  while (prefix < base.length && prefix < side.length && base[prefix] === side[prefix]) prefix++
  let suffix = 0
  while (
    suffix < base.length - prefix &&
    suffix < side.length - prefix &&
    base[base.length - 1 - suffix] === side[side.length - 1 - suffix]
  )
    suffix++
  const a = base.slice(prefix, base.length - suffix)
  const b = side.slice(prefix, side.length - suffix)
  const n = a.length,
    m = b.length
  if (!n && !m) return []
  if (!n || !m) return [{ baseStart: prefix, baseLength: n, sideStart: prefix, sideLength: m }]
  const max = Math.min(n + m, limit)
  const offset = max + 1
  let v = new Int32Array(2 * max + 3)
  const trace: Int32Array[] = []
  let found = -1
  for (let d = 0; d <= max && found < 0; d++) {
    trace.push(v.slice())
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!) ? v[offset + k + 1]! : v[offset + k - 1]! + 1
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) {
        x++
        y++
      }
      v[offset + k] = x
      if (x >= n && y >= m) {
        found = d
        break
      }
    }
  }
  if (found < 0) return undefined
  // Walk the trace backwards and collect the common diagonal runs.
  const matches: [number, number][] = []
  let x = n,
    y = m
  for (let d = found; d > 0; d--) {
    v = trace[d]!
    const k = x - y
    const previous = k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!) ? k + 1 : k - 1
    const startX = v[offset + previous]!
    const startY = startX - previous
    while (x > startX && y > startY) {
      x--
      y--
      matches.push([x, y])
    }
    x = startX
    y = startY
  }
  while (x > 0 && y > 0) {
    x--
    y--
    matches.push([x, y])
  }
  matches.reverse()
  const hunks: Hunk[] = []
  let baseCursor = 0,
    sideCursor = 0
  for (const [i, j] of [...matches, [n, m] as [number, number]]) {
    if (i > baseCursor || j > sideCursor)
      hunks.push({
        baseStart: prefix + baseCursor,
        baseLength: i - baseCursor,
        sideStart: prefix + sideCursor,
        sideLength: j - sideCursor,
      })
    baseCursor = i + 1
    sideCursor = j + 1
  }
  return hunks
}

export type MergeOutcome = { clean: true; text: string } | { clean: false; reason: 'overlap' | 'too-large' }

/**
 * Merges two descendants of `base`. Changes from both sides that touch or
 * overlap the same base region conflict unless they are identical.
 */
export function diff3Merge(base: string, ours: string, theirs: string): MergeOutcome {
  if (ours === theirs) return { clean: true, text: ours }
  if (base === ours) return { clean: true, text: theirs }
  if (base === theirs) return { clean: true, text: ours }
  const o = splitLines(base),
    a = splitLines(ours),
    b = splitLines(theirs)
  const left = diffHunks(o, a),
    right = diffHunks(o, b)
  if (!left || !right) return { clean: false, reason: 'too-large' }
  const sides = [a, b] as const
  const hunks = [
    ...left.map((hunk) => ({ ...hunk, side: 0 as const })),
    ...right.map((hunk) => ({ ...hunk, side: 1 as const })),
  ].sort((x, y) => x.baseStart - y.baseStart || x.side - y.side)
  const output: string[] = []
  let cursor = 0
  while (hunks.length) {
    const first = hunks.shift()!
    const regionStart = first.baseStart
    let regionEnd = first.baseStart + first.baseLength
    const region = [first]
    while (hunks.length && hunks[0]!.baseStart <= regionEnd) {
      const next = hunks.shift()!
      regionEnd = Math.max(regionEnd, next.baseStart + next.baseLength)
      region.push(next)
    }
    output.push(...o.slice(cursor, regionStart))
    // Each side's text for the whole region: its own hunks plus unchanged base around them.
    const content = sides.map((lines, side) => {
      const own = region.filter((hunk) => hunk.side === side)
      if (!own.length) return o.slice(regionStart, regionEnd)
      const start = own[0]!.sideStart - (own[0]!.baseStart - regionStart)
      const last = own.at(-1)!
      const end = last.sideStart + last.sideLength + (regionEnd - (last.baseStart + last.baseLength))
      return lines.slice(start, end)
    })
    const touched = new Set(region.map((hunk) => hunk.side))
    if (touched.size === 1) output.push(...content[region[0]!.side]!)
    else if (content[0]!.join('') === content[1]!.join('')) output.push(...content[0]!)
    else return { clean: false, reason: 'overlap' }
    cursor = regionEnd
  }
  output.push(...o.slice(cursor))
  return { clean: true, text: output.join('') }
}
