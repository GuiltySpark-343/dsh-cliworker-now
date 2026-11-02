import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { dirname } from 'node:path'
import { safePiOmpAncestors } from './pi-omp-native.ts'

/** Hash current bounded own files without retaining file content or following links. */
export async function metadataFileFingerprint(
  path: string,
  signal: AbortSignal,
): Promise<string | undefined> {
  let file: Awaited<ReturnType<typeof open>> | undefined
  let bytes: Buffer | undefined
  try {
    signal.throwIfAborted()
    await safePiOmpAncestors(dirname(path))
    const before = await lstat(path)
    if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1 || before.size > 1_048_576) return
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const opened = await file.stat()
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.nlink !== 1 ||
      opened.size !== before.size ||
      opened.size > 1_048_576 ||
      opened.mtimeMs !== before.mtimeMs
    )
      return
    bytes = Buffer.alloc(opened.size + 1)
    let offset = 0
    while (offset < bytes.length) {
      signal.throwIfAborted()
      const read = await file.read(bytes, offset, bytes.length - offset, offset)
      if (!read.bytesRead) break
      offset += read.bytesRead
    }
    const after = await file.stat(),
      current = await lstat(path)
    signal.throwIfAborted()
    if (
      current.isSymbolicLink() ||
      current.dev !== opened.dev ||
      current.ino !== opened.ino ||
      current.nlink !== 1 ||
      offset !== opened.size ||
      after.size !== opened.size ||
      current.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs ||
      current.mtimeMs !== opened.mtimeMs ||
      after.ctimeMs !== opened.ctimeMs ||
      current.ctimeMs !== opened.ctimeMs
    )
      return
    return createHash('sha256').update(bytes.subarray(0, offset)).digest('hex')
  } catch (error) {
    signal.throwIfAborted()
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : undefined
  } finally {
    bytes?.fill(0)
    await file?.close()
  }
}

/** Callers admit only validated public capabilities, never account status or raw CLI output. */
export class NativeCapabilityCache<T> {
  private readonly entries = new Map<string, { created: number; value: T }>()
  constructor(
    private readonly ttlMs = 30_000,
    private readonly limit = 16,
  ) {}
  get(key: string | undefined): T | undefined {
    if (!key) return
    const entry = this.entries.get(key),
      now = Date.now()
    if (!entry) return
    if (now < entry.created || now - entry.created >= this.ttlMs) {
      this.entries.delete(key)
      return
    }
    return structuredClone(entry.value)
  }
  set(key: string | undefined, value: T): void {
    if (!key) return
    const now = Date.now()
    for (const [id, entry] of this.entries)
      if (now < entry.created || now - entry.created >= this.ttlMs) this.entries.delete(id)
    this.entries.delete(key)
    this.entries.set(key, { created: now, value: structuredClone(value) })
    while (this.entries.size > this.limit) this.entries.delete(this.entries.keys().next().value!)
  }
}
