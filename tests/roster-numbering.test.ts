import { describe, expect, it } from 'vitest'
import { availableAgentName, availableNumberedName } from '../src/host/roles.ts'
import type { Worker } from '../src/shared/types.ts'

// Synthetic Workers only; nothing here touches a CLI, account or real session.
const worker = (agentName: string, extra: Partial<Worker> = {}): Worker =>
  ({
    id: `id-${agentName}`,
    parentSessionId: 'parent',
    project: '/project',
    title: 'fixture',
    agentName,
    preference: { cli: 'codex', model: 'm', effort: 'low' },
    mode: 'accept-edits',
    status: 'completed',
    createdAt: '',
    updatedAt: '',
    runId: `run-${agentName}`,
    ...extra,
  }) as Worker

describe('numbered template instances', () => {
  it('fills the first free number and skips live names', () => {
    const workers = [worker('验收1'), worker('验收3')]
    expect(availableNumberedName(workers, 'parent', '验收')).toBe('验收2')
  })

  it('reuses a number released by a deleted Worker', () => {
    const workers = [
      worker('验收1'),
      worker('验收2', { archivedAt: '2026-01-01T00:00:00.000Z' }),
    ]
    expect(availableNumberedName(workers, 'parent', '验收')).toBe('验收2')
  })

  it('ignores other sessions and reserves aliases of live Workers', () => {
    const workers = [
      worker('验收1', { parentSessionId: 'other' }),
      worker('验收1'),
      worker('另一个名字', { nameAliases: ['验收2'] }),
    ]
    expect(availableNumberedName(workers, 'parent', '验收')).toBe('验收3')
  })
})

describe('automatic CLI names', () => {
  it('releases deleted names as well', () => {
    const workers = [worker('codex-1', { archivedAt: '2026-01-01T00:00:00.000Z' })]
    expect(availableAgentName(workers, 'parent', 'codex')).toBe('codex-1')
    expect(availableAgentName([...workers, worker('codex-1')], 'parent', 'codex')).toBe('codex-2')
  })
})
