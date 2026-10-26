/**
 * The rules of merging a backup into the library, as pure functions: what wins when a record is
 * both here and in the backup. The repository applies them inside the restore transaction
 * (`restore(tables, 'merge')` in `repo.ts`).
 *
 * - A playlist that is in both keeps the name and order of its newer edit, followed by the
 *   tracks only the other one has; each track keeps the earlier of its two added dates.
 * - The list of playlists keeps the order it has here, and the backup's playlists it lacks
 *   follow at the end.
 * - In the match cache a user's pin wins, then the newer decision.
 * - Two plays of the same track at the same moment are the same play.
 *
 * @module
 */

import { type EntityId, entityKey } from '@fxm/core'
import type { HistoryEntry, MatchCacheRecord, PlaylistRecord } from './types'

/** `first`, then the items of `second` it lacks, by `entityKey`. */
export function unionOrder<K extends string>(first: readonly K[], second: readonly K[]): K[] {
  const seen = new Set(first.map((id) => entityKey(id as unknown as EntityId)))
  const extra = second.filter((id) => {
    const key = entityKey(id as unknown as EntityId)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  return [...first, ...extra]
}

/** One playlist that is here and in the backup: the newer edit leads. Its undo is dropped. */
export function mergePlaylist(here: PlaylistRecord, incoming: PlaylistRecord): PlaylistRecord {
  const [newer, older] = incoming.updatedAt > here.updatedAt ? [incoming, here] : [here, incoming]
  const trackIds = unionOrder(newer.trackIds, older.trackIds)
  const addedAt: Record<string, number> = {}
  for (const id of trackIds) {
    const dates = [here.addedAt[id], incoming.addedAt[id]].filter(
      (at): at is number => at !== undefined,
    )
    if (dates.length > 0) addedAt[id] = Math.min(...dates)
  }
  const { undo: _undo, ...rest } = newer
  return {
    ...rest,
    createdAt: Math.min(here.createdAt, incoming.createdAt),
    trackIds,
    addedAt,
  }
}

/** Whether the backup's decision should replace the one here: a pin always wins. */
export function prefersIncomingMatch(here: MatchCacheRecord, incoming: MatchCacheRecord): boolean {
  if (here.userPinned !== incoming.userPinned) return incoming.userPinned
  return incoming.decidedAt > here.decidedAt
}

/** What makes two plays the same play: the track (by `entityKey`) and when it started. */
export function playKey(entry: Pick<HistoryEntry, 'trackId' | 'playedAt'>): string {
  return `${entityKey(entry.trackId)}|${entry.playedAt}`
}
