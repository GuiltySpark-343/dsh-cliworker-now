import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync, type Stats } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import type { Worker, WorkerEvent } from '../shared/types.ts'

const object = (value: unknown): Record<string, any> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : undefined
const uuid = /^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i
const maxBytes = 16 * 1024 * 1024
const stamp = (value: Stats) =>
  `${value.dev}:${value.ino}:${value.nlink}:${value.size}:${value.mtimeMs}:${value.ctimeMs}`

/** Repair only the old HTTP bridge's provable single-part projection, never its stored text. */
function provesSinglePart(records: readonly unknown[], events: readonly WorkerEvent[]): boolean {
  const chunks: string[] = [], messages = new Map<string, Record<string, any>>()
  const parts = new Map<string, Record<string, any>>()
  let sessionId: string | undefined, final: Record<string, any> | undefined, boundaryAfterText = false
  for (const record of records) {
    const frame = object(record)
    if (!frame || final) return false
    if (frame.type === 'session') {
      if (typeof frame.id !== 'string' || !frame.id || (sessionId && sessionId !== frame.id)) return false
      sessionId = frame.id
    } else if (frame.type === 'event' && frame.event?.kind === 'assistant') {
      if (boundaryAfterText) return false
      if (typeof frame.event.text !== 'string' || frame.event.step !== undefined) return false
      chunks.push(frame.event.text)
    } else if (frame.type === 'event' && ['tool', 'reasoning'].includes(frame.event?.kind) && chunks.length) {
      boundaryAfterText = true
    } else if (frame.type === 'native') {
      const native = object(frame.record)
      const info = native?.type === 'message.updated' ? object(native.properties?.info) : undefined
      if (info?.role === 'assistant') {
        if (typeof info.id !== 'string' || !info.id || info.sessionID !== sessionId) return false
        const previous = messages.get(info.id)
        if (previous && (previous.parentID !== info.parentID || previous.sessionID !== info.sessionID)) return false
        messages.set(info.id, info)
      }
      const part = native?.type === 'message.part.updated' ? object(native.properties?.part) : undefined
      if (part?.type === 'text') {
        if (typeof part.id !== 'string' || !part.id || typeof part.text !== 'string' || part.sessionID !== sessionId)
          return false
        const previous = parts.get(part.id)
        if (previous && (previous.messageID !== part.messageID || !part.text.startsWith(previous.text))) return false
        parts.set(part.id, part)
      }
    } else if (frame.type === 'result') final = frame
  }
  if (!sessionId || messages.size !== 1 || parts.size !== 1 || final?.status !== 'SUCCESS') return false
  const message = [...messages.values()][0]!, part = [...parts.values()][0]!
  const text = chunks.join('')
  return chunks.length === events.length && events.every((event, index) => event.text === chunks[index]) &&
    typeof message.parentID === 'string' && !!message.parentID && message.finish === 'stop' &&
    Number.isFinite(message.time?.completed) && !message.error &&
    part.messageID === message.id && Number.isFinite(part.time?.end) &&
    !!text && text === part.text && text === final.response
}

/** Bounded, identity-bound read cache. No writes, prompt requests, or guessed adjacent-message merges. */
export class NativeTimelineReprojector {
  private cache = new Map<string, { stamp: string; events: string; proven: boolean }>()
  project(
    worker: Pick<Worker, 'id' | 'transport' | 'preference'>,
    events: readonly WorkerEvent[],
    rawPath: (runId: string) => string,
  ): readonly WorkerEvent[] {
    const cli = worker.preference.cli
    if (!['opencode', 'mimo'].includes(cli ?? '') || worker.transport !== `${cli}-http-v1`) return events
    const runs = new Map<string, WorkerEvent[]>()
    for (const event of events) if (event.kind === 'assistant') {
      const list = runs.get(event.runId) ?? []
      list.push(event)
      runs.set(event.runId, list)
    }
    const proven = new Set<string>()
    let budget = maxBytes
    for (const [runId, assistants] of [...runs].reverse().slice(0, 16)) {
      if (!uuid.test(runId) || assistants.length < 2 || assistants.some((event) => event.step !== undefined)) continue
      const runEvents = events.filter((event) => event.runId === runId)
      if (runEvents.some((event) => ['tool', 'reasoning'].includes(event.kind) &&
        event.seq > assistants[0]!.seq && event.seq < assistants.at(-1)!.seq)) continue
      const terminal = runEvents.findLast((event) => event.kind === 'status')
      const result = runEvents.findLast((event) => event.kind === 'result')
      if ((terminal?.state ?? terminal?.text) !== 'completed' || result?.state !== 'SUCCESS' ||
        result.text !== assistants.map((event) => event.text).join('')) continue
      const key = `${worker.id}:${runId}`
      let descriptor: number | undefined
      try {
        const path = rawPath(runId), before = lstatSync(path)
        if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > budget ||
          realpathSync(dirname(path)) !== resolve(dirname(path))) continue
        const signature = createHash('sha256').update(JSON.stringify(assistants.map(({ seq, text }) => [seq, text]))).digest('hex')
        const identity = stamp(before), cached = this.cache.get(key)
        if (cached?.stamp === identity && cached.events === signature) {
          if (cached.proven) proven.add(runId)
          continue
        }
        budget -= before.size
        descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
        const opened = fstatSync(descriptor)
        if (!opened.isFile() || opened.nlink !== 1 || stamp(opened) !== identity) continue
        const bytes = Buffer.alloc(before.size + 1)
        let length = 0
        while (length < bytes.length) {
          const size = readSync(descriptor, bytes, length, bytes.length - length, null)
          if (!size) break
          length += size
        }
        if (length !== before.size || stamp(fstatSync(descriptor)) !== identity || stamp(lstatSync(path)) !== identity) continue
        const text = bytes.subarray(0, length).toString('utf8')
        if (!text.endsWith('\n')) continue
        const lines = text.slice(0, -1).split('\n')
        if (lines.length > 30_000 || lines.some((line) => Buffer.byteLength(line) > 1024 * 1024)) continue
        const valid = provesSinglePart(lines.map((line) => JSON.parse(line)), assistants)
        this.cache.set(key, { stamp: identity, events: signature, proven: valid })
        if (this.cache.size > 64) this.cache.delete(this.cache.keys().next().value!)
        if (valid) proven.add(runId)
      } catch {
        // Incomplete/untrusted history must remain readable in its original form.
      } finally {
        if (descriptor !== undefined) closeSync(descriptor)
      }
    }
    return proven.size ? events.map((event) => event.kind === 'assistant' && proven.has(event.runId)
      ? { ...event, step: 0 } : event) : events
  }
}
