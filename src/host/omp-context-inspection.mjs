const count = value => Number.isSafeInteger(value) && value >= 0
const kinds = new Map([
  ['System prompt', 'used'], ['System tools', 'used'], ['System context', 'used'],
  ['Skills', 'used'], ['Messages', 'used'], ['Auto-compact buf', 'buffer'], ['Free', 'free'],
])

/** Only OMP's advertised builtin may be sent through the prompt RPC channel. */
export function hasOmpNativeContextCommand(commands) {
  if (!Array.isArray(commands) || commands.length > 4096) return false
  const matches = commands.filter(command => command?.name === 'context')
  return matches.length === 1 && matches[0].source === 'builtin' &&
    matches[0].description === 'Show context usage' && matches[0].input === undefined
}

/** Parse the installed OMP 16 native report. Counts remain native estimates. */
export function parseOmpNativeContextReport(text, contextUsage) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 32768) return
  const clean = text.replace(/\x1b\[[0-9;]*m/g, '')
  if (/[\x00-\x08\x0b-\x1f\x7f]/.test(clean)) return
  const lines = clean.trimEnd().split('\n')
  const header = /^Context window: ([1-9]\d*) tokens \((\d+)% used\)$/.exec(lines.shift() ?? '')
  if (!header) return // In particular, never accept the native null -> "Used: 0" fallback.
  const contextCapacity = Number(header[1]), percent = Number(header[2])
  if (!count(contextCapacity) || !count(percent)) return
  const categories = [], seen = new Set()
  let inSnapcompact = false
  for (const line of lines) {
    if (line.startsWith('Snapcompact')) { inSnapcompact = true; continue }
    if (inSnapcompact) continue // Native optional savings prose is not a context category.
    const row = /^  (System prompt|System tools|System context|Skills|Messages|Auto-compact buf|Free)\s+\[[█░]{24}\] (\d+)%\s+(\d+) tokens$/.exec(line)
    if (!row || seen.has(row[1])) return
    const tokens = Number(row[3]), barPercent = Number(row[2])
    if (!count(tokens) || !count(barPercent) || barPercent > 100) return
    seen.add(row[1])
    categories.push({ name: row[1], tokens, kind: kinds.get(row[1]) })
  }
  if (!categories.length) return
  // /context rounds the header percentage. Its categories need not close over
  // an anchored total, so never reverse-engineer used tokens from either one.
  const contextUsed = contextUsage?.contextWindow === contextCapacity && count(contextUsage.tokens)
    ? contextUsage.tokens : undefined
  if (contextUsed !== undefined && Math.round(contextUsed / contextCapacity * 100) !== percent) return
  return { contextCapacity, ...(contextUsed !== undefined ? { contextUsed } : {}),
    basis: 'native-estimate', categories }
}

/** Bounded, post-settlement metadata query; its output never enters chat. */
export class OmpContextInspection {
  constructor({ send, emit, done, timeoutMs = 750 }) {
    this.send = send; this.emit = emit; this.done = done; this.timeoutMs = timeoutMs
  }
  observeCommands(commands) { this.available = hasOmpNativeContextCommand(commands) }
  start(sessionId, contextUsage) {
    if (this.started) return
    this.started = true
    if (!this.available || typeof sessionId !== 'string' || !sessionId) { this.done(); return }
    this.sessionId = sessionId
    this.contextUsage = contextUsage
    this.active = true
    this.outputs = []
    this.timer = setTimeout(() => this.finish(), this.timeoutMs)
    this.send({ id: 'cliworker-context-inspection', type: 'prompt', message: '/context' })
  }
  consume(record) {
    if (record?.type === 'command_output') {
      if (this.active) this.outputs.push(record.text)
      return true
    }
    if (record?.type !== 'response' || record.id !== 'cliworker-context-inspection') return false
    if (this.active && record.command === 'prompt' && record.success === true &&
      record.data?.agentInvoked === false && this.outputs.length === 1) {
      const report = parseOmpNativeContextReport(this.outputs[0], this.contextUsage)
      if (report) this.emit({ type: 'cliworker.context_inspection', cli: 'omp',
        source: 'omp.native-context', sessionId: this.sessionId, ...report })
    }
    this.finish()
    return true
  }
  finish() {
    if (!this.active) return
    this.dispose()
    this.done()
  }
  dispose() { clearTimeout(this.timer); this.active = false; this.outputs = [] }
}
