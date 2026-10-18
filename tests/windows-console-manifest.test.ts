import { describe, expect, it } from 'vitest'
import { win32 } from 'node:path'
import { attestElectronConsoleManifest } from '../src/host/windows-console-manifest.mjs'

const host = 'C:\\Program Files\\Harness\\DeepSeek Harness.exe'
const resources = win32.join(win32.dirname(host), 'resources')
const request = {
  nonce: '12345678-1234-1234-1234-123456789abc',
  packageRoot: win32.join(resources, 'app.asar.unpacked', 'dsh', 'node_modules', 'node-pty'),
  archivePath: win32.join(resources, 'app.asar'),
}
function fixture() {
  const readPaths: string[] = []
  const files = new Set([host, request.archivePath])
  const runtime = {
    execPath: host, electron: '44.7.0',
    physical: { async lstat(path: string) {
      return { isSymbolicLink: () => false, isFile: () => files.has(path), isDirectory: () => !files.has(path) }
    } },
    async readManifest(path: string) { readPaths.push(path); return Buffer.from(JSON.stringify({ name: 'node-pty', version: '1.2.0-beta.15' })) },
  }
  return { runtime, readPaths }
}
describe('Electron ASAR console manifest attestation (SIMULATED filesystem)', () => {
  it('reads the exact current Host archive and binds the nonce and physical root', async () => {
    const { runtime, readPaths } = fixture()
    expect(await attestElectronConsoleManifest(request, runtime)).toEqual({ ...request, name: 'node-pty', version: '1.2.0-beta.15' })
    expect(readPaths).toEqual([win32.join(request.archivePath, 'dsh/node_modules/node-pty/package.json')])
  })
  it.each(['nonce', 'packageRoot', 'archivePath'] as const)('rejects a foreign or malformed %s before reading', async key => {
    const { runtime, readPaths } = fixture()
    await expect(attestElectronConsoleManifest({ ...request, [key]: key === 'nonce' ? 'not-a-nonce' : `D:\\foreign\\${key}` }, runtime)).rejects.toThrow()
    expect(readPaths).toEqual([])
  })
  it('rejects a different Host installation', async () => {
    const { runtime, readPaths } = fixture()
    await expect(attestElectronConsoleManifest(request, { ...runtime, execPath: 'D:\\Other\\DeepSeek Harness.exe' })).rejects.toThrow()
    expect(readPaths).toEqual([])
  })
  it('rejects a non-Electron Host', async () => {
    const { runtime } = fixture()
    await expect(attestElectronConsoleManifest(request, { ...runtime, electron: '' })).rejects.toThrow()
  })
  it.each([{ name: 'foreign', version: '1.2.0-beta.15' }, { name: 'node-pty', version: '1.2.0-beta.14' }])('rejects an untrusted manifest %j', async manifest => {
    const { runtime } = fixture()
    await expect(attestElectronConsoleManifest(request, { ...runtime, readManifest: async () => Buffer.from(JSON.stringify(manifest)) })).rejects.toThrow()
  })
  it('rejects a missing archive', async () => {
    const { runtime, readPaths } = fixture()
    const lstat = runtime.physical.lstat
    runtime.physical.lstat = async path => { if (path === request.archivePath) throw Object.assign(new Error('missing'), { code: 'ENOENT' }); return lstat(path) }
    await expect(attestElectronConsoleManifest(request, runtime)).rejects.toThrow()
    expect(readPaths).toEqual([])
  })
  it('rejects a reparse point before reading the logical manifest', async () => {
    const { runtime, readPaths } = fixture()
    const lstat = runtime.physical.lstat
    runtime.physical.lstat = async path => ({ ...await lstat(path), isSymbolicLink: () => path === resources })
    await expect(attestElectronConsoleManifest(request, runtime)).rejects.toThrow()
    expect(readPaths).toEqual([])
  })
})
