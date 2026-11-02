import {
  existsSync,
  lstatSync,
  openSync,
  closeSync,
  fstatSync,
  fchmodSync,
  readSync,
  constants,
} from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { QueuedFollowup } from '../shared/types.ts'
import { atomicJSON, type WorkerStorage } from './storage.ts'

const itemSchema = z.object({
  id: z.uuid(),
  prompt: z.string().min(1).max(100_000),
  createdAt: z.string(),
  state: z.enum(['pending', 'sending', 'paused']),
  pauseReason: z.string().optional(),
  generation: z.number().int().nonnegative().default(0),
})
const queueSchema = z.object({
  policy: z.literal(1),
  generation: z.number().int().nonnegative().default(0),
  items: z.array(itemSchema).max(20),
  receipts: z
    .array(
      z.object({
        id: z.uuid(),
        digest: z.string(),
        delivery: z.literal('steer').optional(),
        acknowledged: z.boolean().optional(),
      }),
    )
    .max(200),
})
type StoredQueue = z.infer<typeof queueSchema>
const publicItem = ({ generation: _, ...item }: StoredQueue['items'][number]): QueuedFollowup =>
  structuredClone(item)

function readQueue(path: string): StoredQueue {
  const limit = 16_100_000
  const entry = lstatSync(path)
  if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1 || entry.size > limit)
    throw new Error('待发送消息存储无法核验')
  const handle = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const before = fstatSync(handle)
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      before.dev !== entry.dev ||
      before.ino !== entry.ino ||
      before.size > limit
    )
      throw new Error('待发送消息存储身份已变化')
    const bytes = Buffer.alloc(before.size + 1)
    let offset = 0
    while (offset < bytes.length) {
      const size = readSync(handle, bytes, offset, bytes.length - offset, null)
      if (!size) break
      offset += size
    }
    const after = fstatSync(handle),
      current = lstatSync(path)
    if (
      offset !== before.size ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      current.isSymbolicLink() ||
      current.nlink !== 1 ||
      after.nlink !== 1 ||
      current.dev !== before.dev ||
      current.ino !== before.ino ||
      current.size !== after.size ||
      current.mtimeMs !== after.mtimeMs
    )
      throw new Error('待发送消息存储读取期间发生变化')
    const queue = queueSchema.parse(JSON.parse(bytes.subarray(0, offset).toString('utf8')))
    fchmodSync(handle, 0o600)
    return queue
  } finally {
    closeSync(handle)
  }
}

