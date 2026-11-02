import { afterEach, describe, expect, it } from 'vitest'
import {
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  readFileSync,
  writeFileSync,
  symlinkSync,
  linkSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkerStorage } from '../src/host/storage.ts'
import { CLI_IDS } from '../src/shared/types.ts'
import { supportsNativeSteering } from '../src/shared/running-message.ts'
import type { RunningMessageMode } from '../src/shared/running-message.ts'

// Synthetic local state only; does not start any CLI or read real accounts.
const cleanups: (() => void)[] = []
afterEach(() =>
  cleanups
    .splice(0)
    .reverse()
    .forEach((close) => close()),
)
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'cwn-running-mode-'))
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }))
  const storage = new WorkerStorage(directory)
  cleanups.push(() => storage.close())
  return { directory, storage }
}

describe('project and CLI running-message settings', () => {
  it('defaults to native steering only where supported, without writing on read', () => {
    const { directory, storage } = fixture()
    const before = readdirSync(directory)
    for (const cli of CLI_IDS) {
      expect(storage.runningMessageSettings('/synthetic/project', cli)).toEqual({
        cli,
        mode: supportsNativeSteering(cli) ? 'steer' : 'queue',
        canSteer: supportsNativeSteering(cli),
      })
    }
    expect(readdirSync(directory)).toEqual(before)
  })
  it('persists explicit choices across restart and isolates projects, CLIs and model defaults', () => {
    const { directory, storage } = fixture()
    storage.setPreference('/synthetic/one', { cli: 'pi', model: 'fixture-model', effort: 'high' })
    storage.setCliEnabled('pi', false)
    storage.setRunningMessageMode('/synthetic/one', 'pi', 'queue')
    storage.setRunningMessageMode('/synthetic/one', 'codex', 'interrupt')
    storage.setRunningMessageMode('/synthetic/two', 'pi', 'interrupt')
    storage.close()
    const restored = new WorkerStorage(directory)
    cleanups.push(() => restored.close())
    expect(restored.runningMessageSettings('/synthetic/one', 'pi').mode).toBe('queue')
    expect(restored.runningMessageSettings('/synthetic/one', 'codex').mode).toBe('interrupt')
    expect(restored.runningMessageSettings('/synthetic/two', 'pi').mode).toBe('interrupt')
    expect(restored.runningMessageSettings('/synthetic/two', 'codex').mode).toBe('steer')
    expect(restored.preference('/synthetic/one', 'pi')).toEqual({
      cli: 'pi',
      model: 'fixture-model',
      effort: 'high',
    })
    expect(restored.cliSettings().enabled.pi).toBe(false)
    for (const file of readdirSync(directory).filter((entry) => entry.endsWith('.running-message.json'))) {
      if (process.platform !== 'win32') expect(statSync(join(directory, file)).mode & 0o777).toBe(0o600)
    }
  })
  it('rejects unsupported, unknown and retired settings without overwriting a saved choice', () => {
    const { storage } = fixture()
    storage.setRunningMessageMode('/synthetic/one', 'antigravity', 'interrupt')
    expect(() => storage.setRunningMessageMode('/synthetic/one', 'antigravity', 'steer')).toThrow(
      '不支持引导',
    )
    expect(() => storage.setRunningMessageMode('/synthetic/one', 'pi', 'bad' as RunningMessageMode)).toThrow()
    expect(() => storage.setRunningMessageMode('/synthetic/one', 'harness', 'queue')).toThrow('入口已移除')
    expect(storage.runningMessageSettings('/synthetic/one', 'antigravity').mode).toBe('interrupt')
  })
  it('rejects corrupt identity and unsupported persisted steering rather than silently changing mode', () => {
    const { directory, storage } = fixture()
    storage.setRunningMessageMode('/synthetic/one', 'antigravity', 'interrupt')
    const path = join(
      directory,
      readdirSync(directory).find((file) => file.endsWith('.running-message.json'))!,
    )
    const value = JSON.parse(readFileSync(path, 'utf8'))
    writeFileSync(path, JSON.stringify({ ...value, project: '/synthetic/two' }))
    expect(() => storage.runningMessageSettings('/synthetic/one', 'antigravity')).toThrow('不匹配')
    writeFileSync(path, JSON.stringify({ ...value, mode: 'steer' }))
    expect(() => storage.runningMessageSettings('/synthetic/one', 'antigravity')).toThrow('不支持引导')
  })
  it('updates policy 1 choices once by current capability and preserves later explicit choices', () => {
    const { directory, storage } = fixture()
    storage.setPreference('/synthetic/one', { cli: 'codex', model: 'fixture-model', effort: 'high' })
    for (const cli of CLI_IDS) storage.setRunningMessageMode('/synthetic/one', cli, 'interrupt')
    for (const name of readdirSync(directory).filter((file) => file.endsWith('.running-message.json'))) {
      const path = join(directory, name),
        old = JSON.parse(readFileSync(path, 'utf8'))
      writeFileSync(path, JSON.stringify({ ...old, policy: 1 }))
    }
    storage.close()
    const migrated = new WorkerStorage(directory)
    cleanups.push(() => migrated.close())
    for (const cli of CLI_IDS) {
      expect(migrated.runningMessageSettings('/synthetic/one', cli).mode).toBe(
        supportsNativeSteering(cli) ? 'steer' : 'queue',
      )
    }
    expect(migrated.preference('/synthetic/one', 'codex')).toEqual({
      cli: 'codex',
      model: 'fixture-model',
      effort: 'high',
    })
    migrated.setRunningMessageMode('/synthetic/one', 'codex', 'queue')
    migrated.setRunningMessageMode('/synthetic/one', 'antigravity', 'interrupt')
    migrated.close()
    const reopened = new WorkerStorage(directory)
    cleanups.push(() => reopened.close())
    expect(reopened.runningMessageSettings('/synthetic/one', 'codex').mode).toBe('queue')
    expect(reopened.runningMessageSettings('/synthetic/one', 'antigravity').mode).toBe('interrupt')
  })
  it('leaves corrupt and linked old settings untouched during the capability update', () => {
    const { directory, storage } = fixture()
    storage.setRunningMessageMode('/synthetic/one', 'pi', 'interrupt')
    const path = join(
      directory,
      readdirSync(directory).find((file) => file.endsWith('.running-message.json'))!,
    )
    const value = JSON.parse(readFileSync(path, 'utf8'))
    writeFileSync(path, JSON.stringify({ ...value, policy: 1, project: '/wrong-project' }))
    const corrupt = readFileSync(path, 'utf8')
    storage.close()
    const reopened = new WorkerStorage(directory)
    cleanups.push(() => reopened.close())
    expect(readFileSync(path, 'utf8')).toBe(corrupt)
    expect(() => reopened.runningMessageSettings('/synthetic/one', 'pi')).toThrow('不匹配')
    reopened.close()
    const outside = join(directory, 'outside.json')
    writeFileSync(outside, JSON.stringify({ ...value, policy: 1 }))
    const original = readFileSync(outside, 'utf8')
    rmSync(path)
    symlinkSync(outside, path)
    const linked = new WorkerStorage(directory)
    cleanups.push(() => linked.close())
    expect(readFileSync(outside, 'utf8')).toBe(original)
    expect(() => linked.runningMessageSettings('/synthetic/one', 'pi')).toThrow('无法核验')
  })
  it('does not follow symbolic or hard-linked setting files', () => {
    const { directory, storage } = fixture()
    storage.setRunningMessageMode('/synthetic/one', 'pi', 'interrupt')
    const path = join(
      directory,
      readdirSync(directory).find((file) => file.endsWith('.running-message.json'))!,
    )
    const outside = join(directory, 'outside.json')
    writeFileSync(outside, readFileSync(path))
    rmSync(path)
    symlinkSync(outside, path)
    expect(() => storage.runningMessageSettings('/synthetic/one', 'pi')).toThrow('无法核验')
    rmSync(path)
    linkSync(outside, path)
    expect(() => storage.runningMessageSettings('/synthetic/one', 'pi')).toThrow('无法核验')
  })
})
