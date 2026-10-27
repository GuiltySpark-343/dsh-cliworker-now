import { expect, it, vi } from 'vitest'
import { CliWorkerService } from '../src/host/index.ts'
import type { DispatchSetup } from '../src/host/storage.ts'
import type { RosterEntry } from '../src/shared/types.ts'

// Real registered tool entry; complete setup and publication are synthetic.
// Complete question, cancellation and storage coverage lives in dispatch-flow.test.ts.
function setup(options: { roster?: RosterEntry; receipt?: string; bound?: string } = {}) {
  const tools = new Map<string, any>()
  let answer!: (response: DispatchSetup) => void
  const waiting = new Promise<DispatchSetup>((resolve) => {
    answer = resolve
  })
  const chooseDispatch = vi.fn(() => waiting)
  const launch = vi.fn((..._args: unknown[]) => options.receipt ?? 'synthetic-receipt')
  const workers = new Map<string, unknown>(
    options.bound ? [[options.bound, { id: options.bound }]] : [],
  )
  const service: any = {
    ctx: {
      effect: (register: () => unknown) => register(),
      tools: { register: (definition: any) => tools.set(definition.name, definition) },
    },
    assertExecution: vi.fn(),
    chooseDispatch,
    disposed: new AbortController(),
    launch,
    // Synthetic host: no template means the tool keeps the plain path.
    rosterEntry: (_parent: string, name: string) =>
      options.roster && options.roster.title === name ? options.roster : undefined,
    rosterRole: (entry: RosterEntry) => entry.role,
    runtime: { storage: { workers, rolePresets: () => [] } },
  }
  ;(CliWorkerService.prototype as any).registerTools.call(service)
  const controller = new AbortController(),
    agent = { id: 'synthetic-parent' }
  const start = (args: Record<string, unknown> = {}) =>
    tools
      .get('cliworker_start')
      .execute(
        { cli: 'antigravity', title: '测试', prompt: '合成任务', agent_name: '小林', ...args },
        { agent, signal: controller.signal },
      )
  const selected: DispatchSetup = {
    preference: { cli: 'antigravity', model: 'fixture', effort: 'low' },
    role: { presetId: 'fixture-review', name: '审稿员', summary: '合成角色', prompt: '检查证据' },
    binding: 'synthetic-account',
  }
  return { service, chooseDispatch, launch, answer, controller, start, selected }
}
const rosterEntry = (overrides: Partial<RosterEntry> = {}): RosterEntry => ({
  id: 'entry-1',
  parentSessionId: 'synthetic-parent',
  project: '/project',
  title: '项目执行者',
  presetId: 'fixture-review',
  roleSource: 'preset',
  role: { presetId: 'fixture-review', name: '项目执行者', summary: '合成角色', prompt: '按流程实现' },
  cli: 'antigravity',
  model: 'fixture',
  effort: 'low',
  createdAt: '',
  updatedAt: '',
  ...overrides,
})

it('publishes only after the complete setup and passes the frozen role without another question', async () => {
  const f = setup(),
    pending = f.start()
  await Promise.resolve()
  expect(f.chooseDispatch).toHaveBeenCalledTimes(1)
  expect(f.launch).not.toHaveBeenCalled()
  f.answer(f.selected)
  expect(await pending).toBe('synthetic-receipt')
  expect(f.launch.mock.calls[0]![3]).toEqual(f.selected.preference)
  expect(f.launch.mock.calls[0]![6]).toMatchObject({ agentName: '小林', role: f.selected.role })
})
it('cancellation before complete setup returns never publishes a background job', async () => {
  const f = setup(),
    pending = f.start()
  f.controller.abort(new Error('user cancelled'))
  f.answer(f.selected)
  await expect(pending).rejects.toThrow('user cancelled')
  expect(f.launch).not.toHaveBeenCalled()
})
it('explicit no-role setup starts without substituting any preset', async () => {
  const f = setup(),
    pending = f.start()
  f.answer({ ...f.selected, role: null })
  await pending
  expect(f.launch.mock.calls[0]![6]).toEqual({ agentName: '小林', role: undefined })
})

it('dispatches a roster template as a pinned, numbered instance', async () => {
  const entry = rosterEntry()
  const f = setup({ roster: entry, receipt: JSON.stringify({ workerId: 'synthetic-worker' }) }),
    pending = f.start({ template: entry.title })
  await Promise.resolve()
  expect(f.chooseDispatch.mock.calls[0]![3]).toMatchObject({
    pinned: true,
    label: entry.title,
    model: entry.model,
    effort: entry.effort,
    roleSnapshot: entry.role,
  })
  f.answer(f.selected)
  await pending
  expect(f.launch).toHaveBeenCalledTimes(1)
  // The Host allocates template1/template2/…; the tool only names the template.
  expect(f.launch.mock.calls[0]![6]).toMatchObject({
    templateId: entry.id,
  })
})
it('each template call is an independent instance', async () => {
  const entry = rosterEntry()
  const f = setup({ roster: entry })
  const first = f.start({ template: entry.title })
  const second = f.start({ template: entry.title })
  f.answer(f.selected)
  await Promise.all([first, second])
  expect(f.launch).toHaveBeenCalledTimes(2)
  for (const call of f.launch.mock.calls) expect(call[6]).toMatchObject({ templateId: entry.id })
})
it('rejects an unknown template and conflicting overrides', async () => {
  const entry = rosterEntry()
  const f = setup({ roster: entry })
  await expect(f.start({ template: '不存在的模板' })).rejects.toThrow('没有名为')
  await expect(f.start({ template: entry.title, cli: 'claude' })).rejects.toThrow('固定使用')
  await expect(f.start({ template: entry.title, model: 'other-model' })).rejects.toThrow('都已固定')
  expect(f.chooseDispatch).not.toHaveBeenCalled()
})
