/**
 * The URL cache: what a source resolved for one audio candidate on one network, handed out
 * again until shortly before the URLs expire. Memory only: an expired URL is never persisted.
 *
 * @module
 */

import { type AudioCandidate, candidateKey, type LadderRung, type StreamOption } from '@fxm/core'

/** One cached resolution. */
export interface CachedResolution {
  /** The options, best first, as the source returned them. */
  readonly options: readonly StreamOption[]
  /** When they were resolved, in epoch milliseconds. */
  readonly resolvedAt: number
  /** Until when they may be handed out, in epoch milliseconds (see `streamsUsableUntil`). */
  readonly usableUntil: number
}

/**
 * The key of one resolution: per network, per channel (the source that resolved it, or the
 * user's Invidious instance), per audio candidate (for YouTube, per videoId) and per rung of
 * the source's ladder.
 */
export function resolutionKey(
  network: string,
  channel: string,
  candidate: Pick<AudioCandidate, 'source' | 'ref'>,
  rung: LadderRung,
): string {
  return `${network}\u0000${channel}\u0000${candidateKey(candidate)}\u0000${rung}`
}

/** How many resolutions a {@link UrlCache} holds by default. */
export const URL_CACHE_SIZE = 256

/**
 * Resolutions by {@link resolutionKey}, each until its `usableUntil`. Past `maxEntries`, a new
 * entry first pushes out the stale ones, then the oldest.
 */
export class UrlCache {
  readonly #entries = new Map<string, CachedResolution>()
  readonly #maxEntries: number

  constructor(maxEntries = URL_CACHE_SIZE) {
    this.#maxEntries = Math.max(1, Math.floor(maxEntries))
  }

  /** How many resolutions it holds, stale ones included until they are looked up or pushed out. */
  get size(): number {
    return this.#entries.size
  }

  /** The resolution under `key` while it is still usable at `now`; a stale one is dropped. */
  get(key: string, now: number): CachedResolution | undefined {
    const entry = this.#entries.get(key)
    if (entry === undefined) return undefined
    if (now < entry.usableUntil) return entry
    this.#entries.delete(key)
    return undefined
  }

  /** Stores `entry` under `key`, unless it is unusable already or holds no options. */
  set(key: string, entry: CachedResolution): void {
    if (entry.options.length === 0 || entry.usableUntil <= entry.resolvedAt) return
    this.#entries.delete(key)
    this.#entries.set(key, entry)
    if (this.#entries.size <= this.#maxEntries) return
    for (const [old, cached] of this.#entries) {
      if (cached.usableUntil <= entry.resolvedAt) this.#entries.delete(old)
    }
    for (const old of this.#entries.keys()) {
      if (this.#entries.size <= this.#maxEntries) break
      this.#entries.delete(old)
    }
  }

  /** Drops the resolution under `key`. Returns whether there was one. */
  delete(key: string): boolean {
    return this.#entries.delete(key)
  }

  /** Drops every resolution. Returns how many there were. */
  clear(): number {
    const { size } = this.#entries
    this.#entries.clear()
    return size
  }
}
