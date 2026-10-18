import { StringDecoder } from 'node:string_decoder'
import { ClaudeResponseTracker } from './primary-response.mjs'
import { NativeBlockResponses, sessionHttpResponseUsage } from './http-rpc-response.mjs'
import type { CliId, PublicToolCall } from '../shared/types.ts'
import type { EventInput, ProtocolResult } from './protocol.ts'

const object = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v)
const text = (v: unknown): string => (typeof v === 'string' ? v : (JSON.stringify(v) ?? ''))
/** Normalizes only public CLI messages. Never synthesizes hidden reasoning. */
export class CliProtocol {
  private decoder = new StringDecoder('utf8')
  private pending = ''
  private steps = new Map<string, number>()
  private completed = new Set<string>()
  private lastAssistant = ''
  private mimoFinished = false
  private openTools = new Set<string>()
  private claudeResponses: ClaudeResponseTracker
  private claudeMessage?: string
  private claudeBlock?: { index: number; type: string }
  private claudeTools = new Map<string, ReturnType<ClaudeResponseTracker['emit']>>()
  private mimoResponses: NativeBlockResponses
  conversationId?: string
  result?: ProtocolResult
  constructor(
    private cli: Exclude<CliId, 'antigravity'>,
    private emit: (event: EventInput) => void,
    private identify: (id: string) => void,
    private maxLineBytes: number,
  ) {
    this.claudeResponses = new ClaudeResponseTracker(emit)
    this.mimoResponses = new NativeBlockResponses('mimo', emit)
  }
  feed(chunk: Buffer | string): void {
    this.pending += typeof chunk === 'string' ? chunk : this.decoder.write(chunk)
    let end: number
    while ((end = this.pending.indexOf('\n')) >= 0) {
      const line = this.pending.slice(0, end).trim()
      this.pending = this.pending.slice(end + 1)
      if (line) this.line(line)
    }
    if (Buffer.byteLength(this.pending) > this.maxLineBytes) throw new Error('CLI event exceeds maxLineBytes')
  }
  end(): void {
    this.pending += this.decoder.end()
    if (this.pending.trim()) this.line(this.pending.trim())
    this.pending = ''
    // Kimi print mode has no terminal result envelope. Clean EOF + the exact
    // resume receipt + an assistant answer are required; runtime checks exit 0.
    if (
      this.cli === 'kimi' &&
      !this.result &&
      this.conversationId &&
      this.lastAssistant &&
      !this.openTools.size
    )
      this.finish('SUCCESS', this.lastAssistant)
    if (this.cli === 'mimo' && !this.result && this.conversationId && this.mimoFinished)
      this.finish('SUCCESS', this.lastAssistant)
  }
  private id(id: unknown) {
    if (typeof id !== 'string' || !id.trim()) return
    if (this.conversationId && this.conversationId !== id)
      throw new Error('CLI session ID changed during a run')
    this.identify(id)
    this.conversationId = id
  }
  private step(id: string) {
    if (!this.steps.has(id)) this.steps.set(id, this.steps.size)
    return this.steps.get(id)!
  }
  private assistant(id: string, content: string, response?: { messageId: string; index: number }) {
    if (this.completed.has(id)) return
    this.completed.add(id)
    if (content) {
      this.lastAssistant = content
      const event = { kind: 'assistant' as const, step: this.step(id), text: content }
      if (response) this.claudeResponses.emit(event, response.messageId, response.index)
      else this.emit(event)
    }
  }
  private tool(id: string, name: string, detail: unknown, done = false, failed = false, toolCall?: PublicToolCall) {
    if (done) this.openTools.delete(id)
    else this.openTools.add(id)
    this.emit({
      kind: 'tool',
      step: this.step(id),
      text: name,
      detail: text(detail),
      state: failed ? 'FAILED' : done ? 'COMPLETED' : 'RUNNING',
      ...(toolCall ? { toolCall } : {}),
    })
  }
  private finish(status: string, response: string, error?: string) {
    if (this.result) throw new Error('Duplicate CLI result')
    if (!this.conversationId) throw new Error('CLI result is missing its session ID')
    this.result = { conversationId: this.conversationId, status, response, error }
    this.emit({ kind: 'result', text: response, state: status })
  }
  private line(line: string) {
    if (Buffer.byteLength(line) > this.maxLineBytes) throw new Error('CLI event exceeds maxLineBytes')
    let v: Record<string, any>
    try {
      v = JSON.parse(line)
    } catch {
      throw new Error(`Invalid ${this.cli} JSONL event`)
    }
    if (!object(v)) throw new Error('Invalid CLI event object')
    // Claude may emit hook/metrics metadata after the result. It cannot modify
    // text, identity or the final result; contradictory terminal events fail.
    if (this.result) {
      if (
        v.type === 'result' ||
        v.type === 'turn.completed' ||
        v.type === 'turn.failed' ||
        v.type === 'error' ||
        v.role === 'assistant'
      )
        throw new Error('Unexpected output after CLI result')
      this.id(v.session_id ?? v.thread_id)
      return
    }
    if (this.cli === 'codex') {
      if (typeof v.type !== 'string') throw new Error('Missing Codex event discriminator')
      if (v.type === 'thread.started') {
        this.id(v.thread_id)
        this.emit({ kind: 'status', text: 'Codex 已连接' })
      } else if (v.type.startsWith('item.') && object(v.item)) {
        const item = v.item,
          id = String(item.id),
          done = v.type === 'item.completed'
        if (item.type === 'agent_message' && done) this.assistant(id, text(item.text ?? ''))
        // Codex exec projects only ThreadItem::Reasoning.summary into this
        // completed text field. Raw/encrypted content is never inspected.
        else if (item.type === 'reasoning' && done && typeof item.text === 'string' && item.redacted !== true)
          this.emit({
            kind: 'reasoning',
            step: this.step(`reasoning:${id}`),
            text: 'Codex 思考摘要',
            detail: item.text,
            state: 'COMPLETED',
          })
        else if (
          ['command_execution', 'file_change', 'mcp_tool_call', 'collab_tool_call', 'web_search', 'todo_list'].includes(item.type)
        )
          this.tool(id, item.command ?? item.tool ?? item.type, item, done,
            item.status === 'failed' || item.status === 'declined' || !!item.error || (typeof item.exit_code === 'number' && item.exit_code !== 0),
            { callId: id, name: item.tool ?? item.type,
              ...(Object.hasOwn(item, 'arguments') ? { input: item.arguments } : {}),
              ...(item.type === 'file_change' && Object.hasOwn(item, 'changes') ? { output: item.changes } : {}),
              ...(typeof item.command === 'string' ? { command: item.command } : {}),
              ...(typeof item.aggregated_output === 'string' ? { output: item.aggregated_output } : {}),
              ...(Object.hasOwn(item, 'result') ? { output: item.result } : {}),
              ...(Number.isSafeInteger(item.exit_code) ? { exitCode: item.exit_code } : {}),
            })
      } else if (v.type === 'turn.completed') this.finish('SUCCESS', this.lastAssistant)
      else if (v.type === 'turn.failed') this.finish('ERROR', this.lastAssistant, text(v.error))
      else if (v.type === 'error') this.emit({ kind: 'diagnostic', text: text(v.message ?? v.error) })
    } else if (this.cli === 'claude') {
      if (typeof v.type !== 'string') throw new Error('Missing Claude event discriminator')
      this.id(v.session_id)
      if (v.type === 'system' && v.subtype === 'init')
        this.emit({
          kind: 'status',
          text: 'Claude Code 已连接',
          observedModel: typeof v.model === 'string' ? v.model : undefined,
        })
      else if (v.type === 'stream_event' && object(v.event) && v.parent_tool_use_id == null) {
        const event = v.event
        if (event.type === 'message_start') {
          this.claudeMessage = event.message?.id
          this.claudeBlock = undefined
          this.claudeResponses.start(event.message?.id, event.message?.usage)
        } else if (event.type === 'content_block_start' && Number.isSafeInteger(event.index) && event.index >= 0)
          this.claudeBlock = { index: event.index, type: event.content_block?.type }
        else if (event.type === 'content_block_stop' && this.claudeBlock?.index === event.index)
          this.claudeBlock = undefined
        else if (event.type === 'message_delta') this.claudeResponses.delta(event.usage)
        else if (event.type === 'message_stop') {
          this.claudeResponses.finish(true)
          this.claudeMessage = undefined
          this.claudeBlock = undefined
        }
      } else if (v.type === 'assistant' && object(v.message)) {
        if (v.parent_tool_use_id == null && this.claudeResponses.id && this.claudeResponses.id !== v.message.id) this.claudeResponses.finish()
        for (const [i, block] of (v.message.content ?? []).entries()) {
          const index = v.message.content.length === 1 && this.claudeMessage === v.message.id && this.claudeBlock && this.claudeBlock.type === block.type ? this.claudeBlock.index : i
          const identity = v.parent_tool_use_id == null ? { messageId: v.message.id, index } : undefined
          if (block.type === 'text') this.assistant(`${v.message.id}:${index}`, text(block.text), identity)
          else if (block.type === 'thinking' && typeof block.thinking === 'string' && block.redacted !== true)
            this.claudeResponses.emit({
              kind: 'reasoning',
              step: this.step(`reasoning:${v.message.id}:${index}`),
              text: 'Claude Code 公开思考',
              detail: block.thinking,
              state: 'COMPLETED',
            }, identity?.messageId, index)
          else if (block.type === 'tool_use') {
            this.openTools.add(block.id)
            const response = this.claudeResponses.emit({ kind: 'tool', step: this.step(block.id), text: block.name, detail: text(block.input), state: 'RUNNING', toolCall: { callId: block.id, name: block.name, input: block.input } }, identity?.messageId, index)
            if (response) this.claudeTools.set(block.id, response)
          }
        }
      } else if (v.type === 'user' && object(v.message)) {
        for (const block of v.message.content ?? [])
          if (block.type === 'tool_result') {
            this.openTools.delete(block.tool_use_id)
            this.emit({ kind: 'tool', step: this.step(block.tool_use_id), text: '', detail: text(block.content), state: block.is_error ? 'FAILED' : 'COMPLETED', ...(this.claudeTools.get(block.tool_use_id) ? { response: this.claudeTools.get(block.tool_use_id) } : {}), toolCall: { callId: block.tool_use_id, output: block.content } })
          }
      } else if (v.type === 'result') {
        this.claudeResponses.finish()
        const denied = Array.isArray(v.permission_denials) && v.permission_denials.length > 0
        this.finish(
          v.is_error || denied || v.subtype !== 'success' ? 'ERROR' : 'SUCCESS',
          text(v.result ?? this.lastAssistant),
          denied ? '工具权限被拒绝；未执行的操作不能视为完成。' : v.errors ? text(v.errors) : undefined,
        )
      }
    } else if (this.cli === 'mimo') {
      if (typeof v.type !== 'string') throw new Error('Missing MiMo event discriminator')
      this.id(v.sessionID)
      const part = v.part
      const scopedPart = object(part) && typeof part.id === 'string' && !!part.id &&
        typeof part.messageID === 'string' && !!part.messageID &&
        part.sessionID === this.conversationId && v.sessionID === this.conversationId
      if (object(part) && typeof part.sessionID === 'string' && part.sessionID !== this.conversationId)
        throw new Error('MiMo part session identity changed')
      if (v.type === 'step_start') {
        this.mimoFinished = false
        this.emit({ kind: 'status', text: 'MiMo 工作中' })
      } else if (v.type === 'text' && object(part) && scopedPart && typeof part.text === 'string') {
        const key = `mimo:${part.messageID}:${part.id}`
        if (!this.completed.has(key)) {
          this.completed.add(key)
          if (part.text) this.lastAssistant = part.text
          this.mimoResponses.event(part.messageID, part.id, { kind: 'assistant', step: this.step(key), text: part.text, state: 'COMPLETED' })
        }
      } else if (v.type === 'text' && object(part)) this.assistant(String(part.id), text(part.text ?? ''))
      else if (v.type === 'reasoning' && scopedPart && part.type === 'reasoning' && typeof part.text === 'string' && part.redacted !== true)
        this.mimoResponses.event(part.messageID, part.id, { kind: 'reasoning', step: this.step(`mimo:${part.messageID}:${part.id}`), text: 'MiMo 公开思考', detail: part.text, state: 'COMPLETED' })
      else if (v.type === 'tool_use' && scopedPart) {
        this.mimoResponses.event(part.messageID, part.id, {
          kind: 'tool', step: this.step(`mimo:${part.messageID}:${part.id}`), text: part.tool ?? '工具', detail: text(part.state),
          state: part.state?.status === 'error' ? 'FAILED' : part.state?.status === 'completed' ? 'COMPLETED' : 'RUNNING',
          toolCall: { ...(typeof part.callID === 'string' && part.callID ? { callId: part.callID } : {}),
            ...(typeof part.tool === 'string' ? { name: part.tool } : {}),
            ...(object(part.state) && Object.hasOwn(part.state, 'input') ? { input: part.state.input } : {}),
            ...(object(part.state) && Object.hasOwn(part.state, 'output') ? { output: part.state.output } : {}),
          },
        })
      } else if (v.type === 'tool_use' && object(part))
        this.tool(
          String(part.callID ?? part.id),
          part.tool ?? '工具',
          part.state,
          true,
          part.state?.status === 'error',
        )
      else if (v.type === 'step_finish') {
        if (scopedPart) this.mimoResponses.finish(part.messageID, sessionHttpResponseUsage(part.tokens))
        this.mimoFinished = part?.reason === 'stop'
      }
      else if (v.type === 'error') this.finish('ERROR', this.lastAssistant, text(v.error))
    } else {
      if (typeof v.role !== 'string') throw new Error('Missing Kimi role discriminator')
      if (v.role === 'meta' && v.type === 'session.resume_hint') {
        this.id(v.session_id)
        this.emit({ kind: 'status', text: 'Kimi 会话已保存' })
      } else if (v.role === 'assistant') {
        if (typeof v.content === 'string') this.assistant(`message:${this.steps.size}`, v.content)
        if (v.tool_calls?.length) this.lastAssistant = ''
        for (const call of v.tool_calls ?? [])
          this.tool(call.id, call.function?.name ?? '工具', call.function?.arguments ?? '', false, false, { callId: call.id, ...(typeof call.function?.name === 'string' ? { name: call.function.name } : {}), input: call.function?.arguments })
      } else if (v.role === 'tool') this.tool(v.tool_call_id, '', v.content, true, false, { callId: v.tool_call_id, output: v.content })
      else if (v.role === 'meta')
        this.emit({ kind: 'diagnostic', text: String(v.type ?? 'Kimi metadata'), detail: line })
      else throw new Error(`Unsupported Kimi message role: ${v.role}`)
    }
  }
}
