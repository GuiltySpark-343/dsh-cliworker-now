// ACP is JSON-RPC 2.0 over NDJSON. Kimi and Grok retain their own config wire.
import { nativeHarnessMcpServers } from './native-harness-injection.mjs'
export const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
export const nonempty = (value) => typeof value === 'string' && value.trim().length > 0

/** Remove only known per-turn arguments; retain executable/launcher and other global options. */
export function replaceNativeArguments(argv, pairs, switches, tail) {
  if (!Array.isArray(argv) || !argv.length || argv.some((arg) => typeof arg !== 'string'))
    throw new Error('Invalid native argument array')
  const result = []
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (pairs.includes(arg)) {
      if (index + 1 >= argv.length) throw new Error('Native option is missing its value')
      index++
    } else if (!switches.includes(arg)) result.push(arg)
  }
  return [...result, ...tail]
}

const optionValues = (options) =>
  Array.isArray(options)
    ? options.flatMap((option) =>
        isRecord(option) && Array.isArray(option.options)
          ? optionValues(option.options)
          : [optionValue(option?.value)],
      )
    : []
const optionValue = (value) => (isRecord(value) ? value.value : value)
const findOption = (state, id) => state?.configOptions?.find((option) => option.id === id)

async function selectOption(peer, sessionId, state, id, value, encode, required = true) {
  const option = findOption(state, id)
  if (!option) {
    if (required) throw new Error(`ACP does not advertise ${id} selection`)
    return state
  }
  if (!optionValues(option.options).includes(value)) throw new Error(`ACP rejected the selected ${id}`)
  if (optionValue(option.currentValue) === value) return state
  const updated = await peer.request(
    'session/set_config_option',
    { sessionId, configId: id, value: encode(value) },
    { jsonrpc: true },
  )
  if (optionValue(findOption(updated, id)?.currentValue) !== value)
    throw new Error(`ACP did not confirm the selected ${id}`)
  return { ...state, ...updated }
}

