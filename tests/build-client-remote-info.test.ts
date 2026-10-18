import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { runInNewContext } from 'node:vm'
import { clientBundleDependencies, selectBuildDependencies } from '../scripts/build-dependencies.mjs'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
it('inlines generated remote-info using the official SDK instead of requesting an unregistered platform module', async () => {
  // Actual already-provisioned SDK; no dependency install, preview or Desktop mutation.
  const selected = selectBuildDependencies(resolve('.'), {})
  const directory = selected.directory
  const req = createRequire(join(directory, 'package.json'))
  const remoteInfo = req.resolve('@deepseek-ai/dsh-typert-protocol/remote-info')
  expect(JSON.parse(readFileSync(join(directory, 'node_modules/@deepseek-ai/dsh/package.json'), 'utf8')).version).toBe(selected.target)
  const { build } = await import(pathToFileURL(req.resolve('tsdown')).href)
  const root = mkdtempSync(join(tmpdir(), 'client-remote-build-')); roots.push(root)
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'mock-remote-client', peerDependencies: { '@deepseek-ai/dsh-typert-protocol': '*' } }))
  writeFileSync(join(root, 'entry.js'), `import { createTypertRemoteInfo } from '@deepseek-ai/dsh-typert-protocol/remote-info';\nexport const Remote = createTypertRemoteInfo({package:'mock-remote-client',methods:{}}, {});\n`)
  const options = { cwd: root, entry: { client: join(root, 'entry.js') }, outDir: join(root, 'out'),
    platform: 'browser', format: 'cjs', dts: false, sourcemap: false, deps: clientBundleDependencies(),
    alias: { '@deepseek-ai/dsh-typert-protocol/remote-info': remoteInfo },
    outputOptions: { banner: 'window.__ModuleLoader__.load({id:"mock-remote-client",factory:(require)=>{',
      intro: 'var module={exports:{}};var exports=module.exports;', footer: 'return module.exports;}});', entryFileNames: '[name].js' },
  }
  await build({ ...options, outDir: join(root, 'broken'), deps: { ...clientBundleDependencies(), alwaysBundle: [] } })
  expect(readFileSync(join(root, 'broken/client.js'), 'utf8')).toMatch(/require\(["']@deepseek-ai\/dsh-typert-protocol\/remote-info/)
  await build(options)
  const bundle = readFileSync(join(root, 'out/client.js'), 'utf8')
  const requested: string[] = []; let exported: any
  runInNewContext(bundle, { window: { __ModuleLoader__: { load: ({ factory }: any) => {
    exported = factory((id: string) => { requested.push(id); throw new Error(`Unregistered platform module: ${id}`) })
  } } } })
  expect(requested).toEqual([])
  expect(exported.Remote.package).toBe('mock-remote-client')
  expect(exported.Remote.methods).toEqual({})
  expect(bundle).not.toMatch(/require\(["']@deepseek-ai\/dsh-typert-protocol/)
})
