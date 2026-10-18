import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SettingsCatalogCache } from '../src/host/settings-catalog-cache.ts'
import type { Catalog } from '../src/host/adapters.ts'
const roots: string[] = []
afterEach(() => roots.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })))
const catalog: Catalog = {
  cli: 'codex',
  notice: 'Synthetic native directory',
  models: [{ id: 'synthetic-one', label: 'Synthetic one', efforts: ['low', 'high'] }],
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'catalog-cache-synthetic-'))
  roots.push(root)
  const cache = new SettingsCatalogCache(root)
  const input = {
    cli: 'codex' as const,
    project: root,
    signal: new AbortController().signal,
    binding: vi.fn(async () => 'synthetic-binding'),
    discover: vi.fn(async () => ({ catalog: structuredClone(catalog), binding: 'synthetic-binding' })),
  }
  return {
    root,
    cache,
    input,
    file: () => join(root, 'settings-catalogs', readdirSync(join(root, 'settings-catalogs'))[0]!),
  }
}
it('discovers once per Host and persists choices; unchanged data on restart is not rewritten', async () => {
  const f = fixture()
  expect((await f.cache.get(f.input)).catalog).toEqual(catalog)
  const before = statSync(f.file())
  const text = readFileSync(f.file(), 'utf8')
  const cached = await f.cache.get(f.input)
  cached.catalog.models[0]!.label = 'caller mutation'
  expect((await f.cache.get(f.input)).catalog).toEqual(catalog)
  expect(f.input.discover).toHaveBeenCalledTimes(1)
  await new SettingsCatalogCache(f.root).get(f.input)
  expect(f.input.discover).toHaveBeenCalledTimes(2)
  expect(statSync(f.file()).ino).toBe(before.ino)
  expect(statSync(f.file()).mtimeMs).toBe(before.mtimeMs)
  expect(readFileSync(f.file(), 'utf8')).toBe(text)
  if (process.platform !== 'win32') expect(statSync(f.file()).mode & 0o777).toBe(0o600)
})
it('updates changed model and effort lists after restart without creating preferences', async () => {
  const f = fixture()
  await f.cache.get(f.input)
  f.input.discover.mockResolvedValue({
    binding: 'synthetic-binding',
    catalog: { ...catalog, models: [{ id: 'synthetic-two', label: 'Synthetic two', efforts: ['max'] }] },
  })
  const result = await new SettingsCatalogCache(f.root).get(f.input)
  expect(result.catalog.models[0]!.id).toBe('synthetic-two')
  expect(JSON.parse(readFileSync(f.file(), 'utf8')).catalog).toEqual(result.catalog)
  expect(readdirSync(f.root)).toEqual(['settings-catalogs'])
})
it('manual refresh and account changes bypass this Host cache', async () => {
  const f = fixture()
  await f.cache.get(f.input)
  await f.cache.get({ ...f.input, refresh: true })
  expect(f.input.discover).toHaveBeenCalledTimes(2)
  f.input.binding.mockResolvedValue('changed-binding')
  f.input.discover.mockResolvedValue({ catalog, binding: 'changed-binding' })
  expect((await f.cache.get(f.input)).binding).toBe('changed-binding')
  expect(f.input.discover).toHaveBeenCalledTimes(3)
})
it('refresh failure never falls back to disk or this Host cached choices', async () => {
  const f = fixture()
  await f.cache.get(f.input)
  f.input.discover.mockRejectedValue(new Error('Synthetic offline'))
  await expect(f.cache.get({ ...f.input, refresh: true })).rejects.toThrow('offline')
  await expect(f.cache.get(f.input)).rejects.toThrow('offline')
  await expect(new SettingsCatalogCache(f.root).get(f.input)).rejects.toThrow('offline')
})
it('invalidates a path change during discovery without publishing its old result', async () => {
  const f = fixture()
  f.input.discover.mockImplementation(async () => {
    f.cache.invalidate('codex')
    return { catalog, binding: 'synthetic-binding' }
  })
  await expect(f.cache.get(f.input)).rejects.toThrow('来源已变化')
  expect(readdirSync(join(f.root, 'settings-catalogs'))).toEqual([])
})
it('does not accept returned CLI or account identity mismatches', async () => {
  const f = fixture()
  f.input.discover.mockResolvedValue({ catalog: { ...catalog, cli: 'claude' }, binding: 'synthetic-binding' })
  await expect(f.cache.get(f.input)).rejects.toThrow('来源已变化')
  f.input.discover.mockResolvedValue({ catalog, binding: 'other-binding' })
  await expect(f.cache.get(f.input)).rejects.toThrow('来源已变化')
})
it('serializes concurrent opens and lets a cancelled waiter exit independently', async () => {
  const f = fixture()
  let complete!: () => void
  f.input.discover.mockImplementationOnce(async () => {
    await new Promise<void>((resolve) => {
      complete = resolve
    })
    return { catalog, binding: 'synthetic-binding' }
  })
  const first = f.cache.get(f.input)
  await vi.waitFor(() => expect(f.input.discover).toHaveBeenCalledTimes(1))
  const controller = new AbortController()
  const cancelled = f.cache.get({ ...f.input, signal: controller.signal })
  controller.abort(new Error('Synthetic cancelled waiter'))
  await expect(cancelled).rejects.toThrow('cancelled waiter')
  const second = f.cache.get(f.input)
  complete()
  expect(await first).toEqual(await second)
  expect(f.input.discover).toHaveBeenCalledTimes(1)
})
it('never persists a cancelled owner result', async () => {
  const f = fixture(),
    controller = new AbortController()
  f.input.discover.mockImplementation(async () => {
    controller.abort(new Error('Synthetic cancelled owner'))
    return { catalog, binding: 'synthetic-binding' }
  })
  await expect(f.cache.get({ ...f.input, signal: controller.signal })).rejects.toThrow('cancelled owner')
  expect(readdirSync(join(f.root, 'settings-catalogs'))).toEqual([])
})
it('treats malformed disk data as untrusted and preserves linked targets on replacement', async () => {
  const f = fixture()
  await f.cache.get(f.input)
  const target = join(f.root, 'external.json')
  writeFileSync(target, 'synthetic external')
  rmSync(f.file())
  // Retrieve a stable filename before removing the directory entry.
  await new SettingsCatalogCache(f.root).get(f.input)
  const path = f.file()
  rmSync(path)
  symlinkSync(target, path)
  await new SettingsCatalogCache(f.root).get(f.input)
  expect(readFileSync(target, 'utf8')).toBe('synthetic external')
  expect(JSON.parse(readFileSync(path, 'utf8')).catalog).toEqual(catalog)
  writeFileSync(path, '{')
  await new SettingsCatalogCache(f.root).get(f.input)
  expect(JSON.parse(readFileSync(path, 'utf8')).catalog).toEqual(catalog)
})
it('isolates projects and CLIs and forces rediscovery after explicit invalidation', async () => {
  const f = fixture()
  await f.cache.get(f.input)
  await f.cache.get({ ...f.input, project: join(f.root, 'other-project') })
  f.cache.invalidate('codex')
  await f.cache.get(f.input)
  expect(f.input.discover).toHaveBeenCalledTimes(3)
  expect(readdirSync(join(f.root, 'settings-catalogs'))).toHaveLength(2)
})

