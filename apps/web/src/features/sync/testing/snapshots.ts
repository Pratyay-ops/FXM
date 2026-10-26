/**
 * Builders of snapshots and their records for sync tests. Tests only.
 *
 * @module
 */

import { type EntityId, entityKey, formatId } from '@fxm/core'
import type {
  FollowRecord,
  HistoryEntry,
  LikeRecord,
  MatchCacheRecord,
  OrderRecord,
  PlaylistRecord,
  TrackRecord,
} from '../../../db/types'
import { LIKED_PLAYLIST_ID, PLAYLISTS_ORDER_ID } from '../../../db/types'
import { track } from '../../../test/library-fixtures'
import { emptySnapshot, normalizeSnapshot, type SyncSnapshot } from '../snapshot'

/** The ID of `track(n)`. */
export const T = (n: number): EntityId<'track'> => track(n).id

/** The ID of a local playlist named after `name`. */
export const P = (name: string): EntityId<'playlist'> => formatId('local', 'playlist', `pl-${name}`)

/** A cached track. */
export function trackRecord(n: number, updatedAt = 1000): TrackRecord {
  return { id: T(n), track: track(n), updatedAt }
}

/** A like of `track(n)`. */
export function like(n: number, likedAt = 1000): LikeRecord {
  return { key: entityKey(T(n)), trackId: T(n), likedAt }
}

/** A user playlist with these tracks, added at 1000. */
export function playlist(
  name: string,
  tracks: readonly number[],
  overrides: Partial<PlaylistRecord> = {},
): PlaylistRecord {
  const trackIds = tracks.map(T)
  return {
    id: P(name),
    name,
    createdAt: 100,
    updatedAt: 1000,
    trackIds,
    addedAt: Object.fromEntries(trackIds.map((id) => [id, 1000])),
    ...overrides,
  }
}

/** Liked songs' record with this order. */
export function liked(tracks: readonly number[], updatedAt = 1000): PlaylistRecord {
  return {
    id: LIKED_PLAYLIST_ID,
    system: 'liked',
    name: 'Liked songs',
    createdAt: 100,
    updatedAt,
    trackIds: tracks.map(T),
    addedAt: {},
  }
}

/** The order of the playlists list. */
export function order(ids: readonly EntityId<'playlist'>[], updatedAt = 1000): OrderRecord {
  return { id: PLAYLISTS_ORDER_ID, order: [...ids], updatedAt }
}

/** A followed artist. */
export function follow(name: string, followedAt = 1000): FollowRecord {
  const id = formatId('ytm', 'artist', `UC-${name}`)
  return { key: entityKey(id), id, kind: 'artist', name, artwork: [], followedAt }
}

/** A play of `track(n)` at `playedAt`. */
export function play(n: number, playedAt: number): HistoryEntry {
  return { trackId: T(n), playedAt, playedMs: 1000, completed: true, skipped: false }
}

/** A pin of `ref` for the Spotify track `source` in Music mode. */
export function pin(source: string, ref: string, decidedAt = 1000): MatchCacheRecord {
  const sourceTrackId = formatId('spotify', 'track', source)
  return {
    key: `${entityKey(sourceTrackId)}|music`,
    sourceKey: entityKey(sourceTrackId),
    sourceTrackId,
    mode: 'music',
    band: 'auto',
    candidate: {
      source: 'ytm',
      ref,
      kind: 'song',
      title: 'Song',
      artists: ['Band'],
      confidence: 0.9,
      evidence: ['isrc'],
    },
    alternatives: [],
    evidence: ['pinned by the user'],
    userPinned: true,
    decidedAt,
  }
}

/** A normalized snapshot with these parts; Liked songs is empty unless given. */
export function snap(parts: Partial<SyncSnapshot> = {}): SyncSnapshot {
  const base = emptySnapshot()
  const playlists = parts.playlists ?? []
  return normalizeSnapshot({
    ...base,
    ...parts,
    playlists: playlists.some((item) => item.id === LIKED_PLAYLIST_ID)
      ? playlists
      : [liked([]), ...playlists],
    appSettings: parts.appSettings ?? { catalogMode: 'music', theme: 'dark' },
  })
}
