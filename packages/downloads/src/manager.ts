/**
 * The download manager (stage 4.1): a queue with concurrency, progress, pause, resume, retry,
 * cancel and delete, and transfers that continue from the bytes already stored.
 *
 * Every command is a change to a record in the {@link DownloadStore}, which all tabs share, and
 * only a manager that was {@link DownloadManager.start started} fetches anything. The app starts
 * one manager at a time (in the web app, the tab that holds a Web Lock), so two tabs never write
 * the same file, while every tab can queue, pause or delete downloads and see their progress.
 *
 * @module
 */

import {
  DEFAULT_QUALITY_PREFS,
  FxmError,
  type ProviderContext,
  type QualityPrefs,
  sameCandidate,
  type Track,
} from '@fxm/core'
import {
  type DownloadAvailability,
  downloadAvailability,
  downloadLane,
  isDownloadableStream,
} from './availability'
import { Emitter, type Listener } from './emitter'
import { maxDownloadBytes } from './limits'
import { classifyDownloadFailure } from './recovery'
import {
  type DownloadResolveReason,
  type DownloadResolver,
  NoDownloadableStreamError,
  type ResolvedDownload,
  unreadableStream,
} from './resolver'
import { type DownloadStorage, type DownloadWriter, isSafeFileName } from './storage'
import type { DownloadStore, RecordChange } from './store'
import { DownloadNetworkError, type TransferFacts, transfer } from './transfer'
import {
  type DownloadError,
  type DownloadErrorCode,
  type DownloadRecord,
  type DownloadStatus,
  downloadId,
  fileFormatOf,
  isDownloadRecord,
  newDownloadRecord,
  sameFileFormat,
  withoutError,
  withoutProgress,
} from './types'

/** Whether the device is online, and a way to hear when that changes. */
export interface DownloadNetwork {
  /** Whether the device is online now. */
  readonly online: boolean
  /** Calls `listener` when the device goes online or offline. Returns a function that stops it. */
  subscribe(listener: () => void): () => void
}

/** A {@link DownloadNetwork} that is always online: the default. */
export const ALWAYS_ONLINE: DownloadNetwork = Object.freeze({
  online: true,
  subscribe: () => () => {},
})

/** How the manager is put together and tuned. */
export interface DownloadManagerOptions {
  /** The download records, shared by every tab. */
  store: DownloadStore
  /** Where the files go. */
  storage: DownloadStorage
  /** Finds what to download for a track (see `createPolicyDownloadResolver`). */
  resolver: DownloadResolver
  /**
   * The provider context downloads run with, read afresh for every attempt: its `fetch` makes
   * the resolver's calls and fetches the bytes, and its capabilities decide what may be
   * downloaded at all. Downloads are background work: give it a `fetch` that draws on the
   * request budget at the `bulk` priority (stage 1.2: `platform.context({ mode, priority:
   * 'bulk' })`), so a long batch never takes the calls search and playback need, waits its
   * turn, and pauses after a bot check. The budget's refusals (`RateLimited`) hold the queue
   * without failing anything.
   */
  context: () => ProviderContext
  /** The user's quality settings. Default: `DEFAULT_QUALITY_PREFS`. */
  qualityPrefs?: () => QualityPrefs
  /** Whether the device is online. Default: always. */
  network?: DownloadNetwork
  /** How many downloads run at once. Default: 2. */
  concurrency?: number
  /** The most bytes one request asks for. Default: 4 MiB. */
  chunkBytes?: number
  /**
   * How many passing failures in a row (network, busy server) end a download. An attempt that
   * stores bytes starts the count over, so a long file on a flaky connection keeps going.
   * Default: 5.
   */
  maxAttempts?: number
  /**
   * How many fresh resolutions in a row one run may take before it gives up; an attempt that
   * stores bytes starts the count over. Default: 3.
   */
  maxRefreshes?: number
  /** How many times one run may start its file over. Default: 2. */
  maxRestarts?: number
  /** The waits before each retry after a passing failure. Default: 1 s, 3 s, 10 s, 30 s. */
  retryDelaysMs?: readonly number[]
  /** How often a running download saves its progress to the store. Default: 500 ms. */
  progressIntervalMs?: number
  /** The clock, in epoch milliseconds. Default: `Date.now`. */
  now?: () => number
  /**
   * A new, unique file name for a download's file: 1 to 64 ASCII letters, digits, `-` and `_`
   * (`isSafeFileName`). Default: a random UUID.
   */
  createFileName?: () => string
}

/** The defaults behind {@link DownloadManagerOptions}. */
export const DOWNLOAD_DEFAULTS = Object.freeze({
  concurrency: 2,
  chunkBytes: 4 * 1024 * 1024,
  maxAttempts: 5,
  maxRefreshes: 3,
  maxRestarts: 2,
  retryDelaysMs: Object.freeze([1_000, 3_000, 10_000, 30_000]),
  progressIntervalMs: 500,
})

/**
 * How the manager waits when a server or the request budget asks it to:
 *
 * - `maxRetryAfterMs`: a server that asks for a longer wait (`Retry-After`) fails the download
 *   instead, as `server`
 * - `maxSlotWaitMs`: a download waits this long at most in its slot; a longer wait gives the slot
 *   back and queues the download again, so downloads from other hosts go on meanwhile
 * - `throttleWaitMs`: how long a lane waits when the request budget or a source asks it to slow
 *   down without saying for how long
 * - `minThrottleWaitMs`, `maxThrottleWaitMs`: the shortest and longest such wait. After the
 *   longest, the lane asks again; the budget refuses at once (no request goes out) while it must
 */