it('rejects a linked state root or ancestor before creating anything in its target', () => {
  const f = fixture()
  const outside = mkdtempSync(join(tmpdir(), 'catalog-cache-outside-'))
  roots.push(outside)
  const linked = join(f.root, 'linked')
  const mode = statSync(outside).mode
  symlinkSync(outside, linked, process.platform === 'win32' ? 'junction' : 'dir')
  expect(() => new SettingsCatalogCache(linked)).toThrow('缓存路径不可用')
  expect(readdirSync(outside)).toEqual([])
  expect(statSync(outside).mode).toBe(mode)
})

it('reads a saved Worker directory after restart without any account or discovery query', async () => {
  const f = fixture()
  await f.cache.get(f.input)
  f.input.binding.mockClear()
  f.input.discover.mockClear()
  const restarted = new SettingsCatalogCache(f.root)
  const displayed = restarted.display(f.root, 'codex', 'synthetic-binding')!
  expect(displayed).toEqual(catalog)
  displayed.models[0]!.label = 'Synthetic caller mutation'
  expect(restarted.display(f.root, 'codex', 'synthetic-binding')).toEqual(catalog)
  expect(restarted.display(f.root, 'codex', 'different-account')).toBeUndefined()
  expect(restarted.display(join(f.root, 'other'), 'codex', 'synthetic-binding')).toBeUndefined()
  expect(restarted.display(f.root, 'claude', 'synthetic-binding')).toBeUndefined()
  expect(f.input.binding).not.toHaveBeenCalled()
  expect(f.input.discover).not.toHaveBeenCalled()
  // A display read never primes the settings-page authorization cache.
  await restarted.get(f.input)
  expect(f.input.discover).toHaveBeenCalledOnce()
})

