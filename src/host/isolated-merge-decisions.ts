import type { AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions/types'
import type { Worker } from '../shared/types.ts'
import type { MergeConflict, MergeResolution, MergeResult } from './isolated-workspace.ts'

// Wording for the parent agent and the user's merge questions. Free-text answers are never applied as a decision.

/** Tells the parent agent that an isolated run's edits still wait in the copy. */
export function isolationGuidance(worker: Worker): string | undefined {
  const isolation = worker.isolation
  if (isolation?.state === 'ready')
    return `本轮改动写在隔离副本 ${isolation.path}，项目主目录尚未改动。核查结果后调用 cliworker_merge 写回；无法自动合并的文件由该工具询问用户。不要让 CLI 改到原目录重做。`
  if (isolation?.state === 'conflict')
    return `改动仍在隔离副本 ${isolation.path}，上次合并有冲突，主目录未改动；调用 cliworker_merge 由用户决定冲突文件。`
  return undefined
}

const MERGE_COPY = '采用 CLI 副本的版本'
const MERGE_PROJECT = '保留项目当前版本'
const MERGE_DEFER = '暂不合并'
const MERGE_ALL_COPY = '全部采用 CLI 副本的版本'
const MERGE_ALL_PROJECT = '全部保留项目当前版本'
/** Above this many conflicts the user decides once for all files. */
export const MERGE_QUESTION_LIMIT = 6

export function mergeQuestions(name: string, result: Extract<MergeResult, { status: 'conflict' }>): AskUserQuestionItem[] {
  const { conflicts, copy } = result
  const copyOption = { label: MERGE_COPY, description: '用副本中的内容覆盖项目中的这个文件' }
  const projectOption = { label: MERGE_PROJECT, description: '项目中的这个文件不变，舍弃副本对它的改动' }
  const deferOption = { label: MERGE_DEFER, description: '不写回任何文件，副本保留' }
  if (conflicts.length <= MERGE_QUESTION_LIMIT)
    return conflicts.map((item, index) => ({
      id: `conflict_${index}`,
      header: '合并冲突',
      question: `${item.path}：${item.reason}`,
      detail: `${name} 的隔离副本：${copy}`,
      options: [...(item.resolvable ? [copyOption] : []), projectOption, deferOption],
    }))
  const listed = conflicts.slice(0, 20).map((item) => `${item.path}：${item.reason}`)
  if (conflicts.length > listed.length) listed.push(`另有 ${conflicts.length - listed.length} 个文件`)
  const fixed = conflicts.filter((item) => !item.resolvable).length
  return [
    {
      id: 'conflicts',
      header: '合并冲突',
      question: `${name} 的隔离副本有 ${conflicts.length} 个文件无法自动合并，如何处理？`,
      detail: [...listed, `副本：${copy}`].join('\n'),
      options: [
        {
          label: MERGE_ALL_COPY,
          description: fixed
            ? `其中 ${fixed} 个结构性冲突只能保留项目版本`
            : '用副本中的内容覆盖这些文件',
        },
        { label: MERGE_ALL_PROJECT, description: '这些文件不变，舍弃副本对它们的改动' },
        deferOption,
      ],
    },
  ]
}

/** Every conflict needs a single chosen option; free text goes back to the parent agent unapplied. */
export function readMergeDecisions(
  conflicts: readonly MergeConflict[],
  answers: readonly { id: string; selected: readonly string[]; custom?: string }[],
):
  | { status: 'decided'; resolutions: Record<string, MergeResolution> }
  | { status: 'deferred' | 'note'; note?: string } {
  const choice = (id: string) => {
    const answer = answers.find((item) => item.id === id)
    if (answer?.custom?.trim()) return { note: answer.custom.trim() }
    return { selected: answer?.selected.length === 1 ? answer.selected[0] : undefined }
  }
  const resolutions: Record<string, MergeResolution> = {}
  if (conflicts.length > MERGE_QUESTION_LIMIT) {
    const picked = choice('conflicts')
    if (picked.note) return { status: 'note', note: picked.note }
    if (picked.selected !== MERGE_ALL_COPY && picked.selected !== MERGE_ALL_PROJECT) return { status: 'deferred' }
    for (const item of conflicts)
      resolutions[item.path] = picked.selected === MERGE_ALL_COPY && item.resolvable ? 'copy' : 'project'
    return { status: 'decided', resolutions }
  }
  for (const [index, item] of conflicts.entries()) {
    const picked = choice(`conflict_${index}`)
    if (picked.note) return { status: 'note', note: picked.note }
    if (picked.selected === MERGE_COPY && item.resolvable) resolutions[item.path] = 'copy'
    else if (picked.selected === MERGE_PROJECT) resolutions[item.path] = 'project'
    else return { status: 'deferred' }
  }
  return { status: 'decided', resolutions }
}
