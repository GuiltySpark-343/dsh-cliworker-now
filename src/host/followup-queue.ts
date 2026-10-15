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
})
const queueSchema = z.object({
  policy: z.literal(1),
  items: z.array(itemSchema).max(20),
  receipts: z.array(z.object({ id: z.uuid(), digest: z.string() })).max(200),
})
type StoredQueue = z.infer<typeof queueSchema>

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
    return structuredClone(this.queues.get(workerId)?.items ?? [])
  }
  add(workerId: string, prompt: string, requestId: string): QueuedFollowup {
    z.uuid().parse(requestId)
    if (!prompt.trim() || prompt.length > 100_000) throw new Error('消息须包含 1–100000 个字符')
    const queue = structuredClone(
      this.queues.get(workerId) ?? { policy: 1 as const, items: [], receipts: [] },
    )
    const digest = createHash('sha256').update(prompt).digest('hex')
    const previous = queue.receipts.find((receipt) => receipt.id === requestId)
    if (previous) {
      if (previous.digest !== digest) throw new Error('重复提交标识对应的消息不同')
      const item = queue.items.find((item) => item.id === requestId)
      if (!item) throw new Error('这条消息已经处理，请刷新会话')
      return structuredClone(item)
    }
    if (queue.items.length >= 20) throw new Error('最多可保留 20 条待发送消息，请先发送或取消')
    const paused = queue.items.find((item) => item.state === 'paused')
    const item: QueuedFollowup = {
      id: requestId,
      prompt,
      createdAt: new Date().toISOString(),
      state: paused ? 'paused' : 'pending',
      ...(paused ? { pauseReason: paused.pauseReason } : {}),
    }
    queue.items.push(item)
    queue.receipts = [...queue.receipts, { id: requestId, digest }].slice(-200)
    this.save(workerId, queue)
    return structuredClone(item)
  }
  remove(workerId: string, id: string): void {
    const queue = structuredClone(this.queues.get(workerId))
    if (!queue || !queue.items.some((item) => item.id === id))
      throw new Error('消息已发送或已取消，请刷新会话')
    queue.items = queue.items.filter((item) => item.id !== id)
    this.save(workerId, queue)
  }
  update(workerId: string, state: 'pending' | 'paused', pauseReason?: string): void {
    const queue = structuredClone(this.queues.get(workerId))
    if (!queue?.items.length) return
    queue.items = queue.items.map((item) => ({ ...item, state, pauseReason }))
    this.save(workerId, queue)
  }
  claim(workerId: string): QueuedFollowup | undefined {
    const queue = structuredClone(this.queues.get(workerId))
    const item = queue?.items[0]
    if (!queue || item?.state !== 'pending') return undefined
    item.state = 'sending'
    this.save(workerId, queue)
    return structuredClone(item)
  }
}
