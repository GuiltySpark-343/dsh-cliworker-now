import { homedir } from 'node:os'
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

/** Secret-free projection of the exact native Windows credential target. */
export function projectWindowsAgyAccount(raw: string): { identity: AccountIdentity; principalHash?: string } {
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
) {
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
  if (platform !== 'win32') return localAccountIdentity()
  return async (cli, signal) =>
    cli === 'antigravity' ? (await readWindowsAgyAccount(backend, config, signal)).identity : undefined
}
