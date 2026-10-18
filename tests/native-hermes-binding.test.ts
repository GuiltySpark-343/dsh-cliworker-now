import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, realpath, writeFile, rename, rm, link, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// Controlled local filesystem races. No CLI, account, network or model is called.
const races = vi.hoisted(() => ({
  afterOpen: undefined as undefined | ((path: string) => Promise<void>),
  afterRead: undefined as undefined | ((path: string) => Promise<void>),
}))
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>()
  return {
    ...fs,
    open: async (...args: Parameters<typeof fs.open>) => {
      const handle = await fs.open(...args)
      const afterOpen = races.afterOpen
      races.afterOpen = undefined
      await afterOpen?.(String(args[0]))
      return new Proxy(handle, {
        get(target, property) {
          if (property === 'readFile')
            return async (...options: any[]) => {
              const contents = await (target.readFile as any)(...options)
              const afterRead = races.afterRead
              races.afterRead = undefined
              await afterRead?.(String(args[0]))
              return contents
            }
          const value = Reflect.get(target, property, target)
          return typeof value === 'function' ? value.bind(target) : value
        },
      })
    },
  }
})
import { readHermesGatewayBinding } from '../src/host/native-hermes.mjs'

const roots: string[] = []
afterEach(async () => {
  races.afterOpen = races.afterRead = undefined
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cwn-hermes-binding-SIMULATED-')))
  roots.push(root)
  const path = join(root, 'gateway_state.json'),
    value = { pid: 123, platforms: { api_server: { state: 'connected' } } }
  await writeFile(path, JSON.stringify(value), { mode: 0o600 })
  let replacementBlocked = false
  const replace = async () => {
    const next = join(root, 'next.json')
    await writeFile(next, JSON.stringify(value), { mode: 0o600 })
    try { await rename(next, path) }
    catch (error) {
      // NTFS refuses to replace this already-open evidence handle. That
      // protects the original identity before the reader's post-read check.
      if (process.platform !== 'win32' || !['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
      replacementBlocked = true
    }
  }
  return { root, path, value, replace, replacementBlocked: () => replacementBlocked }
}
it.each(['afterOpen', 'afterRead'] as const)(
  'discards a status inode atomically replaced %s before trusting its listener',
  async (point) => {
    const f = await fixture()
    races[point] = f.replace
    const observed = await readHermesGatewayBinding(f.path, { line: 4096 })
    if (f.replacementBlocked()) expect(observed).toEqual(f.value)
    else expect(observed).toBeUndefined()
    expect(await readHermesGatewayBinding(f.path, { line: 4096 })).toEqual(f.value)
  },
)
it('discards a status file changed while it was being read', async () => {
  const f = await fixture()
  races.afterRead = async () => {
    await writeFile(f.path, JSON.stringify({ ...f.value, changed: true }))
  }
  expect(await readHermesGatewayBinding(f.path, { line: 4096 })).toBeUndefined()
})
it.each(['hardlink', 'symlink', 'oversize'] as const)(
  'refuses %s listener evidence without weakening the ownership gate',
  async (kind) => {
    const f = await fixture()
    if (kind === 'hardlink') await link(f.path, join(f.root, 'another-link'))
    else if (kind === 'symlink') {
      await rename(f.path, join(f.root, 'outside.json'))
      await symlink(join(f.root, 'outside.json'), f.path)
    }
    await expect(readHermesGatewayBinding(f.path, { line: kind === 'oversize' ? 4 : 4096 })).rejects.toThrow()
  },
)
