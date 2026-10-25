import { useSyncExternalStore } from 'react'
import { cliOf, type CliId, type HarnessConversationBinding, type Worker } from '../shared/types.ts'
import { t } from './i18n.ts'

export type HarnessNativeBinding = HarnessConversationBinding & {
  /** Exact owning Worker; never inferred from a CLI conversation id. */
  workerId?: string
  /** Display metadata from Worker snapshots, never a replacement model directory. */
  cliSelection?: { cli?: CliId; model: string; effort: string; observedModel?: string }
}

/** Host-issued child identities shared by the native main view and Worker management. */
export class HarnessBindingRegistry {
  private readonly bindings = new Map<string, HarnessNativeBinding>()
  private readonly listeners = new Set<() => void>()
  private snapshot: readonly HarnessNativeBinding[] = []
  get = (sessionId: string) => this.bindings.get(sessionId)
  getSnapshot = () => this.snapshot
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  publish(binding: HarnessConversationBinding, worker?: Pick<Worker, 'id' | 'preference' | 'observedModel'>): void {
    if (!binding.sessionId || binding.sessionId === binding.parentSessionId)
      throw new Error(t('不能把主会话登记为 CLI 子会话'))
    const cliSelection = worker?.preference
      ? {
          cli: cliOf(worker.preference),
          model: worker.preference.model,
          effort: worker.preference.effort,
          observedModel: worker.observedModel,
        }
      : this.bindings.get(binding.sessionId)?.cliSelection
    const workerId = worker?.id ?? this.bindings.get(binding.sessionId)?.workerId
    const next = { ...binding, ...(workerId ? { workerId } : {}), ...(cliSelection ? { cliSelection } : {}) }
    if (JSON.stringify(this.bindings.get(binding.sessionId)) === JSON.stringify(next)) return
    this.bindings.set(binding.sessionId, next)
    this.snapshot = [...this.bindings.values()]
    for (const listener of this.listeners) listener()
  }
  clear(): void {
    this.bindings.clear()
    this.snapshot = []
    for (const listener of this.listeners) listener()
  }
}

export function useHarnessSessionBinding(registry: HarnessBindingRegistry, sessionId: string) {
  return useSyncExternalStore(registry.subscribe, () => registry.get(sessionId))
}
