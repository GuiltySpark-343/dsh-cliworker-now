import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, realpathSync, rmSync, lstatSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { withNativeFilePrivacy, nativePrivacyDiagnostics } from '../src/host/native-file-privacy.mjs'
import { syntheticNativeAcl, exposeSyntheticNativePath, recordSyntheticNativePrivacy } from './fixtures/native-file-privacy.ts'
// Real Windows owner/DACL and process transport, entirely synthetic files. No account/model/network.
const roots: string[] = []
afterEach(() => roots.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })))
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cwn-WINDOWS-acl-private-'))); roots.push(root)
  const path = join(root, 'counter.json'); writeFileSync(path, '{"counter":12,"private":"SIMULATED-private"}')
  syntheticNativeAcl([{ path: root }, { path }])
  return { root, path, entries: [{ path: root }, { path }] }
}
it.runIf(process.platform === 'win32')('proves native current-owner/DACL twice, preserves bytes, and records bounded batch timings', async () => {
  const f = fixture(), bytes = readFileSync(f.path), first = nativePrivacyDiagnostics().length
  const result = await withNativeFilePrivacy(f.entries, guard => {
    expect(guard.allows(f.path, lstatSync(f.path))).toBe(true)
    return { counter: JSON.parse(readFileSync(f.path, 'utf8')).counter }
  }, { reader: 'windows-acceptance' })
  expect(result).toEqual({ counter: 12 }); expect(readFileSync(f.path)).toEqual(bytes)
  const batches = nativePrivacyDiagnostics().slice(first)
  expect(batches).toHaveLength(2)
  expect(batches.every(x => x.ok && x.paths === 2 && x.durationMs < 2500)).toBe(true)
})
it.runIf(process.platform === 'win32')('rejects actual public access and a DACL change during read without rewriting permissions', async () => {
  const f = fixture(), bytes = readFileSync(f.path)
  expect(await withNativeFilePrivacy(f.entries, () => { exposeSyntheticNativePath(f.path); return { counter: 12 } })).toBeUndefined()
  let read = false
  expect(await withNativeFilePrivacy(f.entries, () => { read = true; return { counter: 12 } })).toBeUndefined()
  expect(read).toBe(false); expect(readFileSync(f.path)).toEqual(bytes)
})
it.runIf(process.platform === 'win32')('aborts native ACL proof while the Node event loop remains responsive', async () => {
  const f = fixture(), controller = new AbortController(), start = Date.now()
  const pending = withNativeFilePrivacy(f.entries, () => ({ counter: 12 }), { signal: controller.signal })
  const timer = setTimeout(() => controller.abort(), 20)
  try { expect(await pending).toBeUndefined() } finally { clearTimeout(timer) }
  expect(Date.now() - start).toBeLessThan(2500)
})

afterEach(() => recordSyntheticNativePrivacy('native-proof'))