export const DOWNLOAD_WAITS = Object.freeze({
  maxRetryAfterMs: 10 * 60_000,
  maxSlotWaitMs: 30_000,
  throttleWaitMs: 60_000,
  minThrottleWaitMs: 1_000,
  maxThrottleWaitMs: 15 * 60_000,
})

/** Stop using a URL this close to its expiry, and resolve afresh instead. */
const EXPIRY_MARGIN_MS = 60_000

/**
 * The longest the manager waits for the storage to close a file or delete one before it goes on
 * (the file stays for the next start's tidy-up). A storage must settle every call (see
 * `DownloadStorage`); this keeps a faulty one from stalling the queue.
 */
const STORAGE_WAIT_MS = 30_000

/** The statuses the queue reads: downloads on their way, and on their way out. */
const ACTIVE_STATUSES: readonly DownloadStatus[] = [
  'queued',
  'downloading',
  'paused',
  'failed',
  'removing',
]

/** The events a {@link DownloadManager} announces, with their payloads. */
export interface DownloadEventMap {
  /** A download completed: its file is stored and plays offline. */
  completed: DownloadRecord
  /** A download failed; `error` on the record says why. */
  failed: DownloadRecord
  /** A cancelled or deleted download is gone, with its file. */
  removed: DownloadRecord
}

/** What {@link DownloadManager.enqueueAll} did. */
export interface EnqueueAllResult {
  /** Downloads queued now, or queued again. */
  queued: number
  /** Tracks downloaded or queued already. */
  present: number
  /** Tracks that can't be downloaded here. */
  skipped: number
}

/** Why a running download stopped before its end. */
type StopReason = 'paused' | 'removed' | 'stopped'

/** One running download. */
interface Job {
  readonly id: string
  readonly controller: AbortController
  done: Promise<void>
  /** Progress not saved yet. */
  bytes: number
  facts: TransferFacts
  savedAt: number
  saving: boolean
  abort(reason: StopReason): void
}

/** A version 4 UUID, also where `crypto.randomUUID` is missing (an insecure context). */
export function randomFileName(): string {
  const crypto = globalThis.crypto
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** Waits `ms`, or rejects with the signal's reason when it aborts first. */
function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason)
      return
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal.reason)
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * `promise`, or a rejection with the signal's reason as soon as it aborts: a storage call that
 * takes long never keeps a paused or cancelled download in its slot.
 */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    promise.catch(() => {})
    return Promise.reject(signal.reason)
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

/** Waits for `promise` to settle, but no longer than `ms`. Never rejects. */
function settle(promise: Promise<unknown> | undefined, ms: number): Promise<void> {
  if (promise === undefined) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    const done = () => {
      clearTimeout(timer)
      resolve()
    }
    promise.then(done, done)
  })
}

/**
 * `writer`, with every call but `close` given up as soon as the signal aborts. A write that
 * lands all the same still reports where the file ends now (`onWritten`), so a paused download
 * shows every byte it stored.
 */
function guardWriter(
  writer: DownloadWriter,
  signal: AbortSignal,
  onWritten: (end: number) => void,
): DownloadWriter {
  return {
    size: () => untilAborted(writer.size(), signal),
    write: (offset, bytes) => {
      const writing = writer.write(offset, bytes)
      writing.then(
        () => onWritten(offset + bytes.length),
        () => {},
      )
      return untilAborted(writing, signal)
    },
    truncate: (size) => untilAborted(writer.truncate(size), signal),
    flush: () => untilAborted(writer.flush(), signal),
    close: () => writer.close(),
  }
}

function positive(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback
}

function count(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isInteger(value) && value >= 0 ? value : fallback
}

function clamp(value: number, min: number, max: number): number {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : max
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Queued downloads start oldest first. */
function queueOrder(a: DownloadRecord, b: DownloadRecord): number {
  return a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1)
}

const REQUEUE_FROM: readonly DownloadStatus[] = ['paused', 'failed', 'removing']

/** `track`'s download queued: a new one, or one that was paused, failed or being removed. */
function queued(current: DownloadRecord | undefined, track: Track, now: number): DownloadRecord {
  if (current === undefined) return newDownloadRecord(track, now)
  if (!REQUEUE_FROM.includes(current.status)) return current
  return { ...withoutError(current), track, status: 'queued', attempts: 0, updatedAt: now }
}

/** `current` moved from one of `from` to `to`; queued again, it forgets its error and attempts. */
function moved(
  current: DownloadRecord | undefined,
  from: readonly DownloadStatus[],
  to: DownloadStatus,
  now: number,
  error?: DownloadError,
): RecordChange {
  if (current === undefined || !from.includes(current.status)) return current
  const next: DownloadRecord = { ...withoutError(current), status: to, updatedAt: now }
  if (to === 'queued') return { ...next, attempts: 0 }
  return error === undefined ? next : { ...next, error }
}

/**
 * The download manager. Create one per app with the platform's store, storage and resolver,
 * call {@link start} in the one place that should fetch (see the module notes), and use the
 * commands anywhere:
 *
 * ```ts
 * const manager = new DownloadManager({ store, storage, resolver, context: () => ctx })
 * manager.on('completed', (record) => library.addDownload(record.track))
 * await manager.start()
 * await manager.enqueue(track)
 * ```
 *
 * Every method is safe to call at any time. The commands resolve once the store has the change;
 * the download itself goes on in the background.
 */
