import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { WorkerStorage } from '../src/host/storage.ts'
import type { Worker } from '../src/shared/types.ts'

// All parents, projects and roles in these fixtures are synthetic.
const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'cwn-roster-'))
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }))
  const open = () => {
    const store = new WorkerStorage(directory)
    cleanups.push(() => store.close())
    return store
  }
  return { directory, store: open(), open }
}
const parent = 'synthetic-parent'
const project = '/synthetic/project'
const card = (store: WorkerStorage) => store.rolePresets()[0]!
function worker(parentSessionId = parent, agentName = '项目执行者1'): Worker {
  return {
    id: randomUUID(),
    parentSessionId,
    project,
    title: '合成任务',
    agentName,
    preference: { cli: 'codex', model: 'synthetic-model', effort: 'high' },
    mode: 'accept-edits',
    status: 'completed',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    runId: randomUUID(),
  }
}

describe('session roster storage', () => {
  it('keeps the card name for the first template and only numbers a repeat', () => {
    const { store } = fixture()
    const preset = card(store)
    const first = store.saveRosterEntry(parent, project, {
      presetId: preset.id,
      roleSource: 'preset',
      cli: 'codex',
      model: 'synthetic-model',
      effort: 'high',
    })
    const second = store.saveRosterEntry(parent, project, {
      presetId: preset.id,
      roleSource: 'preset',
      cli: 'claude',
      model: 'other-model',
      effort: 'low',
    })
    expect(first.title).toBe(preset.name)
    expect(second.title).toBe(`${preset.name}1`)
    expect(first.role.prompt).toBe(preset.prompt)
    expect(second.cli).toBe('claude')
    expect(store.roster(parent)).toHaveLength(2)
  })

  it('keeps custom prompts and follows the card otherwise', () => {
    const { store } = fixture()
    const preset = card(store)
    const followed = store.saveRosterEntry(parent, project, {
      presetId: preset.id,
      roleSource: 'preset',
      cli: 'codex',
      model: 'synthetic-model',
      effort: 'high',
    })
    const edited = store.saveRosterEntry(parent, project, {
      id: followed.id,
      presetId: preset.id,
      roleSource: 'custom',
      title: followed.title,
      role: { name: '自定义', summary: '条目内改写', prompt: '只检查我关心的部分' },
      cli: 'codex',
      model: 'synthetic-model',
      effort: 'high',
    })
    expect(edited.roleSource).toBe('custom')
    expect(edited.role.prompt).toBe('只检查我关心的部分')
    expect(edited.title).toBe(followed.title)
  })

  it('refuses duplicate titles and names already used by a worker', () => {
    const { store } = fixture()
    const preset = card(store)
    store.saveRosterEntry(parent, project, {
      presetId: preset.id,
      roleSource: 'preset',
      title: '同名',
      cli: 'codex',
      model: 'synthetic-model',
      effort: 'high',
    })
    expect(() =>
      store.saveRosterEntry(parent, project, {
        presetId: preset.id,
        roleSource: 'preset',
        title: '同名',
        cli: 'codex',
        model: 'synthetic-model',
        effort: 'high',
      }),
    ).toThrow('同名可用智能体')
    const existing = worker()
    store.save(existing)
    expect(() =>
      store.saveRosterEntry(parent, project, {
        presetId: preset.id,
        roleSource: 'preset',
        title: existing.agentName!,
        cli: 'codex',
        model: 'synthetic-model',
        effort: 'high',
      }),
    ).toThrow('同名智能体')
  })

  it('keeps sessions isolated and survives a reopen', () => {
    const { store, open } = fixture()
    const preset = card(store)
    const entry = store.saveRosterEntry(parent, project, {
      presetId: preset.id,
      roleSource: 'preset',
      cli: 'codex',
      model: 'synthetic-model',
      effort: 'high',
    })
    expect(store.roster('another-parent')).toEqual([])
    store.close()
    const reopened = open()
    expect(reopened.roster(parent).find((item) => item.id === entry.id)?.title).toBe(entry.title)
    expect(reopened.roster('another-parent')).toEqual([])
  })

  it('deletes a template without touching the agents it created', () => {
    const { store } = fixture()
    const preset = card(store)
    const entry = store.saveRosterEntry(parent, project, {
      presetId: preset.id,
      roleSource: 'preset',
      cli: 'codex',
      model: 'synthetic-model',
      effort: 'high',
    })
    const instance = worker(parent, `${entry.title}1`)
    store.save(instance)
    store.deleteRosterEntry(parent, entry.id)
    expect(store.roster(parent)).toEqual([])
    expect(store.workers.get(instance.id)?.agentName).toBe(`${entry.title}1`)
  })

  it('rejects unknown cards and unknown entries', () => {
    const { store } = fixture()
    expect(() =>
      store.saveRosterEntry(parent, project, {
        presetId: 'missing-card',
        roleSource: 'preset',
        cli: 'codex',
        model: 'synthetic-model',
        effort: 'high',
      }),
    ).toThrow('角色预设已删除')
    expect(() =>
      store.saveRosterEntry(parent, project, {
        id: randomUUID(),
        presetId: card(store).id,
        roleSource: 'preset',
        cli: 'codex',
        model: 'synthetic-model',
        effort: 'high',
      }),
    ).toThrow('已被删除')
    expect(() => store.deleteRosterEntry(parent, randomUUID())).toThrow('已被删除')
  })
})
