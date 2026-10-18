import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { win32 } from 'node:path'

const equal = (left, right) => typeof left === 'string' && typeof right === 'string' && left.toLowerCase() === right.toLowerCase()
const absolute = value => typeof value === 'string' && win32.isAbsolute(value) && !/^[\\/]{2}/.test(value) && equal(win32.resolve(value), value)

/** Read only the manifest beside this Host's exact ASAR-unpacked helper.
 * The PowerShell owner holds the physical archive against writes/deletion until
 * this nonce-bound reply is consumed and the console has been adopted.
 */
export async function attestElectronConsoleManifest(request, runtime = {}) {
  const electron = runtime.electron ?? process.versions.electron
  const execPath = runtime.execPath ?? process.execPath
  if (!electron || !absolute(execPath) || !request || typeof request !== 'object' ||
      !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(request.nonce ?? '') ||
      !absolute(request.packageRoot) || !absolute(request.archivePath)) throw new Error('Invalid Windows console manifest request')
  const resources = win32.join(win32.dirname(execPath), 'resources')
  const packageRoot = win32.join(resources, 'app.asar.unpacked', 'dsh', 'node_modules', 'node-pty')
  const archivePath = win32.join(resources, 'app.asar')
  if (!equal(request.packageRoot, packageRoot) || !equal(request.archivePath, archivePath))
    throw new Error('Windows console manifest source mismatch')
  // Electron's patched fs presents app.asar as a directory; physical identity
  // must use original-fs while the manifest read must use the patched fs.
  const physical = runtime.physical ?? createRequire(import.meta.url)('original-fs').promises
  const noLinks = async (path, file) => {
    let first = true
    for (let current = path; current; current = win32.dirname(current)) {
      const entry = await physical.lstat(current)
      if (entry.isSymbolicLink() || first && (file ? !entry.isFile() : !entry.isDirectory()) || !first && !entry.isDirectory())
        throw new Error('Unsafe Windows console manifest source')
      first = false
      if (win32.dirname(current) === current) break
    }
  }
  await noLinks(execPath, true)
  await noLinks(archivePath, true)
  await noLinks(packageRoot, false)
  const manifestPath = win32.join(archivePath, 'dsh', 'node_modules', 'node-pty', 'package.json')
  const bytes = await (runtime.readManifest ?? readFile)(manifestPath)
  if (Buffer.byteLength(bytes) > 65536) throw new Error('Oversized Windows console manifest')
  const manifest = JSON.parse(String(bytes))
  if (manifest?.name !== 'node-pty' || manifest?.version !== '1.2.0-beta.15') throw new Error('Untrusted Windows console manifest')
  return { nonce: request.nonce, packageRoot: request.packageRoot, archivePath: request.archivePath, name: manifest.name, version: manifest.version }
}
