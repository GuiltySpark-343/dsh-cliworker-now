import { runNativeAcp } from './native-acp.mjs'
import { readQoderDurableContextAsync } from './qoder-durable-context.mjs'

/** Qoder's ACP uses acceptEdits; its CLI flag spelling is accept_edits. */
export const qoderAcpArgv = (config) => {
  if (config.mode !== 'accept-edits')
    throw new Error('Qoder 当前 ACP 未公开只读规划模式，无法安全执行规划任务')
  // Model is selected and confirmed again through ACP before prompt admission.
  return [...config.argv]
}

export const runNativeQoder = (config, io) =>
  runNativeAcp(config, io, {
    name: 'Qoder',
    argv: qoderAcpArgv,
    effortId: 'reasoning_effort',
    off: 'none',
    editMode: 'acceptEdits',
    modeConfigId: 'mode',
    encode: (value) => value,
    toolName: (update) => update._meta?.qoder?.toolName ?? update.title,
    onResult: async (result, sessionId, nativeIo) => {
      const usage = qoderPromptUsage(result?.usage)
      if (result?.stopReason === 'end_turn' && usage)
        nativeIo.native({
          type: 'cliworker.qoder_prompt_usage',
          sessionId,
          model: config.preference.model,
          usage,
        })
      if (result?.stopReason === 'end_turn') {
        const context = await readQoderDurableContextAsync({ home: config.env?.QODER_CONFIG_DIR, project: config.project,
          sessionId, model: config.preference.model, userMessageId: result.userMessageId }, { signal: nativeIo.signal })
        if (context) nativeIo.native(context)
      }
    },
  })

/** Aggregate prompt accounting only; Qoder supplies no response/cache/context breakdown here. */
export function qoderPromptUsage(value) {
  if (
    !value ||
    !['inputTokens', 'outputTokens', 'totalTokens'].every(
      (key) => Number.isSafeInteger(value[key]) && value[key] >= 0,
    ) ||
    value.totalTokens !== value.inputTokens + value.outputTokens ||
    // Official Qoder routes mask all token counts as zero. ACP supplies no
    // disclosure flag, so a zero triple cannot establish a real zero bill.
    value.totalTokens === 0
  )
    return
  return { inputTokens: value.inputTokens, outputTokens: value.outputTokens, totalTokens: value.totalTokens }
}
