import type { Context } from '@deepseek-ai/cordis'
import { useEffect, useLayoutEffect, useRef } from 'react'
import type { PropsRuntime, PropsRenderSlots, SlotCore } from '@deepseek-ai/dsh-client-ui-slots'
import { Button, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import remoteContribution from 'dsh-cliworker-now/remote'
import { active } from '../shared/types.ts'
import { Panel } from './panel.tsx'
import { NativePresentationProvider } from './native-presentation.tsx'
import { HarnessConversation, readHarnessConversationBinding } from './harness-conversation.tsx'
import { HarnessBindingRegistry } from './harness-binding-registry.ts'
import { HarnessNativeSessionSupports } from './harness-native-session-support.tsx'
import { installHarnessControlGuards } from './harness-control-guards.tsx'
import { installHarnessNativeContent } from './harness-native-content.tsx'
import { installHarnessReasoningRecords, reasoningRecordsStyles } from './harness-reasoning-records.tsx'
import { installHarnessNativeTelemetry } from './harness-native-telemetry.tsx'
import { HARNESS_COMMAND_SOURCE, installHarnessNativeCommands } from './harness-native-commands.ts'
import { useWorkers, type API } from './workers.ts'
import {
  styles,
  nativeChatStyles,
  modelPickerStyles,
  telemetryStyles,
  processStyles,
  contextInspectionStyles,
  nativeInteractionStyles,
  hoverFeedbackStyles,
  conversationInteractionStyles,
  settingsStyles,
  rolePresetStyles,
} from './styles.ts'
import { BrandIcon } from './icons.tsx'
import { installNativeJobOverlay } from './native-job-overlay.ts'
import { workerManagementStyles } from './management-styles.ts'
import { renameCopyStyles } from './rename-copy-styles.ts'

const ID = 'dsh-cliworker-now'

export const inject = [
  'slots',
  'sidebarRightTabs',
  'sidebarRight',
  'remote',
  'configForms',
  'sessions',
  'conversation',
  'uiConversation',
  'uiSession',
]
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.remote.$mount(remoteContribution), 'cliworker:remote')
  ctx.inject(['remote.cliworker'], (scope) => {
    const remote = scope.remote,
      worker = remote.cliworker
    const api: API = { $stream: (options) => remote.$stream(options), cliworker: worker }
    const nativeChatSettings = scope.configForms.get<{ transcriptView?: unknown }>('ui-chat')
    const harnessServices = { sessions: scope.sessions }
    const bindings = new HarnessBindingRegistry()
    scope.effect(() => () => bindings.clear())
    scope.effect(() => installHarnessControlGuards(scope, bindings, api))
    scope.effect(() => installHarnessReasoningRecords(scope, bindings))
    const nativeTelemetry = installHarnessNativeTelemetry(scope, bindings, api)
    scope.effect(() => () => nativeTelemetry.dispose())
    scope.inject(['inputTriggers', 'commandUi'], (commands) => {
      commands.effect(() => installHarnessNativeCommands(commands, bindings, api))
    })
    function WorkerPanel(
      props: PropsRuntime<'sidebar.right.pane.tab'> & PropsRenderSlots<'cliworker.native.sidebar'> & {
        api: API
        openNativeSettings?: () => void
      },
    ) {
      const address = props.useSession((session) => session.subagent?.address)
      const parentSessionId = address?.parentSessionId ?? props.sessionId
      return (
        <NativePresentationProvider source={nativeChatSettings}>
          <Panel
            {...props}
            sessionId={parentSessionId}
            activeHarnessSessionId={address?.childSessionId}
            renderHarnessConversation={(worker) => (
              <HarnessConversation
                key={worker.id}
                services={harnessServices}
                bindings={bindings}
                attachProjections={nativeTelemetry.attach}
                api={api}
                parentSessionId={parentSessionId}
                worker={worker}
                renderConversation={(reference) => (
                  <props.SessionProvider session={reference}>
                    {props.renderSlot('cliworker.native.sidebar', { composerPresentation: 'main', commandSource: HARNESS_COMMAND_SOURCE })}
                  </props.SessionProvider>
                )}
              />
            )}
          />
        </NativePresentationProvider>
      )
    }
    let nativeSettingsOpen: (() => void) | undefined
    function NativeSettingsBridge({ open }: { open?: () => void }) {
      useEffect(() => {
        nativeSettingsOpen = open
        return () => {
          if (nativeSettingsOpen === open) nativeSettingsOpen = undefined
        }
      }, [open])
      return null
    }
    scope.effect(() =>
      scope.slots.inject('settings.section', () =>
        scope.slots.inject('shell.overlay', () => {
          // Harness 0.2.0-rc.2 compatibility: share the shell's existing root
          // handle. The renderer owns instance creation, binding and disposal;
          // we neither create its store nor redeclare its settings slots.
          // Use SlotCore's dynamic inspection signature; sidebar.settings is
          // owned by an optional native package, not declared by this plugin.
          const ledger: Pick<SlotCore, 'entriesOfSlot'> = scope.slots
          const handle = ledger.entriesOfSlot('sidebar.settings')[0]?.store
          if (
            !handle ||
            typeof handle === 'function' ||
            typeof handle.spec?.actions?.openSection !== 'function'
          )
            return () => {}
          const dispose = scope.slots.register(
            {
              name: 'shell.overlay',
              id: `${ID}.native-settings`,
              store: handle,
              inject: (actions) => ({
                open:
                  typeof actions.openSection === 'function' ? () => actions.openSection('models') : undefined,
              }),
            },
            NativeSettingsBridge,
          )
          return () => {
            nativeSettingsOpen = undefined
            dispose()
          }
        }),
      ),
    )
    scope.effect(() => {
      const style = document.createElement('style')
      style.textContent =
        styles +
        nativeChatStyles +
        modelPickerStyles +
        telemetryStyles +
        nativeInteractionStyles +
        hoverFeedbackStyles +
        conversationInteractionStyles +
        settingsStyles +
        rolePresetStyles +
        workerManagementStyles +
        renameCopyStyles +
        processStyles +
        contextInspectionStyles +
        reasoningRecordsStyles
      document.head.append(style)
      return () => style.remove()
    })
    scope.effect(() => installNativeJobOverlay(document))
    scope.effect(() =>
      scope.sidebarRightTabs.register({
        id: ID,
        kind: 'cliworker',
        title: () => 'CLI Worker',
        guide: [
          {
            id: 'cliworker',
            order: 25,
            title: () => 'CLI Worker',
            description: () => '查看各 CLI 子 Agent 的实时工作',
            icon: () => <BrandIcon />,
          },
        ],
      }),
    )
    scope.effect(() =>
      scope.slots.inject('sidebar.right.pane.tab', () =>
        scope.slots.register(
          {
            name: 'sidebar.right.pane.tab',
            key: ID,
            children: { 'cliworker.native.sidebar': { kind: 'single', scope: 'session' } },
            inject: () => ({
              api,
              openNativeSettings: () => {
                if (!nativeSettingsOpen) throw new Error('Harness 原生设置入口暂不可用')
                nativeSettingsOpen()
              },
            }),
          },
          WorkerPanel,
        ),
      ),
    )
    scope.effect(() => installHarnessNativeContent(scope))
    function Header({ sessionId, useSession }: PropsRuntime<'conversation.session.header.utilities'>) {
      const address = useSession((session) => session.subagent?.address)
      const parentSessionId = address?.parentSessionId ?? sessionId
      const { snapshot, connecting } = useWorkers(api, parentSessionId)
      useLayoutEffect(() => {
        if (connecting) return
        for (const worker of snapshot.workers) {
          if (worker.parentSessionId !== parentSessionId || !worker.harnessConversation) continue
          try {
            bindings.publish(
              readHarnessConversationBinding(worker.harnessConversation, parentSessionId),
              worker,
            )
          } catch {
            /* Invalid Host identity never scopes native controls. */
          }
        }
      }, [snapshot, connecting, parentSessionId])
      const seen = useRef(new Set<string>())
      useEffect(() => {
        seen.current.clear()
      }, [parentSessionId])
      const open = () => {
        if (scope.sidebarRight.mounted.getSnapshot() === sessionId) scope.sidebarRight.openTab('cliworker')
      }
      useEffect(() => {
        if (address) return
        const ids = snapshot.workers.filter((w) => active(w.status)).map((w) => w.runId)
        if (snapshot.configuring) ids.push('configuring')
        if (ids.some((id) => !seen.current.has(id))) {
          ids.forEach((id) => seen.current.add(id))
          open()
        }
      }, [snapshot, address])
      return (
        <>
          <HarnessNativeSessionSupports bindings={bindings} conversation={scope.conversation} />
          <Tooltip label="打开 CLI Worker" side="bottom" portal>
            <Button
              variant="ghost"
              size="sm"
              aria-label="打开 CLI Worker"
              className="cwn-entry"
              icon={<BrandIcon size={16} />}
              onClick={open}
            />
          </Tooltip>
        </>
      )
    }
    scope.effect(() =>
      scope.slots.inject('conversation.session.header.utilities', () =>
        scope.slots.register({ name: 'conversation.session.header.utilities', id: ID, order: -20 }, Header),
      ),
    )
  })
}
