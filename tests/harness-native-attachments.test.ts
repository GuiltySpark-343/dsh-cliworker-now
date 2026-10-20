import { afterEach, expect, it, vi } from 'vitest'
import { installHarnessNativeAttachments } from '../src/client/harness-native-attachments.ts'
import { HarnessBindingRegistry } from '../src/client/harness-binding-registry.ts'

// Glyph stubs and a subsequence ranking; the real primitives bundle needs a browser.
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => {
  const icon = (name: string) => Object.assign(() => null, { displayName: name })
  const matches = (text: string, query: string) => {
    let at = 0
    for (const char of text.toLowerCase()) if (char === query[at]) at++
    return at === query.length
  }
  return {
    IconBranchOutlineRegular: icon('branch'),
    IconDataOutlineRegular: icon('data'),
    IconGoalOutlineRegular: icon('goal'),
    IconPaperPlaneOutlineRegular: icon('paper-plane'),
    IconPaperclipOutlineRegular: icon('paperclip'),
    IconPlanOutlineRegular: icon('plan'),
    PermissionIconFullAccessRegular: icon('permission'),
    rankByName: vi.fn((items: { name: string; label?: string }[], query: string) =>
      items.filter((item) => matches(item.name, query.toLowerCase()) || matches(item.label ?? '', query.toLowerCase()))),
  }
})

const cleanups: (() => void)[] = []
afterEach(() => { cleanups.splice(0).reverse().forEach(dispose => dispose()); vi.unstubAllGlobals() })
function fixture() {
  const registry = new HarnessBindingRegistry()
  registry.publish({ sessionId: 'child', parentSessionId: 'parent', mode: 'continuable', capabilities: { attachments: true } } as any,
    { id: 'worker', preference: { cli: 'qoder', model: 'qfmodel', effort: 'low' } })
  const insertReference = vi.fn(() => true), notify = vi.fn(), focus = vi.fn()
  let state: any = { draft: 'existing text', draftRev: 4, occurrences: [] }
  const input = { insertReference, notify, focus, state: { getSnapshot: () => state } }
  const scope = { ctx: {} }
  let currentScope: any = scope
  const adjudicate = vi.fn(async () => 'handled')
  let source: any
  const unregister = vi.fn()
  const installed = installHarnessNativeAttachments({
    sessions: { binding: (id: string) => id === 'child' ? currentScope : undefined,
      subagentAddress: (id: string) => id === 'child' ? { parentSessionId: 'parent', childSessionId: 'child' } : undefined },
    conversation: { input: { for: (ctx: unknown) => { expect(ctx).toBe(scope.ctx); return input } } },
    inputTriggers: { registerSource: (value: any) => { source = value; return unregister }, sessionOf: () => ({ adjudicate }) },
  } as any, registry)
  cleanups.push(installed.dispose)
  const listeners: Record<string, () => void> = {}
  const picker = { type: '', hidden: false, multiple: false, files: [] as any[], click: vi.fn(), remove: vi.fn(),
    addEventListener: (name: string, callback: () => void) => { listeners[name] = callback } }
  vi.stubGlobal('document', { createElement: (tag: string) => { expect(tag).toBe('input'); return picker }, body: { append: vi.fn() } })
  vi.stubGlobal('__DSH_HOST_PATHS__', { pathFor: (file: any) => file.hostPath })
  const pick = (name: string, id = 'child') => installed.pick({ session: { sessionId: id }, candidate: { name }, span: { start: 0, end: 0, draftRev: 4 } } as any)
  return { installed, pick, picker, listeners, source, insertReference, notify, adjudicate, unregister,
    replaceScope: () => { currentScope = { ctx: {} } }, setState: (value: unknown) => { state = value } }
}

it('adds macOS and Windows Desktop paths through native reference insertion and preserves the existing draft', async () => {
  const f = fixture()
  expect(f.installed.candidates('child' as any).map(item => [item.section, item.name, item.label, (item.icon as any)?.displayName]))
    .toEqual([['add', 'file', '文件', 'paperclip'], ['add', 'image', '图片', 'paperclip']])
  expect(f.pick('file')).toBe(true)
  const paths = ['/Users/example/中文 file.txt', 'C:\\Users\\admin\\中文 $(data).pdf', '\\\\host\\share\\file.docx']
  f.picker.files = paths.map(hostPath => ({ hostPath, name: hostPath.split(/[\\/]/u).at(-1) }))
  f.listeners.change!()
  const [reference, span] = f.insertReference.mock.calls[0] as any
  expect(span).toEqual({ start: 13, end: 13, draftRev: 4 })
  expect(JSON.parse(reference.ref)).toEqual(paths)
  expect(await f.source.codec.serialize(reference.ref, new AbortController().signal)).toContain(JSON.stringify(paths))
  expect(f.picker.remove).toHaveBeenCalledOnce()
})
it('delegates images to the native File action instead of creating an upload registry', async () => {
  const f = fixture()
  expect(f.pick('image')).toBe(true)
  expect(f.adjudicate).toHaveBeenCalledWith('/file', expect.any(AbortSignal), { attachments: 0 })
  expect(f.picker.click).not.toHaveBeenCalled()
  expect(f.insertReference).not.toHaveBeenCalled()
})
it('appends another file after existing native reference and command chips in detect coordinates', () => {
  const f = fixture()
  f.setState({ draft: '/goal ' + 'x'.repeat(120) + ' existing text', draftRev: 8,
    claim: { token: '/goal' }, occurrences: [{ offset: 6, length: 120 }] })
  f.pick('file'); f.picker.files = [{ name: 'second.txt', hostPath: 'C:\\second.txt' }]; f.listeners.change!()
  expect(f.insertReference).toHaveBeenCalledWith(expect.any(Object), { start: 17, end: 17, draftRev: 8 })
})
it('does not add picked paths to a retired session generation or a parent conversation', () => {
  const f = fixture()
  expect(f.pick('file', 'parent')).toBe(false)
  f.pick('file')
  f.picker.files = [{ name: 'a.txt', hostPath: 'C:\\a.txt' }]
  f.replaceScope(); f.listeners.change!()
  expect(f.insertReference).not.toHaveBeenCalled()
  expect(f.picker.remove).toHaveBeenCalledOnce()
})
it('refuses missing paths, oversize batches and invalid persisted references without losing the draft', async () => {
  const f = fixture()
  f.pick('file'); f.picker.files = [{ name: 'lost.txt', hostPath: '' }]; f.listeners.change!()
  expect(f.insertReference).not.toHaveBeenCalled()
  expect(f.notify).toHaveBeenCalledWith('error', '文件引用无效')
  await expect(f.source.codec.serialize(JSON.stringify(Array(21).fill('C:\\x')), new AbortController().signal)).rejects.toThrow('文件引用无效')
  expect(() => f.source.codec.clipboardText('["relative/path"]')).toThrow('文件引用无效')
})
it('cleans up the picker, source and pending image action on disposal and hides Desktop files in Web', () => {
  const f = fixture()
  vi.stubGlobal('__DSH_HOST_PATHS__', undefined)
  expect(f.installed.candidates('child' as any).map(item => item.name)).toEqual(['image'])
  vi.stubGlobal('__DSH_HOST_PATHS__', { pathFor: () => 'C:\\x' })
  f.pick('file'); f.pick('image'); f.installed.dispose()
  expect(f.picker.remove).toHaveBeenCalledOnce()
  expect(f.unregister).toHaveBeenCalledOnce()
  expect((f.adjudicate.mock.calls[0] as any)[1].aborted).toBe(true)
  expect(f.pick('file')).toBe(false)
})
