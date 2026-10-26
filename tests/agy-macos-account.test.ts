import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { DEFAULT_CONFIG, type ProcessBackend } from '../src/host/process.ts'

// Synthetic keychain output and home directory only; no real keychain, CLI or network.
const state = vi.hoisted(() => ({ home: '' }))
vi.mock('node:os', async (actual) => ({
  ...(await actual<typeof import('node:os')>()),
  homedir: () => state.home,
}))
import {
  MAC_AGY_KEYCHAIN_ARGUMENTS,
  MacAgyKeychainError,
  decodeMacAgyKeychain,
  macAgyAccountIdentity,
  readMacAgyCredential,
} from '../src/host/agy-macos-account.ts'
import { readCliAccountBinding } from '../src/host/cli-account-binding.ts'

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
beforeEach(() => {
  state.home = mkdtempSync(join(tmpdir(), 'cwn-agy-keychain-synthetic-'))
  mkdirSync(join(state.home, '.gemini/antigravity-cli'), { recursive: true })
})
afterEach(() => {
  Object.defineProperty(process, 'platform', platform)
  rmSync(state.home, { recursive: true, force: true })
})
const signal = () => new AbortController().signal
const SECRET = 'synthetic-refresh-secret'
const login = (sub = 'synthetic-subject', email?: string) => ({
  auth_method: 'consumer',
  token: { access_token: 'synthetic-access', refresh_token: SECRET, expiry: '2099-01-01T00:00:00Z' },
  id_token: `synthetic.${Buffer.from(JSON.stringify({ sub, iss: 'https://accounts.google.com', ...(email ? { email } : {}) })).toString('base64url')}.signature`,
})
function security(output: string, exitCode = 0) {
  const spawn = vi.fn(() => ({
    stdout: Readable.from([output]),
    stderr: Readable.from(['synthetic security diagnostic']),
    done: Promise.resolve({ exitCode }),
    terminate: vi.fn(),
    waitForExit: vi.fn(async () => true),
  }) as unknown as ReturnType<ProcessBackend['spawn']>)
  return { resolveExecutable: vi.fn(), spawn } satisfies ProcessBackend
}

it('reads exactly the go-keyring item through /usr/bin/security with an argument array', async () => {
  const backend = security(JSON.stringify(login()) + '\n')
  expect(await readMacAgyCredential(backend, DEFAULT_CONFIG, signal())).toEqual(login())
  expect(backend.spawn).toHaveBeenCalledOnce()
  expect(vi.mocked(backend.spawn).mock.calls[0]![0]).toMatchObject({
    argv: ['/usr/bin/security', 'find-generic-password', '-s', 'gemini', '-a', 'antigravity', '-w'],
    stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
  })
  expect(MAC_AGY_KEYCHAIN_ARGUMENTS).toHaveLength(7)
})

it.each([
  ['plain', (raw: string) => raw],
  ['base64', (raw: string) => 'go-keyring-base64:' + Buffer.from(raw).toString('base64')],
  ['hex', (raw: string) => 'go-keyring-encoded:' + Buffer.from(raw).toString('hex')],
])('decodes the %s go-keyring form', (_name, encode) => {
  expect(decodeMacAgyKeychain(encode(JSON.stringify(login())) + '\n')).toEqual(login())
})

it('answers a missing item (exit 44) as signed out, not from the stale token file', async () => {
  writeFileSync(join(state.home, '.gemini/jetski-standalone-oauth-token'), JSON.stringify(login()))
  const backend = security('', 44)
  expect(await readMacAgyCredential(backend, DEFAULT_CONFIG, signal())).toBeUndefined()
  expect(await macAgyAccountIdentity(backend, DEFAULT_CONFIG)('antigravity', signal())).toMatchObject({
    state: 'unconfigured',
    summary: '尚未登录 Antigravity',
  })
})

it.each([
  ['another exit status', '', 51],
  ['unparseable output', 'not-json-' + SECRET, 0],
  ['a non-object value', '["' + SECRET + '"]', 0],
  ['an oversized value', 'x'.repeat(64 * 1024 + 1), 0],
])('reports the keychain as unreadable on %s, without carrying the item', async (_name, output, exitCode) => {
  const backend = security(output, exitCode)
  const failure = await readMacAgyCredential(backend, DEFAULT_CONFIG, signal()).catch((error) => error)
  expect(failure).toBeInstanceOf(MacAgyKeychainError)
  expect(String(failure.message) + String(failure.stack)).not.toContain(SECRET)
  const identity = await macAgyAccountIdentity(backend, DEFAULT_CONFIG)('antigravity', signal())
  expect(identity).toMatchObject({ state: 'unavailable', summary: '无法读取 macOS 钥匙串中的 Antigravity 账号，请重试' })
  expect(JSON.stringify(identity)).not.toContain(SECRET)
})

it('shows the signed-in email and never exposes the token in the identity', async () => {
  const identity = await macAgyAccountIdentity(security(JSON.stringify(login('s', 'Synthetic@Example.test'))), DEFAULT_CONFIG)(
    'antigravity',
    signal(),
  )
  expect(identity).toEqual({
    state: 'authenticated',
    authMethod: 'oauth',
    verification: 'local',
    accountLabel: 'Synthetic@Example.test',
    summary: '已登录 Antigravity',
  })
  expect(JSON.stringify(identity)).not.toContain(SECRET)
})

it('keeps one binding for one account when macOS moves from the token file to the keychain', async () => {
  // The same synthetic JSON as the former file source: existing bindings must stay valid.
  writeFileSync(join(state.home, '.gemini/jetski-standalone-oauth-token'), JSON.stringify(login()))
  Object.defineProperty(process, 'platform', { ...platform, value: 'linux' })
  const fromFile = await readCliAccountBinding('antigravity', security('', 44), DEFAULT_CONFIG, state.home, signal())
  Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' })
  const fromKeychain = await readCliAccountBinding(
    'antigravity', security(JSON.stringify(login())), DEFAULT_CONFIG, state.home, signal())
  expect(fromKeychain).toBe(fromFile)
  const other = await readCliAccountBinding(
    'antigravity', security(JSON.stringify(login('synthetic-other-subject'))), DEFAULT_CONFIG, state.home, signal())
  expect(other).not.toBe(fromFile)
  await expect(readCliAccountBinding('antigravity', security('', 44), DEFAULT_CONFIG, state.home, signal()))
    .rejects.toMatchObject({ code: 'CLI_OWN_ACCOUNT_REQUIRED' })
})
