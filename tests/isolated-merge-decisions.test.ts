import { expect, it } from 'vitest'
import {
  isolationGuidance,
  MERGE_QUESTION_LIMIT,
  mergeQuestions,
  readMergeDecisions,
} from '../src/host/isolated-merge-decisions.ts'
import type { MergeConflict } from '../src/host/isolated-workspace.ts'
import type { Worker } from '../src/shared/types.ts'

// Pure decision logic; the question card and the merge itself are simulated by plain data.
const conflict = (path: string, resolvable = true): MergeConflict => ({ path, reason: '两边改动了相同或相邻的行', resolvable })
const result = (conflicts: MergeConflict[]) => ({ status: 'conflict' as const, conflicts, copy: '/simulation/copy' })
const answer = (id: string, selected: string[], custom?: string) => ({ id, selected, custom })

it('tells the parent agent to review and merge an idle copy, and never to redo the work in the project', () => {
  const worker = (isolation?: Worker['isolation']) => ({ isolation }) as Worker
  expect(isolationGuidance(worker({ state: 'ready', path: '/simulation/copy' }))).toMatch(
    /隔离副本 \/simulation\/copy.*主目录尚未改动.*cliworker_merge.*不要让 CLI 改到原目录重做/,
  )
  expect(isolationGuidance(worker({ state: 'conflict', path: '/c' }))).toContain('由用户决定冲突文件')
  for (const state of ['preparing', 'merging', 'released'] as const)
    expect(isolationGuidance(worker({ state, path: '/c' }))).toBeUndefined()
  expect(isolationGuidance(worker())).toBeUndefined()
})

it('asks one question per conflict and offers the copy version only when it can be applied', () => {
  const questions = mergeQuestions('ZCode-2', result([conflict('a.ts'), conflict('b', false)]))
  expect(questions).toHaveLength(2)
  expect(questions[0]).toMatchObject({ id: 'conflict_0', question: 'a.ts：两边改动了相同或相邻的行' })
  expect(questions[0]!.detail).toContain('/simulation/copy')
  expect(questions[0]!.options!.map((option) => option.label)).toEqual(['采用 CLI 副本的版本', '保留项目当前版本', '暂不合并'])
  expect(questions[1]!.options!.map((option) => option.label)).toEqual(['保留项目当前版本', '暂不合并'])
})

it('maps each chosen option to a resolution', () => {
  const conflicts = [conflict('a.ts'), conflict('b', false)]
  expect(
    readMergeDecisions(conflicts, [answer('conflict_0', ['采用 CLI 副本的版本']), answer('conflict_1', ['保留项目当前版本'])]),
  ).toEqual({ status: 'decided', resolutions: { 'a.ts': 'copy', b: 'project' } })
})

it.each([
  ['an explicit defer', [answer('conflict_0', ['采用 CLI 副本的版本']), answer('conflict_1', ['暂不合并'])]],
  ['a missing answer', [answer('conflict_0', ['采用 CLI 副本的版本'])]],
  ['the copy version on a structural conflict', [answer('conflict_0', ['保留项目当前版本']), answer('conflict_1', ['采用 CLI 副本的版本'])]],
  ['several selections', [answer('conflict_0', ['采用 CLI 副本的版本', '保留项目当前版本']), answer('conflict_1', ['保留项目当前版本'])]],
])('defers the whole merge on %s', (_name, answers) => {
  expect(readMergeDecisions([conflict('a.ts'), conflict('b', false)], answers)).toEqual({ status: 'deferred' })
})

it('returns free text to the parent agent instead of applying it', () => {
  expect(readMergeDecisions([conflict('a.ts')], [answer('conflict_0', [], '先给我看看两边的差异')])).toEqual({
    status: 'note',
    note: '先给我看看两边的差异',
  })
})

it('asks once for many conflicts and keeps structural ones at the project version', () => {
  const conflicts = Array.from({ length: MERGE_QUESTION_LIMIT + 1 }, (_, index) => conflict(`f${index}`, index !== 0))
  const [question, ...rest] = mergeQuestions('ZCode-2', result(conflicts))
  expect(rest).toEqual([])
  expect(question).toMatchObject({ id: 'conflicts' })
  expect(question!.question).toContain(`${conflicts.length} 个文件无法自动合并`)
  expect(question!.options![0]!.description).toContain('1 个结构性冲突只能保留项目版本')
  const all = readMergeDecisions(conflicts, [answer('conflicts', ['全部采用 CLI 副本的版本'])])
  expect(all).toMatchObject({ status: 'decided', resolutions: { f0: 'project', f1: 'copy' } })
  const kept = readMergeDecisions(conflicts, [answer('conflicts', ['全部保留项目当前版本'])])
  expect(Object.values(kept.status === 'decided' ? kept.resolutions : {})).toEqual(conflicts.map(() => 'project'))
  expect(readMergeDecisions(conflicts, [answer('conflicts', ['暂不合并'])])).toEqual({ status: 'deferred' })
})
