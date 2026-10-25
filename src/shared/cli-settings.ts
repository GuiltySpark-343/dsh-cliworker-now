import type { CliId } from './types.ts'

/** Harness-profile preferences; independent from project model defaults. */
export interface CliSettings {
  enabled: Record<CliId, boolean>
}

/** Bounds shared by the Host schema and the settings control. */
export const MAX_CONCURRENT_LIMIT = 8

/** Profile-wide plugin settings shown on the CLI Worker settings page. */
export interface GeneralSettings {
  /** Effective admission limit shared by all CLIs. */
  maxConcurrent: number
  /** Deployment value used when the user has not chosen one. */
  defaultMaxConcurrent: number
  /** Conflicting same-project writers run in plugin-owned copies; off by default. */
  isolatedParallelWrites: boolean
}

/** Machine-local executable selection; separate from project model preferences. */
export interface CliExecutablePathStatus {
  cli: CliId
  path: string
  source: 'auto' | 'manual' | 'configured' | 'none'
  available: boolean
  error?: string
}
