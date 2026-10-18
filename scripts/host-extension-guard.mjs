// Read-only bundle preflight. It never migrates, writes, installs or fetches anything.
import { createRequire } from 'node:module'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { hostRuntimePackages, verifyHostRuntime } from './host-runtime.mjs'

export const inject = ['loader', 'profileContext']
export const readyService = 'cliworkerNativeReady'
const prefix = 'CLI Worker 原生界面安装冲突'
const fail = (kind, id) => { throw new Error(`${prefix}：${kind}${id ? ` (${id})` : ''}。请保留配置，退出宿主后检查覆盖或卸载本插件；不要反复重启。`) }
const flatten = rows => rows.flatMap(row => [row, ...(row.group && Array.isArray(row.config) ? flatten(row.config) : [])])

function packageOf(name) {
  if (typeof name !== 'string') return undefined
  if (hostRuntimePackages.some(id => name === `@deepseek-ai/dsh-client-${id}`)) return name
  if (!name.startsWith('file:') && !isAbsolute(name)) return undefined
  let directory = dirname(name.startsWith('file:') ? fileURLToPath(name) : name)
  // No directory walks or network lookups: at most twelve ancestor manifests per file entry.
  for (let depth = 0; depth < 12; depth++) {
    const file = join(directory, 'package.json')
    if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8')).name
    const parent = dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  return undefined
}

/** Entries are the Loader's effective inventory; duplicate config IDs are already reconciled. */
export function inspectHostRuntimeEntries(entries, rawRows, patches, root) {
  const effective = [...entries]
  for (const id of hostRuntimePackages) {
    const canonical = `@deepseek-ai/dsh-client-${id}`
    const sources = effective.filter(entry => !entry.disabled && packageOf(entry.options.name) === canonical)
    if (sources.length !== 1) fail(sources.length ? 'duplicate-module-source' : 'missing-module-source', id)
    const selected = sources[0]
    if (selected.options.id !== id) fail('external-module-override', id)
    const expected = realpathSync(join(root, 'runtime-host', `dsh-client-${id}`, 'lib/index.js'))
    const name = selected.options.name
    if (!name.startsWith('file:') || realpathSync(fileURLToPath(name)) !== expected) fail('external-module-override', id)
    // A later name assertion would be silently skipped by the official patch dialect.
    for (const patch of patches)
      if (patch.id === id && !patch.insert && patch.name && patch.name !== name) fail('setting-source-assertion', id)
    // Do not discard settings attached to a replaced row in an earlier bundle.
    for (const previous of flatten(rawRows).filter(row => row.id === id && row.name !== selected.options.name)) {
      for (const key of ['config', 'isolate', 'intercept'])
        if (previous[key] !== undefined && JSON.stringify(previous[key]) !== JSON.stringify(selected.options[key])) fail('preexisting-entry-settings', id)
      if (previous.inject !== undefined && JSON.stringify(previous.inject) !== JSON.stringify(selected.options.inject)) fail('preexisting-entry-inject', id)
    }
  }
  return true
}

export function apply(ctx) {
  const directory = dirname(fileURLToPath(import.meta.url))
  const root = resolve(directory, basename(directory) === 'native-runtime-guard' ? '../..' : '..')
  try {
    verifyHostRuntime(root, { sourcePatch: false })
    const profile = ctx.profileContext
    let patches = []
    if (profile) {
      const require = createRequire(profile.installAnchor)
      const { loadOptionalPatches } = require(require.resolve('@deepseek-ai/dsh-app-boot'))
      if (typeof loadOptionalPatches !== 'function') fail('missing-profile-patch-interface')
      patches = [profile.patchPath, join(profile.home, 'cordis.patch.yml')]
        .flatMap(path => loadOptionalPatches('CLI Worker', path) ?? [])
        .concat(profile.overlays ?? [])
    }
    inspectHostRuntimeEntries(ctx.loader.entries(), ctx.loader.root.data, patches, root)
    ctx.provide(readyService, Object.freeze({ verified: true }))
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(prefix)) throw error
    fail('runtime-verification-failed')
  }
}
