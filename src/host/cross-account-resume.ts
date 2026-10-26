import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { CLI_IDS, type CliId } from '../shared/types.ts'

/**
 * How an existing task continues after its account changed:
 * `native` (confirmed) and `try` (untested) resume the native session and fall
 * back to a carryover when that fails before any event; `carryover` skips the
 * native attempt and starts a new session with the plugin's own history. Entries change only after a
 * real-account experiment (OpenSpec continue-tasks-across-account-changes §0).
 */
export type CrossAccountResume = 'native' | 'carryover' | 'try'

export const CROSS_ACCOUNT_RESUME: Readonly<Record<CliId, CrossAccountResume>> = Object.fromEntries(
  CLI_IDS.map((cli) => [cli, 'try' as const]),
) as Record<CliId, CrossAccountResume>

export const crossAccountResume = (cli: CliId): CrossAccountResume => CROSS_ACCOUNT_RESUME[cli]

/**
 * Local presence check without reading session content or calling a model.
 * `false` means the native session is certainly absent from the store the
 * next launch uses; `undefined` means unknown, so native resume is attempted.
 */
export function nativeSessionReachable(input: {
  cli: CliId
  transport?: string
  hermesHome?: string
}): false | undefined {
  // Oneshot Hermes keeps sessions in its account HERMES_HOME; the native HTTP
  // transport keeps them in the task's own private home instead.
  if (input.cli === 'hermes' && input.transport !== 'hermes-http-v1' && input.hermesHome)
    return existsSync(join(input.hermesHome, 'state.db')) ? undefined : false
  return undefined
}
