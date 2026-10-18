import { afterEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { copyFileSync, lstatSync, mkdtempSync, rmSync, readFileSync, realpathSync, symlinkSync, renameSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { createContext, runInContext, runInNewContext } from 'node:vm'
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript'
import { AgyContextReader, decodeAgyContext } from '../src/host/agy-context.ts'

// Synthetic protobuf/SQLite fixtures; no real conversations copied into tests.
const varint = (input: number | bigint): number[] => {
  let n = BigInt(input)
  const out: number[] = []
  do {
    out.push(Number(n & 127n) | (n > 127n ? 128 : 0))
    n >>= 7n
  } while (n)
  return out
}
const nested = (field: number, bytes: number[]) => [
  ...varint(field * 8 + 2),
  ...varint(bytes.length),
  ...bytes,
]
const blob = (used: number | bigint, capacity: number, extra: number[] = []) =>
  Uint8Array.from(nested(1, nested(9, nested(10, [8, ...varint(used), 32, ...varint(capacity), ...extra]))))
const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })))
function fixture(owner = id) {
  const directory = mkdtempSync(join(tmpdir(), 'cwn-context-'))
  dirs.push(directory)
  const path = join(directory, `${id}.db`)
  const db = new DatabaseSync(path)
  db.exec(
    'CREATE TABLE trajectory_meta(cascade_id TEXT); CREATE TABLE gen_metadata(idx INTEGER PRIMARY KEY, data BLOB);',
  )
  db.prepare('INSERT INTO trajectory_meta VALUES (?)').run(owner)
  db.prepare('INSERT INTO gen_metadata VALUES (?,?)').run(0, blob(28757, 256000))
  db.close()
  return { directory, path }
}
function coldWalFixture(checkpointed: boolean) {
  const source = fixture()
  const db = new DatabaseSync(source.path)
  const directory = mkdtempSync(join(tmpdir(), 'cwn-context-wal-'))
  dirs.push(directory)
  const path = join(directory, `${id}.db`)
  try {
    db.exec('PRAGMA journal_mode=WAL')
    db.prepare('INSERT INTO gen_metadata VALUES (?,?)').run(1, blob(120000, 256000))
    if (checkpointed) db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    // A closed historical CLI may leave WAL/SHM behind. Copy a consistent
    // synthetic snapshot while the source connection keeps its sidecars alive.
    for (const suffix of ['', '-wal', '-shm']) copyFileSync(source.path + suffix, path + suffix)
    utimesSync(`${path}-shm`, new Date(0), new Date(0))
  } finally { db.close() }
  return { directory, path }
}
function isolatedReader(directory: string, beforeStat?: (file: unknown) => void) {
  const exports: { AgyContextReader?: typeof AgyContextReader } = {}
  const nativeRequire = createRequire(import.meta.url)
  const realm = createContext({ exports, require: (name: string) => {
    if (name !== 'node:fs' || !beforeStat) return nativeRequire(name)
    return { ...nativeRequire(name), lstatSync: (file: Parameters<typeof lstatSync>[0]) => {
      beforeStat(file)
      return lstatSync(file)
    } }
  } })
  const source = readFileSync(new URL('../src/host/agy-context.ts', import.meta.url), 'utf8')
  runInContext(transpileModule(source, {
    compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 },
  }).outputText, realm)
  return new exports.AgyContextReader!(directory)
}
describe('Antigravity local context adapter', () => {
  it('decodes foreign-realm SQLite byte arrays including nested context groups', () => {
    const group = (type: number, tokens: number) => nested(1, [16, ...varint(type), 32, ...varint(tokens)])
    const bytes = blob(900, 10000, nested(3, [...group(1, 200), ...group(2, 300), ...group(7, 400)]))
    const foreign = runInNewContext('Uint8Array.from(bytes)', { bytes: Array.from(bytes) }) as Uint8Array
    expect(foreign instanceof Uint8Array).toBe(false)
    expect(decodeAgyContext(foreign)).toMatchObject({
      contextUsed: 900,
      contextCapacity: 10000,
      contextBreakdown: { systemTokens: 200, toolTokens: 300, messageTokens: 400 },
    })
  })
  it('reads actual native SQLite blobs from an isolated module realm without changing the database', () => {
    const { directory, path } = fixture()
    const before = readFileSync(path)
    const exports: { AgyContextReader?: typeof AgyContextReader } = {}
    const realm = createContext({ exports, require: createRequire(import.meta.url), sample: blob(1, 100) })
    expect(runInContext('sample instanceof Uint8Array', realm)).toBe(false)
    const source = readFileSync(new URL('../src/host/agy-context.ts', import.meta.url), 'utf8')
    const compiled = transpileModule(source, {
      compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 },
    }).outputText
    runInContext(compiled, realm)
    const reader = new exports.AgyContextReader!(directory)
    expect(reader.read(id)).toMatchObject({ contextUsed: 28757, contextCapacity: 256000 })
    expect(reader.read(id)).toMatchObject({ contextUsed: 28757, contextCapacity: 256000 })
    expect(readFileSync(path)).toEqual(before)
  })
  it('decodes verified fields and labels estimates without model-name guessing', () => {
    expect(decodeAgyContext(blob(28757, 256000))).toMatchObject({
      contextUsed: 28757,
      contextCapacity: 256000,
      contextEstimated: true,
    })
    expect(decodeAgyContext(blob(0, 256000))?.contextUsed).toBe(0)
  })
  it('projects only explicit native group types, preserving partial categories and zero counts', () => {
    const group = (type: number, tokens: number | bigint) =>
      nested(1, [16, ...varint(type), 32, ...varint(tokens)])
    const extra = nested(3, [...group(1, 14769), ...group(2, 12950), ...group(7, 1985), ...group(3, 99)])
    expect(decodeAgyContext(blob(29704, 256000, extra))?.contextBreakdown).toMatchObject({
      systemTokens: 14769,
      toolTokens: 12950,
      messageTokens: 1985,
      estimated: true,
    })
    const partial = decodeAgyContext(blob(29704, 256000, nested(3, group(1, 0))))?.contextBreakdown
    expect(partial?.systemTokens).toBe(0)
    expect(partial?.toolTokens).toBeUndefined()
    expect(partial?.messageTokens).toBeUndefined()
    expect(
      decodeAgyContext(blob(1, 256000, nested(3, group(1, 18446744073709551615n))))?.contextBreakdown,
    ).toBeUndefined()
  })
  it('ignores unrelated signed uint64 fields but rejects invalid metrics and malformed data', () => {
    expect(decodeAgyContext(blob(42, 256000, [16, ...varint(18446744073709551615n)]))?.contextUsed).toBe(42)
    expect(decodeAgyContext(blob(18446744073709551615n, 256000))).toBeUndefined()
    expect(decodeAgyContext(blob(10, 0))).toBeUndefined()
    expect(decodeAgyContext(Uint8Array.of(10, 255))).toBeUndefined()
    expect(decodeAgyContext(Uint8Array.of(8, 10))).toBeUndefined()
    for (const value of [
      new Uint16Array(blob(42, 100)),
      new DataView(blob(42, 100).buffer),
      { ...blob(42, 100), length: 100, [Symbol.toStringTag]: 'Uint8Array' },
    ]) expect(decodeAgyContext(value as unknown as Uint8Array)).toBeUndefined()
  })
  it('reads matching conversation metadata without modifying the database', () => {
    const { directory, path } = fixture()
    const before = readFileSync(path)
    const reader = new AgyContextReader(directory)
    expect(reader.read(id)?.contextUsed).toBe(28757)
    expect(reader.read(id)?.contextCapacity).toBe(256000)
    expect(readFileSync(path)).toEqual(before)
  })
  it.each([true, false])('reads a cold WAL snapshot despite SQLite updating SHM read marks (checkpointed=%s)', (checkpointed) => {
    const { directory, path } = coldWalFixture(checkpointed)
    const before = { main: readFileSync(path), wal: readFileSync(`${path}-wal`), shm: lstatSync(`${path}-shm`) }
    expect(before.wal.length === 0).toBe(checkpointed)
    const reader = new AgyContextReader(directory)
    expect(reader.read(id)).toMatchObject({ contextUsed: 120000, contextCapacity: 256000 })
    const afterShm = lstatSync(`${path}-shm`)
    expect(afterShm.ino).toBe(before.shm.ino)
    expect(afterShm.size).toBe(before.shm.size)
    expect(afterShm.mtimeMs).not.toBe(before.shm.mtimeMs)
    expect(readFileSync(path)).toEqual(before.main)
    expect(readFileSync(`${path}-wal`)).toEqual(before.wal)
    expect(reader.read(id)).toMatchObject({ contextUsed: 120000, contextCapacity: 256000 })
  })
  it.each([false, true])('rejects a database generation changed during a read (WAL=%s)', (wal) => {
    const { directory, path } = fixture()
    const writer = new DatabaseSync(path)
    const canonicalPath = realpathSync(path)
    let statCount = 0
    try {
      if (wal) writer.exec('PRAGMA journal_mode=WAL')
      const before = readFileSync(path)
      const reader = isolatedReader(directory, (file) => {
        // A real concurrent write between the SELECT and final file check.
        if (file === canonicalPath && ++statCount === 2)
          writer.prepare('INSERT INTO gen_metadata VALUES (?,?)').run(1, blob(120000, 256000))
      })
      expect(reader.read(id)).toBeUndefined()
      if (wal) expect(readFileSync(path)).toEqual(before)
      expect(reader.read(id)).toMatchObject({ contextUsed: 120000, contextCapacity: 256000 })
    } finally { writer.close() }
  })
  it('refuses mismatched ownership, invalid paths and missing files', () => {
    const { directory } = fixture('ffffffff-bbbb-cccc-dddd-eeeeeeeeeeee')
    const reader = new AgyContextReader(directory)
    expect(reader.read(id)).toBeUndefined()
    expect(reader.read('../private')).toBeUndefined()
    expect(reader.read()).toBeUndefined()
    expect(reader.read('ffffffff-bbbb-cccc-dddd-eeeeeeeeeeee')).toBeUndefined()
  })
  it('refuses linked database and WAL/SHM sidecars instead of following an external target', () => {
    const { directory, path } = fixture()
    const moved = `${path}.original`
    renameSync(path, moved)
    symlinkSync(moved, path)
    expect(new AgyContextReader(directory).read(id)).toBeUndefined()
    rmSync(path)
    renameSync(moved, path)
    symlinkSync(path, `${path}-wal`)
    expect(new AgyContextReader(directory).read(id)).toBeUndefined()
    rmSync(`${path}-wal`)
    symlinkSync(path, `${path}-shm`)
    expect(new AgyContextReader(directory).read(id)).toBeUndefined()
  })
  it('refreshes after new metadata and never substitutes stale data for an invalid latest request', () => {
    const { directory, path } = fixture()
    const reader = new AgyContextReader(directory)
    expect(reader.read(id)?.contextUsed).toBe(28757)
    const db = new DatabaseSync(path)
    db.prepare('INSERT INTO gen_metadata VALUES (?,?)').run(
      1,
      blob(120000, 256000, new Array(2000).fill([24, 1]).flat()),
    )
    expect(reader.read(id)?.contextUsed).toBe(120000)
    db.prepare('INSERT INTO gen_metadata VALUES (?,?)').run(2, new Uint8Array(9000))
    expect(reader.read(id)).toBeUndefined()
    db.close()
  })
})
