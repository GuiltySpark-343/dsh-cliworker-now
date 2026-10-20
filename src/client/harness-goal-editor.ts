import type { HarnessBindingRegistry } from './harness-binding-registry.ts'
import { harnessFeatureReason } from './harness-feature-support.ts'

const editors = new WeakMap<
  HarnessBindingRegistry,
  { requests: Map<string, number>; listeners: Set<() => void> }
>()
export function harnessGoalEditor(bindings: HarnessBindingRegistry) {
  let editor = editors.get(bindings)
  if (!editor) editors.set(bindings, (editor = { requests: new Map(), listeners: new Set() }))
  return editor
}
export function openHarnessWorkerGoal(bindings: HarnessBindingRegistry, sessionId: string) {
  const binding = bindings.get(sessionId)
  if (!binding || harnessFeatureReason(binding, 'goal')) return
  const editor = harnessGoalEditor(bindings)
  editor.requests.set(sessionId, (editor.requests.get(sessionId) ?? 0) + 1)
  editor.listeners.forEach((listener) => listener())
}
