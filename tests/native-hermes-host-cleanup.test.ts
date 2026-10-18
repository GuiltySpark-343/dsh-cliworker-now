import { expect, it, vi } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { extendedLaunch } from '../src/host/extended-adapters.ts'
import { DEFAULT_CONFIG } from '../src/host/process.ts'

// Synthetic preparation only. A killed native bridge cannot run its own finally.
vi.mock('../src/host/hermes-adapter.ts', () => ({
  prepareHermes: async () => ({ argv: ['/synthetic/hermes', 'chat'], env: {} }),
  discoverHermes: vi.fn(),
}))
vi.mock('../src/host/hermes-account-context.ts', () => ({
  effectiveHermesHome: () => '/synthetic/own-hermes-home',
}))

it('Host cleanup removes forced-exit gateway credentials while keeping native session data', async () => {
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'cwn-hermes-host-cleanup-')))
  try {
    const state = join(project, 'state')
    const launch = await extendedLaunch(
      'hermes',
      '/synthetic/hermes',
      project,
      { cli: 'hermes', model: '["nous","synthetic-model"]', effort: 'low' },
      'accept-edits',
      'synthetic only',
      state,
      DEFAULT_CONFIG,
      undefined,
      undefined,
      undefined,
      true,
    )
    const home = join(state, 'hermes-http-home')
    mkdirSync(join(home, 'shared'), { recursive: true, mode: 0o700 })
    for (const file of ['auth.json', '.env', 'config.yaml', 'shared/auth.json'])
      writeFileSync(join(home, file), 'synthetic private material', { mode: 0o600 })
    writeFileSync(join(home, 'state.db'), 'synthetic native session')
    await launch.cleanup()
    for (const file of ['auth.json', '.env', 'config.yaml', 'shared'])
      expect(existsSync(join(home, file))).toBe(false)
    expect(readFileSync(join(home, 'state.db'), 'utf8')).toBe('synthetic native session')
    expect(readdirSync(state).filter((name) => name.startsWith('native-request-'))).toEqual([])
  } finally {
    rmSync(project, { recursive: true, force: true })
  }
})
