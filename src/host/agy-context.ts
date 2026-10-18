import { DatabaseSync } from 'node:sqlite'
import { lstatSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { types } from 'node:util'
import type { Telemetry } from '../shared/telemetry.ts'

// Verified against Antigravity CLI 1.2.16 and 1.3.6's embedded protobuf descriptors:
// CortexStepGeneratorMetadata.chat_model(1) -> ChatModelMetadata.chat_start_metadata(9)
// -> ChatStartMetadata.context_window_metadata(10) -> estimated_tokens_used(1), max_context_tokens(4).
// field 3 is TokenBreakdown.groups(1): TopLevelTokenGroup.type(2), num_tokens(4).
// TokenType: 1 SYSTEM_PROMPT, 2 TOOLS, 7 CHAT_MESSAGES. Other groups stay unclassified.
// This is a version-specific, optional local adapter, never a guessed model capacity.
function fields(bytes: Uint8Array): Map<number, (number | Uint8Array)[]> {
  let offset = 0
  const result = new Map<number, (number | Uint8Array)[]>()
  const add = (field: number, value: number | Uint8Array) => {
    const entries = result.get(field) ?? []
    entries.push(value)
    result.set(field, entries)
  }
  const integer = (allowUnsafe = false) => {
    let value = 0n
    for (let shift = 0n; shift < 70n; shift += 7n) {
      if (offset >= bytes.length) throw new Error('Truncated protobuf')
      const byte = bytes[offset++]!
      value |= BigInt(byte & 127) << shift
      if (byte < 128) {
        if (!allowUnsafe && value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Unsafe integer')
        return Number(value)
      }
    }
    throw new Error('Invalid varint')
  }
  while (offset < bytes.length) {
    const tag = integer(),
      field = Math.floor(tag / 8),
      wire = tag & 7
    if (!field) throw new Error('Invalid field')
    if (wire === 0) add(field, integer(true))
    else {
      const length = wire === 2 ? integer() : wire === 1 ? 8 : wire === 5 ? 4 : -1
      if (length < 0 || offset + length > bytes.length) throw new Error('Invalid field length')
      if (wire === 2) add(field, bytes.subarray(offset, offset + length))
      offset += length
    }
  }
  return result
}
export function decodeAgyContext(data: Uint8Array): Telemetry | undefined {
  try {
    // Native SQLite can return bytes owned by another JS realm. Intrinsic
    // type checks accept those bytes without accepting other views or objects.
    if (!types.isUint8Array(data) || data.length > 8 * 1024 * 1024) return
    let value = data
    for (const key of [1, 9, 10]) {
      const nested = fields(value).get(key)?.at(-1)
      if (!types.isUint8Array(nested)) return
      value = nested
    }
    const context = fields(value),
      used = context.get(1)?.at(-1),
      capacity = context.get(4)?.at(-1)
    if (
      typeof used !== 'number' ||
      typeof capacity !== 'number' ||
      !Number.isSafeInteger(used) ||
      !Number.isSafeInteger(capacity) ||
      used < 0 ||
      capacity <= 0
    )
      return
    const result: Telemetry = {
      contextUsed: used,
      contextCapacity: capacity,
      contextEstimated: true,
      contextSource: 'Antigravity 最近一次请求的本地上下文估算',
      contextCapacitySource: 'Antigravity 原生会话窗口',
    }
    const breakdown = context.get(3)?.at(-1)
    if (types.isUint8Array(breakdown)) {
      const groups = fields(breakdown).get(1) ?? []
      if (groups.length > 1024) return result
      const counts = new Map<number, number>()
      for (const group of groups) {
        if (!types.isUint8Array(group)) continue
        const values = fields(group),
          type = values.get(2)?.at(-1),
          tokens = values.get(4)?.at(-1) ?? 0
        if (typeof type !== 'number' || ![1, 2, 7].includes(type)) continue
        if (typeof tokens !== 'number' || !Number.isSafeInteger(tokens) || tokens < 0) continue
        const total = (counts.get(type) ?? 0) + tokens
        if (!Number.isSafeInteger(total)) return result
        counts.set(type, total)
      }
      if (counts.size)
        result.contextBreakdown = {
          ...(counts.has(1) ? { systemTokens: counts.get(1) } : {}),
          ...(counts.has(2) ? { toolTokens: counts.get(2) } : {}),
          ...(counts.has(7) ? { messageTokens: counts.get(7) } : {}),
          estimated: true,
          source: 'Antigravity 原生上下文分类估算',
        }
    }
    return result
  } catch {
    return undefined
  }
}
export class AgyContextReader {
  private cache = new Map<string, { stamp: string; value?: Telemetry }>()
  constructor(private directory = join(homedir(), '.gemini', 'antigravity-cli', 'conversations')) {}
  read(conversationId?: string): Telemetry | undefined {
    if (!conversationId || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(conversationId)) return
    let path: string
    try {
      path = join(realpathSync(this.directory), `${conversationId}.db`)
    } catch {
      return
    }
    const stampOf = () => {
      if (realpathSync(path) !== resolve(path)) throw new Error('Linked context metadata')
      return [path, `${path}-wal`, `${path}-shm`]
        .map((file, index) => {
          try {
            const s = lstatSync(file)
            if (!s.isFile() || s.nlink !== 1 || s.size > 64 * 1024 * 1024)
              throw new Error('Invalid context metadata file')
            // SQLite read-only connections may update the SHM read marks.
            // Validate its identity and size, but only main/WAL timestamps
            // identify changes to the persistent database contents.
            return `${s.dev}:${s.ino}:${s.size}${index === 2 ? '' : `:${s.mtimeMs}`}`
          } catch (error) {
            if (index > 0 && (error as NodeJS.ErrnoException).code === 'ENOENT') return ''
            throw error
          }
        })
        .join('|')
    }
    let stamp: string
    try {
      stamp = stampOf()
    } catch {
      return
    }
    const cached = this.cache.get(conversationId)
    if (cached?.stamp === stamp) return cached.value
    let db: DatabaseSync | undefined, value: Telemetry | undefined
    try {
      db = new DatabaseSync(path, { readOnly: true })
      // Verify ownership before reading only this plugin-managed conversation's metadata.
      if (!db.prepare('SELECT 1 FROM trajectory_meta WHERE cascade_id = ? LIMIT 1').get(conversationId)) return
      const row = db
        .prepare(
          'SELECT CASE WHEN length(data) <= 8388608 THEN data END AS data FROM gen_metadata ORDER BY idx DESC LIMIT 1',
        )
        .get()
      if (types.isUint8Array(row?.data)) value = decodeAgyContext(row.data)
      if (stampOf() !== stamp) return
      this.cache.set(conversationId, { stamp, value })
      if (this.cache.size > 128) this.cache.delete(this.cache.keys().next().value!)
      return value
    } catch {
      return undefined
    } finally {
      db?.close()
    }
  }
}
