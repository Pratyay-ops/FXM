/**
 * React hooks for downloads. Records are read as live queries on the downloads database, so
 * every view updates with the queue's progress, from whichever tab runs it.
 *
 * @module
 */

import type { ProviderContext, Track } from '@fxm/core'
import {
  type DownloadAvailability,
  type DownloadRecord,
  type DownloadStatus,
  downloadAvailability,
  downloadId,
  isDownloadRecord,
} from '@fxm/downloads'
import { useLiveQuery } from 'dexie-react-hooks'
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  estimateStorage,
  isStoragePersisted,
  requestStoragePersistence,
  type StorageEstimate,
} from './persistence'
import { getDownloads } from './runtime'

/** A live read's state, as in the library's hooks. */
export type LiveDownloads<T> =
  | { status: 'loading' }
  | { status: 'ready'; data: T }
  | { status: 'error'; error: unknown }

const LOADING = { status: 'loading' } as const

/** Every download that isn't being removed, oldest first. */
export function useDownloadRecords(): LiveDownloads<DownloadRecord[]> {
  const { db } = getDownloads()
  const result = useLiveQuery(async (): Promise<LiveDownloads<DownloadRecord[]>> => {
    try {
      const records = (await db.downloads.toArray()).filter(
        (record) => isDownloadRecord(record) && record.status !== 'removing',
      )
      records.sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1))
      return { status: 'ready', data: records }
    } catch (error) {
      return { status: 'error', error }
    }
  }, [db])
  return result ?? LOADING
}

/**
 * The status of every download by `downloadId` (removed ones left out), for lists whose menus
 * depend on it. The live query returns a string, so progress saves, which change no status,
 * don't re-render a long list.
 */
export function useDownloadStatuses(): ReadonlyMap<string, DownloadStatus> {
  const { db } = getDownloads()
  const signature = useLiveQuery(async () => {
    try {
      const lines: string[] = []
      for (const record of await db.downloads.toArray()) {
        if (isDownloadRecord(record) && record.status !== 'removing') {
          lines.push(`${record.id}\t${record.status}`)
        }
      }
      return lines.sort().join('\n')
    } catch {
      return ''
    }
  }, [db])
  return useMemo(() => {
    const statuses = new Map<string, DownloadStatus>()
    for (const line of signature?.split('\n') ?? []) {
      const tab = line.lastIndexOf('\t')
      if (tab > 0) statuses.set(line.slice(0, tab), line.slice(tab + 1) as DownloadStatus)
    }
    return statuses
  }, [signature])
}

/**
 * The download of `track`: its record, `null` when there is none (or it is being removed), and
 * `undefined` while the database is read.
 */
export function useDownload(
  track: Pick<Track, 'id'> | undefined,
): DownloadRecord | null | undefined {
  const { db } = getDownloads()
  const id = track === undefined ? undefined : downloadId(track)
  return useLiveQuery(async () => {
    if (id === undefined) return null
    const record = await db.downloads.get(id).catch(() => undefined)
    return isDownloadRecord(record) && record.status !== 'removing' ? record : null
  }, [db, id])
}

type DownloadContext = Pick<ProviderContext, 'capabilities' | 'mode'>

function readContext(environment: ReturnType<typeof getDownloads>['environment']): DownloadContext {
  const { capabilities, mode } = environment.context()
  return { capabilities, mode }
}

/**
 * The capabilities and catalog mode downloads run with right now: they change when the
 * environment says so (FXM Connect appeared, the catalog mode changed).
 */
export function useDownloadContext(): DownloadContext {
  const { environment } = getDownloads()
  const [state, setState] = useState(() => ({ environment, ctx: readContext(environment) }))
  if (state.environment !== environment) setState({ environment, ctx: readContext(environment) })
  useEffect(
    () => environment.subscribe(() => setState({ environment, ctx: readContext(environment) })),
    [environment],
  )
  return state.environment === environment ? state.ctx : readContext(environment)
}

/**
 * Whether `track` can be downloaded here: the browser can store files, and its audio's bytes
 * are readable with the current capabilities in the catalog mode (never YouTube audio in the
 * Lite tier).
 */
export function useDownloadAvailability(
  track: Pick<Track, 'source' | 'kind' | 'songId' | 'id'> | undefined,
): DownloadAvailability | undefined {
  const { supported } = getDownloads()
  const ctx = useDownloadContext()
  if (track === undefined || !supported) return undefined
  return downloadAvailability(track, ctx)
}

/** Whether a track can be downloaded here, as a function, for lists. */
export function useCanDownload(): (track: Track | undefined) => boolean {
  const { supported } = getDownloads()
  const ctx = useDownloadContext()
  return useCallback(
    (track: Track | undefined) =>
      supported && track !== undefined && downloadAvailability(track, ctx).available,
    [supported, ctx],
  )
}

/** The storage meter's numbers and the persistence state, refreshed with `refresh()`. */
export interface StorageInfo {
  estimate: StorageEstimate | undefined
  /** Whether the browser keeps FXM's data when space runs low; `undefined` when unknown. */
  persisted: boolean | undefined
  /** Whether a request to keep the data was refused in this session. */
  refused: boolean
  /** Reads the numbers again. */
  refresh: () => void
  /** Asks the browser to keep FXM's data. Call it straight from a click. */
  persist: () => Promise<boolean | undefined>
}

/** The storage meter's numbers; re-read whenever `key` changes, e.g. the downloads' total size. */
export function useStorageInfo(key: unknown): StorageInfo {
  const [estimate, setEstimate] = useState<StorageEstimate | undefined>()
  const [persisted, setPersisted] = useState<boolean | undefined>()
  const [refused, setRefused] = useState(false)
  const [tick, setTick] = useState(0)
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` and `tick` ask for a fresh read
  useEffect(() => {
    let live = true
    void Promise.all([estimateStorage(), isStoragePersisted()]).then(([size, kept]) => {
      if (!live) return
      setEstimate(size)
      setPersisted(kept)
    })
    return () => {
      live = false
    }
  }, [key, tick])
  const refresh = useCallback(() => setTick((value) => value + 1), [])
  const persist = useCallback(async () => {
    const kept = await requestStoragePersistence()
    if (kept !== undefined) setPersisted(kept)
    if (kept === false) setRefused(true)
    return kept
  }, [])
  return { estimate, persisted, refused, refresh, persist }
}
