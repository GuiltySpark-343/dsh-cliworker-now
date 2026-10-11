import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hermesHomeDirectory } from '../src/host/hermes-adapter.ts'

const state = vi.hoisted(() => ({ home: '' }))
vi.mock('node:os', async (actual) => ({
  ...(await actual<typeof import('node:os')>()),
  homedir: () => state.home,
}))
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
beforeEach(() => {
  state.home = realpathSync(mkdtempSync(join(tmpdir(), 'synthetic-hermes-home-')))
  vi.stubEnv('LOCALAPPDATA', join(state.home, 'local-data'))
  vi.stubEnv('HERMES_HOME', '')
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
})
afterEach(() => {
  Object.defineProperty(process, 'platform', platform)
  vi.unstubAllEnvs()
  rmSync(state.home, { recursive: true, force: true })
})

// Synthetic directories only. These tests never read an installed CLI or an account.
describe('Hermes native platform data directory', () => {
  it('uses the Windows native data home even when an unrelated legacy dot-directory exists', () => {
    mkdirSync(join(state.home, '.hermes'))
    expect(hermesHomeDirectory()).toBe(join(state.home, 'local-data', 'hermes'))
  })
  it('uses the native Windows profile fallback when LOCALAPPDATA is absent', () => {
    vi.stubEnv('LOCALAPPDATA', '')
    expect(hermesHomeDirectory()).toBe(join(state.home, 'AppData', 'Local', 'hermes'))
  })
  it('preserves explicit plugin and native environment home selection in that order', () => {
    const configured = join(state.home, 'configured-account')
    const native = join(state.home, 'native-account')
    vi.stubEnv('HERMES_HOME', native)
    expect(hermesHomeDirectory(configured)).toBe(configured)
    expect(hermesHomeDirectory()).toBe(native)
  })
  it('does not reinterpret a malformed Windows native root as another account home', () => {
    vi.stubEnv('LOCALAPPDATA', './relative-data')
    expect(() => hermesHomeDirectory()).toThrow('absolute path')
  })
  it('retains the macOS default without using Windows environment directories', () => {
    Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' })
    expect(hermesHomeDirectory()).toBe(join(state.home, '.hermes'))
  })
})
