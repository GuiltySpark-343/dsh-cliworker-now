import type { Stats } from 'node:fs'
export interface NativePrivacyOptions { signal?: AbortSignal; budgetMs?: number; reader?: string }
export interface NativePrivacyGuard { allows(path: string, info: Stats): boolean }
export function privateWindowsAcl(value: unknown, currentSid: string, mask?: number): boolean
export function nativePrivacyDiagnostics(): Array<{ reader: string; operation?: number; phase?: string; paths: number; durationMs: number; ok: boolean }>
export function withNativeFilePrivacy<T>(entries: Array<{ path: string; mask?: number }>,
  read: (privacy: NativePrivacyGuard) => T, options?: NativePrivacyOptions): T | undefined | Promise<Awaited<T> | undefined>
