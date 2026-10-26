/**
 * Diversity: maximal marginal relevance (MMR) re-ranking with a per-artist cap, so a list
 * doesn't turn into ten songs by one artist or ten songs that sound alike.
 *
 * MMR picks, one at a time, the item that maximizes
 *
 *     λ · relevance(item) − (1 − λ) · max similarity(item, picked)
 *
 * where relevance is the item's score scaled to 0–1 within the list. λ = 1 keeps the ranking as
 * it is; lower values trade relevance for variety. The cap is hard: an item none of whose
 * credited artists has reached it yet may join, the rest stay out. So does a second listing of a
 * song already picked (one sharing any of its keys): a list never holds a song twice.
 *
 * Everything is deterministic: ties go to the item that came first, so the same list always
 * gives the same result.
 *
 * @module
 */

import type { PooledSong } from './pool'

/** Options for {@link diversify}. */
export interface DiversifyOptions {
  /** How many items to pick at most. */
  readonly limit: number
  /** Relevance against variety, from 0 to 1. Default 0.7. */
  readonly lambda?: number
  /**
   * At most this many items per artist, counting every credited artist of an item. Default 2;
   * `Infinity` for no cap.
   */
  readonly perArtistCap?: number
  /** How alike two songs are, from 0 to 1. Default {@link songSimilarity}. */
  readonly similarity?: (a: PooledSong, b: PooledSong) => number
  /**
   * Items the list already holds, e.g. the favourites of a mix before its new songs: they count
   * toward the cap, are never picked again, and new items keep their distance from them too.
   */
  readonly after?: readonly { readonly song: PooledSong }[]
}

/** The default trade-off between relevance and variety. */
export const DEFAULT_MMR_LAMBDA = 0.7

/** The default most items per artist. */
export const DEFAULT_PER_ARTIST_CAP = 2

/** The Jaccard index of two lists of keys: shared over all, 0 when either is empty. */
function jaccard(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 || b.length === 0) return 0
  const left = new Set(a)
  let shared = 0
  const all = new Set(a)
  for (const key of b) {
    if (left.has(key)) shared++
    all.add(key)
  }
  return shared / all.size
}

/**
 * How alike two songs are, from 0 to 1: 1 for the same song or the same main artist, 0.7 for a
 * shared credited artist, and up to 0.5 for shared tags.
 */
export function songSimilarity(a: PooledSong, b: PooledSong): number {
  if (a.key === b.key || a.keys.some((key) => b.keys.includes(key))) return 1
  const mainA = a.artistKeys[0]
  if (mainA !== undefined && mainA === b.artistKeys[0]) return 1
  const shared = a.artistKeys.some((key) => b.artistKeys.includes(key)) ? 0.7 : 0
  return Math.max(shared, 0.5 * jaccard(a.tags, b.tags))
}

/**
 * An MMR pick in progress: {@link Picker.next} picks one item at a time, so several lists can
 * take turns drawing from one pool (see `draft` in `home.ts`).
 */
export interface Picker<T> {
  /**
   * Picks the next item: the best by MMR among the items not picked yet that fit the cap and
   * that `blocked` doesn't refuse. `undefined` when the list is full or nothing fits.
   */
  next(blocked?: (song: PooledSong) => boolean): T | undefined
  /** What it picked so far, in order. */
  readonly picked: readonly T[]
  /** Whether it holds `limit` items. */
  readonly full: boolean
}

/**
 * Starts an MMR pick over `items` (best first): see the module documentation.
 *
 * It does only the work a pick needs, so a long list costs little more than a short one: an
 * item's similarity to what the list holds is brought up to date only when the item is weighed,
 * and the search for the next pick stops at the first item that no later one can beat (an
 * item's value is at most `λ · relevance`). The picks are exactly those of weighing every item
 * every time.
 */
export function createPicker<T extends { readonly song: PooledSong; readonly score: number }>(
  items: readonly T[],
  options: DiversifyOptions,
): Picker<T> {
  const limit = Math.max(0, Math.floor(Number.isFinite(options.limit) ? options.limit : 0))
  const lambda = Math.min(1, Math.max(0, options.lambda ?? DEFAULT_MMR_LAMBDA))
  const cap = options.perArtistCap ?? DEFAULT_PER_ARTIST_CAP
  const similarity = options.similarity ?? songSimilarity

  const scores = items.map((item) => (Number.isFinite(item.score) ? item.score : -Infinity))
  const finite = scores.filter((score) => Number.isFinite(score))
  const max = finite.length === 0 ? 0 : Math.max(...finite)
  const min = finite.length === 0 ? 0 : Math.min(...finite)
  const span = max - min
  const relevance = scores.map((score) =>
    !Number.isFinite(score) ? 0 : span > 0 ? (score - min) / span : 1,
  )
  // The best relevance from each item on: no item from there can be worth more than λ times it.
  const bound = new Array<number>(items.length)
  for (let index = items.length - 1, best = 0; index >= 0; index--) {
    best = Math.max(best, relevance[index] as number)
    bound[index] = best
  }

  const picked: T[] = []
  const taken = new Set<number>()
  const pickedKeys = new Set<string>()
  const perArtist = new Map<string, number>()
  /** What the list holds: the songs it came with (`after`), then its picks. */
  const held: PooledSong[] = []
  /** Each item's highest similarity to the first `seen[index]` songs held. */
  const nearest = items.map(() => 0)
  const seen = items.map(() => 0)
  const fits = (item: T) =>
    !item.song.keys.some((key) => pickedKeys.has(key)) &&
    item.song.artistKeys.every((key) => (perArtist.get(key) ?? 0) < cap)
  const hold = (song: PooledSong) => {
    for (const key of song.keys) pickedKeys.add(key)
    for (const key of song.artistKeys) perArtist.set(key, (perArtist.get(key) ?? 0) + 1)
    held.push(song)
  }
  /** The item's highest similarity to every song held, brought up to date. */
  const nearestOf = (index: number) => {
    const song = (items[index] as T).song
    let near = nearest[index] as number
    for (let at = seen[index] as number; at < held.length; at++) {
      const alike = similarity(song, held[at] as PooledSong)
      if (alike > near) near = alike
    }
    nearest[index] = near
    seen[index] = held.length
    return near
  }
  for (const one of options.after ?? []) hold(one.song)

  return {
    picked,
    get full() {
      return picked.length >= limit
    },
    next(blocked) {
      if (picked.length >= limit) return undefined
      let best = -1
      let bestValue = -Infinity
      for (let index = 0; index < items.length; index++) {
        // Ties go to the earlier item, so nothing from here on can win.
        if (lambda * (bound[index] as number) <= bestValue) break
        const item = items[index] as T
        if (taken.has(index) || !fits(item) || blocked?.(item.song) === true) continue
        const value = lambda * (relevance[index] as number) - (1 - lambda) * nearestOf(index)
        if (value > bestValue) {
          best = index
          bestValue = value
        }
      }
      if (best < 0) return undefined
      const chosen = items[best] as T
      taken.add(best)
      picked.push(chosen)
      hold(chosen.song)
      return chosen
    },
  }
}

/**
 * Re-ranks `items` (best first) for variety, honouring the per-artist cap (see the module
 * documentation). Returns at most `limit` items.
 */
export function diversify<T extends { readonly song: PooledSong; readonly score: number }>(
  items: readonly T[],
  options: DiversifyOptions,
): T[] {
  const picker = createPicker(items, options)
  while (picker.next() !== undefined) {
    // Picks until the list is full or nothing fits.
  }
  return [...picker.picked]
}
