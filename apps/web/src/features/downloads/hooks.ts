/**
 * React hooks for downloads. Records are read as live queries on the downloads database, so
 * every view updates with the queue's progress, from whichever tab runs it. The queries stay
 * cheap however many downloads there are: progress saves touch only unfinished downloads, and
 * the reads that don't need progress use the status index alone.
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
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { UNFINISHED_STATUSES } from './download-db'
import {
  estimateStorage,
  isStoragePersisted,
  requestStoragePersistence,
  type StorageEstimate,
} from './persistence'
import { type DownloadSupport, getDownloads } from './runtime'

/** A live read's state, as in the library's hooks. */
export type LiveDownloads<T> =
  | { status: 'loading' }
  | { status: 'ready'; data: T }
  | { status: 'error'; error: unknown }

const LOADING = { status: 'loading' } as const

/** The downloads on their way (`pending`) and the completed ones, each oldest first. */
export interface DownloadLists {
  /** Queued, downloading, paused or failed. */
  pending: DownloadRecord[]
  /** Completed: on the device. */
  completed: DownloadRecord[]
}

/** The statuses of downloads on their way, which the lists show with their progress. */
const PENDING_STATUSES = UNFINISHED_STATUSES.filter((status) => status !== 'removing')

/** The well-formed records of `collection`, oldest first. */
async function readRecords(collection: {
  toArray(): Promise<readonly unknown[]>
}): Promise<LiveDownloads<DownloadRecord[]>> {
  try {
    const records = (await collection.toArray()).filter(isDownloadRecord)
    records.sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1))
    return { status: 'ready', data: records }
  } catch (error) {
    return { status: 'error', error }
  }
}

/**
 * Every download that isn't being removed, oldest first, as two live reads: the ones on their
 * way, which change with every progress save, and the completed ones, which don't.
 */
export function useDownloadRecords(): LiveDownloads<DownloadLists> {
  const { db } = getDownloads()
  const pending = useLiveQuery(
    () => readRecords(db.downloads.where('status').anyOf([...PENDING_STATUSES])),
    [db],
  )
  const completed = useLiveQuery(
    () => readRecords(db.downloads.where('status').equals('completed')),
    [db],
  )
  return useMemo(() => {
    if (pending === undefined || completed === undefined) return LOADING
    if (pending.status === 'error') return pending
    if (completed.status === 'error') return completed
    if (pending.status !== 'ready' || completed.status !== 'ready') return LOADING
    return { status: 'ready', data: { pending: pending.data, completed: completed.data } }
  }, [pending, completed])
}

/** The statuses lists show: every one a download has, except `removing`. */
const VISIBLE_STATUSES: readonly DownloadStatus[] = [...PENDING_STATUSES, 'completed']

/**
 * The status of every download by `downloadId` (removed ones left out), for lists whose menus
 * depend on it; `undefined` while the database is read. It reads the status index alone, and
 * returns the same map until a status changes, so progress saves don't re-render a long list.
 */
export function useDownloadStatuses(): ReadonlyMap<string, DownloadStatus> | undefined {
  const { db } = getDownloads()
  const signature = useLiveQuery(async () => {
    try {
      const lines: string[] = []
      await db.downloads
        .where('status')
        .anyOf([...VISIBLE_STATUSES])
        .eachKey((status, cursor) => {
          lines.push(`${String(cursor.primaryKey)}\t${String(status)}`)
        })
      return lines.sort().join('\n')
    } catch {
      return ''
    }
  }, [db])
  return useMemo(() => {
    if (signature === undefined) return undefined
    const statuses = new Map<string, DownloadStatus>()
    for (const line of signature.split('\n')) {
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

/**
 * Whether this browser can store downloads: `checking` until the storage has been tried, then
 * `supported` or `unsupported`.
 */
export function useDownloadSupport(): DownloadSupport {
  const { support } = getDownloads()
  return useSyncExternalStore(
    support.subscribe,
    () => support.current,
    () => support.current,
  )
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
 * Whether `track` can be downloaded here: the browser is known to store files, its audio's
 * bytes are readable with the current capabilities in the catalog mode (never YouTube audio in
 * the Lite tier), and the app can resolve it (see `DownloadResolver.canResolve`).
 */
export function useDownloadAvailability(
  track: Pick<Track, 'source' | 'kind' | 'songId' | 'id'> | undefined,
): DownloadAvailability | undefined {
  const { environment } = getDownloads()
  const support = useDownloadSupport()
  const ctx = useDownloadContext()
  if (track === undefined || support !== 'supported') return undefined
  return downloadAvailability(track, ctx, environment.resolver)
}

/** Whether a track can be downloaded here (see {@link useDownloadAvailability}), for lists. */
export function useCanDownload(): (track: Track | undefined) => boolean {
  const { environment } = getDownloads()
  const support = useDownloadSupport()
  const ctx = useDownloadContext()
  return useCallback(
    (track: Track | undefined) =>
      support === 'supported' &&
      track !== undefined &&
      downloadAvailability(track, ctx, environment.resolver).available,
    [support, ctx, environment],
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

/** The shortest time between two reads of the storage numbers while downloads run: 5 s. */
export const STORAGE_REFRESH_MS = 5_000

/**
 * The storage meter's numbers. They are read again when `key` changes (e.g. the downloads'
 * total size, which grows with every progress save) at most every {@link STORAGE_REFRESH_MS},
 * and at once on `refresh()`.
 */
export function useStorageInfo(key: unknown): StorageInfo {
  const [estimate, setEstimate] = useState<StorageEstimate | undefined>()
  const [persisted, setPersisted] = useState<boolean | undefined>()
  const [refused, setRefused] = useState(false)
  const [tick, setTick] = useState(0)
  const lastRead = useRef(Number.NEGATIVE_INFINITY)
  const lastTick = useRef(tick)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` and `tick` ask for a fresh read
  useEffect(() => {
    const asked = lastTick.current !== tick
    lastTick.current = tick
    const wait = asked ? 0 : Math.max(0, lastRead.current + STORAGE_REFRESH_MS - Date.now())
    // A later change moves this read, but a read under way still lands.
    const timer = setTimeout(() => {
      lastRead.current = Date.now()
      void Promise.all([estimateStorage(), isStoragePersisted()]).then(([size, kept]) => {
        if (!mounted.current) return
        setEstimate(size)
        setPersisted(kept)
      })
    }, wait)
    return () => clearTimeout(timer)
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
