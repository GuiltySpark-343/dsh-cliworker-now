export interface ZcodeContextBinding {
  sessionId: string
  turnId: string
  requestId: string
  traceId: string
  model: string
}
export interface ZcodeRequestComposition {
  systemTokens: number
  toolTokens: number
  messageTokens: number
  estimated: true
  basis: 'zcode.estimateTokens.v1.actual-request'
}
export interface ZcodeContextInspection extends ZcodeContextBinding {
  type: 'cliworker.zcode_context_observation'
  cli: 'zcode'
  source: 'zcode.native-model-io'
  breakdown: ZcodeRequestComposition | null
}
export function zcodeNativeTokenEstimate(value: unknown): number | undefined
export function estimateZcodeRequestComposition(record: unknown, binding: ZcodeContextBinding): ZcodeRequestComposition | undefined
export function zcodeContextBinding(event: unknown, identity: { sessionId: string; turnId?: string; model: string }): ZcodeContextBinding | undefined
export function zcodeContextBindings(records: unknown[], identity: { sessionId: string; turnId?: string; model: string }): ZcodeContextBinding[]
export function unknownZcodeContextInspection(binding: ZcodeContextBinding): ZcodeContextInspection | undefined
export function readZcodeContextInspections(input: { nativeDirectory: string; bindings: ZcodeContextBinding[] }): ZcodeContextInspection[]
