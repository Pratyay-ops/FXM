/**
 * React hooks that read the library as live queries (`useLiveQuery` from dexie-react-hooks):
 * a component re-renders whenever a write touches what its query read, whether the write came
 * from this page, another component (the player bar's like button) or another tab.
 *
 * Why not TanStack Query here: the library is local data written from many places, and a live
 * query re-runs exactly the reads a write affected, in every open tab, with no cache keys to
 * invalidate by hand. TanStack Query stays for data from the network.
 *
 * The list of playlists is one query that the sidebar and the Library page share, so both get
 * each change in the same render and never show two different orders.
 *
 * @module
 */

import type { EntityId } from '@fxm/core'
import { Dexie, liveQuery } from 'dexie'
import { useLiveQuery } from 'dexie-react-hooks'
import { useCallback, useSyncExternalStore } from 'react'
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

/**
 * Whether Dexie found an IndexedDB in this browser window when it loaded. There is none when
 * the user turned IndexedDB off (Firefox's `dom.indexedDB.enabled`), in some sandboxed frames
 * with an opaque origin and in some hardened webviews.
 */
export function hasIndexedDb(): boolean {
  return Boolean(Dexie.dependencies.indexedDB)
}

/** The state of every live query in a window without IndexedDB. */
const MISSING: Live<never> = {
  status: 'error',
  error: new Dexie.MissingAPIError('IndexedDB is not available in this browser window'),
}

/** The app's library repository, for writes. */
export function useLibrary(): LibraryRepo {
  return getLibrary()
}

/**
 * Runs `query` as a live query. Errors (IndexedDB blocked in a private window, a full disk)
 * come back as a state instead of breaking the page, so the shell keeps working. Without
 * IndexedDB at all, Dexie's live queries never answer, so that is an error at once too.
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
  if (!hasIndexedDb()) return MISSING
  return result ?? LOADING
}

/**
 * One live query for every component that reads it: it runs while at least one of them is
 * mounted, and they all get each result in the same render.
 */
function sharedLive<T>(query: (repo: LibraryRepo) => Promise<T>) {
  let value: Live<T> = LOADING
  let subscription: { unsubscribe: () => void } | undefined
  const listeners = new Set<() => void>()
  const subscribe = (listener: () => void) => {
    listeners.add(listener)
    if (subscription === undefined) {
      const repo = getLibrary()
      subscription = liveQuery(async (): Promise<Live<T>> => {
        try {
          return { status: 'ready', data: await query(repo) }
        } catch (error) {
          return { status: 'error', error }
        }
      }).subscribe({
        next: (next) => {
          value = next
          for (const notify of listeners) notify()
        },
      })
    }
    return () => {
      listeners.delete(listener)
      if (listeners.size > 0) return
      subscription?.unsubscribe()
      subscription = undefined
      value = LOADING
    }
  }
  return { subscribe, get: () => value }
}

const playlistList = sharedLive((repo) => repo.getPlaylistList())

/**
 * The list of playlists in its saved custom order. The sidebar and the Library page share one
 * query, so a change reaches both in the same render.
 */
export function usePlaylistList(): Live<PlaylistListView> {
  const live = useSyncExternalStore(playlistList.subscribe, playlistList.get)
  return hasIndexedDb() ? live : MISSING
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
