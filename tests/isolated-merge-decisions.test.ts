import { expect, it } from 'vitest'
import {
  integrationReport,
  isolationGuidance,
  MERGE_CONTENT_LIMIT,
  readResolutions,
} from '../src/host/isolated-merge-decisions.ts'
import type { Worker } from '../src/shared/types.ts'

// Pure wording and argument checks; the merge itself is covered by isolated-workspace tests.
it('tells the parent agent to review and merge an idle copy, and never to redo the work in the project', () => {
  const worker = (isolation?: Worker['isolation']) => ({ isolation }) as Worker
  expect(isolationGuidance(worker({ state: 'ready', path: '/simulation/copy' }))).toMatch(
    /隔离副本 \/simulation\/copy.*主目录尚未改动.*cliworker_merge.*由你整合.*不要让 CLI 改到原目录重做/,
  )
  expect(isolationGuidance(worker({ state: 'conflict', path: '/c' }))).toContain('等待你整合')
  for (const state of ['preparing', 'merging', 'released'] as const)
    expect(isolationGuidance(worker({ state, path: '/c' }))).toBeUndefined()
  expect(isolationGuidance(worker())).toBeUndefined()
})

it('reports files changed on both sides as work to integrate, not as a conflict', () => {
  const report = integrationReport('zcode-2', {
    status: 'conflict',
    copy: '/simulation/copy',
    conflicts: [
      {
        path: 'merge.txt',
        reason: '两边改动了相同或相邻的行',
        choices: ['project', 'copy', 'content'],
        versions: { base: '/b/merge.txt', project: '/p/merge.txt', copy: '/c/merge.txt' },
      },
    ],
  })
  expect(report).toMatchObject({
    status: 'needs_integration',
    agentName: 'zcode-2',
    files: [{ path: 'merge.txt', choices: ['project', 'copy', 'content'], versions: { copy: '/c/merge.txt' } }],
  })
  expect(report.guidance).toMatch(/正常情况，不是错误.*use="content".*目标相互矛盾.*ask_user_question/)
  expect(JSON.stringify(report)).not.toContain('冲突')
  expect(integrationReport('zcode-2', { status: 'conflict', copy: '/c', conflicts: [] }, ['a.ts']).guidance).toContain(
    '仍缺少这些文件的决定，或合并期间项目又有变化：a.ts',
  )
})

it('reads content, copy and project decisions', () => {
  expect(readResolutions(undefined)).toBeUndefined()
  expect(
    readResolutions([
      { path: 'a.ts', use: 'content', content: 'merged\n' },
      { path: 'b.ts', use: 'copy' },
      { path: 'c.ts', use: 'project' },
    ]),
  ).toEqual({ 'a.ts': { content: 'merged\n' }, 'b.ts': 'copy', 'c.ts': 'project' })
})

it.each([
  ['a non-array', { path: 'a' }, 'resolutions 须为数组'],
  ['a missing path', [{ use: 'copy' }], '须包含 path'],
  ['a repeated path', [{ path: 'a', use: 'copy' }, { path: 'a', use: 'project' }], '重复'],
  ['content without text', [{ path: 'a', use: 'content' }], '须提供完整内容'],
  ['an unknown use', [{ path: 'a', use: 'ask' }], 'use 须为'],
  ['oversized content', [{ path: 'a', use: 'content', content: 'x'.repeat(MERGE_CONTENT_LIMIT + 1) }], '超过 2 MiB'],
])('rejects %s', (_name, raw, message) => {
  expect(() => readResolutions(raw)).toThrow(message)
})
