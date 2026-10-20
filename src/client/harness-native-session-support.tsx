import { useLayoutEffect, useState, useSyncExternalStore } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import { useHarnessSessionBinding, type HarnessBindingRegistry } from './harness-binding-registry.ts'
import { harnessComposerBlock, retainHarnessComposerBlock } from './harness-conversation.tsx'
import { installHarnessSessionDomGuard, type GuardedNativeControl } from './harness-dom-guard.ts'
import { HarnessNativeTooltips } from './harness-native-tooltip.tsx'
import { useWorkers, type API } from './workers.ts'
import type { HarnessWorkerFork } from './harness-worker-fork.tsx'

export function HarnessNativeSessionSupports({
  bindings,
  conversation,
  forks,
  api,
}: {
  bindings: HarnessBindingRegistry
  conversation: Context['conversation']
  forks?: HarnessWorkerFork
  api?: API
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
          forks={forks}
          api={api}
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
  forks,
  api,
}: {
  sessionId: string
  bindings: HarnessBindingRegistry
  conversation: Context['conversation']
  forks?: HarnessWorkerFork
  api?: API
}) {
  const binding = useHarnessSessionBinding(bindings, sessionId)
  const forkRevision = useSyncExternalStore(forks?.subscribe ?? noSubscribe, forks?.getSnapshot ?? noRevision)
  const [targets, setTargets] = useState<readonly GuardedNativeControl[]>([])
  useLayoutEffect(() => {
    if (!binding) return
    return retainHarnessComposerBlock(conversation, sessionId, harnessComposerBlock(binding))
  }, [binding, conversation, sessionId])
  useLayoutEffect(() => {
    setTargets([])
    if (!binding || typeof document === 'undefined') return
    const cut = (button: HTMLButtonElement) => {
      const turn = button.closest('[data-turn-tail]')?.getAttribute('data-turn-tail')
      return turn == null ? { atMessageId: '', reason: '只能从已完成的助手轮次分支' } : forks!.cut(sessionId, { turn: Number(turn) })
    }
    return installHarnessSessionDomGuard(document, binding, (next) =>
      setTargets((previous) =>
        previous.length === next.length &&
        previous.every(
          (target, index) => target.element === next[index]?.element && target.reason === next[index]?.reason,
        )
          ? previous
          : next,
      ), forks ? {
      reason: (button) => forks.reason(sessionId, cut(button)),
      fork: (button) => { void forks.fork(sessionId, cut(button)) },
    } : undefined)
  }, [binding, forks, forkRevision])
  return <>
    {api && forks && binding?.workerId && <ForkWorkerState api={api} forks={forks} binding={binding} />}
    <HarnessNativeTooltips targets={targets} />
  </>
}
const noSubscribe = () => () => {}
const noRevision = () => 0
function ForkWorkerState({ api, forks, binding }: { api: API; forks: HarnessWorkerFork; binding: NonNullable<ReturnType<HarnessBindingRegistry['get']>> }) {
  const { snapshot } = useWorkers(api, binding.parentSessionId, binding.workerId!)
  useLayoutEffect(() => { forks.update(binding.sessionId, snapshot) }, [forks, binding.sessionId, snapshot])
  return null
}
