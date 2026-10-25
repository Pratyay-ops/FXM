/**
 * The web app's downloads: one download manager for the whole app, over the `fxm-downloads`
 * database and the Origin Private File System, created on first use.
 *
 * - **One tab runs the queue.** Every tab can queue, pause or delete downloads and see their
 *   progress, but only the tab that holds the `fxm-downloads` Web Lock fetches and writes files
 *   (`startDownloads`, called once from `main.tsx`). When it closes, the next tab takes over and
 *   continues where the files end.
 * - **The Downloads playlist follows.** A completed download joins the library's Downloads
 *   playlist (stage 2.6), and a deleted one leaves it.
 * - **Offline playback:** {@link getOfflineStore} is the stream lifecycle's `offline` store
 *   (stage 2.3), so the player plays downloads first.
 *
 * @module
 */

import { entityKey } from '@fxm/core'
import {
  createOfflineStore,
  DownloadManager,
  type DownloadManagerOptions,
  type DownloadNetwork,
  type DownloadStorage,
  type DownloadStore,
} from '@fxm/downloads'
import type { OfflineStore } from '@fxm/player'
import { Dexie } from 'dexie'
import { getLibrary, type LibraryRepo } from '../../db/repo'
import { DOWNLOADS_PLAYLIST_ID } from '../../db/types'
import {
  createDexieDownloadStore,
  DOWNLOADS_DB_NAME,
  type DownloadsDatabase,
  openDownloadsDatabase,
} from './download-db'
import { createAppDownloadEnvironment, type DownloadEnvironment } from './environment'
import { createBrowserOpfsStorage, opfsSupported } from './opfs/storage'

/** The name of the Web Lock that the tab running the download queue holds. */
export const RUNNER_LOCK = 'fxm-downloads'

/** The app's downloads, put together. */
export interface Downloads {
  /** The download manager: commands work in every tab. */
  readonly manager: DownloadManager
  /** The download records. */
  readonly store: DownloadStore
  /** The database behind them, for live queries. */
  readonly db: DownloadsDatabase
  /** Where the files go. */
  readonly storage: DownloadStorage
  /**
   * Whether this browser can store downloads at all (the Origin Private File System). When it
   * can't, nothing is offered for download.
   */
  readonly supported: boolean
  /** The stream lifecycle's offline store. */
  readonly offline: OfflineStore
  /** What the downloads run with. */
  readonly environment: DownloadEnvironment
}

/** What tests (and later the desktop and Android apps) may replace. */
export interface DownloadsConfig {
  environment?: DownloadEnvironment
  storage?: DownloadStorage
  /** Whether the storage works here. Default: true with a given storage, else OPFS support. */
  supported?: boolean
  network?: DownloadNetwork
  /** The database name. Default: `fxm-downloads`. */
  dbName?: string
  /** Manager tuning, e.g. shorter retry delays in tests. */
  manager?: Partial<
    Pick<
      DownloadManagerOptions,
      'concurrency' | 'chunkBytes' | 'retryDelaysMs' | 'progressIntervalMs' | 'createFileName'
    >
  >
}

/** `navigator.onLine` and its events, as the manager's network. */
export function browserNetwork(): DownloadNetwork {
  return {
    get online() {
      return typeof navigator === 'undefined' || navigator.onLine !== false
    },
    subscribe(listener) {
      if (typeof window === 'undefined') return () => {}
      window.addEventListener('online', listener)
      window.addEventListener('offline', listener)
      return () => {
        window.removeEventListener('online', listener)
        window.removeEventListener('offline', listener)
      }
    },
  }
}

/** A storage that holds nothing and refuses to write: where the browser can't store files. */
function unsupportedStorage(): DownloadStorage {
  return {
    open: () =>
      Promise.reject(new DOMException('This browser cannot store downloads', 'SecurityError')),
    remove: async () => {},
    list: async () => [],
    size: async () => undefined,
    read: async () => undefined,
    playbackUrl: async () => undefined,
  }
}

