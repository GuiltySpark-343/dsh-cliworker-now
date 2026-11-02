import { afterEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { copyFileSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { HermesSessionTelemetryReader, hermesSessionTelemetry } from '../src/host/hermes-session-telemetry.ts'
import { TelemetryReader, extractTelemetry } from '../src/host/telemetry.ts'
import { nativeTokenUsage } from '../src/client/harness-telemetry-data.ts'
import { nativeUsageReport } from '../src/shared/native-usage-report.ts'
import { createHash } from 'node:crypto'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cwn-hermes-statistics-SIMULATED-')))
  roots.push(root)
  const db = new DatabaseSync(join(root, 'state.db'))
  db.exec(`CREATE TABLE sessions(id TEXT PRIMARY KEY, source TEXT, cwd TEXT, input_tokens INTEGER,
    output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER, reasoning_tokens INTEGER)`)
  db.prepare('INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?)')
    .run('synthetic-session', 'oneshot', root, 8160, 93, 416, 0, 92)
  db.close()
  return { root, reader: new HermesSessionTelemetryReader() }
}
function inventory(root: string) {
  return readdirSync(root).sort().map((name) => ({ name,
    sha256: createHash('sha256').update(readFileSync(join(root, name))).digest('hex'),
  }))
}
describe('Hermes real-protocol accounting regression (synthetic private records)', () => {
  it('keeps positive legacy cache buckets and treats normalized zero as unknown', () => {
    const { root } = fixture()
    const path = join(root, 'synthetic.raw.jsonl')
    writeFileSync(path, [
      { type: 'system', subtype: 'init', session_id: 'synthetic-session', model: 'synthetic' },
      { type: 'result', session_id: 'synthetic-session', tokens:
        { input: 3673, output: 4, total: 3901, cache_read: 224, cache_write: 0 } },
    ].map((value) => JSON.stringify(value)).join('\n') + '\n')
    const telemetry = new TelemetryReader().read(path, 'hermes', { conversationId: 'synthetic-session' })
    expect(telemetry.usage).toEqual({ total: 3901, input: 3897, output: 4, cacheRead: 224, scope: 'run' })
    expect(nativeTokenUsage('hermes', telemetry.usage)).toBeUndefined()
    expect(nativeUsageReport('hermes', telemetry.usage)).toEqual({ totalTokens: 3901,
      inputTokens: 3897, inputBasis: 'inclusive', outputTokens: 4, cacheReadTokens: 224 })
    expect(telemetry.contextUsed).toBeUndefined()
  })
  it('does not apply legacy cache addition to HTTP inclusive prompt tokens', () => {
    const telemetry = extractTelemetry('hermes', [{ type: 'hermes.run', run_id: 'synthetic-run',
      session_id: 'synthetic-session', usage: { input_tokens: 3897, output_tokens: 4,
        total_tokens: 3901, cache_read_tokens: 224, cache_write_tokens: 0 } }], { conversationId: 'synthetic-session' })
    expect(telemetry.usage).toEqual({ total: 3901, input: 3897, output: 4, cacheRead: 224, scope: 'run' })
    expect(nativeTokenUsage('hermes', telemetry.usage)).toBeUndefined()
  })
  it.each(['foreign-session', null, undefined])('rejects an unbound legacy receipt: %s', (session_id) => {
    const result = extractTelemetry('hermes', [
      { type: 'system', subtype: 'init', session_id: 'synthetic-session' },
      { type: 'result', session_id, tokens: { input: 2, output: 1, cache_read: 0, cache_write: 0, total: 3 } },
    ], { conversationId: 'synthetic-session' })
    expect(result.usage).toBeUndefined()
  })
  it('reads only a bound session and refreshes cumulative native statistics without summing snapshots', () => {
    const { root, reader } = fixture()
    expect(reader.read(root, 'synthetic-session', 'oneshot', root)?.usage)
      .toEqual({ input: 8576, output: 93, total: 8669, cacheRead: 416, reasoning: 92, scope: 'session' })
    expect(reader.read(root, 'foreign-session', 'oneshot', root)).toBeUndefined()
    expect(reader.read(root, 'synthetic-session', 'api_server', root)).toBeUndefined()
    expect(reader.read(root, 'synthetic-session', 'oneshot', join(root, 'foreign'))).toBeUndefined()
    const db = new DatabaseSync(join(root, 'state.db'))
    db.exec('UPDATE sessions SET input_tokens = 9000')
    db.close()
    expect(reader.read(root, 'synthetic-session', 'oneshot', root)?.usage?.total).toBe(9509)
    expect(reader.read(root, 'synthetic-session', 'oneshot', root)?.usage?.total).toBe(9509)
    expect(reader.read(root, 'synthetic-session', 'oneshot', root)?.contextUsed).toBeUndefined()
  })
  it('rejects a linked database or unknown native numeric field instead of filling zero', () => {
    const { root, reader } = fixture()
    const actual = join(root, 'state.db')
    const other = fixture().root
    rmSync(join(other, 'state.db'))
    symlinkSync(actual, join(other, 'state.db'))
    expect(reader.read(other, 'synthetic-session', 'oneshot', root)).toBeUndefined()
    expect(hermesSessionTelemetry({ input_tokens: 1, output_tokens: 2, cache_read_tokens: 0 })).toBeUndefined()
  })
  it('does not recover a missing WAL shared-memory index or write any source files', () => {
    const source = fixture(), copied = fixture()
    const db = new DatabaseSync(join(source.root, 'state.db'))
    try {
      db.exec('PRAGMA journal_mode=WAL; UPDATE sessions SET input_tokens = 9000')
      // Simulate a crash-preserved WAL without an index using private files only.
      for (const name of ['state.db', 'state.db-wal']) copyFileSync(join(source.root, name), join(copied.root, name))
      const before = inventory(copied.root)
      expect(copied.reader.read(copied.root, 'synthetic-session', 'oneshot', source.root)).toBeUndefined()
      expect(inventory(copied.root)).toEqual(before)
    } finally { db.close() }
  })
  it('reads a checkpointed WAL-mode database without creating empty WAL or SHM files', () => {
    const f = fixture()
    const db = new DatabaseSync(join(f.root, 'state.db'))
    db.exec('PRAGMA journal_mode=WAL; UPDATE sessions SET input_tokens = 9000')
    db.close()
    expect(readdirSync(f.root)).toEqual(['state.db'])
    const before = inventory(f.root)
    expect(f.reader.read(f.root, 'synthetic-session', 'oneshot', f.root)?.usage?.total).toBe(9509)
    expect(inventory(f.root)).toEqual(before)
  })
  it('reads a live WAL receipt without changing the user database or shared-memory read marks', () => {
    const f = fixture()
    const db = new DatabaseSync(join(f.root, 'state.db'))
    try {
      db.exec('PRAGMA journal_mode=WAL; UPDATE sessions SET input_tokens = 9000')
      const before = inventory(f.root)
      expect(f.reader.read(f.root, 'synthetic-session', 'oneshot', f.root)?.usage?.total).toBe(9509)
      expect(inventory(f.root)).toEqual(before)
    } finally { db.close() }
  })
})
