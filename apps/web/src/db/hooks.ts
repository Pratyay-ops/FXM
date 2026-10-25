/**
 * React hooks that read the library as live queries (`useLiveQuery` from dexie-react-hooks):
 * a component re-renders whenever a write touches what its query read, whether the write came
 * from this page, another component (the player bar's like button) or another tab.
 *
 * Why not TanStack Query here: the library is local data written from many places, and a live
 * query re-runs exactly the reads a write affected, in every open tab, with no cache keys to
 * invalidate by hand. TanStack Query stays for data from the network.
 *
 * @module
 */

import type { EntityId } from '@fxm/core'
import { useLiveQuery } from 'dexie-react-hooks'
import { useCallback } from 'react'
import {
  getLibrary,
  type LibraryRepo,
  type PlaylistListView,
  type PlaylistView,
  type RecentRow,
} from './repo'
import type { FollowKind, FollowRecord } from './types'

/** A live query's state. */
export type Live<T> =
  | { status: 'loading' }
  | { status: 'ready'; data: T }
  | { status: 'error'; error: unknown }

const LOADING = { status: 'loading' } as const

/** The app's library repository, for writes. */
export function useLibrary(): LibraryRepo {
  return getLibrary()
}

/**
 * Runs `query` as a live query. Errors (IndexedDB blocked in a private window, a full disk)
 * come back as a state instead of breaking the page, so the shell keeps working.
 */
export function useLive<T>(query: (repo: LibraryRepo) => Promise<T>, deps: unknown[]): Live<T> {
  const repo = getLibrary()
  // biome-ignore lint/correctness/useExhaustiveDependencies: the caller lists the query's inputs
  const run = useCallback(query, deps)
  const result = useLiveQuery(async (): Promise<Live<T>> => {
    try {
      return { status: 'ready', data: await run(repo) }
    } catch (error) {
      return { status: 'error', error }
    }
  }, [repo, run])
  return result ?? LOADING
}

/** The list of playlists in its saved custom order. */
export function usePlaylistList(): Live<PlaylistListView> {
  return useLive((repo) => repo.getPlaylistList(), [])
}

/** One playlist with its tracks; `undefined` data when it doesn't exist. */
export function usePlaylistView(id: EntityId<'playlist'>): Live<PlaylistView | undefined> {
  return useLive((repo) => repo.getPlaylistView(id), [id])
}

/** Whether a track is liked; `false` while loading. */
export function useIsLiked(trackId: EntityId<'track'>): boolean {
  const live = useLive((repo) => repo.isLiked(trackId), [trackId])
  return live.status === 'ready' && live.data
}

/** Followed artists, saved albums or followed playlists, most recent first. */
export function useFollows(kind: FollowKind): Live<FollowRecord[]> {
  return useLive((repo) => repo.listFollows(kind), [kind])
}

/** The most recently played distinct tracks. */
export function useRecentlyPlayed(limit = 50): Live<RecentRow[]> {
  return useLive((repo) => repo.recentlyPlayed(limit), [limit])
}
