// Explicit offline protocol simulations. No private history, account, model call,
// inferred context categories, or synthetic final assistant reply is included.
const conversationId = 'SIMULATED-ten-cli-session'
const model = 'SIMULATED-provider/SIMULATED-model'
const separate = { total: 43, input: 12, output: 8, cacheRead: 20, cacheWrite: 3 }
const camel = { totalTokens: 43, inputTokens: 35, outputTokens: 8, cachedInputTokens: 20, cacheWriteInputTokens: 3, reasoningOutputTokens: 0 }
const categories = [{ name: 'System prompt', tokens: 10, kind: 'used' }, { name: 'System tools', tokens: 0, kind: 'used' }, { name: 'Messages', tokens: 25, kind: 'used' }]
const rows: any[] = [
  { cli: 'antigravity', transport: 'agy-stream-v1', records: [
    { event: 'init', conversation_id: conversationId },
    { event: 'step_update', conversation_id: conversationId, step_update: { step_type: 'agent_response', step_index: 0, state: 'DONE', usage: { input_tokens: 12, output_tokens: 8, cache_read_tokens: 20, total_tokens: 20 } } },
    { event: 'result', result: { conversation_id: conversationId, usage: { input_tokens: 12, output_tokens: 8, cache_read_tokens: 20, total_tokens: 20 } } },
  ], expected: { total: 20, nativeTotal: 40 } },
  { cli: 'codex', transport: 'codex-app-v1', records: [
    { method: 'thread/tokenUsage/updated', params: { threadId: conversationId, turnId: 'SIMULATED-turn', tokenUsage: { total: camel, last: { ...camel, totalTokens: 35, inputTokens: 30, outputTokens: 5 }, modelContextWindow: 1000 } } },
    { type: 'cliworker.codex_run_usage', sessionId: conversationId, turnId: 'SIMULATED-turn', usage: camel },
  ], expected: { total: 43, nativeTotal: 43, contextUsed: 35, contextCapacity: 1000 } },
  { cli: 'claude', transport: 'claude-stream-v1', records: [
    { type: 'result', session_id: conversationId, usage: { input_tokens: 12, output_tokens: 8, cache_read_input_tokens: 20, cache_creation_input_tokens: 3 } },
    { type: 'cliworker.context_inspection', cli: 'claude', source: 'claude.get_context_usage.summary', sessionId: conversationId, model, contextUsed: 35, contextCapacity: 1000, categories },
  ], expected: { total: 43, nativeTotal: 43, contextUsed: 35, contextCapacity: 1000, breakdown: { systemTokens: 10, toolsTokens: 0, messageTokens: 25 } } },
  { cli: 'kimi', transport: 'kimi-acp-v1', records: [
    { type: 'cliworker.kimi_usage', source: 'kimi.durable.main-wire', sessionId: conversationId, model, turnId: 'SIMULATED-turn', scope: 'run', usage: { inputOther: 12, output: 8, inputCacheRead: 20, inputCacheCreation: 3 } },
    { method: 'session/update', params: { sessionId: conversationId, update: { sessionUpdate: 'usage_update', used: 35, size: 1000 } } },
  ], expected: { total: 43, nativeTotal: 43, contextUsed: 35, contextCapacity: 1000 } },
  { cli: 'grok', transport: 'grok-acp-v1', records: [
    { type: 'cliworker.grok_prompt_usage', sessionId: conversationId, usageIsIncomplete: false, usage: { inputTokens: 35, outputTokens: 8, totalTokens: 43, cachedReadTokens: 20, cacheCreationTokens: 3, reasoningTokens: 0 } },
    { method: 'session/update', params: { sessionId: conversationId, update: { sessionUpdate: 'usage_update', used: 35, size: 1000 } } },
  ], expected: { total: 43, nativeTotal: 43, contextUsed: 35, contextCapacity: 1000 } },
  { cli: 'zcode', transport: 'zcode-app-v1', records: [
    { method: 'session/event', params: { sessionId: conversationId, type: 'turn.completed', payload: { usage: { totalTokens: 43, inputTokens: 35, outputTokens: 8, cacheReadTokens: 20, cacheWriteTokens: 3, reasoningTokens: 0 } } } },
    { result: { projection: { sessionId: conversationId, contextUsed: 35, contextWindow: 1000, totalTokenCount: 43 } } },
  ], expected: { total: 43, nativeTotal: 43, contextUsed: 35, contextCapacity: 1000 } },
]
for (const cli of ['mimo', 'opencode']) rows.push({ cli, transport: `${cli}-http-v1`, records: [
  { type: 'message.updated', properties: { info: { id: 'SIMULATED-message', sessionID: conversationId, role: 'assistant', finish: 'stop', providerID: 'SIMULATED-provider', modelID: 'SIMULATED-model', time: { completed: 2 }, tokens: { total: 43, input: 12, output: 3, reasoning: 5, cache: { read: 20, write: 3 } } } } },
  { type: 'cliworker.model_context', source: `${cli}.provider.limit.context`, providerID: 'SIMULATED-provider', modelID: 'SIMULATED-model', contextCapacity: 1000 },
], expected: { total: 43, nativeTotal: 43, contextUsed: cli === 'mimo' ? 32 : 35, contextCapacity: 1000 } })
for (const cli of ['pi', 'omp']) rows.push({ cli, transport: `${cli}-rpc-v1`, records: [
  { type: 'cliworker.rpc_response', cli, source: `${cli}.message_end`, sessionId: conversationId, responseId: 'SIMULATED-response', usage: separate },
  { type: 'cliworker.rpc_usage', cli, source: `${cli}.get_session_stats`, sessionId: conversationId, usage: separate, contextUsage: { tokens: 35, contextWindow: 1000 } },
  { type: 'cliworker.model_context', source: `${cli}.get_state.model.contextWindow`, providerID: 'SIMULATED-provider', modelID: 'SIMULATED-model', contextCapacity: 1000 },
  ...(cli === 'omp' ? [{ type: 'cliworker.context_inspection', cli, source: 'omp.native-context', sessionId: conversationId, contextUsed: 35, contextCapacity: 1000, categories: [{ name: 'Skills', tokens: 5, kind: 'used' }] }] : []),
], expected: { total: 43, nativeTotal: 43, contextUsed: 35, contextCapacity: 1000, ...(cli === 'omp' ? { partialCategories: true } : {}) } })
export const tenCliNativeParityFixtures = rows.map(row => ({ ...row, conversationId, model, identity: { conversationId, model } }))