/** Runs exactly one turn; restored history is deliberately ignored before prompt admission. */
export async function runNativeAcp(config, io, settings) {
  const wantedMode = config.mode === 'plan' ? 'plan' : settings.editMode
  let peer,
    sessionId,
    active = false,
    response = '',
    thought = '',
    failure,
    ended = false
  let step = 0, assistantStep = 0, assistantSegmentOpen = false, thoughtStep = 0
  const responses = settings.responseTracker?.(io)
  const emit = (event) => responses
    ? responses.emit(event, event.kind === 'tool' ? `tool:${event.toolCall.callId}` : `${event.kind}:${event.step}`)
    : io.event(event)
  const tools = new Map(),
    seen = new Set(),
    early = []
  const fail = (message) => {
    failure ??= message
  }
  const finishThought = () => {
    if (!thought) return
    emit({ kind: 'reasoning', step: thoughtStep++, text: `${settings.name} 公开思考`,
      detail: thought, state: 'COMPLETED' })
    thought = ''
  }
  const receive = (message) => {
    io.native(message)
    if (!isRecord(message) || message.jsonrpc !== '2.0') {
      fail('Invalid ACP JSON-RPC envelope')
      throw new Error('Invalid ACP JSON-RPC envelope')
    }
    if (!nonempty(message.method)) return
    if (!peer) {
      early.push(message)
      return
    }
    if (message.id !== undefined) {
      if (message.method === 'session/request_permission') {
        if (active && message.params?.sessionId === sessionId) {
          fail('CLI 请求的额外权限已拒绝')
          io.event({ kind: 'diagnostic', text: 'CLI 额外权限请求已拒绝' })
        }
        const reject = message.params?.options?.find((option) => option.kind === 'reject_once')
        return peer.send({
          jsonrpc: '2.0',
          id: message.id,
          result: {
            outcome: reject ? { outcome: 'selected', optionId: reject.optionId } : { outcome: 'cancelled' },
          },
        })
      } else {
        return peer.send({
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32601, message: 'Client capability unavailable' },
        })
      }
      return
    }
    if (active && !ended && settings.receive?.(message, sessionId, responses, finishThought)) return
    if (!active || ended || message.method !== 'session/update' || message.params?.sessionId !== sessionId)
      return
    const update = message.params.update
    if (!isRecord(update)) return
    if (update.sessionUpdate === 'config_option_update') {
      const observed = optionValue(findOption(update, 'model')?.currentValue)
      if (observed !== undefined && observed !== config.preference.model) {
        fail('ACP 实际模型与所选模型不匹配')
        cancel()
      }
      const observedMode = settings.modeConfigId && optionValue(findOption(update, settings.modeConfigId)?.currentValue)
      if (settings.modeConfigId && observedMode !== undefined && observedMode !== wantedMode) {
        fail('ACP 实际权限与所选模式不匹配')
        cancel()
      }
      return
    }
    // Stable ids only: identical token chunks can legitimately repeat without an id.
    const eventId = update.eventId ?? message.params.eventId ?? message.params._meta?.eventId
    if (nonempty(eventId)) {
      if (seen.has(eventId)) return
      seen.add(eventId)
    }
    if (update.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') {
      finishThought()
      if (typeof update.content.text !== 'string') {
        fail('Invalid ACP text chunk')
        return
      }
      response += update.content.text
      if (update.content.text) {
        if (!assistantSegmentOpen) { assistantStep++; assistantSegmentOpen = true }
        emit({ kind: 'assistant', step: assistantStep, text: update.content.text })
      }
    } else if (update.sessionUpdate === 'agent_thought_chunk' && update.content?.type === 'text') {
      if (typeof update.content.text === 'string') {
        if (update.content.text) assistantSegmentOpen = false
        thought += update.content.text
        emit({
          kind: 'reasoning',
          step: thoughtStep,
          text: `${settings.name} 公开思考`,
          detail: thought,
          state: 'RUNNING',
        })
      }
    } else if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
      finishThought()
      assistantSegmentOpen = false
      if (!nonempty(update.toolCallId)) {
        fail('Invalid ACP tool identity')
        return
      }
      const previous = tools.get(update.toolCallId) ?? { step: step++, title: '工具', status: 'pending' }
      const value = {
        ...previous,
        ...(nonempty(update.title) ? { title: update.title } : {}),
        ...(nonempty(update.status) ? { status: update.status } : {}),
      }
      tools.set(update.toolCallId, value)
      if (value.status === 'failed') fail('CLI 工具执行失败')
      emit({
        kind: 'tool',
        step: value.step,
        text: value.title,
        state: value.status === 'completed' ? 'COMPLETED' : value.status === 'failed' ? 'FAILED' : 'RUNNING',
        detail: JSON.stringify(update),
        toolCall: { callId: update.toolCallId,
          ...(nonempty(settings.toolName?.(update) ?? update.title)
            ? { name: settings.toolName?.(update) ?? update.title } : {}),
          ...(Object.hasOwn(update, 'rawInput') ? { input: update.rawInput } : {}),
          ...(Object.hasOwn(update, 'rawOutput') ? { output: update.rawOutput } :
            ['completed', 'failed'].includes(value.status) && Array.isArray(update.content)
              ? { output: update.content } : {}) },
      })
    }
  }
  const cancel = () => {
    if (peer && sessionId && active && !ended)
      void peer.send({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId } }).catch(() => {})
  }
  io.signal.addEventListener('abort', cancel, { once: true })
  try {
    io.signal.throwIfAborted()
    peer = await io.openStdio(settings.argv(config), {
      env: config.env,
      cwd: config.project,
      onMessage: receive,
    })
    for (const message of early.splice(0)) {
      // It was already supplied to telemetry before the peer became available.
      if (message.id !== undefined)
        await peer.send({
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32601, message: 'Client not initialized' },
        })
    }
    const initialized = await peer.request(
      'initialize',
      {
        protocolVersion: 1,
        clientCapabilities: settings.clientCapabilities ?? {},
        clientInfo: { name: 'dsh-cliworker-now', version: '0.8.1' },
      },
      { jsonrpc: true },
    )
    if (initialized?.protocolVersion !== 1) throw new Error('Unsupported ACP protocol version')
    let state
    if (config.conversationId) {
      if (initialized.agentCapabilities?.loadSession !== true)
        throw new Error('ACP cannot restore the existing session')
      sessionId = config.conversationId
      state = await peer.request(
        'session/load',
        { sessionId, cwd: config.project, mcpServers: nativeHarnessMcpServers(config) },
        { jsonrpc: true },
      )
      if (state?.sessionId !== undefined && state.sessionId !== sessionId)
        throw new Error('ACP restored a different session')
    } else {
      state = await peer.request('session/new', { cwd: config.project, mcpServers: nativeHarnessMcpServers(config) }, { jsonrpc: true })
      if (!nonempty(state?.sessionId)) throw new Error('ACP did not return a session identity')
      sessionId = state.sessionId
    }
    state = await selectOption(peer, sessionId, state, 'model', config.preference.model, settings.encode)
    if (config.preference.effort !== 'default')
      state = await selectOption(
        peer,
        sessionId,
        state,
        settings.effortId,
        config.preference.effort === 'none' ? settings.off : config.preference.effort,
        settings.encode,
      )
    if (wantedMode && settings.modeConfigId) {
      state = await selectOption(peer, sessionId, state, settings.modeConfigId, wantedMode, settings.encode)
    } else if (wantedMode && state?.modes?.currentModeId !== wantedMode) {
      if (!state?.modes?.availableModes?.some((mode) => mode.id === wantedMode))
        throw new Error('ACP does not advertise the selected permission mode')
      await peer.request('session/set_mode', { sessionId, modeId: wantedMode }, { jsonrpc: true })
    }
    io.signal.throwIfAborted()
    if (failure) throw new Error(failure)
    io.session(sessionId, config.preference.model)
    await settings.onReady?.(state, sessionId, io)
    io.signal.throwIfAborted()
    io.event({ kind: 'status', text: `${settings.name} 原生模型已确认` })
    active = true
    const result = await peer.request(
      'session/prompt',
      {
        sessionId,
        prompt: [{ type: 'text', text: config.prompt }],
      },
      { jsonrpc: true, timeoutMs: config.timeoutMs },
    )
    ended = true
    // Kimi emits its context snapshot asynchronously AFTER settling prompt.
    // Give that optional native receipt a bounded drain before closing stdio.
    if (settings.awaitPostPromptUsage && peer.waitFor && !io.signal.aborted)
      await peer.waitFor((message) => message.method === 'session/update' &&
        message.params?.sessionId === sessionId &&
        message.params?.update?.sessionUpdate === 'usage_update',
      { timeoutMs: Math.min(config.timeoutMs ?? 15000, 1000) }).catch(() => {})
    finishThought()
    responses?.finish(undefined, false)
    if (result?.sessionId !== undefined && result.sessionId !== sessionId)
      throw new Error('ACP prompt session changed')
    await settings.onResult?.(result, sessionId, io)
    if (result?.stopReason !== 'end_turn')
      fail(`CLI 未成功完成（${String(result?.stopReason ?? 'missing terminal')}）`)
    if ([...tools.values()].some((tool) => !['completed', 'failed'].includes(tool.status)))
      fail('CLI 工具缺少终态')
    if (io.signal.aborted) fail('任务已停止')
    io.result(
      failure ? 'ERROR' : response ? 'SUCCESS' : 'UNCERTAIN',
      response,
      failure ?? (response ? undefined : 'CLI 未返回可核查的本轮正文'),
      'run',
    )
  } finally {
    io.signal.removeEventListener('abort', cancel)
    active = false
    if (peer) {
      peer.end()
      await peer.close()
    }
  }
}
