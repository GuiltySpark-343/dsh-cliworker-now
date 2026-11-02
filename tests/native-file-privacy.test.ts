import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, lstatSync, realpathSync, rmSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const transport = vi.hoisted(() => ({ calls: 0, broad: false, rejected: false, beforeReply: undefined as (() => void) | undefined }))
vi.mock('node:child_process', () => ({ execFile: (_file: string, _args: string[], options: any, callback: any) => ({
  stdin: { on() {}, end(raw: string) {
    transport.calls++
    const paths = JSON.parse(raw).paths
    queueMicrotask(() => {
      transport.beforeReply?.()
      callback(transport.rejected ? new Error('SIMULATED transport unavailable') : null,
      JSON.stringify({ version: 1, currentSid: 'S-1-5-21-1-2-3-1001', items: paths.map((path: string) => ({
        path, owner: 'S-1-5-21-1-2-3-1001', nullDacl: false, control: 4,
        descriptor: transport.broad ? 'SIMULATED-public' : 'SIMULATED-private',
        aces: [{ type: 0, flags: 0, sid: transport.broad ? 'S-1-1-0' : 'S-1-5-21-1-2-3-1001', mask: 0x1f01ff }],
      })) }))
    })
  } },
}) }))
import { privateWindowsAcl, withNativeFilePrivacy } from '../src/host/native-file-privacy.mjs'
const sid = 'S-1-5-21-1-2-3-1001'
const acl = () => ({ owner: sid, nullDacl: false, control: 4, descriptor: 'SIMULATED security descriptor',
  aces: [{ type: 0, flags: 0, sid, mask: 0x1f01ff }, { type: 0, flags: 16, sid: 'S-1-5-18', mask: 0x1f01ff },
    { type: 0, flags: 16, sid: 'S-1-5-32-544', mask: 0x1f01ff }] })
const roots: string[] = []
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); transport.calls = 0; transport.beforeReply = undefined; transport.broad = transport.rejected = false; roots.splice(0).forEach(p => rmSync(p, { recursive: true, force: true })) })
it('accepts current-user ownership with only native current-user, SYSTEM and Administrators access', () => {
  expect(privateWindowsAcl(acl(), sid)).toBe(true)
  expect(privateWindowsAcl({ ...acl(), owner: 'S-1-5-32-544' }, sid)).toBe(false)
  expect(privateWindowsAcl({ ...acl(), owner: 'S-1-5-18' }, sid)).toBe(false)
})
it.each(['owner', 'null', 'missing', 'empty', 'untrusted', 'callback', 'unknown-flags', 'bad-mask', 'foreign-read', 'foreign-write', 'write-dacl'])(
  'rejects unsafe or unprovable native ACL (%s)', kind => {
    const value: any = acl()
    if (kind === 'owner') value.owner = 'S-1-5-21-1-2-3-1002'
    if (kind === 'null') value.nullDacl = true
    if (kind === 'missing') value.control = 0
    if (kind === 'empty') value.aces = []
    if (kind === 'untrusted') value.control |= 64
    if (kind === 'callback') value.aces[0].type = 9
    if (kind === 'unknown-flags') value.aces[0].flags |= 64
    if (kind === 'bad-mask') value.aces[0].mask = NaN
    if (kind.startsWith('foreign') || kind === 'write-dacl') value.aces.push({ type: 0, flags: 0, sid: 'S-1-1-0', mask: kind === 'foreign-read' ? 1 : kind === 'write-dacl' ? 0x40000 : 2 })
    expect(privateWindowsAcl(value, sid)).toBe(false)
  },
)
it('allows the existing public-read Qoder root only when every foreign grant is read-only', () => {
  const value = acl(); value.aces.push({ type: 0, flags: 0, sid: 'S-1-1-0', mask: 0x1200a9 })
  expect(privateWindowsAcl(value, sid, 0o022)).toBe(true)
  for (const mask of [2, 4, 0x10, 0x40, 0x100, 0x10000, 0x40000, 0x80000, 0x40000000, 0x10000000]) {
    value.aces.at(-1)!.mask = mask
    expect(privateWindowsAcl(value, sid, 0o022)).toBe(false)
  }
})
function simulatedWindows() {
  vi.stubGlobal('process', { ...process, platform: 'win32' })
  vi.stubEnv('SystemRoot', 'C:\\Windows')
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'SIMULATED-acl-proof-'))); roots.push(root)
  const path = join(root, 'counter.json'); writeFileSync(path, '{"counter":12,"private":"SIMULATED-secret"}', { mode: 0o600 })
  return { root, path, entries: [{ path: root }, { path }] }
}
it('batches exact paths twice around a complete read without blocking the event loop (simulated Windows transport)', async () => {
  const f = simulatedWindows(); let ticked = false
  queueMicrotask(() => { ticked = true })
  const result = await withNativeFilePrivacy(f.entries, guard => {
    expect(ticked).toBe(true); expect(guard.allows(f.path, lstatSync(f.path))).toBe(true)
    return { counter: 12 }
  })
  expect(result).toEqual({ counter: 12 }); expect(transport.calls).toBe(2)
})
it('does not read payload on ACL rejection or transport failure (simulated Windows transport)', async () => {
  const f = simulatedWindows(), read = vi.fn(() => ({ counter: 12 }))
  transport.broad = true
  expect(await withNativeFilePrivacy(f.entries, read)).toBeUndefined()
  transport.broad = false; transport.rejected = true
  expect(await withNativeFilePrivacy(f.entries, read)).toBeUndefined()
  expect(read).not.toHaveBeenCalled()
})
it('accepts a native flush during pre-proof transport before taking the bounded payload snapshot', async () => {
  const f = simulatedWindows()
  transport.beforeReply = () => {
    if (transport.calls === 1) writeFileSync(f.path, '{"counter":1234}')
  }
  const value = await withNativeFilePrivacy(f.entries, guard => {
    expect(guard.allows(f.path, lstatSync(f.path))).toBe(true)
    return { counter: JSON.parse(readFileSync(f.path, 'utf8')).counter }
  })
  expect(value).toEqual({ counter: 1234 })
  expect(transport.calls).toBe(2)
})
it('still rejects a replacement during pre-proof transport before reading payload', async () => {
  const f = simulatedWindows(), read = vi.fn(() => ({ counter: 12 }))
  transport.beforeReply = () => {
    if (transport.calls === 1) { renameSync(f.path, f.path + '.old'); writeFileSync(f.path, '{"counter":1234}') }
  }
  expect(await withNativeFilePrivacy(f.entries, read)).toBeUndefined()
  expect(read).not.toHaveBeenCalled()
})
it.each(['acl', 'replacement', 'abort'])('drops an otherwise numeric observation after %s changes during read (simulated Windows transport)', async kind => {
  const f = simulatedWindows(), controller = new AbortController()
  const result = await withNativeFilePrivacy(f.entries, () => {
    if (kind === 'acl') transport.broad = true
    if (kind === 'replacement') { renameSync(f.path, f.path + '.old'); writeFileSync(f.path, '{}') }
    if (kind === 'abort') controller.abort()
    return { counter: 12 }
  }, { signal: controller.signal })
  expect(result).toBeUndefined()
})
