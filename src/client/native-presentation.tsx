import { createContext, useContext, useMemo, useSyncExternalStore, type ReactNode } from 'react'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'

export type WorkDetailsMode = 'compact' | 'standard' | 'detailed' | 'verbose'
export interface WorkDetailsPolicy {
  mode: WorkDetailsMode
  foldCompletedTurns: boolean
  stepGrouping: 'collapsed' | 'history' | 'none'
  liveProcessDetail: boolean
  settledReasoningPreview: boolean
}
/** Harness rc.2 ui-chat presentation-policy; its complete component is not exported. */
const policies: Record<WorkDetailsMode, WorkDetailsPolicy> = {
  compact: {
    mode: 'compact',
    foldCompletedTurns: true,
    stepGrouping: 'collapsed',
    liveProcessDetail: false,
    settledReasoningPreview: false,
  },
  standard: {
    mode: 'standard',
    foldCompletedTurns: true,
    stepGrouping: 'collapsed',
    liveProcessDetail: true,
    settledReasoningPreview: true,
  },
  detailed: {
    mode: 'detailed',
    foldCompletedTurns: true,
    stepGrouping: 'history',
    liveProcessDetail: true,
    settledReasoningPreview: true,
  },
  verbose: {
    mode: 'verbose',
    foldCompletedTurns: false,
    stepGrouping: 'none',
    liveProcessDetail: false,
    settledReasoningPreview: true,
  },
}
export function workDetailsPolicy(value: unknown, desktop = 'dshDesktop' in globalThis): WorkDetailsPolicy {
  if (value === 'normal' || value === 'expanded') return policies.detailed
  return policies[
    value === 'compact' || value === 'standard' || value === 'detailed' || value === 'verbose'
      ? value
      : desktop
        ? 'standard'
        : 'compact'
  ]
}
const Presentation = createContext<WorkDetailsPolicy | undefined>(undefined)
export type NativeChatSettings = Pick<ConfigForm<{ transcriptView?: unknown }>, 'getSnapshot' | 'subscribe'>

/** Only the global presentation preference is read, never a parent Session projection. */
export function NativePresentationProvider({
  source,
  children,
}: {
  source: NativeChatSettings
  children: ReactNode
}) {
  const observe = useMemo(
    () => ({
      read: () => source.getSnapshot(),
      subscribe: (listener: () => void) => source.subscribe(listener),
    }),
    [source],
  )
  const snapshot = useSyncExternalStore(observe.subscribe, observe.read, observe.read)
  return (
    <Presentation.Provider value={workDetailsPolicy(snapshot.value?.transcriptView)}>
      {children}
    </Presentation.Provider>
  )
}
export const useNativePresentation = () => useContext(Presentation) ?? workDetailsPolicy(undefined)
