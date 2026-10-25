/**
 * React hooks over local files: the roots and tracks as live queries of the local-files
 * database (they update while a scan writes, and in other tabs), and each root's status in this
 * visit from the facade's store.
 *
 * @module
 */

import { useLiveQuery } from 'dexie-react-hooks'
import { useCallback } from 'react'
import { useStore } from 'zustand'
import type { Live } from '../../db/hooks'
import { CHECKING, getLocalFiles, type LocalFiles, type RootStatus } from './local-files'
import { type LocalTrack, toLocalTracks } from './tracks'
import type { LocalPictureRecord, LocalRootRecord } from './types'

const LOADING = { status: 'loading' } as const

/** The app's local files. */
export function useLocalFiles(): LocalFiles {
  return getLocalFiles()
}

/**
 * Runs `query` as a live query of the local-files database. A failure (IndexedDB blocked in a
 * private window, say) comes back as an error state, so the page keeps working.
 */
export function useLocalLive<T>(
  query: (files: LocalFiles) => Promise<T>,
  deps: unknown[],
): Live<T> {
  const files = getLocalFiles()
  // biome-ignore lint/correctness/useExhaustiveDependencies: the caller lists the query's inputs
  const run = useCallback(query, deps)
  const result = useLiveQuery(async (): Promise<Live<T>> => {
    try {
      return { status: 'ready', data: await run(files) }
    } catch (error) {
      return { status: 'error', error }
    }
  }, [files, run])
  return result ?? LOADING
}

/** Every root, oldest first. */
export function useLocalRoots(): Live<LocalRootRecord[]> {
  return useLocalLive((files) => files.repo.listRoots(), [])
}

/**
 * Cover thumbnails by key. Keys are hashes of the images, so a key's thumbnail never changes:
 * each is read once, not on every change to the list.
 */
const pictureCache = new Map<string, LocalPictureRecord>()

/** Every listed file as a track with its cover, in no particular order (sort it to show). */
export function useLocalTracks(): Live<LocalTrack[]> {
  return useLocalLive(async ({ repo }) => {
    const files = await repo.listFiles()
    const missing = [
      ...new Set(
        files.flatMap((file) =>
          file.pictureKey !== undefined && !pictureCache.has(file.pictureKey)
            ? [file.pictureKey]
            : [],
        ),
      ),
    ]
    if (missing.length > 0) {
      for (const [key, picture] of await repo.getPictures(missing)) pictureCache.set(key, picture)
    }
    return toLocalTracks(files, pictureCache)
  }, [])
}

/** Every root's status in this visit, by root ID. */
export function useRootStatuses(): Readonly<Record<string, RootStatus>> {
  return useStore(getLocalFiles().store, (state) => state.statuses)
}

/** One root's status in this visit. */
export function useRootStatus(rootId: string): RootStatus {
  return useStore(getLocalFiles().store, (state) => state.statuses[rootId] ?? CHECKING)
}
