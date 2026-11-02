export interface QoderContextBinding { cli?: 'qoder' | 'qodercn'; home: string; project: string; sessionId: string; model: string; userMessageId: string }
export interface QoderContextObservation { type: 'cliworker.qoder_context' | 'cliworker.qodercn_context'; source: 'qoder.native-transcript' | 'qodercn.native-transcript'; basis: 'native-ratio'; sessionId: string; model: string; userMessageId: string; contextRatio?: number; providerCredits?: number; contextCapacity?: number; contextUsed?: number; contextCapacitySource?: 'qoder.native-runtime-config' | 'qoder.native-session-log' | 'qodercn.native-runtime-config' | 'qodercn.native-session-log'; turnStartedAt?: number; turnEndedAt?: number }
export function qoderProjectKey(project: string): string
export function qoderContextPaths(config: Pick<QoderContextBinding, 'cli' | 'home' | 'project' | 'sessionId'>): string[]
export function qoderMeteringPaths(config: Pick<QoderContextBinding, 'cli' | 'home' | 'project' | 'sessionId'>): string[]
export function inspectQoderLogWindow(text: string, config: QoderContextBinding, observed: QoderContextObservation): number | undefined
export function inspectQoderDurableContext(records: unknown[], config: QoderContextBinding): QoderContextObservation | undefined
export function readQoderDurableContext(config: QoderContextBinding): QoderContextObservation | undefined

export function readQoderDurableContextAsync(config: QoderContextBinding, options?: { signal?: AbortSignal; budgetMs?: number }): Promise<QoderContextObservation | undefined>