let config: DownloadsConfig = {}
let current: Downloads | undefined
let stopRunner: (() => void) | undefined

function create(options: DownloadsConfig): Downloads {
  const environment = options.environment ?? createAppDownloadEnvironment()
  const supported = options.supported ?? (options.storage !== undefined || opfsSupported())
  const storage = options.storage ?? (supported ? createBrowserOpfsStorage() : unsupportedStorage())
  const db = openDownloadsDatabase(options.dbName ?? DOWNLOADS_DB_NAME)
  const store = createDexieDownloadStore(db)
  const manager = new DownloadManager({
    store,
    storage,
    resolver: environment.resolver,
    context: () => environment.context(),
    network: options.network ?? browserNetwork(),
    ...options.manager,
  })
  // The tab that runs the queue completes and deletes downloads: it keeps the playlist in step.
  manager.on('completed', (record) => {
    getLibrary()
      .addDownload(record.track)
      .catch(() => {})
  })
  manager.on('removed', (record) => {
    getLibrary()
      .removeDownload(record.track.id)
      .catch(() => {})
  })
  return {
    manager,
    store,
    db,
    storage,
    supported,
    offline: createOfflineStore({ store, storage }),
    environment,
  }
}

/** The app's downloads, created on first use. */
export function getDownloads(): Downloads {
  current ??= create(config)
  return current
}

/**
 * The offline store for the app's stream lifecycle: pass it as `offline` when the player's
 * `StreamLifecycle` is created, so downloads play first, also without a network.
 */
export function getOfflineStore(): OfflineStore {
  return getDownloads().offline
}

/**
 * Adds every completed download that the Downloads playlist lacks, newest on top: a tab that
 * closed between a download's end and the playlist's update leaves one behind.
 */
export async function reconcileDownloadsPlaylist(
  manager: DownloadManager,
  library: LibraryRepo,
): Promise<number> {
  const view = await library.getPlaylistView(DOWNLOADS_PLAYLIST_ID)
  const listed = new Set(view?.rows.map((row) => entityKey(row.id)) ?? [])
  const missing = (await manager.list())
    .filter((record) => record.status === 'completed' && !listed.has(record.id))
    .sort((a, b) => (a.completedAt ?? 0) - (b.completedAt ?? 0))
  for (const record of missing) await library.addDownload(record.track)
  return missing.length
}

/**
 * Runs the download queue in this tab once it holds the `fxm-downloads` Web Lock, which only
 * one tab holds at a time (without Web Locks, at once). Returns a function that stops it.
 * `main.tsx` calls it once; tests call it to run the queue.
 */
export function startDownloads(): () => void {
  if (stopRunner !== undefined) return stopRunner
  const downloads = getDownloads()
  if (!downloads.supported) return () => {}
  const stop = new AbortController()
  const run = async () => {
    await downloads.manager.start()
    await reconcileDownloadsPlaylist(downloads.manager, getLibrary()).catch(() => 0)
    await new Promise<void>((resolve) => {
      if (stop.signal.aborted) resolve()
      else stop.signal.addEventListener('abort', () => resolve(), { once: true })
    })
    await downloads.manager.stop()
  }
  const locks = typeof navigator === 'undefined' ? undefined : navigator.locks
  if (typeof locks?.request === 'function') {
    locks.request(RUNNER_LOCK, { signal: stop.signal }, run).catch(() => {})
  } else {
    void run().catch(() => {})
  }
  const stopThis = () => {
    stop.abort()
    if (stopRunner === stopThis) stopRunner = undefined
  }
  stopRunner = stopThis
  return stopThis
}

/**
 * Tests only: uses `next` for the app's downloads from now on. Stops and forgets the current
 * ones and deletes their database; the next {@link getDownloads} creates them afresh.
 */
export async function resetDownloads(next: DownloadsConfig = {}): Promise<void> {
  stopRunner?.()
  const previous = current
  current = undefined
  config = next
  if (previous === undefined) return
  await previous.manager.destroy()
  previous.db.close()
  await Dexie.delete(previous.db.name)
}
