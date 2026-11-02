type Query = (signal: AbortSignal) => Promise<void>
type Running = { controller: AbortController; query: Query }

/** Bounds dialog requests. Host owns process cleanup, including after RPC cancellation. */
export class AccountQueryQueue<Key extends string> {
  private readonly waiting = new Map<Key, Query>()
  private readonly running = new Map<Key, Running>()
  private priority?: Key

  constructor(private readonly limit = 2) {}

  has(key: Key): boolean {
    // A cancelled request can still occupy a slot while a fresh read waits behind it.
    const current = this.running.get(key)
    return this.waiting.has(key) || !!(current && !current.controller.signal.aborted)
  }

  enqueue(key: Key, query: Query, replace = false): boolean {
    if (this.has(key) && !replace) return false
    if (replace) this.running.get(key)?.controller.abort()
    this.waiting.set(key, query)
    this.drain()
    return true
  }

  prioritize(key: Key): void {
    this.priority = key
    this.drain()
  }

  cancel(key: Key): void {
    this.waiting.delete(key)
    this.running.get(key)?.controller.abort()
  }

  clear(): void {
    this.waiting.clear()
    for (const current of this.running.values()) current.controller.abort()
  }

  private drain(): void {
    // Reprioritize queued reads without aborting in-flight work: Gateway
    // cancellation is not an acknowledgement that Host process cleanup is done.
    while (this.running.size < this.limit) {
      const key =
        this.priority !== undefined && this.waiting.has(this.priority) && !this.running.has(this.priority)
          ? this.priority
          : [...this.waiting.keys()].find((candidate) => !this.running.has(candidate))
      if (key === undefined) return
      const query = this.waiting.get(key)!
      this.waiting.delete(key)
      const current = { query, controller: new AbortController() }
      this.running.set(key, current)
      void Promise.resolve()
        .then(() => (current.controller.signal.aborted ? undefined : query(current.controller.signal)))
        .catch(() => undefined)
        .finally(() => {
          if (this.running.get(key) === current) this.running.delete(key)
          this.drain()
        })
    }
  }
}
