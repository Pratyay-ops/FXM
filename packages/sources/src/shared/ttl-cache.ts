/**
 * Small in-memory caches for the free-source providers: {@link TtlCache} keeps values for a
 * while, and {@link LoadCache} also shares one in-flight request between callers, so a search
 * that expands an item and a resolve of one of its tracks fetch the item once.
 *
 * They live only as long as the page or app, which is all the caching Jamendo's API terms allow
 * ("to the extent reasonably necessary") and all MusicBrainz and Internet Archive need.
 *
 * @module
 */

/** Settings of a {@link TtlCache} or {@link LoadCache}. */
export interface CacheOptions {
  /** At most this many entries; the least recently used one goes first. */
  maxEntries: number
  /** The clock, in epoch milliseconds. `Date.now` by default; tests pass a fake one. */
  now?: () => number
}

/** A map whose entries expire, capped in size. */
export class TtlCache<V> {
  private readonly entries = new Map<string, { value: V; expiresAt: number }>()
  private readonly now: () => number

  constructor(private readonly options: CacheOptions) {
    this.now = options.now ?? Date.now
  }

  /** The live value for `key`, which then counts as recently used, or `undefined`. */
  get(key: string): V | undefined {
    const entry = this.entries.get(key)
    if (entry === undefined) return undefined
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key)
      return undefined
    }
    this.entries.delete(key)
    this.entries.set(key, entry)
    return entry.value
  }

  /** The value for `key`, live or not, without touching its place in the queue. */
  peek(key: string): V | undefined {
    return this.entries.get(key)?.value
  }

  /** Keeps `value` for `ttlMs` milliseconds. A lifetime of 0 or less removes the key. */
  set(key: string, value: V, ttlMs: number): void {
    this.entries.delete(key)
    if (!(ttlMs > 0)) return
    this.entries.set(key, { value, expiresAt: this.now() + ttlMs })
    for (const oldest of this.entries.keys()) {
      if (this.entries.size <= this.options.maxEntries) break
      this.entries.delete(oldest)
    }
  }

  /** Forgets `key`. */
  delete(key: string): void {
    this.entries.delete(key)
  }

  /** Forgets everything. */
  clear(): void {
    this.entries.clear()
  }

  /** How many entries are stored, expired ones included until they are next read. */
  get size(): number {
    return this.entries.size
  }
}

/** Marks a load that failed because the caller who started it cancelled it. */
class LoadCancelled extends Error {
  override readonly name = 'LoadCancelled'
}

/** `promise`, or a rejection with `signal`'s reason as soon as it aborts, whichever comes first. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return promise
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason)
    if (signal.aborted) {
      onAbort()
      return
    }
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

/**
 * A {@link TtlCache} of loads: the first caller of a key starts the load, and everyone asking
 * for the same key meanwhile waits for that same promise. A failed load is forgotten at once,
 * so the next caller tries again. When the caller who started a load cancels it, the callers
 * still waiting start their own instead of failing with someone else's cancellation.
 */
export class LoadCache<V> {
  private readonly cache: TtlCache<Promise<V>>

  constructor(options: CacheOptions) {
    this.cache = new TtlCache(options)
  }

  /**
   * The value for `key`: cached, in flight, or from `load`, kept for `ttlMs` from the start of
   * the load. Rejects with `signal`'s reason as soon as the caller cancels, even while waiting
   * for a load someone else started, which then goes on for the others.
   */
  async get(key: string, ttlMs: number, load: () => Promise<V>, signal?: AbortSignal): Promise<V> {
    for (;;) {
      signal?.throwIfAborted()
      let entry = this.cache.get(key)
      if (entry === undefined) {
        const started = new Promise<V>((resolve) => resolve(load())).catch((error: unknown) => {
          throw signal?.aborted ? new LoadCancelled('The load was cancelled') : error
        })
        entry = started
        this.cache.set(key, started, ttlMs)
        started.catch(() => {
          if (this.cache.peek(key) === started) this.cache.delete(key)
        })
      }
      try {
        return await untilAborted(entry, signal)
      } catch (error) {
        if (signal?.aborted) throw signal.reason
        if (error instanceof LoadCancelled) continue
        throw error
      }
    }
  }

  /** Forgets `key`, e.g. after the source said the cached data is stale. */
  delete(key: string): void {
    this.cache.delete(key)
  }

  /** Forgets everything. */
  clear(): void {
    this.cache.clear()
  }
}
