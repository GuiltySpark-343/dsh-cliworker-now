import type { CliId } from './types.ts'

export const RUNNING_MESSAGE_MODES = ['steer', 'interrupt', 'queue'] as const
export type RunningMessageMode = (typeof RUNNING_MESSAGE_MODES)[number]
export const RUNNING_MESSAGE_LABELS: Record<RunningMessageMode, string> = {
  steer: '引导',
  interrupt: '插队',
  queue: '排队',
}
/** Only protocols with an implemented, acknowledged native steering channel. */
export const supportsNativeSteering = (cli: CliId): boolean => cli === 'pi' || cli === 'omp'
export const defaultRunningMessageMode = (cli: CliId): RunningMessageMode =>
  supportsNativeSteering(cli) ? 'steer' : 'queue'

export interface RunningMessageSettings {
  cli: CliId
  mode: RunningMessageMode
  canSteer: boolean
}
