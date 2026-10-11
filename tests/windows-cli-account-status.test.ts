import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AccountManager } from '../src/host/accounts.ts'
import { DEFAULT_CONFIG, type ProcessBackend } from '../src/host/process.ts'
import { WindowsCliInstallationError } from '../src/host/windows-cli-installation.ts'

// Synthetic resolver errors only. No installed CLI, account or terminal is accessed.
const roots: string[] = [],
  managers: AccountManager[] = []
afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.close()))
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function fixture(error: WindowsCliInstallationError) {
  const cwd = mkdtempSync(join(tmpdir(), 'synthetic-windows-account-status-'))
  roots.push(cwd)
  const backend: ProcessBackend = {
    resolveExecutable: vi.fn(async () => {
      throw error
    }),
    spawn: vi.fn(() => {
      throw new Error('Unexpected CLI execution')
    }),
    spawnTerminal: vi.fn(async () => {
      throw new Error('Unexpected account terminal')
    }),
  }
  const manager = new AccountManager(backend, {
    ...DEFAULT_CONFIG,
    codexExecutable: '/synthetic/codex.exe',
    hermesExecutable: '/synthetic/hermes.exe',
    stateDirectory: join(cwd, 'state'),
  })
  managers.push(manager)
  return { manager, backend, cwd, signal: new AbortController().signal }
}

it('reports incomplete Hermes installation without claiming an installed CLI or logged-out account', async () => {
  const error = new WindowsCliInstallationError(
    '检测到 Hermes 安装目录，但未找到可用 CLI 入口，请完成安装或配置已有入口',
  )
  const f = fixture(error)
  expect(await f.manager.status('hermes', f.cwd, f.signal)).toEqual({
    cli: 'hermes',
    installed: false,
    state: 'unavailable',
    summary: error.message,
    actions: [],
  })
  expect(f.backend.spawn).not.toHaveBeenCalled()
  expect(f.backend.spawnTerminal).not.toHaveBeenCalled()
})
it('keeps an installed but unverified Codex package distinct from no installation', async () => {
  const error = new WindowsCliInstallationError('Codex Windows 应用包入口无法确认，请检查安装', true)
  const f = fixture(error)
  expect(await f.manager.status('codex', f.cwd, f.signal)).toEqual({
    cli: 'codex',
    installed: true,
    state: 'unavailable',
    summary: error.message,
    actions: [],
  })
})
it('keeps safe installation failure visible during a raced account start and releases the reservation', async () => {
  const error = new WindowsCliInstallationError('Codex Windows 应用包入口无法确认，请检查安装', true)
  const f = fixture(error)
  await expect(f.manager.start('synthetic-parent', 'codex', 'login', f.cwd, f.signal)).rejects.toBe(error)
  expect(f.manager.isBusy('codex')).toBe(false)
  expect(f.backend.spawnTerminal).not.toHaveBeenCalled()
})
