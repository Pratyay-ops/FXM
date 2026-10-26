/**
 * Which track the app's player is on, for the track lists that mark the row of the song that
 * plays (`components/ui/now-playing-marker.tsx`).
 *
 * **Identity.** A row is the current track's when its track ID is the current queue item's
 * `track.id`, never by title. The queue keeps there the track the user picked, also when it
 * plays through a match: a Spotify or imported track that plays a YouTube recording keeps its
 * own ID, and the recording is the item's `candidate`. So the row that was tapped is the one
 * marked, not a row of the recording itself, nor another song of the same name. A track that
 * two lists show is marked in both. A list that shows a track more than once (a playlist can
 * repeat a song) marks one of its copies, the one the queue plays (see {@link CurrentTrack.copy}).
 *
 * **Performance.** Rows subscribe through {@link useNowPlayingStatus} to the current item's
 * identity and status only, over one subscription to the player: a playback tick (the position
 * moving) notifies no row, and a change of track re-renders only the rows that gain or lose the
 * marker; play and pause re-render only the current one.
 *
 * @module
 */

import { currentQueueItem, type EntityId, type QueueState } from '@fxm/core'
import type { PlayerState, PlayerStatus } from '@fxm/player'
import { useSyncExternalStore } from 'react'
import type { NowPlayingStatus } from '../../components/ui/now-playing-marker'
import { getPlayer, subscribePlayer } from './playback'

/** The queue's current track, as track lists mark it. */
export interface CurrentTrack {
  /**
   * The current queue item's track ID: the track the user picked, also when a match plays it
   * (the matched recording is the item's `candidate`, which rows never look at).
   */
  readonly id: EntityId<'track'>
  /**
   * Which copy of that track the current item is, from 1, among the queue's items of the same
   * track, in the order the queue was given them (before any shuffle). 1 unless the queue holds
   * the track more than once.
   */
  readonly copy: number
  /** Whether it plays (or loads), or is paused. */
  readonly status: NowPlayingStatus
}

/** Where a row stands among the rows of its list that show the same track. */
export interface RowCopy {
  /** Which of them it is, from 1, in list order. */
  readonly copy: number
  /** How many rows of the list show the track. */
  readonly copies: number
}

/** The marker's status for a player status: `playing` also while the track loads. */
export function nowPlayingStatusFor(status: PlayerStatus): NowPlayingStatus {
  return status === 'playing' || status === 'loading' ? 'playing' : 'paused'
}

type TrackKey = Pick<CurrentTrack, 'id' | 'copy'>

/** The copy number of the item with `uid` among the items of track `id`, in original order. */
function copyOf(queue: QueueState, uid: number, id: string): number {
  const same = new Set<number>()
  for (const item of queue.items) if (item.track.id === id) same.add(item.uid)
  if (same.size < 2) return 1
  let copy = 0
  for (const entry of queue.unshuffled ?? queue.items.map((item) => item.uid)) {
    if (!same.has(entry)) continue
    copy++
    if (entry === uid) return copy
  }
  return 1
}

/** The queue's current track without its status: what changes only with the queue. */
function trackOf(queue: QueueState): TrackKey | undefined {
  const item = currentQueueItem(queue)
  if (item === undefined) return undefined
  return { id: item.track.id, copy: copyOf(queue, item.uid, item.track.id) }
}

/** The current track of a player's state, or `undefined` while the queue is empty. */
export function currentTrackOf(state: PlayerState): CurrentTrack | undefined {
  const track = trackOf(state.queue)
  return track === undefined ? undefined : { ...track, status: nowPlayingStatusFor(state.status) }
}

/**
 * Which copy of its track each entry of `ids` is, for lists that may show a track more than
 * once, such as a catalog playlist.
 */
export function rowCopies(ids: readonly string[]): RowCopy[] {
  const counts = new Map<string, number>()
  for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1)
  const seen = new Map<string, number>()
  return ids.map((id) => {
    const copy = (seen.get(id) ?? 0) + 1
    seen.set(id, copy)
    return { copy, copies: counts.get(id) ?? 1 }
  })
}

/**
 * The marker of the row that shows track `trackId`: the current track's status when the row is
 * that track's, else `undefined`. Of several rows of one list that show the track (`rowCopy`),
 * only the copy the queue plays is marked: the same copy number, or the list's last copy when
 * the queue holds more copies than the list.
 */
export function nowPlayingStatusOf(
  current: CurrentTrack | undefined,
  trackId: string | undefined,
  rowCopy?: RowCopy,
): NowPlayingStatus | undefined {
  if (current === undefined || trackId === undefined || trackId !== current.id) return undefined
  if (rowCopy !== undefined && rowCopy.copies > 1) {
    if (rowCopy.copy !== Math.min(current.copy, rowCopy.copies)) return undefined
  }
  return current.status
}

// One subscription to the player for every row that follows the current track.

let cachedQueue: QueueState | undefined
let cachedTrack: TrackKey | undefined
let snapshot: CurrentTrack | undefined

/**
 * The app player's current track, the same object until its identity or status changes. The
 * copy number is worked out again only when the queue changes, not on every tick.
 */
function readCurrentTrack(): CurrentTrack | undefined {
  const state = getPlayer().getState()
  if (state.queue !== cachedQueue) {
    cachedQueue = state.queue
    cachedTrack = trackOf(state.queue)
  }
  const track = cachedTrack
  const status = nowPlayingStatusFor(state.status)
  const unchanged =
    track === undefined
      ? snapshot === undefined
      : snapshot !== undefined &&
        snapshot.id === track.id &&
        snapshot.copy === track.copy &&
        snapshot.status === status
  if (!unchanged) snapshot = track === undefined ? undefined : { ...track, status }
  return snapshot
}

const listeners = new Set<() => void>()
let stopFollowing: (() => void) | undefined
let announced: CurrentTrack | undefined

/** Tells the rows when the current track or its status changed, and only then. */
function follow(): void {
  const next = readCurrentTrack()
  if (next === announced) return
  announced = next
  for (const listener of [...listeners]) listener()
}

function subscribeCurrentTrack(listener: () => void): () => void {
  if (listeners.size === 0) {
    announced = readCurrentTrack()
    stopFollowing = subscribePlayer(follow)
  }
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
    if (listeners.size > 0) return
    stopFollowing?.()
    stopFollowing = undefined
  }
}

/**
 * The app player's current track, or `undefined` while the queue is empty. Re-renders when the
 * current track or its status changes, never on a playback tick.
 */
export function useCurrentTrack(): CurrentTrack | undefined {
  return useSyncExternalStore(subscribeCurrentTrack, readCurrentTrack, readCurrentTrack)
}

/**
 * The marker of a row that shows track `trackId` (see {@link nowPlayingStatusOf}): `playing` or
 * `paused` while it is the current track's row, else `undefined`. Re-renders only when that
 * changes, so a long list re-renders the rows that gain or lose the marker, and no others.
 */
export function useNowPlayingStatus(
  trackId: string | undefined,
  rowCopy?: RowCopy,
): NowPlayingStatus | undefined {
  const read = () => nowPlayingStatusOf(readCurrentTrack(), trackId, rowCopy)
  return useSyncExternalStore(subscribeCurrentTrack, read, read)
}
