import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkerStorage } from '../src/host/storage.ts'
import { CLI_IDS } from '../src/shared/types.ts'

// Synthetic local state only; does not start any CLI or read real accounts.
const cleanups: (() => void)[] = []
afterEach(() =>
  cleanups
    .splice(0)
    .reverse()
    .forEach((close) => close()),
)
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'cwn-dispatch-ask-'))
  const directory = join(root, 'state')
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  const storage = new WorkerStorage(directory)
  cleanups.push(() => storage.close())
  return { directory, storage }
}
const records = (directory: string) => readdirSync(directory).filter((name) => name.endsWith('.dispatch-ask.json'))

describe('project and CLI dispatch-question setting', () => {
  it('defaults every CLI to asking without writing on read', () => {
    const { directory, storage } = fixture()
    for (const cli of CLI_IDS) expect(storage.dispatchAskSettings('/synthetic/project', cli)).toEqual({ cli, ask: true })
    expect(records(directory)).toEqual([])
  })

  it('persists privately per project and CLI and survives reopen', () => {
    const { directory, storage } = fixture()
    expect(storage.setDispatchAsk('/synthetic/one', 'codex', false)).toEqual({ cli: 'codex', ask: false })
    storage.close()
    const reopened = new WorkerStorage(directory)
    cleanups.push(() => reopened.close())
    expect(reopened.dispatchAskSettings('/synthetic/one', 'codex').ask).toBe(false)
    expect(reopened.dispatchAskSettings('/synthetic/one', 'pi').ask).toBe(true)
    expect(reopened.dispatchAskSettings('/synthetic/two', 'codex').ask).toBe(true)
    const [name] = records(directory)
    expect(statSync(directory).mode & 0o777).toBe(0o700)
    expect(statSync(join(directory, name!)).mode & 0o777).toBe(0o600)
    expect(JSON.parse(readFileSync(join(directory, name!), 'utf8'))).toEqual({
      policy: 1,
      project: '/synthetic/one',
      cli: 'codex',
      ask: false,
    })
    reopened.setDispatchAsk('/synthetic/one', 'codex', true)
    expect(reopened.dispatchAskSettings('/synthetic/one', 'codex').ask).toBe(true)
  })

  it('rejects a mismatched, malformed or linked record instead of treating it as asking off', () => {
    const { directory, storage } = fixture()
    storage.setDispatchAsk('/synthetic/one', 'codex', false)
    const path = join(directory, records(directory)[0]!)
    writeFileSync(path, JSON.stringify({ policy: 1, project: '/synthetic/other', cli: 'codex', ask: false }))
    expect(() => storage.dispatchAskSettings('/synthetic/one', 'codex')).toThrow('不匹配')
    writeFileSync(path, JSON.stringify({ policy: 1, project: '/synthetic/one', cli: 'codex', ask: 'no' }))
    expect(() => storage.dispatchAskSettings('/synthetic/one', 'codex')).toThrow()
    rmSync(path)
    const target = join(directory, 'synthetic-target.json')
    writeFileSync(target, JSON.stringify({ policy: 1, project: '/synthetic/one', cli: 'codex', ask: false }))
    symlinkSync(target, path)
    expect(() => storage.dispatchAskSettings('/synthetic/one', 'codex')).toThrow('无法核验')
  })
})
