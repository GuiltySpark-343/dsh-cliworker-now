import type { DiffHunk } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PublicToolCall } from '../shared/types.ts'

/** Codex FileUpdateChange.diff is a unified patch, never a complete file. */
export function patchHunks(path: string, patch: string): DiffHunk[] | undefined {
  if (patch.length > 200_000) return
  const lines = patch.split('\n')
  if (lines.length > 4096) return
  const hunks: DiffHunk[] = []
  let current: { old: string[]; next: string[]; oldCount: number; nextCount: number } | undefined
  const finish = () => {
    if (!current) return true
    if (current.old.length !== current.oldCount || current.next.length !== current.nextCount) return false
    hunks.push({ path, oldText: current.old.join('\n'), newText: current.next.join('\n') })
    current = undefined
    return true
  }
  for (const [index, line] of lines.entries()) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:.*)$/.exec(line)
    if (header) {
      if (!finish()) return
      current = { old: [], next: [], oldCount: Number(header[2] ?? 1), nextCount: Number(header[4] ?? 1) }
      continue
    }
    if (!current) {
      if (
        /^(?:diff |index |--- |\+\+\+ |new file mode |deleted file mode |old mode |new mode |similarity index |rename from |rename to )/.test(
          line,
        ) ||
        line === ''
      )
        continue
      return
    }
    if (line === '\\ No newline at end of file') continue
    if (index === lines.length - 1 && line === '') continue
    if (line.startsWith(' ')) {
      current.old.push(line.slice(1))
      current.next.push(line.slice(1))
    } else if (line.startsWith('-')) current.old.push(line.slice(1))
    else if (line.startsWith('+')) current.next.push(line.slice(1))
    else return
  }
  return finish() && hunks.length ? hunks : undefined
}

export function nativeFileDiffs(call?: PublicToolCall): DiffHunk[] | undefined {
  if (
    call?.name !== 'fileChange' ||
    !Array.isArray(call.output) ||
    !call.output.length ||
    call.output.length > 64
  )
    return
  const result: DiffHunk[] = []
  let bytes = 0
  for (const change of call.output) {
    if (
      !change ||
      typeof change !== 'object' ||
      typeof change.path !== 'string' ||
      typeof change.diff !== 'string' ||
      !change.kind
    )
      return
    bytes += change.diff.length
    if (bytes > 200_000) return
    const hunks = patchHunks(change.path, change.diff)
    if (!hunks) return
    result.push(...hunks)
  }
  return result
}