export class DownloadManager {
  readonly #store: DownloadStore
  readonly #storage: DownloadStorage
  readonly #resolver: DownloadResolver
  readonly #context: () => ProviderContext
  readonly #prefs: () => QualityPrefs
  readonly #network: DownloadNetwork
  readonly #now: () => number
  readonly #createFileName: () => string
  readonly #config: {
    concurrency: number
    chunkBytes: number
    maxAttempts: number
    maxRefreshes: number
    maxRestarts: number
    retryDelaysMs: readonly number[]
    progressIntervalMs: number
  }
  readonly #events = new Emitter<DownloadEventMap>()
  readonly #jobs = new Map<string, Job>()
  /** Until when each lane waits (a throttle), in epoch milliseconds. */
  readonly #holds = new Map<string, number>()
  /** Until when each queued download waits (a long `Retry-After`), in epoch milliseconds. */
  readonly #notBefore = new Map<string, number>()
  #running = false
  #starting = false
  #stopping: Promise<void> | undefined
  #passing: Promise<void> | undefined
  #again = false
  #unsubscribe: (() => void)[] = []
  #wakeTimer: ReturnType<typeof setTimeout> | undefined
  #wakeAt = Number.POSITIVE_INFINITY

  constructor(options: DownloadManagerOptions) {
    this.#store = options.store
    this.#storage = options.storage
    this.#resolver = options.resolver
    this.#context = options.context
    this.#prefs = options.qualityPrefs ?? (() => DEFAULT_QUALITY_PREFS)
    this.#network = options.network ?? ALWAYS_ONLINE
    this.#now = options.now ?? Date.now
    this.#createFileName = options.createFileName ?? randomFileName
    const d = DOWNLOAD_DEFAULTS
    const delays = options.retryDelaysMs?.filter((ms) => Number.isFinite(ms) && ms >= 0) ?? []
    this.#config = {
      concurrency: Math.floor(positive(options.concurrency, d.concurrency)),
      chunkBytes: Math.floor(positive(options.chunkBytes, d.chunkBytes)),
      maxAttempts: Math.max(1, count(options.maxAttempts, d.maxAttempts)),
      maxRefreshes: count(options.maxRefreshes, d.maxRefreshes),
      maxRestarts: count(options.maxRestarts, d.maxRestarts),
      retryDelaysMs: delays.length > 0 ? delays : d.retryDelaysMs,
      progressIntervalMs: count(options.progressIntervalMs, d.progressIntervalMs),
    }
  }

  // --- Commands (any tab) ---------------------------------------------------------------------

  /**
   * Whether `track` can be downloaded with the current capabilities and catalog mode, by the
   * resolver this manager has (see `downloadAvailability`).
   */
  availability(track: Track): DownloadAvailability {
    return downloadAvailability(track, this.#context(), this.#resolver)
  }

  /**
   * Queues a download of `track`, or queues a paused, failed or cancelled one again. A track
   * that is downloaded or on its way already stays as it is. Rejects with an `Unsupported`
   * `FxmError` when the track can't be downloaded here (see {@link availability}).
   */
  async enqueue(track: Track): Promise<DownloadRecord> {
    const availability = this.availability(track)
    if (!availability.available) {
      throw new FxmError(
        'Unsupported',
        `"${track.title}" can't be downloaded here (${availability.reason})`,
      )
    }
    const now = this.#now()
    const record = await this.#store.update(downloadId(track), (current) =>
      queued(current, track, now),
    )
    this.#schedule()
    if (record === undefined) throw new Error(`The store lost the download of "${track.title}"`)
    return record
  }

  /**
   * Queues every track of `tracks` that can be downloaded here and isn't downloaded or on its
   * way already, in order (e.g. "Download all" on a playlist), as one change to the store.
   */
  async enqueueAll(tracks: readonly Track[]): Promise<EnqueueAllResult> {
    const result: EnqueueAllResult = { queued: 0, present: 0, skipped: 0 }
    const wanted = new Map<string, Track>()
    for (const track of tracks) {
      const id = downloadId(track)
      if (wanted.has(id)) continue
      if (!this.availability(track).available) {
        result.skipped += 1
        continue
      }
      wanted.set(id, track)
    }
    if (wanted.size === 0) return result
    // Distinct times keep the queue in the order of the list.
    const ids = [...wanted.keys()]
    const first = this.#now()
    const times = new Map(ids.map((id, index) => [id, first + index]))
    await this.#store.updateMany(ids, (current, id) => {
      const track = wanted.get(id)
      if (track === undefined) return current
      const next = queued(current, track, times.get(id) ?? first)
      if (next === current) result.present += 1
      else result.queued += 1
      return next
    })
    this.#schedule()
    return result
  }

  /** Pauses a queued or running download. Resolves with the record, or `undefined`. */
  pause(id: string): Promise<DownloadRecord | undefined> {
    return this.#transition(id, ['queued', 'downloading'], 'paused')
  }

  /** Resumes a paused or failed download, from the bytes already stored. */
  resume(id: string): Promise<DownloadRecord | undefined> {
    return this.#transition(id, ['paused', 'failed'], 'queued')
  }

  /** Retries a failed download: the same as {@link resume}. */
  retry(id: string): Promise<DownloadRecord | undefined> {
    return this.#transition(id, ['failed'], 'queued')
  }

  /**
   * Cancels or deletes a download: it disappears from lists at once, and the manager that runs
   * the queue deletes its file and then its record, announcing `removed`. Resolves with the
   * record as it was, or `undefined` when there was none.
   */
  async remove(id: string): Promise<DownloadRecord | undefined> {
    const [record] = await this.removeMany([id])
    return record
  }

  /**
   * Cancels or deletes the downloads `ids` (see {@link remove}), as one change to the store.
   * Resolves with the records as they were.
   */
  async removeMany(ids: readonly string[]): Promise<DownloadRecord[]> {
    const now = this.#now()
    const removed: DownloadRecord[] = []
    await this.#store.updateMany(ids, (current) => {
      if (current === undefined || current.status === 'removing') return current
      removed.push(current)
      return { ...current, status: 'removing', updatedAt: now }
    })
    this.#schedule()
    return removed
  }

  /** Pauses every queued and running download. */
  async pauseAll(): Promise<void> {
    await this.#transitionAll(['queued', 'downloading'], 'paused')
  }

  /** Resumes every paused download, and retries every failed one. */
  async resumeAll(): Promise<void> {
    await this.#transitionAll(['paused', 'failed'], 'queued')
  }

  /**
   * Cancels or deletes every download (see {@link remove}), as one change to the store, and
   * deletes the rows the store can't read (written by a newer FXM, or damaged) with them: their
   * files go at the next start's tidy-up, once no row names them. Resolves with the records
   * removed, oldest first.
   */
  async removeAll(): Promise<DownloadRecord[]> {
    const rows = await this.#store.rows()
    const now = this.#now()
    const removed: DownloadRecord[] = []
    await this.#store.updateMany(
      rows.map((row) => row.id),
      (current) => {
        if (current === undefined) return null
        if (current.status === 'removing') return current
        removed.push(current)
        return { ...current, status: 'removing', updatedAt: now }
      },
    )
    this.#schedule()
    return removed.sort(queueOrder)
  }

  // --- Reading (any tab) ----------------------------------------------------------------------

  /** Every download that isn't being removed, oldest first. */
  async list(): Promise<DownloadRecord[]> {
    const records = (await this.#store.list()).filter(
      (record) => isDownloadRecord(record) && record.status !== 'removing',
    )
    return records.sort(queueOrder)
  }

  /** The download of `track`, unless there is none or it is being removed. */
  async get(track: Pick<Track, 'id'>): Promise<DownloadRecord | undefined> {
    const record = await this.#store.get(downloadId(track))
    return isDownloadRecord(record) && record.status !== 'removing' ? record : undefined
  }

  /** Adds a listener for one {@link DownloadEventMap} event. Returns a function that removes it. */
  on<K extends keyof DownloadEventMap>(
    type: K,
    listener: Listener<DownloadEventMap[K]>,
  ): () => void {
    return this.#events.on(type, listener)
  }

  // --- Running the queue (one manager at a time) ----------------------------------------------

  /** Whether this manager runs the queue. */
  get running(): boolean {
    return this.#running
  }

  /**
   * Starts running the queue: from now on this manager fetches queued downloads, follows the
   * store for commands from any tab, and deletes removed downloads. First it tidies up after a
   * manager that stopped without warning (a closed tab): downloads that were running are queued
   * again and continue where their files end, completed downloads whose file is gone fail as
   * `file-missing`, and files no stored row names (valid or not) are deleted.
   */
  async start(): Promise<void> {
    if (this.#stopping !== undefined) await this.#stopping
    if (this.#running) return
    this.#running = true
    this.#starting = true
    this.#unsubscribe = [
      this.#store.subscribe(() => this.#schedule()),
      this.#network.subscribe(() => this.#schedule()),
    ]
    try {
      await this.#tidy()
    } catch {
      // Tidying is best effort; the queue runs anyway.
    } finally {
      this.#starting = false
    }
    this.#schedule()
  }

  /**
   * Stops running the queue: running downloads stop where they are (they stay `downloading`, so
   * the next manager to start continues them) and nothing new starts. Resolves when they have
   * stopped, including any that a pass over the queue was starting just then.
   */
  stop(): Promise<void> {
    if (this.#stopping !== undefined) return this.#stopping
    if (!this.#running) return Promise.resolve()
    this.#running = false
    for (const unsubscribe of this.#unsubscribe) unsubscribe()
    this.#unsubscribe = []
    this.#clearWake()
    const stopping: Promise<void> = this.#halt().finally(() => {
      if (this.#stopping === stopping) this.#stopping = undefined
    })
    this.#stopping = stopping
    return stopping
  }

  /**
   * Resolves once nothing runs or waits to run: no download in progress and no pass over the
   * queue pending. Downloads waiting out a retry delay in their slot count as running, so with
   * fake timers, advance the clock first. Downloads held back (a throttle, a long `Retry-After`)
   * are queued, and don't count.
   */
  async idle(): Promise<void> {
    for (;;) {
      const pending = [...this.#jobs.values()].map((job) => job.done)
      if (this.#passing !== undefined) pending.push(this.#passing)
      if (pending.length === 0) {
        // Store notifications arrive in microtasks and may schedule another pass.
        for (let turn = 0; turn < 5; turn += 1) await Promise.resolve()
        if (this.#jobs.size === 0 && this.#passing === undefined) return
        continue
      }
      await Promise.allSettled(pending)
    }
  }

  /** Stops the queue and removes every listener. */
  async destroy(): Promise<void> {
    await this.stop()
    this.#events.clear()
  }

  /** Aborts every running download and waits for it, and for a pass that may start one. */
  async #halt(): Promise<void> {
    for (;;) {
      const jobs = [...this.#jobs.values()]
      for (const job of jobs) job.abort('stopped')
      const pending: Promise<unknown>[] = jobs.map((job) => job.done)
      if (this.#passing !== undefined) pending.push(this.#passing)
      if (pending.length === 0) return
      await Promise.allSettled(pending)
    }
  }

  // --- Commands, internally -------------------------------------------------------------------

  async #transition(
    id: string,
    from: readonly DownloadStatus[],
    to: DownloadStatus,
  ): Promise<DownloadRecord | undefined> {
    const now = this.#now()
    const record = await this.#store.update(id, (current) => moved(current, from, to, now))
    this.#schedule()
    return record?.status === 'removing' ? undefined : record
  }

  /**
   * Moves every download in one of `from` to `to`, as one change to the store: only those `only`
   * accepts, and with `error` as the reason (a pause on the manager's own account).
   */
  async #transitionAll(
    from: readonly DownloadStatus[],
    to: DownloadStatus,
    options: { error?: DownloadError; only?: (record: DownloadRecord) => boolean } = {},
  ): Promise<void> {
    const { error, only = () => true } = options
    const ids = (await this.#store.list(from))
      .filter((record) => isDownloadRecord(record) && only(record))
      .map((record) => record.id)
    if (ids.length === 0) return
    const now = this.#now()
    await this.#store.updateMany(ids, (current) =>
      current === undefined || only(current) ? moved(current, from, to, now, error) : current,
    )
    this.#schedule()
  }

  // --- The queue ------------------------------------------------------------------------------

  /** Runs a pass over the queue soon, unless one is running: then once more after it. */
  #schedule(): void {
    if (!this.#running || this.#starting) return
    if (this.#passing !== undefined) {
      this.#again = true
      return
    }
    this.#passing = this.#pass()
      .catch(() => {
        // The store failed (e.g. IndexedDB went away); the next change tries again.
      })
      .finally(() => {
        this.#passing = undefined
        if (this.#again) {
          this.#again = false
          this.#schedule()
        }
      })
  }

  /** Until when `record` waits before it may start: its lane's hold, or its own wait. */
  #waitUntil(record: DownloadRecord): number {
    const lane = this.#holds.get(downloadLane(record.track)) ?? 0
    return Math.max(lane, this.#notBefore.get(record.id) ?? 0)
  }

  /** Makes every download of `lane` wait until `until`. */
  #hold(lane: string, until: number): void {
    this.#holds.set(lane, Math.max(this.#holds.get(lane) ?? 0, until))
  }

  /** Runs a pass at `at`, unless one is due sooner. */
  #wakeUp(at: number): void {
    if (!this.#running || at >= this.#wakeAt) return
    this.#clearWake()
    this.#wakeAt = at
    this.#wakeTimer = setTimeout(
      () => {
        this.#wakeTimer = undefined
        this.#wakeAt = Number.POSITIVE_INFINITY
        this.#schedule()
      },
      Math.max(0, at - this.#now()),
    )
  }

  #clearWake(): void {
    if (this.#wakeTimer !== undefined) clearTimeout(this.#wakeTimer)
    this.#wakeTimer = undefined
    this.#wakeAt = Number.POSITIVE_INFINITY
  }

  /**
   * One pass: stop downloads the store no longer has running (paused or removed, maybe from
   * another tab), delete removed downloads that don't run, and start queued ones, oldest first,
   * while there is room and the device is online, skipping those held back until their time.
   * It reads only the downloads on their way (not the completed ones).
   */
  async #pass(): Promise<void> {
    const records = (await this.#store.list(ACTIVE_STATUSES)).filter(isDownloadRecord)
    const byId = new Map(records.map((record) => [record.id, record]))
    for (const [id, job] of this.#jobs) {
      const record = byId.get(id)
      if (record?.status === 'removing') job.abort('removed')
      else if (record?.status === 'paused') job.abort('paused')
      else if (record?.status !== 'downloading') job.abort('stopped')
    }
    const removing = records
      .filter((record) => record.status === 'removing' && !this.#jobs.has(record.id))
      .map((record) => record.id)
    if (removing.length > 0) await this.#cleanUp(removing)
    if (!this.#network.online) return
    const now = this.#now()
    let wake = Number.POSITIVE_INFINITY
    const waiting = records
      .filter((record) => record.status === 'queued' && !this.#jobs.has(record.id))
      .sort(queueOrder)
    for (const record of waiting) {
      if (!this.#running || this.#jobs.size >= this.#config.concurrency) break
      const until = this.#waitUntil(record)
      if (until > now) {
        wake = Math.min(wake, until)
        continue
      }
      const started = await this.#store.update(record.id, (current) =>
        current?.status === 'queued'
          ? { ...current, status: 'downloading', updatedAt: now }
          : current,
      )
      if (started?.status !== 'downloading' || this.#jobs.has(started.id)) continue
      if (!this.#running) {
        // stop() came while this one was starting: leave it queued for the next manager.
        await this.#store.update(started.id, (current) =>
          current?.status === 'downloading'
            ? { ...current, status: 'queued', updatedAt: now }
            : current,
        )
        break
      }
      this.#notBefore.delete(started.id)
      this.#run(started)
    }
    if (wake !== Number.POSITIVE_INFINITY) this.#wakeUp(wake)
  }

  /**
   * Deletes removed downloads: their records first (those still `removing`, in one change), then
   * their files, announcing each.
   */
  async #cleanUp(ids: readonly string[]): Promise<void> {
    const taken: DownloadRecord[] = []
    await this.#store.updateMany(ids, (current) => {
      if (current?.status !== 'removing') return current
      taken.push(current)
      return null
    })
    for (const record of taken) {
      this.#notBefore.delete(record.id)
      // A file that can't go now (another tab reads it, the storage is stuck) has no record
      // left: the next start's tidy-up deletes it.
      if (record.file !== undefined) {
        await settle(this.#storage.remove(record.file), STORAGE_WAIT_MS)
      }
      this.#events.emit('removed', record)
    }
  }

  /**
   * Tidies up after a manager that stopped without warning: see {@link start}. Files are
   * compared with the stored rows only now, before any download runs, so no new file is
   * mistaken for an orphan, and with every row, so a file that a row this version can't read
   * (a newer FXM's) still names is never deleted.
   */
  async #tidy(): Promise<void> {
    const now = this.#now()
    const rows = await this.#store.rows()
    const records = (await this.#store.list()).filter(isDownloadRecord)
    const interrupted = records
      .filter((record) => record.status === 'downloading' && !this.#jobs.has(record.id))
      .map((record) => record.id)
    if (interrupted.length > 0) {
      await this.#store.updateMany(interrupted, (current) =>
        current?.status === 'downloading'
          ? { ...current, status: 'queued', updatedAt: now }
          : current,
      )
    }
    let files: Set<string>
    try {
      files = new Set(await this.#storage.list())
    } catch {
      return
    }
    const missing = records
      .filter(
        (record) =>
          record.status === 'completed' && (record.file === undefined || !files.has(record.file)),
      )
      .map((record) => record.id)
    if (missing.length > 0) {
      await this.#store.updateMany(missing, (current) => {
        if (current?.status !== 'completed') return current
        return {
          ...withoutProgress(current),
          status: 'failed',
          updatedAt: now,
          error: { code: 'file-missing', message: 'The downloaded file is gone', at: now },
        }
      })
    }
    const named = new Set(rows.flatMap((row) => (row.file === undefined ? [] : [row.file])))
    for (const file of files) {
      if (!named.has(file)) await settle(this.#storage.remove(file), STORAGE_WAIT_MS)
    }
  }

  // --- One download ---------------------------------------------------------------------------

  #run(record: DownloadRecord): void {
    const controller = new AbortController()
    const job: Job = {
      id: record.id,
      controller,
      done: Promise.resolve(),
      bytes: record.bytesDone,
      facts: {},
      savedAt: this.#now(),
      saving: false,
      abort(reason) {
        if (!controller.signal.aborted) {
          controller.abort(new DOMException(`The download was ${reason}`, 'AbortError'))
        }
      },
    }
    this.#jobs.set(record.id, job)
    job.done = this.#download(record, job)
      .catch(async (error: unknown) => {
        if (controller.signal.aborted) return
        // A bug, not a download problem: fail the download rather than spin.
        await this.#fail(job, 'unknown', error).catch(() => {})
      })
      .finally(() => {
        this.#jobs.delete(record.id)
        this.#schedule()
      })
  }

  /** Opens the download's file, giving up when the job stops first (the late writer is closed). */
  async #open(file: string, job: Job): Promise<DownloadWriter> {
    const { signal } = job.controller
    const opening = this.#storage.open(file)
    opening.then(
      (late) => {
        if (signal.aborted) late.close().catch(() => {})
      },
      () => {},
    )
    return guardWriter(await untilAborted(opening, signal), signal, (end) => {
      job.bytes = Math.max(job.bytes, end)
    })
  }

  /** The download loop: resolve, open the file, transfer, and handle each failure by its kind. */
  async #download(initial: DownloadRecord, job: Job): Promise<void> {
    const { signal } = job.controller
    const config = this.#config
    let record = initial
    let attempts = initial.attempts
    let refreshes = 0
    let restarts = 0
    let reason: DownloadResolveReason = initial.file === undefined ? 'start' : 'resume'
    let resolved: ResolvedDownload | undefined
    const failedUrls = new Set<string>()
    // One name for the whole run, also when opening the file has to be tried again.
    const file = initial.file ?? this.#createFileName()
    if (!isSafeFileName(file)) {
      throw new TypeError(`${JSON.stringify(file)} is not a download file name`)
    }
    let writer: DownloadWriter | undefined
    try {
      for (;;) {
        signal.throwIfAborted()
        const ctx: ProviderContext = { ...this.#context(), signal }
        // Where this attempt's transfer started, once it did: bytes past it are progress.
        let from: number | undefined
        try {
          const availability = downloadAvailability(record.track, ctx)
          if (!availability.available) {
            throw new FxmError('Unsupported', `Can't download here (${availability.reason})`)
          }
          const expiresAt = resolved?.stream.expiresAt
          if (expiresAt !== undefined && expiresAt - this.#now() < EXPIRY_MARGIN_MS) {
            resolved = undefined
          }
          if (resolved === undefined) {
            resolved = await this.#resolver.resolve(record.track, {
              ctx,
              prefs: this.#prefs(),
              reason,
              attempt: refreshes,
              exclude: failedUrls,
              signal,
              ...(record.candidate === undefined ? {} : { candidate: record.candidate }),
              ...(record.format === undefined ? {} : { format: record.format }),
            })
            if (!isDownloadableStream(resolved.candidate, resolved.stream)) {
              throw new NoDownloadableStreamError('unverified', 'The stream was not verified')
            }
          }
          const { candidate, stream } = resolved
          const format = fileFormatOf(stream)
          writer ??= await this.#open(file, job)
          const otherAudio =
            record.candidate !== undefined && !sameCandidate(record.candidate, candidate)
          const otherFormat = record.format !== undefined && !sameFileFormat(record.format, format)
          let start = await writer.size()
          if (
            otherAudio ||
            otherFormat ||
            (record.bytesTotal !== undefined && start > record.bytesTotal)
          ) {
            // The stored bytes belong to another file: start this one over.
            await writer.truncate(0)
            start = 0
            record = withoutProgress(record)
            job.facts = {}
          }
          // What earlier answers told about the file, saved or not yet.
          const total = record.bytesTotal ?? job.facts.total
          const validator = record.validator ?? job.facts.validator
          job.bytes = start
          from = start
          record = await this.#save(job, (current) => ({
            ...withoutProgress(current),
            file,
            candidate,
            format,
            bytesDone: start,
            ...(total === undefined ? {} : { bytesTotal: total }),
            ...(validator === undefined ? {} : { validator }),
          }))
          const result = await transfer({
            fetch: ctx.fetch,
            url: stream.url,
            ...(stream.requestHeaders === undefined ? {} : { headers: stream.requestHeaders }),
            writer,
            start,
            ...(total === undefined ? {} : { total }),
            ...(validator === undefined ? {} : { validator }),
            chunkBytes: config.chunkBytes,
            maxBytes: maxDownloadBytes(format, candidate.durationMs ?? record.track.durationMs),
            signal,
            onProgress: (bytes) => this.#progress(job, bytes),
            onFacts: (facts) => {
              job.facts = { ...job.facts, ...facts }
            },
          })
          await writer.flush()
          // A close that fails leaves no writer behind: the next attempt opens the file afresh,
          // finds it complete and completes it.
          const done = writer
          writer = undefined
          await done.close()
          await this.#complete(job, result.total, result.validator)
          return
        } catch (caught) {
          if (signal.aborted) throw caught
          let error = caught
          if (
            caught instanceof DownloadNetworkError &&
            caught.phase === 'request' &&
            resolved?.stream.ipBound === true &&
            this.#network.online
          ) {
            // On the web, a request to a signed URL that got no answer may be bytes the browser
            // won't let the page read (a googlevideo redirect with an older FXM Connect): a quick
            // check tells, so the download fails at once with the reason instead of resolving
            // afresh again and again in vain.
            error = (await unreadableStream(resolved.stream.url, ctx, signal)) ?? caught
          }
          const failure = classifyDownloadFailure(error, {
            online: this.#network.online,
            ipBound: resolved?.stream.ipBound ?? false,
            platform: ctx.platform,
          })
          // An attempt that stored bytes shows that the URL and the connection work: only
          // failures in a row without progress count towards the limits.
          if (from !== undefined && job.bytes > from) {
            attempts = 0
            refreshes = 0
          }
          if (failure.kind === 'fatal') {
            if (failure.code === 'too-large' && writer !== undefined) {
              // Nothing of a file over the limit is kept.
              await writer.truncate(0).catch(() => {})
              job.bytes = 0
              job.facts = {}
              record = await this.#save(job, withoutProgress)
            }
            await this.#fail(job, failure.code, error)
            return
          }
          if (failure.kind === 'throttled') {
            // The request budget or a source asks to slow down: give the slot back, and hold
            // every download of the same lane, so none of them asks again before its time.
            const w = DOWNLOAD_WAITS
            const wait = clamp(
              failure.retryAfterMs ?? w.throttleWaitMs,
              w.minThrottleWaitMs,
              w.maxThrottleWaitMs,
            )
            this.#hold(downloadLane(record.track), this.#now() + wait)
            await this.#requeue(job)
            return
          }
          if (failure.kind === 'offline') {
            // A new network may mean a new IP address, which signed URLs are bound to.
            resolved = undefined
            reason = 'refresh'
            await this.#waitOnline(signal)
            continue
          }
          if (failure.kind === 'url') {
            if (resolved !== undefined) failedUrls.add(resolved.stream.url)
            resolved = undefined
            reason = 'refresh'
            refreshes += 1
            if (refreshes > config.maxRefreshes) {
              await this.#fail(job, failure.code, error)
              return
            }
            continue
          }
          if (failure.kind === 'restart') {
            restarts += 1
            if (restarts > config.maxRestarts) {
              await this.#fail(job, failure.code, error)
              return
            }
            await writer?.truncate(0)
            job.bytes = 0
            job.facts = {}
            record = await this.#save(job, withoutProgress)
            resolved = undefined
            reason = 'start'
            continue
          }
          attempts += 1
          const retryAfter = failure.retryAfterMs
          if (
            attempts >= config.maxAttempts ||
            (retryAfter !== undefined && retryAfter > DOWNLOAD_WAITS.maxRetryAfterMs)
          ) {
            await this.#fail(job, failure.code, error, attempts)
            return
          }
          const wait =
            retryAfter ??
            config.retryDelaysMs[Math.min(attempts - 1, config.retryDelaysMs.length - 1)] ??
            0
          if (wait > DOWNLOAD_WAITS.maxSlotWaitMs) {
            // A long wait gives the slot back, so downloads from other hosts go on meanwhile.
            this.#notBefore.set(job.id, this.#now() + wait)
            await this.#requeue(job, attempts)
            return
          }
          const saved = attempts
          record = await this.#save(job, (current) => ({ ...current, attempts: saved }))
          await delay(wait, signal)
        }
      }
    } finally {
      await settle(writer?.close(), STORAGE_WAIT_MS)
      if (signal.aborted) await this.#saveStopped(job).catch(() => {})
    }
  }

  /**
   * Queues a running download again, keeping its progress, so it gives its slot back while it
   * waits (see {@link #waitUntil}).
   */
  async #requeue(job: Job, attempts?: number): Promise<void> {
    const now = this.#now()
    const { total, validator } = job.facts
    await this.#store.update(job.id, (current) => {
      if (current?.status !== 'downloading') return current
      return {
        ...current,
        status: 'queued',
        updatedAt: now,
        bytesDone: job.bytes,
        ...(attempts === undefined ? {} : { attempts }),
        ...(total === undefined ? {} : { bytesTotal: total }),
        ...(validator === undefined ? {} : { validator }),
      }
    })
  }

  /**
   * Saves how far a download got when it stopped early: a paused download shows its progress,
   * and the next run starts there (it reads the file's size anyway).
   */
  async #saveStopped(job: Job): Promise<void> {
    const { total, validator } = job.facts
    await this.#store.update(job.id, (current) => {
      if (current?.status !== 'paused' && current?.status !== 'downloading') return current
      if (
        current.bytesDone === job.bytes &&
        (total === undefined || current.bytesTotal === total)
      ) {
        return current
      }
      return {
        ...current,
        bytesDone: job.bytes,
        ...(total === undefined ? {} : { bytesTotal: total }),
        ...(validator === undefined ? {} : { validator }),
      }
    })
  }

  /**
   * Saves a change to the running download's record. When the record no longer runs (paused or
   * removed from any tab), the job stops at once instead.
   */
  async #save(
    job: Job,
    change: (current: DownloadRecord) => DownloadRecord,
  ): Promise<DownloadRecord> {
    const next = await this.#store.update(job.id, (current) =>
      current?.status === 'downloading' ? change(current) : current,
    )
    if (next?.status !== 'downloading') {
      if (next === undefined || next.status === 'removing') job.abort('removed')
      else if (next.status === 'paused') job.abort('paused')
      else job.abort('stopped')
      job.controller.signal.throwIfAborted()
    }
    return next as DownloadRecord
  }

  /** Saves progress at most every `progressIntervalMs`, one write at a time. */
  #progress(job: Job, bytes: number): void {
    job.bytes = bytes
    const now = this.#now()
    if (job.saving || now - job.savedAt < this.#config.progressIntervalMs) return
    job.savedAt = now
    job.saving = true
    const { total, validator } = job.facts
    this.#save(job, (current) => ({
      ...current,
      bytesDone: job.bytes,
      updatedAt: now,
      ...(total === undefined ? {} : { bytesTotal: total }),
      ...(validator === undefined ? {} : { validator }),
    }))
      .catch(() => {
        // Paused or removed: the job has stopped. A store error: the next save tries again.
      })
      .finally(() => {
        job.saving = false
      })
  }

  async #complete(job: Job, total: number, validator: string | undefined): Promise<void> {
    const now = this.#now()
    const done = await this.#store.update(job.id, (current) => {
      if (current?.status !== 'downloading') return current
      return {
        ...withoutError(current),
        status: 'completed',
        completedAt: now,
        updatedAt: now,
        bytesDone: total,
        bytesTotal: total,
        attempts: 0,
        ...(validator === undefined ? {} : { validator }),
      }
    })
    if (done?.status === 'completed') this.#events.emit('completed', done)
  }

  async #fail(job: Job, code: DownloadErrorCode, error: unknown, attempts?: number): Promise<void> {
    const now = this.#now()
    const failed = await this.#store.update(job.id, (current) => {
      if (current?.status !== 'downloading') return current
      return {
        ...current,
        status: 'failed',
        updatedAt: now,
        bytesDone: Math.max(current.bytesDone, job.bytes),
        ...(attempts === undefined ? {} : { attempts }),
        error: { code, message: messageOf(error), at: now },
      }
    })
    if (failed?.status !== 'failed') return
    this.#events.emit('failed', failed)
    // With the storage full, every other download would fail the same way after spending a
    // resolution each; after a bot check, every other YouTube download would ask YouTube again
    // and make it worse. Pause them instead, saying why, until the user resumes them.
    if (code === 'storage-full') {
      await this.#transitionAll(['queued'], 'paused', {
        error: { code, message: 'Paused: the storage is full', at: now },
      })
    } else if (code === 'bot-check') {
      await this.#transitionAll(['queued'], 'paused', {
        error: { code, message: 'Paused: YouTube asked for a bot check', at: now },
        only: (record) => downloadLane(record.track) === 'youtube',
      })
    }
  }

  /** Waits until the device is online, or the job stops. */
  #waitOnline(signal: AbortSignal): Promise<void> {
    if (this.#network.online) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const done = () => {
        stop()
        signal.removeEventListener('abort', onAbort)
      }
      const onAbort = () => {
        done()
        reject(signal.reason)
      }
      const stop = this.#network.subscribe(() => {
        if (!this.#network.online) return
        done()
        resolve()
      })
      signal.addEventListener('abort', onAbort, { once: true })
    })
  }
}
