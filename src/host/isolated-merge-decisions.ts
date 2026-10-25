import type { Worker } from '../shared/types.ts'
import type { MergeConflict, MergeResolution, MergeResult } from './isolated-workspace.ts'

// Wording for the parent agent. Overlapping edits are normal parallel work for it to integrate, not errors.

/** Largest content the main agent may write for one file, matching the merge baseline limit. */
export const MERGE_CONTENT_LIMIT = 2 * 1024 * 1024

/** Tells the parent agent that an isolated run's edits still wait in the copy. */
export function isolationGuidance(worker: Worker): string | undefined {
  const isolation = worker.isolation
  if (isolation?.state === 'ready')
    return `本轮改动写在隔离副本 ${isolation.path}，项目主目录尚未改动。核查结果后调用 cliworker_merge 写回；两边都改过的文件由你整合。不要让 CLI 改到原目录重做。`
  if (isolation?.state === 'conflict')
    return `改动仍在隔离副本 ${isolation.path}，有文件两边都改过、等待你整合，主目录未改动；再次调用 cliworker_merge，并为这些文件给出 resolutions。`
  return undefined
}

const INTEGRATION_GUIDANCE =
  '以下文件在项目和该智能体的副本中都改过，这是并行写入的正常情况，不是错误。versions.base 是派遣时的项目版本，versions.project 是项目当前版本（可能已含其他智能体写回的改动），versions.copy 是该智能体的版本。读取这些文件，按各任务的目标把两边改动整合成最终内容，然后再次调用 cliworker_merge，在 resolutions 中为每个文件给出 use="content"（附完整的最终内容）、use="copy" 或 use="project"；choices 只列出该文件允许的方式。只有两边任务的目标相互矛盾、无法同时满足时，才用 ask_user_question 请用户选择。给出全部文件的决定前，项目中的文件不会被改动，副本保留。'

/** What the parent agent needs to integrate the files both sides changed. */
export function integrationReport(
  name: string,
  result: Extract<MergeResult, { status: 'conflict' }>,
  pending?: readonly string[],
) {
  return {
    status: 'needs_integration' as const,
    agentName: name,
    copy: result.copy,
    files: result.conflicts.map(({ path, reason, choices, versions }: MergeConflict) => ({ path, reason, choices, versions })),
    guidance: pending?.length
      ? `${INTEGRATION_GUIDANCE} 本次仍缺少这些文件的决定，或合并期间项目又有变化：${pending.join('、')}。`
      : INTEGRATION_GUIDANCE,
  }
}

/** Validates the tool's `resolutions` argument; paths repeat at most once. */
export function readResolutions(raw: unknown): Record<string, MergeResolution> | undefined {
  if (raw === undefined || raw === null) return undefined
  if (!Array.isArray(raw)) throw new Error('resolutions 须为数组')
  const resolutions: Record<string, MergeResolution> = {}
  for (const item of raw) {
    const { path, use, content } = (item ?? {}) as { path?: unknown; use?: unknown; content?: unknown }
    if (typeof path !== 'string' || !path) throw new Error('resolutions 中每项须包含 path')
    if (Object.hasOwn(resolutions, path)) throw new Error(`resolutions 中 ${path} 重复`)
    if (use === 'copy' || use === 'project') resolutions[path] = use
    else if (use === 'content') {
      if (typeof content !== 'string') throw new Error(`${path} 选择 content 时须提供完整内容`)
      if (Buffer.byteLength(content, 'utf8') > MERGE_CONTENT_LIMIT) throw new Error(`${path} 的整合内容超过 2 MiB`)
      resolutions[path] = { content }
    } else throw new Error(`${path} 的 use 须为 content、copy 或 project`)
  }
  return resolutions
}