/** Host-private outbox. Restart restores text but never restores execution authority. */
export class FollowupQueue {
  private queues = new Map<string, StoredQueue>()
  constructor(private storage: WorkerStorage) {
    for (const worker of storage.workers.values()) {
      const path = this.path(worker.id)
      if (!existsSync(path)) continue
      const queue = readQueue(path)
      for (const item of queue.items) {
        item.state = 'paused'
        item.pauseReason = 'Host 已重启，请确认后继续发送'
      }
      this.queues.set(worker.id, queue)
      this.save(worker.id, queue)
    }
  }
  private path(workerId: string): string {
    z.uuid().parse(workerId)
    return join(this.storage.directory, `${workerId}.followups.json`)
  }
  private save(workerId: string, queue: StoredQueue): void {
    atomicJSON(this.path(workerId), queueSchema.parse(queue))
    this.queues.set(workerId, queue)
  }
  list(workerId: string): QueuedFollowup[] {
    return (this.queues.get(workerId)?.items ?? []).map(publicItem)
  }
  generation(workerId: string): number {
    return this.queues.get(workerId)?.generation ?? 0
  }
  generationOf(workerId: string, id: string): number | undefined {
    return this.queues.get(workerId)?.items.find((item) => item.id === id)?.generation
  }
  advanceGeneration(workerId: string): number {
    const { previous, persistenceError } = this.revokeGeneration(workerId)
    if (persistenceError) throw persistenceError
    return previous
  }
  /**
   * Stop must not depend on disk. The in-memory generation advances first so
   * earlier items lose their sending eligibility; a failed write is returned
   * for the caller to report after cancellation has started.
   */
  revokeGeneration(workerId: string): { previous: number; persistenceError?: unknown } {
    const queue = structuredClone(
      this.queues.get(workerId) ?? { policy: 1 as const, generation: 0, items: [], receipts: [] },
    )
    const previous = queue.generation
    queue.generation++
    this.queues.set(workerId, queue)
    try {
      atomicJSON(this.path(workerId), queueSchema.parse(queue))
    } catch (persistenceError) {
      return { previous, persistenceError }
    }
    return { previous }
  }
  receipt(
    workerId: string,
    prompt: string,
    requestId: string,
  ): { delivery: 'queue' | 'steer'; item?: QueuedFollowup; acknowledged?: boolean } | undefined {
    z.uuid().parse(requestId)
    const queue = this.queues.get(workerId)
    const receipt = queue?.receipts.find((entry) => entry.id === requestId)
    const item = queue?.items.find((entry) => entry.id === requestId)
    if (!receipt) {
      if (!item) return undefined
      if (item.prompt !== prompt) throw new Error('重复提交标识对应的消息不同')
      return { delivery: 'queue', item: publicItem(item) }
    }
    if (receipt.digest !== createHash('sha256').update(prompt).digest('hex'))
      throw new Error('重复提交标识对应的消息不同')
    return {
      delivery: receipt.delivery ?? 'queue',
      acknowledged: receipt.acknowledged,
      item: item ? publicItem(item) : undefined,
    }
  }
  /** Reserve the identity before native delivery; an uncertain receipt must never be resent as a queue item. */
  recordSteering(workerId: string, prompt: string, requestId: string, acknowledged: boolean): void {
    const previous = this.receipt(workerId, prompt, requestId)
    if (previous && previous.delivery !== 'steer') throw new Error('这条消息已经排队，请刷新会话')
    const queue = structuredClone(
      this.queues.get(workerId) ?? { policy: 1 as const, generation: 0, items: [], receipts: [] },
    )
    const receipt = {
      id: requestId,
      digest: createHash('sha256').update(prompt).digest('hex'),
      delivery: 'steer' as const,
      acknowledged,
    }
    queue.receipts = [...queue.receipts.filter((entry) => entry.id !== requestId), receipt].slice(-200)
    this.save(workerId, queue)
  }
  forgetRejectedSteering(workerId: string, requestId: string): void {
    const queue = structuredClone(this.queues.get(workerId))
    const receipt = queue?.receipts.find((entry) => entry.id === requestId)
    if (!queue || receipt?.delivery !== 'steer' || receipt.acknowledged) return
    queue.receipts = queue.receipts.filter((entry) => entry.id !== requestId)
    this.save(workerId, queue)
  }
  add(workerId: string, prompt: string, requestId: string): QueuedFollowup {
    z.uuid().parse(requestId)
    if (!prompt.trim() || prompt.length > 100_000) throw new Error('消息须包含 1–100000 个字符')
    const queue = structuredClone(
      this.queues.get(workerId) ?? { policy: 1 as const, generation: 0, items: [], receipts: [] },
    )
    const digest = createHash('sha256').update(prompt).digest('hex')
    const pending = queue.items.find((item) => item.id === requestId)
    if (pending) {
      if (pending.prompt !== prompt) throw new Error('重复提交标识对应的消息不同')
      return publicItem(pending)
    }
    const previous = queue.receipts.find((receipt) => receipt.id === requestId)
    if (previous) {
      if (previous.digest !== digest) throw new Error('重复提交标识对应的消息不同')
      if (previous.delivery === 'steer') throw new Error('这条引导消息已经提交，请核查本轮记录')
      const item = queue.items.find((item) => item.id === requestId)
      if (!item) throw new Error('这条消息已经处理，请刷新会话')
      return publicItem(item)
    }
    if (queue.items.length >= 20) throw new Error('最多可保留 20 条待发送消息，请先发送或取消')
    const paused = queue.items.find((item) => item.state === 'paused' && item.generation === queue.generation)
    const item = {
      id: requestId,
      prompt,
      createdAt: new Date().toISOString(),
      state: paused ? ('paused' as const) : ('pending' as const),
      generation: queue.generation,
      ...(paused ? { pauseReason: paused.pauseReason } : {}),
    }
    queue.items.push(item)
    queue.receipts = [...queue.receipts, { id: requestId, digest }].slice(-200)
    this.save(workerId, queue)
    return publicItem(item)
  }
  /** Moving a message to durable conversation history consumes its outbox identity. */
  consume(workerId: string, prompt: string, requestId: string): void {
    const prior = this.receipt(workerId, prompt, requestId)
    if (prior?.delivery === 'steer') throw new Error('这条引导消息已经提交，请核查本轮记录')
    const queue = structuredClone(
      this.queues.get(workerId) ?? { policy: 1 as const, generation: 0, items: [], receipts: [] },
    )
    queue.items = queue.items.filter((item) => item.id !== requestId)
    if (!queue.receipts.some((receipt) => receipt.id === requestId))
      queue.receipts = [
        ...queue.receipts,
        { id: requestId, digest: createHash('sha256').update(prompt).digest('hex') },
      ].slice(-200)
    this.save(workerId, queue)
  }
  restoreStates(workerId: string, previous: QueuedFollowup[]): void {
    const queue = structuredClone(this.queues.get(workerId))
    if (!queue) return
    const originals = new Map(previous.map((item) => [item.id, item]))
    queue.items = queue.items.map((item) => {
      const prior = originals.get(item.id)
      return prior
        ? {
            ...item,
            state: prior.state === 'sending' ? ('pending' as const) : prior.state,
            pauseReason: prior.state === 'paused' ? prior.pauseReason : undefined,
          }
        : item
    })
    this.save(workerId, queue)
  }
  remove(workerId: string, id: string): void {
    const queue = structuredClone(this.queues.get(workerId))
    if (!queue || !queue.items.some((item) => item.id === id))
      throw new Error('消息已发送或已取消，请刷新会话')
    queue.items = queue.items.filter((item) => item.id !== id)
    this.save(workerId, queue)
  }
  update(
    workerId: string,
    state: 'pending' | 'paused',
    pauseReason?: string,
    throughGeneration = this.generation(workerId),
  ): void {
    const queue = structuredClone(this.queues.get(workerId))
    if (!queue?.items.length) return
    queue.items = queue.items.map((item) =>
      item.generation <= throughGeneration
        ? { ...item, state, pauseReason, ...(state === 'pending' ? { generation: queue.generation } : {}) }
        : item,
    )
    this.save(workerId, queue)
  }
  releaseClaim(workerId: string, id: string): void {
    const queue = structuredClone(this.queues.get(workerId))
    const item = queue?.items.find((entry) => entry.id === id)
    if (!queue || item?.state !== 'sending') return
    item.state = 'pending'
    this.save(workerId, queue)
  }
  /** Explicit interruption may activate one message without resuming an already paused queue. */
  promote(workerId: string, id: string, previous: QueuedFollowup[]): QueuedFollowup {
    const queue = structuredClone(this.queues.get(workerId))
    const item = queue?.items.find((entry) => entry.id === id)
    if (!queue || !item) throw new Error('消息已发送或已取消，请刷新会话')
    if (item.state === 'sending') throw new Error('消息正在发送，请稍后再试')
    const originals = new Map(previous.map((entry) => [entry.id, entry]))
    queue.items = queue.items
      .filter((entry) => entry.id !== id)
      .map((entry) => {
        const original = originals.get(entry.id)
        return original
          ? {
              ...entry,
              state: original.state === 'sending' ? 'pending' : original.state,
              pauseReason: original.state === 'paused' ? original.pauseReason : undefined,
            }
          : entry
      })
    item.state = 'pending'
    delete item.pauseReason
    queue.items.unshift(item)
    this.save(workerId, queue)
    return publicItem(item)
  }
  claim(workerId: string): QueuedFollowup | undefined {
    const queue = structuredClone(this.queues.get(workerId))
    const item = queue?.items.find((entry) => entry.state === 'pending')
    if (!queue || item?.state !== 'pending') return undefined
    item.state = 'sending'
    this.save(workerId, queue)
    return publicItem(item)
  }
}
