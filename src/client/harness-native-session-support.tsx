import { useLayoutEffect, useState, useSyncExternalStore } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import { useHarnessSessionBinding, type HarnessBindingRegistry } from './harness-binding-registry.ts'
import { harnessComposerBlock, retainHarnessComposerBlock } from './harness-conversation.tsx'
import { installHarnessSessionDomGuard, type GuardedNativeControl } from './harness-dom-guard.ts'
import { HarnessNativeTooltips } from './harness-native-tooltip.tsx'

export function HarnessNativeSessionSupports({
  bindings,
  conversation,
}: {
  bindings: HarnessBindingRegistry
  conversation: Context['conversation']
}) {
  const known = useSyncExternalStore(bindings.subscribe, bindings.getSnapshot)
  return (
    <>
      {known.map((binding) => (
        <HarnessNativeSessionSupport
          key={binding.sessionId}
          sessionId={binding.sessionId}
          bindings={bindings}
          conversation={conversation}
        />
      ))}
    </>
  )
}

/** Capability support for an exact Host-issued child; it owns no native UI or navigation. */
export function HarnessNativeSessionSupport({
  sessionId,
  bindings,
  conversation,
}: {
  sessionId: string
  bindings: HarnessBindingRegistry
  conversation: Context['conversation']
}) {
  const binding = useHarnessSessionBinding(bindings, sessionId)
  const [targets, setTargets] = useState<readonly GuardedNativeControl[]>([])
  useLayoutEffect(() => {
    if (!binding) return
    return retainHarnessComposerBlock(conversation, sessionId, harnessComposerBlock(binding))
  }, [binding, conversation, sessionId])
  useLayoutEffect(() => {
    setTargets([])
    if (!binding || typeof document === 'undefined') return
    return installHarnessSessionDomGuard(document, binding, (next) =>
      setTargets((previous) =>
        previous.length === next.length &&
        previous.every(
          (target, index) => target.element === next[index]?.element && target.reason === next[index]?.reason,
        )
          ? previous
          : next,
      ),
    )
  }, [binding])
  return <HarnessNativeTooltips targets={targets} />
}
