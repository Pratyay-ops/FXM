/**
 * A small in-memory cache with per-entry lifetimes, an injectable clock and a size bound, which
 * also shares one load between concurrent callers of the same key. Failures are never cached.
 *
 * @module
 */

import { isFxmError } from '@fxm/core'

/** Options for {@link TtlCache}. */
export interface TtlCacheOptions {
  /** The clock, as epoch milliseconds. Default `Date.now`. */
  now?: () => number
  /** The most entries kept; the oldest go first. Default 500. */
  maxEntries?: number
}

interface Entry {
  value: unknown
  expiresAt: number
}

/** An in-memory cache whose entries expire. */
export class TtlCache {
  readonly #now: () => number
  readonly #maxEntries: number
  readonly #entries = new Map<string, Entry>()
  readonly #loading = new Map<string, Promise<unknown>>()

  constructor(options: TtlCacheOptions = {}) {
    this.#now = options.now ?? Date.now
    this.#maxEntries = options.maxEntries ?? 500
  }

  /** The fresh value under `key`, or `undefined`. */
  get<V>(key: string): V | undefined {
    const entry = this.#entries.get(key)
    if (!entry) return undefined
    if (this.#now() >= entry.expiresAt) {
      this.#entries.delete(key)
      return undefined
    }
    return entry.value as V
  }

  /** Stores `value` under `key` for `ttlMs` (nothing is stored when `ttlMs` is not positive). */
  set(key: string, value: unknown, ttlMs: number): void {
    this.#entries.delete(key)
    if (!(ttlMs > 0)) return
    this.#entries.set(key, { value, expiresAt: this.#now() + ttlMs })
    while (this.#entries.size > this.#maxEntries) {
      const oldest = this.#entries.keys().next()
      if (oldest.done) break
      this.#entries.delete(oldest.value)
    }
  }

  /** Removes `key`. */
  delete(key: string): void {
    this.#entries.delete(key)
  }

  /** Removes every key that starts with `prefix`, or everything without one. */
  clear(prefix?: string): void {
    for (const key of [...this.#entries.keys()]) {
      if (prefix === undefined || key.startsWith(prefix)) this.#entries.delete(key)
    }
    for (const key of [...this.#loading.keys()]) {
      if (prefix === undefined || key.startsWith(prefix)) this.#loading.delete(key)
    }
  }

  /**
   * The fresh value under `key`, else the result of `load`, stored for `ttlMs`. Concurrent calls
   * for one key share a single load. When a shared load fails with something other than an
   * `FxmError` (the abort of the caller that started it) while `signal` has not aborted, this
   * caller loads again with its own `load`.
   */
  async getOrLoad<V>(
    key: string,
    ttlMs: number,
    load: () => Promise<V>,
    signal?: AbortSignal,
  ): Promise<V> {
    const hit = this.get<V>(key)
    if (hit !== undefined) return hit
    const shared = this.#loading.get(key) as Promise<V> | undefined
    if (shared) {
      try {
        return await shared
      } catch (error) {
        if (isFxmError(error) || signal?.aborted) throw error
      }
    }
    const promise = load().then((value) => {
      if (this.#loading.get(key) === promise) this.set(key, value, ttlMs)
      return value
    })
    this.#loading.set(key, promise)
    const settle = () => {
      if (this.#loading.get(key) === promise) this.#loading.delete(key)
    }
    promise.then(settle, settle)
    return promise
  }
}
