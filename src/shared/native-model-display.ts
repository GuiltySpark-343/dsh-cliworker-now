import type { CliId } from './types.ts'

/** An observed native ID only. Missing providers stay undisclosed. */
export function nativeModelDisplay(cli: CliId, observed: unknown): string | undefined {
  if (typeof observed !== 'string' || !observed.trim() || observed.length > 1024 || /[\x00-\x1f\x7f]/.test(observed)) return
  let model = observed.trim(), provider: string | undefined
  if (cli === 'hermes') {
    try {
      const pair: unknown = JSON.parse(model)
      if (!Array.isArray(pair) || pair.length !== 2 || pair.some(v => typeof v !== 'string' || !v.trim() || /[\x00-\x1f\x7f]/.test(v))) return
      ;[provider, model] = pair as [string, string]
    } catch { /* Older native receipts may expose only the model ID. */ }
  }
  if (!provider && ['omp', 'pi', 'zcode', 'opencode', 'mimo'].includes(cli) && model.includes('/')) {
    const slash = model.indexOf('/')
    provider = model.slice(0, slash); model = model.slice(slash + 1)
    if (!provider || !model) return
  }
  return `${cli}/${provider ?? '未公开'}/${model}`
}
