import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'

// The optional commands package may be loaded after this bridge. Its public
// registry notification is the same merge-extensible Cordis event contract.
declare module '@deepseek-ai/cordis' {
  interface Events {
    'commands/change'(): void
  }
}

export const HARNESS_COMMAND_UNAVAILABLE =
  '此命令尚未接通 CLI 会话状态或辅助模型能力；原生发送、排队和停止仍可使用'
// These commands mutate or generate model state that the external CLI owns.
// Ordinary host commands remain native and retain their own permission checks.
const unsupported = new Set(['clear', 'compact', 'fork', 'new', 'model', 'plan', 'goal'])
interface Commands {
  list(agent: Agent): readonly { name: string; description: string }[]
  register(definition: {
    name: string
    description: string
    input?: { hint: string }
    handler(invocation: {
      agent: Agent
      rawInput: string
      signal: AbortSignal
    }): { kind: 'error' | 'success'; text: string } | Promise<{ kind: 'error' | 'success'; text: string }>
  }): () => void
}
interface ChildCommands {
  agent: Agent
  shadows: Map<string, () => void>
  refreshing: boolean
  closed: boolean
}

/** Public agent-scoped command shadows, never a slash-text parser or core patch. */
export class HarnessConversationCommandGuard {
  private readonly children = new Map<string, ChildCommands>()
  private readonly disposeHooks: Array<() => unknown> = []
  private disposed = false

  constructor(
    private readonly ctx: Context,
    private readonly owns: (agent: Agent) => boolean,
    private readonly permission?: (
      agent: Agent,
      mode: string | undefined,
      signal: AbortSignal,
    ) => Promise<string>,
  ) {
    this.disposeHooks.push(
      ctx.on(
        'agent/created',
        ({ agent }) => {
          if (owns(agent)) this.protect(agent)
        },
        { global: true },
      ),
    )
    this.disposeHooks.push(ctx.on('agent/disposed', ({ agent }) => this.release(agent.id), { global: true }))
    this.disposeHooks.push(
      ctx.on(
        'commands/change',
        () => {
          for (const child of this.children.values()) this.refresh(child)
        },
        { global: true },
      ),
    )
    const binding = ctx.inject(['commands'], () => {
      for (const child of this.children.values()) this.refresh(child)
    })
    this.disposeHooks.push(() => binding.dispose())
  }

  protect(agent: Agent) {
    if (this.disposed || !this.owns(agent) || this.children.has(agent.id)) return
    const child: ChildCommands = { agent, shadows: new Map(), refreshing: false, closed: false }
    this.children.set(agent.id, child)
    this.refresh(child)
  }

  private refresh(child: ChildCommands) {
    if (child.closed || child.refreshing || this.disposed) return
    const commands = child.agent.ctx.get('commands') as Commands | undefined
    if (!commands) return
    child.refreshing = true
    try {
      for (const definition of commands.list(child.agent)) {
        if (!unsupported.has(definition.name) && definition.name !== 'permission') continue
        if (child.shadows.has(definition.name)) continue
        const dispose = commands.register({
          name: definition.name,
          description:
            definition.name === 'permission'
              ? '查看或选择当前 CLI 的真实权限模式'
              : HARNESS_COMMAND_UNAVAILABLE,
          ...(definition.name === 'permission' ? { input: { hint: '<CLI 权限模式>' } } : {}),
          handler: async ({ agent, rawInput, signal }) => {
            if (definition.name !== 'permission' || !this.permission)
              return { kind: 'error', text: HARNESS_COMMAND_UNAVAILABLE }
            if (!this.owns(agent) || agent.id !== child.agent.id)
              return { kind: 'error', text: 'CLI 权限命令所属会话不匹配' }
            try {
              signal.throwIfAborted()
              return {
                kind: 'success',
                text: await this.permission(agent, rawInput.trim() || undefined, signal),
              }
            } catch (error) {
              return { kind: 'error', text: String(error) }
            }
          },
        })
        child.shadows.set(definition.name, dispose)
      }
    } finally {
      child.refreshing = false
    }
  }

  private release(sessionId: string) {
    const child = this.children.get(sessionId)
    if (!child) return
    child.closed = true
    this.children.delete(sessionId)
    for (const dispose of child.shadows.values()) dispose()
    child.shadows.clear()
  }

  async dispose() {
    if (this.disposed) return
    this.disposed = true
    for (const id of this.children.keys()) this.release(id)
    await Promise.all(
      this.disposeHooks
        .splice(0)
        .reverse()
        .map((dispose) => dispose()),
    )
  }
}
