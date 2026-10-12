import type { CliId } from './types.ts'

/** Harness-profile preferences; independent from project model defaults. */
export interface CliSettings {
  enabled: Record<CliId, boolean>
}

/** Machine-local executable selection; separate from project model preferences. */
export interface CliExecutablePathStatus {
  cli: CliId
  path: string
  source: 'auto' | 'manual' | 'configured' | 'none'
  available: boolean
  error?: string
}
