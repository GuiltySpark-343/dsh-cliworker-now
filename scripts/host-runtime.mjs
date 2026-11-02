// Public, bounded inventory shared by builds and the read-only activation guard.
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

export const hostRuntimeDirectory = 'runtime-host'
export const hostRuntimePackages = ['ui-session', 'ui-conversation', 'ui-subagent', 'ui-chat']
export const digest = bytes => createHash('sha256').update(bytes).digest('hex')

export function runtimeFiles(directory, base = directory) {
  return readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0).flatMap(entry => {
    const path = join(directory, entry.name)
    if (entry.isSymbolicLink()) throw new Error('CLI Worker native interface: linked-runtime-resource')
    return entry.isDirectory() ? runtimeFiles(path, base) : [relative(base, path).split(sep).join('/')]
  })
}

/** Only generated comment paths and an unused source-map link may change. */
export function normalizeHostClient(source) {
  return source.replace(/^([\t ]*\/\/#region \\0dsh-css:).*?(packages\/client\/[^\r\n]+)$/gm, '$1$2')
    .replace(/^[\t ]*\/\/#[ \t]*sourceMappingURL=[^\r\n]*(?:\r?\n|$)/gm, '')
}

export function verifyHostRuntime(root, { sourcePatch = true, directory = join(root, hostRuntimeDirectory) } = {}) {
  const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8'))
  if (manifest.schema !== 1 || manifest.packages?.length !== 4 || manifest.patch?.path !== 'source.patch' || !Array.isArray(manifest.files) || manifest.files.length > 500)
    throw new Error('CLI Worker native interface: invalid-runtime-manifest')
  const files = runtimeFiles(directory).filter(path => path !== 'manifest.json')
  if (JSON.stringify(files) !== JSON.stringify(manifest.files.map(file => file.path)))
    throw new Error('CLI Worker native interface: runtime-inventory-mismatch')
  const actualRoot = realpathSync(directory)
  for (const file of manifest.files) {
    if (typeof file.path !== 'string' || isAbsolute(file.path) || file.path.split(/[\\/]/).some(part => part === '..'))
      throw new Error('CLI Worker native interface: invalid-runtime-path')
    const path = join(directory, file.path)
    const rel = relative(actualRoot, realpathSync(path))
    if (rel === '..' || rel.startsWith(`..${sep}`) || !lstatSync(path).isFile())
      throw new Error('CLI Worker native interface: escaping-runtime-resource')
    const bytes = readFileSync(path)
    if (bytes.length !== file.bytes || digest(bytes) !== file.sha256)
      throw new Error('CLI Worker native interface: runtime-content-mismatch')
    if (/\.(?:js|json|map|md|patch|ts)$/u.test(file.path) && /(?:\/Users\/|\/home\/|[A-Z]:\\Users\\)/iu.test(bytes.toString('utf8')))
      throw new Error('CLI Worker native interface: private-runtime-path')
  }
  for (const id of hostRuntimePackages) {
    const pkg = manifest.packages.find(pkg => pkg.id === id)
    if (!pkg || pkg.name !== `@deepseek-ai/dsh-client-${id}` || pkg.directory !== `dsh-client-${id}`)
      throw new Error('CLI Worker native interface: invalid-runtime-package')
    const json = JSON.parse(readFileSync(join(directory, pkg.directory, 'package.json'), 'utf8'))
    if (json.name !== pkg.name || json.version !== pkg.version || json.dsh?.client?.platform !== 'web' ||
        json.exports?.['./client']?.default !== './lib/client.js' || json.scripts || json.devDependencies)
      throw new Error(`CLI Worker native interface: invalid-package-contract (${id})`)
  }
  if (digest(readFileSync(join(directory, manifest.patch.path))) !== manifest.patch.sha256)
    throw new Error('CLI Worker native interface: source-patch-mismatch')
  const trackedPatch = resolve(root, 'host-extensions', `dsh-${manifest.upstream.version}`, 'source.patch')
  if (sourcePatch && existsSync(trackedPatch) && digest(readFileSync(trackedPatch)) !== manifest.patch.sha256)
    throw new Error('CLI Worker native interface: vendored-source-is-outdated')
  return manifest
}