it('does not display old disk choices after invalidation, refresh failure, or during an active query', async () => {
  const f = fixture()
  await f.cache.get(f.input)
  f.cache.invalidate('codex')
  expect(f.cache.display(f.root, 'codex', 'synthetic-binding')).toBeUndefined()
  await f.cache.get(f.input)
  expect(f.cache.display(f.root, 'codex', 'synthetic-binding')).toEqual(catalog)
  let finish!: () => void
  f.input.discover.mockImplementationOnce(async () => {
    await new Promise<void>((resolve) => {
      finish = resolve
    })
    throw new Error('Synthetic refresh failed')
  })
  const pending = f.cache.get({ ...f.input, refresh: true })
  const failed = expect(pending).rejects.toThrow('refresh failed')
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
  expect(f.cache.display(f.root, 'codex', 'synthetic-binding')).toBeUndefined()
  finish()
  await failed
  expect(f.cache.display(f.root, 'codex', 'synthetic-binding')).toBeUndefined()
})

it('remembers a first dispatch directory only if its source revision remains current', () => {
  const f = fixture()
  const revision = f.cache.revision('codex')
  f.cache.remember(f.root, { catalog, binding: 'synthetic-binding' }, revision)
  expect(new SettingsCatalogCache(f.root).display(f.root, 'codex', 'synthetic-binding')).toEqual(catalog)
  f.cache.invalidate('codex')
  expect(() => f.cache.remember(f.root, { catalog, binding: 'synthetic-binding' }, revision)).toThrow(
    '来源已变化',
  )
  expect(f.cache.display(f.root, 'codex', 'synthetic-binding')).toBeUndefined()
})

it('lets Qoder self-verified cold/forced discovery own authorization while preserving fresh warm binding checks', async () => {
  const f = fixture(), qoder = { ...catalog, cli: 'qoder' as const }
  const input = { ...f.input, cli: 'qoder' as const, selfVerifiedDiscovery: true,
    discover: vi.fn(async () => ({ catalog: qoder, binding: 'synthetic-binding' })) }
  await f.cache.get(input)
  expect(input.binding).not.toHaveBeenCalled()
  await f.cache.get(input)
  expect(input.binding).toHaveBeenCalledTimes(1)
  expect(input.discover).toHaveBeenCalledTimes(1)
  await f.cache.get({ ...input, refresh: true })
  expect(input.binding).toHaveBeenCalledTimes(1)
  expect(input.discover).toHaveBeenCalledTimes(2)
  input.binding.mockRejectedValue(new Error('Synthetic logged out'))
  await expect(f.cache.get(input)).rejects.toThrow('logged out')
  expect(input.discover).toHaveBeenCalledTimes(2)
})
it('does not extend self-verified discovery bypass to other CLIs or allow stale revisions/empty Qoder catalogs', async () => {
  const f = fixture()
  await f.cache.get({ ...f.input, selfVerifiedDiscovery: true })
  expect(f.input.binding).toHaveBeenCalledTimes(1)
  const input = { ...f.input, cli: 'qoder' as const, selfVerifiedDiscovery: true,
    discover: vi.fn(async () => ({ catalog: { ...catalog, cli: 'qoder' as const }, binding: 'synthetic-binding' })) }
  input.discover.mockImplementationOnce(async () => {
    f.cache.invalidate('qoder')
    return { catalog: { ...catalog, cli: 'qoder' }, binding: 'synthetic-binding' }
  })
  await expect(f.cache.get(input)).rejects.toThrow('来源已变化')
  input.discover.mockResolvedValueOnce({ catalog: { ...catalog, cli: 'qoder', models: [] }, binding: 'synthetic-binding' })
  await expect(f.cache.get(input)).rejects.toThrow('来源已变化')
})
