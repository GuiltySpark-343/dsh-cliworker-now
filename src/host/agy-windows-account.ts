import { homedir } from 'node:os'
import { AsyncLocalStorage } from 'node:async_hooks'
import { win32 } from 'node:path'
import { fileURLToPath } from 'node:url'
import { captureCatalogMetadata } from './adapters.ts'
import {
  accountEmail,
  localAccountIdentity,
  type AccountIdentity,
  type AccountIdentitySource,
} from './account-identity.ts'
import type { ProcessBackend, RuntimeConfig } from './process.ts'
import { macAgyAccountIdentity } from './agy-macos-account.ts'

type WindowsAgyAccount = { identity: AccountIdentity; principalHash?: string }
interface AccountSnapshotScope {
  backend: ProcessBackend
  config: RuntimeConfig
  signal: AbortSignal
  active: boolean
  reading?: Promise<WindowsAgyAccount>
}
const accountSnapshots = new AsyncLocalStorage<AccountSnapshotScope>()

/** Only the initial binding and model precheck may share a native projection.
 * The final binding must be read after this operation has exited its scope. */
export async function withWindowsAgyAccountSnapshot<T>(
  backend: ProcessBackend,
  config: RuntimeConfig,
  signal: AbortSignal,
  operation: () => Promise<T>,
): Promise<T> {
  signal.throwIfAborted()
  const scope: AccountSnapshotScope = { backend, config, signal, active: true }
  return accountSnapshots.run(scope, async () => {
    try {
      return await operation()
    } finally {
      // Async descendants can retain the ALS store; they must not reuse a
      // projection after the originating operation has completed or failed.
      scope.active = false
      scope.reading = undefined
    }
  })
}

/** Secret-free projection of the exact native Windows credential target. */
export function projectWindowsAgyAccount(raw: string): WindowsAgyAccount {
  try {
    if (raw.length > 4096) throw new Error('Invalid native account projection')
    const value = JSON.parse(raw)
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid projection')
    if (value.state === 'authenticated')
      return {
        identity: {
          state: 'authenticated',
          authMethod: 'oauth',
          verification: 'local',
          summary: '已登录 Antigravity',
          accountLabel: accountEmail(value.email),
        },
        ...(typeof value.principalHash === 'string' && /^[a-f0-9]{64}$/.test(value.principalHash)
          ? { principalHash: value.principalHash }
          : {}),
      }
    if (value.state === 'unconfigured')
      return { identity: { state: 'unconfigured', verification: 'local', summary: '尚未登录 Antigravity' } }
    if (value.state === 'unauthenticated')
      return {
        identity: { state: 'unauthenticated', verification: 'local', summary: '本地登录已过期，请重新登录' },
      }
    if (value.state === 'unknown')
      return {
        identity: { state: 'unknown', verification: 'local', summary: '登录格式未知，请打开账号终端' },
      }
  } catch {
    /* Fixed safe diagnosis below. */
  }
  return {
    identity: {
      state: 'unavailable',
      verification: 'local',
      summary: '无法读取 Windows 原生账号，请在登录的桌面会话中重试',
    },
  }
}

export async function readWindowsAgyAccount(
  backend: ProcessBackend,
  config: RuntimeConfig,
  signal: AbortSignal,
): Promise<WindowsAgyAccount> {
  signal.throwIfAborted()
  const scope = accountSnapshots.getStore()
  if (!scope?.active || scope.backend !== backend || scope.config !== config || scope.signal !== signal)
    return readNativeWindowsAgyAccount(backend, config, signal)
  const reading = (scope.reading ??= readNativeWindowsAgyAccount(backend, config, signal))
  try {
    const account = await reading
    signal.throwIfAborted()
    // A consumer cannot mutate another precheck's safe projection.
    return { ...account, identity: { ...account.identity } }
  } catch (error) {
    if (scope.reading === reading) scope.reading = undefined
    throw error
  }
}

async function readNativeWindowsAgyAccount(
  backend: ProcessBackend,
  config: RuntimeConfig,
  signal: AbortSignal,
): Promise<WindowsAgyAccount> {
  signal.throwIfAborted()
  const raw = await captureCatalogMetadata(
    backend,
    config,
    [
      win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'),
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-File',
      fileURLToPath(new URL('./windows-agy-account.ps1', import.meta.url)),
    ],
    homedir(),
    signal,
    undefined,
    [0, 1],
  )
  signal.throwIfAborted()
  return projectWindowsAgyAccount(raw)
}

export function nativeAgyAccountIdentity(
  backend: ProcessBackend,
  config: RuntimeConfig,
  platform: NodeJS.Platform = process.platform,
): AccountIdentitySource {
  // macOS keeps the login in the keychain; only Linux still reads the token file.
  if (platform === 'darwin') return macAgyAccountIdentity(backend, config)
  if (platform !== 'win32') return localAccountIdentity()
  return async (cli, signal) =>
    cli === 'antigravity' ? (await readWindowsAgyAccount(backend, config, signal)).identity : undefined
}
