import { DatabaseSync } from 'node:sqlite'
import { chmodSync, copyFileSync, lstatSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, parse, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Telemetry } from '../shared/telemetry.ts'
import { hermesTokenUsage } from './hermes-adapter.ts'
import { hermesCanonicalUsage } from './hermes-canonical-usage.ts'

const count = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

/** Hermes CanonicalUsage input excludes cache; its session row stores these exact buckets. */
export function hermesSessionTelemetry(row: Record<string, unknown>): Telemetry | undefined {
  const buckets = [row.input_tokens, row.output_tokens, row.cache_read_tokens, row.cache_write_tokens]
  if (!buckets.every(count)) return
  const total = buckets.reduce((sum, value) => sum + value, 0)
  if (!count(total)) return
  const usage = hermesTokenUsage({ total, input: row.input_tokens, output: row.output_tokens,
    cache_read: row.cache_read_tokens, cache_write: row.cache_write_tokens })
  if (!usage) return
  // No context or per-response counts exist in this resource. In particular,
  // a stored model name can predate a resumed run and cannot supply a capacity.
  return { usage: { ...hermesCanonicalUsage(usage), scope: 'session',
    ...(count(row.reasoning_tokens) && row.reasoning_tokens <= (row.output_tokens as number)
      ? { reasoning: row.reasoning_tokens } : {}) } }
}

/** Exact-session, bounded statistics. Only numeric columns are queried or retained. */
export class HermesSessionTelemetryReader {
  private cache = new Map<string, { stamp: string; value?: Telemetry }>()
  read(home: string, sessionId: string | undefined, source: 'oneshot' | 'api_server', project: string): Telemetry | undefined {
    if (!isAbsolute(home) || !sessionId || !/^[A-Za-z0-9_-]{1,256}$/.test(sessionId)) return
    const directory = resolve(home), path = join(directory, 'state.db')
    const stampOf = () => {
      // A private path must not be redirected through any ancestor or sidecar.
      for (let parent = directory; parent !== parse(parent).root; parent = dirname(parent)) {
        const info = lstatSync(parent)
        if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Linked Hermes statistics directory')
      }
      if (realpathSync(path) !== path) throw new Error('Linked Hermes statistics database')
      const files = [path, `${path}-wal`, `${path}-shm`].map((file, index) => {
        try {
          const info = lstatSync(file)
          if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 128 * 1024 * 1024)
            throw new Error('Invalid Hermes statistics file')
          return `${info.dev}:${info.ino}:${info.size}${index === 2 ? '' : `:${info.mtimeMs}:${info.ctimeMs}`}`
        } catch (error) {
          if (index && (error as NodeJS.ErrnoException).code === 'ENOENT') return ''
          throw error
        }
      })
      // SQLite may create the shared-memory index even for a readOnly connection.
      // Statistics are optional: do not recover it in the user's live directory.
      if (files[1] && !files[2]) throw new Error('Hermes WAL has no shared-memory index')
      return { stamp: files.join('|'), wal: !!files[1] }
    }
    let db: DatabaseSync | undefined
    let snapshot: string | undefined
    try {
      const observed = stampOf(), stamp = observed.stamp, key = JSON.stringify([path, sessionId, source, project])
      const previous = this.cache.get(key)
      if (previous?.stamp === stamp) return previous.value
      // A checkpointed WAL-mode main file also creates empty WAL/SHM files on
      // ordinary readOnly open. With no WAL present, immutable reads the main
      // file without side effects; the before/after stamps still reject races.
      // SQLite even updates read marks in an existing live SHM on readOnly
      // connections. Read a private transient DB/WAL copy instead, and never
      // open the user's live WAL database. No history/config rows are queried.
      let readPath = path
      if (observed.wal) {
        snapshot = mkdtempSync(join(tmpdir(), 'cliworker-hermes-statistics-'))
        chmodSync(snapshot, 0o700)
        readPath = join(snapshot, 'state.db')
        copyFileSync(path, readPath)
        chmodSync(readPath, 0o600)
        copyFileSync(`${path}-wal`, `${readPath}-wal`)
        chmodSync(`${readPath}-wal`, 0o600)
        if (stampOf().stamp !== stamp) return
      }
      const checkpoint = pathToFileURL(path)
      checkpoint.search = 'mode=ro&immutable=1'
      db = new DatabaseSync(observed.wal ? readPath : checkpoint.href, { readOnly: true })
      db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=50')
      const row = db.prepare(`SELECT id, source, cwd, input_tokens, output_tokens,
        cache_read_tokens, cache_write_tokens, reasoning_tokens
        FROM sessions WHERE id = ? LIMIT 1`).get(sessionId)
      if (!row || row.id !== sessionId || row.source !== source ||
        (typeof row.cwd === 'string' && row.cwd && resolve(row.cwd) !== resolve(project))) return
      const value = hermesSessionTelemetry(row)
      if (stampOf().stamp !== stamp) return
      this.cache.set(key, { stamp, value })
      if (this.cache.size > 64) this.cache.delete(this.cache.keys().next().value!)
      return value
    } catch {
      return undefined
    } finally {
      try { db?.close() } finally {
        if (snapshot) rmSync(snapshot, { recursive: true, force: true })
      }
    }
  }
}
