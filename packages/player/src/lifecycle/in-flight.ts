/**
 * Shared in-flight work: callers that ask for the same thing while it is being fetched wait for
 * the same promise instead of fetching it again.
 *
 * @module
 */

interface Entry<V> {
  readonly promise: Promise<V>
  readonly controller: AbortController
  waiters: number
}

/**
 * Runs one piece of work per key at a time and shares its result with every caller that asks
 * for the same key meanwhile. Each caller can give up on its own signal; the work itself is
 * aborted only when every caller waiting for it has given up.
 */
export class InFlight<V> {
  readonly #entries = new Map<string, Entry<V>>()

  /** How many keys have work in flight. */
  get size(): number {
    return this.#entries.size
  }

  /**
   * The result of the work under `key`: joins the work in flight, or starts it with `start`.
   * Rejects with `signal.reason` when the caller's signal aborts first.
   */
  run(key: string, signal: AbortSignal, start: (signal: AbortSignal) => Promise<V>): Promise<V> {
    if (signal.aborted) return Promise.reject(signal.reason)
    const entry = this.#entries.get(key) ?? this.#start(key, start)
    entry.waiters += 1
    return new Promise<V>((resolve, reject) => {
      let settled = false
      const leave = (): boolean => {
        if (settled) return false
        settled = true
        entry.waiters -= 1
        signal.removeEventListener('abort', onAbort)
        return true
      }
      const onAbort = () => {
        if (!leave()) return
        if (entry.waiters === 0) {
          if (this.#entries.get(key) === entry) this.#entries.delete(key)
          entry.controller.abort(signal.reason)
        }
        reject(signal.reason)
      }
      signal.addEventListener('abort', onAbort, { once: true })
      entry.promise.then(
        (value) => {
          if (leave()) resolve(value)
        },
        (error: unknown) => {
          if (leave()) reject(error)
        },
      )
    })
  }

  /**
   * Forgets the work in flight, so later callers start afresh: e.g. after the network changed,
   * when its results would belong to the old one. Callers already waiting still get them.
   */
  clear(): void {
    this.#entries.clear()
  }

  #start(key: string, start: (signal: AbortSignal) => Promise<V>): Entry<V> {
    const controller = new AbortController()
    const promise = new Promise<V>((resolve) => {
      resolve(start(controller.signal))
    })
    const entry: Entry<V> = { promise, controller, waiters: 0 }
    this.#entries.set(key, entry)
    const forget = () => {
      if (this.#entries.get(key) === entry) this.#entries.delete(key)
    }
    promise.then(forget, forget)
    return entry
  }
}
