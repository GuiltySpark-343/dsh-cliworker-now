// Run-scoped, read-only observer of Pi's actual provider-facing transcript.
import { randomBytes } from 'node:crypto'
import { writeSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { inspectPiInstallation } from './pi-installation.mjs'

export const PI_CONTEXT_ENV = 'CWN_PI_CONTEXT_OBSERVER'
const count = value => Number.isSafeInteger(value) && value >= 0
const safeSum = values => {
  const total = values.reduce((sum, value) => sum + value, 0)
  return values.every(count) && count(total) ? total : undefined
}

/** Official estimates on the actual transcript; never subtract billing buckets. */
export function estimatePiContextCategories(messages, { estimateTokens, getCurrentSystemMessage }) {
  const roles = new Set(['system', 'user', 'assistant', 'custom', 'toolResult', 'bashExecution', 'branchSummary', 'compactionSummary'])
  if (!Array.isArray(messages) || messages.length > 100000 ||
    messages.some(message => !message || !roles.has(message.role))) return
  const system = getCurrentSystemMessage(messages)
  if (!system || system.role !== 'system') return
  const { toolsAdded, toolsRemoved: _removed, ...prompt } = system
  const systemTokens = estimateTokens(prompt)
  const toolTokens = estimateTokens({ role: 'system', content: '', timestamp: 0,
    ...(toolsAdded?.length ? { toolsAdded } : {}) })
  const messageTokens = safeSum(messages.filter(message => message.role !== 'system').map(estimateTokens))
  if (![systemTokens, toolTokens, messageTokens].every(count)) return
  return [
    { name: 'System prompt', tokens: systemTokens, kind: 'used' },
    { name: 'System tools', tokens: toolTokens, kind: 'used' },
    { name: 'Messages', tokens: messageTokens, kind: 'used' },
  ]
}

/** Optional capability discovery only, bound to the already selected Pi install. */
export async function preparePiContextObserver(executable) {
  try {
    const { dist, version } = inspectPiInstallation(executable)
    const types = await readFile(join(dist, 'core/extensions/types.d.ts'), 'utf8')
    if (!types.includes('type: "context_with_system"')) return { argv: [], env: {} }
    const estimator = join(dist, 'core/compaction/compaction.js')
    const require = createRequire(join(dist, 'index.js'))
    let transcript
    // Pi AI is import-only, so require.resolve() cannot resolve its public
    // entry. Follow Node's package lookup roots and verify the paired version.
    for (const directory of require.resolve.paths('@earendil-works/pi-ai') ?? []) {
      const packageRoot = join(directory, '@earendil-works/pi-ai')
      try {
        const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'))
        if (manifest.name !== '@earendil-works/pi-ai' || manifest.version !== version ||
          manifest.exports?.['.']?.import !== './dist/index.js') return { argv: [], env: {} }
        transcript = join(packageRoot, 'dist/utils/transcript.js')
        break
      } catch { /* Continue ordinary Node package lookup, never scan user data. */ }
    }
    if (!transcript) return { argv: [], env: {} }
    if (!(await stat(estimator)).isFile() || !(await stat(transcript)).isFile()) return { argv: [], env: {} }
    const nonce = randomBytes(24).toString('hex')
    return { nonce, argv: ['--extension', fileURLToPath(import.meta.url)], env: {
      [PI_CONTEXT_ENV]: JSON.stringify({ nonce, outputFd: 3, estimator: pathToFileURL(estimator).href, transcript: pathToFileURL(transcript).href }),
    } }
  } catch { return { argv: [], env: {} } }
}

/** No prompt, schema, credential, signature, or arbitrary field leaves the child. */
export function readPiContextObservation(record, { nonce, sessionId, provider, model, sequence, active }) {
  if (active !== true || !nonce || record?.type !== 'cliworker.pi_context_observation' || record.nonce !== nonce ||
    record.sessionId !== sessionId || record.provider !== provider || record.model !== model ||
    record.sequence !== sequence + 1 || !count(record.sequence) ||
    !count(record.contextCapacity) || record.contextCapacity <= 0) return
  if (record.categories !== null && (!Array.isArray(record.categories) || record.categories.length !== 3)) return
  const names = ['System prompt', 'System tools', 'Messages']
  if (record.categories?.some((row, index) => row?.name !== names[index] || row.kind !== 'used' || !count(row.tokens))) return
  return { type: 'cliworker.context_inspection', cli: 'pi', source: 'pi.context_with_system',
    sessionId, provider, model, requestId: `${sessionId}:context:${record.sequence}`,
    basis: 'native-estimate', contextCapacity: record.contextCapacity,
    categories: record.categories === null ? null : record.categories.map(({ name, tokens, kind }) => ({ name, tokens, kind })) }
}

export function registerPiContextObserver(api, primitives, nonce, emit) {
  let sequence = 0
  api.on('context_with_system', (event, context) => {
    try {
      if (context.mode !== 'rpc' || !context.model ||
        !count(context.model.contextWindow) || context.model.contextWindow <= 0) return
      const sessionId = context.sessionManager.getSessionId(), provider = context.model.provider, model = context.model.id
      if (typeof sessionId !== 'string' || !sessionId || typeof provider !== 'string' || !provider ||
        typeof model !== 'string' || !model) return
      const requestSequence = ++sequence
      // An exact new request must invalidate earlier categories even when its
      // transcript cannot be estimated. Unknown is explicit, never silence/0.
      let categories = null
      try { categories = estimatePiContextCategories(event.messages, primitives) ?? null } catch {}
      emit({ type: 'cliworker.pi_context_observation', nonce, sequence: requestSequence, sessionId,
        provider, model,
        contextCapacity: context.model.contextWindow, categories })
    } catch { /* Optional estimates cannot modify or fail a provider request. */ }
    // No return value: Pi keeps precisely the same transcript objects.
  })
}

export default async function piContextObserver(api) {
  // RPC stdout is guarded before extensions load. Use the dedicated Host
  // pipe, never stdout/stderr, user messages or persistent session entries.
  try {
    const config = JSON.parse(process.env[PI_CONTEXT_ENV] ?? 'null')
    if (!config || config.outputFd !== 3 || !/^[a-f0-9]{48}$/.test(config.nonce) ||
      !config.estimator?.startsWith('file:') || !config.transcript?.startsWith('file:')) return
    const { estimateTokens } = await import(config.estimator)
    const { getCurrentSystemMessage } = await import(config.transcript)
    if (typeof estimateTokens !== 'function' || typeof getCurrentSystemMessage !== 'function') return
    registerPiContextObserver(api, { estimateTokens, getCurrentSystemMessage }, config.nonce,
      record => writeSync(config.outputFd, JSON.stringify(record) + '\n'))
  } catch { /* Older installations keep their existing unknown categories. */ }
}
