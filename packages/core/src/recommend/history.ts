/**
 * De-duplicating recommendations against the listening history, across sessions: what the user
 * already knows or just heard doesn't come back as new (Bloomee repeats songs; FXM shouldn't).
 * A song counts as played on every source once it played on one, because the history is
 * matched by song identity as well as by track.
 *
 * @module
 */

import type { PooledSong } from './pool'
import type { TasteIndex } from './taste'

/** Which songs to leave out. Every rule that is set applies. */
export interface HistoryFilter {
  /** Leave out songs the user knows: played, liked or saved, as far as the profile tells. */
  readonly unheard?: boolean
  /** Leave out songs that started playing less than this many milliseconds ago. */
  readonly playedWithinMs?: number
  /** Leave out songs among the last this many plays ("no repeats within N tracks"). */
  readonly lastPlays?: number
  /** Leave out songs known by any of these keys, e.g. what another shelf already shows. */
  readonly exclude?: ReadonlySet<string>
}

/** Whether `song` passes `filter`. */
export function passesHistory(song: PooledSong, taste: TasteIndex, filter: HistoryFilter): boolean {
  const { exclude, unheard, playedWithinMs, lastPlays } = filter
  if (exclude !== undefined && song.keys.some((key) => exclude.has(key))) return false
  if (unheard === true && taste.known(song.keys)) return false
  if (playedWithinMs !== undefined && playedWithinMs > 0) {
    const at = taste.lastPlayedAt(song.keys)
    if (at !== undefined && taste.now - at < playedWithinMs) return false
  }
  if (lastPlays !== undefined && lastPlays > 0) {
    const ago = taste.playsAgo(song.keys)
    if (ago !== undefined && ago < lastPlays) return false
  }
  return true
}

/** The items whose song passes `filter`, in order. */
export function filterHistory<T extends { readonly song: PooledSong }>(
  items: readonly T[],
  taste: TasteIndex,
  filter: HistoryFilter,
): T[] {
  return items.filter((item) => passesHistory(item.song, taste, filter))
}
