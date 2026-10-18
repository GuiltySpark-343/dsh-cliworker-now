export interface QoderContextBinding { home: string; project: string; sessionId: string; model: string; userMessageId: string }
export interface QoderContextObservation { type: 'cliworker.qoder_context'; source: 'qoder.native-transcript'; basis: 'native-ratio'; sessionId: string; model: string; userMessageId: string; contextRatio: number }
export function qoderProjectKey(project: string): string
export function qoderContextPaths(config: Pick<QoderContextBinding, 'home' | 'project' | 'sessionId'>): string[]
export function inspectQoderDurableContext(records: unknown[], config: QoderContextBinding): QoderContextObservation | undefined
export function readQoderDurableContext(config: QoderContextBinding): QoderContextObservation | undefined

export function readQoderDurableContextAsync(config: QoderContextBinding, options?: { signal?: AbortSignal; budgetMs?: number }): Promise<QoderContextObservation | undefined>
