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

import { type EntityId, entityKey } from '@fxm/core'
import {
  createOfflineStore,
  DownloadManager,
  type DownloadManagerOptions,
  type DownloadNetwork,
  type DownloadStorage,
  type DownloadStore,
  storageUnavailableError,
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
import { estimateStorage } from './persistence'

/** The name of the Web Lock that the tab running the download queue holds. */
export const RUNNER_LOCK = 'fxm-downloads'

/**
 * Whether this browser can store downloads: `checking` while the storage is tried (the Origin
 * Private File System, its worker and sync access handles), then `supported` or `unsupported`.
 */
export type DownloadSupport = 'checking' | 'supported' | 'unsupported'

/** Where the check of {@link DownloadSupport} stands, and a way to hear when it is done. */
export interface SupportState {
  /** Where the check stands now. */
  readonly current: DownloadSupport
  /** Calls `listener` once the check is done. Returns a function that stops it. */
  subscribe(listener: () => void): () => void
  /** Resolves with whether downloads can be stored, once known. Never rejects. */
  readonly known: Promise<boolean>
}

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
   * Whether this browser can store downloads at all. Until it is known to, nothing is offered
   * for download; when it can't, the Downloads tab says why.
   */
  readonly support: SupportState
  /** The stream lifecycle's offline store. */
  readonly offline: OfflineStore
  /** What the downloads run with. */
  readonly environment: DownloadEnvironment
}

/** What tests (and later the desktop and Android apps) may replace. */
export interface DownloadsConfig {
  environment?: DownloadEnvironment
  storage?: DownloadStorage
  /**
   * Whether the storage works here, or a promise of it (a check under way). Default: true with
   * a given storage, else what trying the Origin Private File System finds.
   */
  supported?: boolean | Promise<boolean>
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
    open: () => Promise.reject(storageUnavailableError('This browser cannot store downloads')),
    remove: async () => {},
    list: async () => [],
    size: async () => undefined,
    read: async () => undefined,
    playbackUrl: async () => undefined,
  }
}

/** A {@link SupportState} that settles with `check`. */
function supportState(check: Promise<boolean> | boolean): SupportState {
  const listeners = new Set<() => void>()
  let current: DownloadSupport =
    typeof check === 'boolean' ? (check ? 'supported' : 'unsupported') : 'checking'
  const known = Promise.resolve(check)
    .catch(() => false)
    .then((supported) => {
      current = supported ? 'supported' : 'unsupported'
      for (const listener of [...listeners]) listener()
      return supported
    })
  return {
    get current() {
      return current
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    known,
  }
}

/** How long deleted downloads gather before they leave the Downloads playlist together. */
const PLAYLIST_BATCH_MS = 200

/**
 * Takes deleted downloads out of the Downloads playlist in batches, so removing many downloads
 * rewrites the playlist a few times rather than once per song.
 */
function playlistCleaner() {
  const pending = new Set<EntityId<'track'>>()
  let timer: ReturnType<typeof setTimeout> | undefined
  const flush = () => {
    timer = undefined
    const ids = [...pending]
    pending.clear()
    if (ids.length > 0) {
      getLibrary()
        .removeDownloads(ids)
        .catch(() => {})
    }
  }
  return {
    add(id: EntityId<'track'>) {
      pending.add(id)
      timer ??= setTimeout(flush, PLAYLIST_BATCH_MS)
    },
    cancel() {
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
      pending.clear()
    },
  }
}

let config: DownloadsConfig = {}
let current: (Downloads & { readonly dispose: () => void }) | undefined
let stopRunner: (() => void) | undefined

function create(options: DownloadsConfig): Downloads & { readonly dispose: () => void } {
  const environment = options.environment ?? createAppDownloadEnvironment()
  let storage: DownloadStorage
  let check: Promise<boolean> | boolean
  if (options.storage !== undefined) {
    storage = options.storage
    check = options.supported ?? true
  } else if (options.supported === false || !opfsSupported()) {
    storage = unsupportedStorage()
    check = false
  } else {
    // The worker and sync access handles may still be missing (an older Safari), or a private
    // window may refuse the folder: try them before anything is offered.
    const opfs = createBrowserOpfsStorage(estimateStorage)
    storage = opfs
    check = opfs.probe()
  }
  const support = supportState(check)
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
  const cleaner = playlistCleaner()
  manager.on('completed', (record) => {
    getLibrary()
      .addDownload(record.track)
      .catch(() => {})
  })
  manager.on('removed', (record) => cleaner.add(record.track.id))
  return {
    manager,
    store,
    db,
    storage,
    support,
    offline: createOfflineStore({ store, storage }),
    environment,
    dispose: () => cleaner.cancel(),
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
 * one tab holds at a time (without Web Locks, at once), and only once this browser is known to
 * store downloads. Returns a function that stops it. `main.tsx` calls it once; tests call it to
 * run the queue.
 */
export function startDownloads(): () => void {
  if (stopRunner !== undefined) return stopRunner
  const downloads = getDownloads()
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
  const begin = () => {
    const locks = typeof navigator === 'undefined' ? undefined : navigator.locks
    if (typeof locks?.request === 'function') {
      locks.request(RUNNER_LOCK, { signal: stop.signal }, run).catch(() => {})
    } else {
      void run().catch(() => {})
    }
  }
  void downloads.support.known.then((supported) => {
    if (supported && !stop.signal.aborted) begin()
  })
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
  previous.dispose()
  previous.db.close()
  await Dexie.delete(previous.db.name)
}
