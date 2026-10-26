import type { CliId } from './types.ts'

/** Project/CLI choice: false starts with a still-valid saved setup instead of asking. */
export interface DispatchAskSettings {
  cli: CliId
  ask: boolean
}
