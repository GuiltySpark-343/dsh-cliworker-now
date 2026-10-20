import { describe, expect, it, vi } from 'vitest'
import { settingsCacheMetadata, settingsDisplayPool } from '../src/client/settings-display-cache.ts'
import { CLI_IDS, type CliId } from '../src/shared/types.ts'
import type { SettingsCacheMetadata } from '../src/shared/settings-cache.ts'

// Display-only fixtures; no account, filesystem or CLI is accessed.
const enabled = Object.fromEntries(CLI_IDS.map(cli => [cli, true])) as Record<CliId, boolean>
const metadata = (): SettingsCacheMetadata => ({ policy: 1, host: 'SIMULATED-host', project: 'SIMULATED-project',
  revisions: Object.fromEntries(CLI_IDS.map(cli => [cli, '0:0'])) as Record<CliId, string>,
  catalogReady: Object.fromEntries(CLI_IDS.map(cli => [cli, true])) as Record<CliId, boolean>, preferences: {} })
function fixture() {
  const api = {}, meta = metadata(), pool = settingsDisplayPool(api), cache = pool.resolve(meta, enabled)
  const account = { loading: false, data: { cli: 'codex' as const, installed: true, state: 'authenticated' as const,
    summary: 'SIMULATED account', actions: [] } }
  const catalog = { loading: false, data: { cli: 'codex' as const,
    models: [{ id: 'SIMULATED-model', label: 'SIMULATED model', efforts: ['low', 'high'] as const }].map(x => ({ ...x, efforts: [...x.efforts] })) } }
  cache.account('codex', account); cache.catalog('codex', catalog)
  return { api, meta, pool, cache, account, catalog }
}
describe('shared settings display cache', () => {
  it('requires a complete scope and falls back only when the Host capability is absent', () => {
    expect(settingsCacheMetadata(undefined)).toBeUndefined()
    expect(settingsCacheMetadata(metadata())).toEqual(metadata())
    for (const value of [null, {}, { ...metadata(), policy: 2 }, { ...metadata(), revisions: {} },
      { ...metadata(), catalogReady: {} }, { ...metadata(), preferences: { codex: { cli: 'qoder', model: 'x', effort: 'low' } } }])
      expect(() => settingsCacheMetadata(value)).toThrow()
  })
  it('retains completed account and catalog receipts across opens and isolates callers from mutation', () => {
    const f = fixture(), next = f.pool.resolve(metadata(), enabled)
    expect(next).toBe(f.cache)
    const accounts = next.accountSnapshot(), catalogs = next.catalogSnapshot()
    accounts.codex!.data!.summary = 'MUTATED'; catalogs.codex!.data!.models.length = 0
    expect(next.accountSnapshot().codex).toEqual(f.account)
    expect(next.catalogSnapshot().codex).toEqual(f.catalog)
  })
  it('does not retain pending or cross-CLI receipts', () => {
    const f = fixture(); f.cache.invalidate('codex')
    f.cache.account('codex', { ...f.account, loading: true }); f.cache.catalog('codex', { ...f.catalog, loading: true })
    f.cache.account('qoder', f.account); f.cache.catalog('qoder', f.catalog)
    expect(f.cache.accountSnapshot()).toEqual({}); expect(f.cache.catalogSnapshot()).toEqual({})
  })
  it('remembers separate failures without restoring a previous successful list', () => {
    const f = fixture(); f.cache.catalog('codex', { loading: false, error: 'SIMULATED failure' })
    expect(f.pool.resolve(metadata(), enabled).catalogSnapshot().codex).toEqual({ loading: false, error: 'SIMULATED failure' })
    expect(f.cache.accountSnapshot().codex).toEqual(f.account)
  })
  it('invalidates only the changed CLI and refuses late results from its prior generation', () => {
    const f = fixture(), version = f.cache.version('codex')
    f.cache.account('qoder', { loading: false, error: 'SIMULATED Qoder state' })
    const next = metadata(); next.revisions.codex = '1:0'; f.pool.resolve(next, enabled)
    f.cache.account('codex', f.account, version); f.cache.catalog('codex', f.catalog, version)
    expect(f.cache.accountSnapshot().codex).toBeUndefined(); expect(f.cache.catalogSnapshot().codex).toBeUndefined()
    expect(f.cache.accountSnapshot().qoder).toBeDefined()
  })
  it('requires the current Host to retain the original model-account display binding', () => {
    const f = fixture(), next = metadata(); next.catalogReady.codex = false
    f.pool.resolve(next, enabled)
    expect(f.cache.catalogSnapshot().codex).toBeUndefined()
    f.cache.catalog('codex', { loading: false, error: 'SIMULATED unavailable' })
    expect(f.pool.resolve(next, enabled).catalogSnapshot().codex?.error).toBe('SIMULATED unavailable')
  })
  it('resets across Host, project and Gateway identities', () => {
    const f = fixture()
    expect(f.pool.resolve({ ...metadata(), project: 'OTHER-project' }, enabled).accountSnapshot()).toEqual({})
    expect(settingsDisplayPool({}).resolve(metadata(), enabled).accountSnapshot()).toEqual({})
    expect(f.pool.resolve({ ...metadata(), host: 'NEW-host' }, enabled).accountSnapshot()).toEqual({})
  })
  it('drops disabled CLI data and keeps other CLI results intact', () => {
    const f = fixture(); f.cache.account('qoder', { loading: false, error: 'SIMULATED Qoder state' })
    f.pool.resolve(metadata(), { ...enabled, codex: false })
    expect(f.cache.catalogSnapshot().codex).toBeUndefined(); expect(f.cache.accountSnapshot().qoder).toBeDefined()
  })
  it('uses current project defaults without creating a replacement or changing models', () => {
    const f = fixture(), next = metadata(); next.preferences.codex = { cli: 'codex', model: 'SIMULATED-model', effort: 'high' }
    const catalog = f.pool.resolve(next, enabled).catalogSnapshot().codex!.data!
    expect(catalog.preference).toEqual(next.preferences.codex); expect(catalog.models).toEqual(f.catalog.data.models)
    f.pool.resolve(metadata(), enabled)
    expect(f.cache.catalogSnapshot().codex?.data?.preference).toBeUndefined()
  })
  it('bounds retained projects and evicts the least recently used display scope', () => {
    const f = fixture()
    for (let n = 0; n < 8; n++) f.pool.resolve({ ...metadata(), project: `OTHER-${n}` }, enabled)
    expect(f.pool.resolve(metadata(), enabled)).not.toBe(f.cache)
  })
  it('evicts display receipts without allowing a second project writer to overtake its unfinished save', async () => {
    const f = fixture()
    let finish!: (value: any) => void
    const pending = new Promise<any>(resolve => { finish = resolve })
    const write = vi.fn().mockReturnValueOnce(pending).mockImplementation(async p => p)
    const saved = vi.fn(), high = { cli: 'codex' as const, model: 'SIMULATED-model', effort: 'high' as const }
    f.cache.preferenceSaves.stage(high, write, saved); f.cache.preferenceSaves.flush('codex')
    await Promise.resolve()
    for (let n = 0; n < 8; n++) f.pool.resolve({ ...metadata(), project: `OTHER-${n}` }, enabled)
    const returned = f.pool.resolve(metadata(), enabled)
    expect(returned.catalogSnapshot()).toEqual({})
    returned.preferenceSaves.stage({ ...high, effort: 'low' }, write, saved); returned.preferenceSaves.flush('codex')
    expect(write).toHaveBeenCalledOnce()
    finish(high)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(write).toHaveBeenCalledTimes(2)
    expect(saved.mock.calls.map(call => call[0].effort)).toEqual(['high', 'low'])
  })
  it('aborts pending writes when the Host generation changes', async () => {
    let finish!: (value: any) => void
    const f = fixture(), write = vi.fn((_preference: unknown, _signal: AbortSignal) => new Promise<any>(resolve => { finish = resolve }))
    f.cache.preferenceSaves.stage({ cli: 'codex', model: 'SIMULATED-model', effort: 'high' }, write, vi.fn())
    f.cache.preferenceSaves.flush('codex'); await Promise.resolve()
    const signal = write.mock.calls[0]![1] as AbortSignal
    f.pool.resolve({ ...metadata(), host: 'SIMULATED-restarted-host' }, enabled)
    expect(signal.aborted).toBe(true)
    finish({ cli: 'codex', model: 'SIMULATED-model', effort: 'high' })
    await new Promise(resolve => setTimeout(resolve, 0))
  })
})
