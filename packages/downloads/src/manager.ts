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
  isDownloadableStream,
} from './availability'
import { Emitter, type Listener } from './emitter'
import { classifyDownloadFailure } from './recovery'
import {
  type DownloadResolveReason,
  type DownloadResolver,
  NoDownloadableStreamError,
  type ResolvedDownload,
} from './resolver'
import type { DownloadStorage, DownloadWriter } from './storage'
import type { DownloadStore } from './store'
import { type TransferFacts, transfer } from './transfer'
import {
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
   * The provider context downloads run with, read afresh for every attempt: its `fetch` fetches
   * the bytes, and its capabilities decide what may be downloaded at all.
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
  /** How many passing failures (network, busy server) end a download. Default: 5. */
  maxAttempts?: number
  /** How many fresh resolutions one run may take before it gives up. Default: 3. */
  maxRefreshes?: number
  /** How many times one run may start its file over. Default: 2. */
  maxRestarts?: number
  /** The waits before each retry after a passing failure. Default: 1 s, 3 s, 10 s, 30 s. */
  retryDelaysMs?: readonly number[]
  /** How often a running download saves its progress to the store. Default: 500 ms. */
  progressIntervalMs?: number
  /** The clock, in epoch milliseconds. Default: `Date.now`. */
  now?: () => number
  /** A new, unique file name for a download's file. Default: a random UUID. */
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

/** Stop using a URL this close to its expiry, and resolve afresh instead. */
const EXPIRY_MARGIN_MS = 60_000

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

function positive(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback
}

function count(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isInteger(value) && value >= 0 ? value : fallback
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const REQUEUE_FROM: readonly DownloadStatus[] = ['paused', 'failed', 'removing']

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
  #running = false
  #starting = false
  #passing: Promise<void> | undefined
  #again = false
  #unsubscribe: (() => void)[] = []

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

  /** Whether `track` can be downloaded with the current capabilities and catalog mode. */
  availability(track: Track): DownloadAvailability {
    return downloadAvailability(track, this.#context())
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
    const record = await this.#store.update(downloadId(track), (current) => {
      if (current === undefined) return newDownloadRecord(track, now)
      if (!REQUEUE_FROM.includes(current.status)) return current
      return { ...withoutError(current), track, status: 'queued', attempts: 0, updatedAt: now }
    })
    this.#schedule()
    if (record === undefined) throw new Error(`The store lost the download of "${track.title}"`)
    return record
  }

  /**
   * Queues every track of `tracks` that can be downloaded here and isn't downloaded or on its
   * way already, in order (e.g. "Download all" on a playlist).
   */
  async enqueueAll(tracks: readonly Track[]): Promise<EnqueueAllResult> {
    const result: EnqueueAllResult = { queued: 0, present: 0, skipped: 0 }
    const seen = new Set<string>()
    let at = this.#now()
    for (const track of tracks) {
      const id = downloadId(track)
      if (seen.has(id)) continue
      seen.add(id)
      if (!this.availability(track).available) {
        result.skipped += 1
        continue
      }
      // Distinct times keep the queue in the order of the list.
      const now = Math.max(this.#now(), at)
      at = now + 1
      const change = { queued: false }
      await this.#store.update(id, (current) => {
        if (current === undefined) {
          change.queued = true
          return newDownloadRecord(track, now)
        }
        if (!REQUEUE_FROM.includes(current.status)) return current
        change.queued = true
        return { ...withoutError(current), track, status: 'queued', attempts: 0, updatedAt: now }
      })
      if (change.queued) result.queued += 1
      else result.present += 1
    }
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
    const now = this.#now()
    const taken: { record?: DownloadRecord } = {}
    await this.#store.update(id, (current) => {
      if (current === undefined || current.status === 'removing') return current
      taken.record = current
      return { ...current, status: 'removing', updatedAt: now }
    })
    this.#schedule()
    return taken.record
  }

  /** Pauses every queued and running download. */
  async pauseAll(): Promise<void> {
    await this.#transitionAll(['queued', 'downloading'], 'paused')
  }

  /** Resumes every paused download, and retries every failed one. */
  async resumeAll(): Promise<void> {
    await this.#transitionAll(['paused', 'failed'], 'queued')
  }

  /** Cancels or deletes every download (see {@link remove}). Resolves with the records removed. */
  async removeAll(): Promise<DownloadRecord[]> {
    const removed: DownloadRecord[] = []
    for (const record of await this.list()) {
      const before = await this.remove(record.id)
      if (before !== undefined) removed.push(before)
    }
    return removed
  }

  // --- Reading (any tab) ----------------------------------------------------------------------

  /** Every download that isn't being removed, oldest first. */
  async list(): Promise<DownloadRecord[]> {
    const records = (await this.#store.list()).filter(
      (record) => isDownloadRecord(record) && record.status !== 'removing',
    )
    return records.sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1))
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
   * `file-missing`, and files no record names are deleted.
   */
  async start(): Promise<void> {
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
   * stopped.
   */
  async stop(): Promise<void> {
    if (!this.#running) return
    this.#running = false
    for (const unsubscribe of this.#unsubscribe) unsubscribe()
    this.#unsubscribe = []
    const jobs = [...this.#jobs.values()]
    for (const job of jobs) job.abort('stopped')
    await Promise.allSettled([...jobs.map((job) => job.done), this.#passing])
  }

  /**
   * Resolves once nothing runs or waits to run: no download in progress and no pass over the
   * queue pending. Downloads waiting out a retry delay count as running, so with fake timers,
   * advance the clock first.
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

  // --- Commands, internally -------------------------------------------------------------------

  async #transition(
    id: string,
    from: readonly DownloadStatus[],
    to: DownloadStatus,
  ): Promise<DownloadRecord | undefined> {
    const now = this.#now()
    const record = await this.#store.update(id, (current) => {
      if (current === undefined || !from.includes(current.status)) return current
      const next: DownloadRecord = { ...current, status: to, updatedAt: now }
      return to === 'queued' ? { ...withoutError(next), attempts: 0 } : next
    })
    this.#schedule()
    return record?.status === 'removing' ? undefined : record
  }

  async #transitionAll(from: readonly DownloadStatus[], to: DownloadStatus): Promise<void> {
    for (const record of await this.#store.list()) {
      if (from.includes(record.status)) await this.#transition(record.id, from, to)
    }
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

  /**
   * One pass: stop downloads the store no longer has running (paused or removed, maybe from
   * another tab), delete removed downloads that don't run, and start queued ones, oldest first,
   * while there is room and the device is online.
   */
  async #pass(): Promise<void> {
    const records = (await this.#store.list()).filter(isDownloadRecord)
    const byId = new Map(records.map((record) => [record.id, record]))
    for (const [id, job] of this.#jobs) {
      const record = byId.get(id)
      if (record === undefined || record.status === 'removing') job.abort('removed')
      else if (record.status === 'paused') job.abort('paused')
      else if (record.status !== 'downloading') job.abort('stopped')
    }
    for (const record of records) {
      if (record.status === 'removing' && !this.#jobs.has(record.id)) await this.#cleanUp(record.id)
    }
    if (!this.#network.online) return
    const queued = records
      .filter((record) => record.status === 'queued' && !this.#jobs.has(record.id))
      .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1))
    for (const record of queued) {
      if (!this.#running || this.#jobs.size >= this.#config.concurrency) break
      const now = this.#now()
      const started = await this.#store.update(record.id, (current) =>
        current?.status === 'queued'
          ? { ...current, status: 'downloading', updatedAt: now }
          : current,
      )
      if (started?.status === 'downloading' && !this.#jobs.has(started.id)) this.#run(started)
    }
  }

  /** Deletes a removed download: its record first (if still `removing`), then its file. */
  async #cleanUp(id: string): Promise<void> {
    const taken: { record?: DownloadRecord } = {}
    await this.#store.update(id, (current) => {
      if (current?.status !== 'removing') return current
      taken.record = current
      return null
    })
    const { record } = taken
    if (record === undefined) return
    if (record.file !== undefined) {
      // A file that can't go now (another tab reads it) has no record left: the next start's
      // tidy-up deletes it.
      await this.#storage.remove(record.file).catch(() => {})
    }
    this.#events.emit('removed', record)
  }

  /**
   * Tidies up after a manager that stopped without warning: see {@link start}. Files are
   * compared with the records only now, before any download runs, so no new file is mistaken
   * for an orphan.
   */
  async #tidy(): Promise<void> {
    const now = this.#now()
    const records = (await this.#store.list()).filter(isDownloadRecord)
    for (const record of records) {
      if (record.status === 'downloading' && !this.#jobs.has(record.id)) {
        await this.#store.update(record.id, (current) =>
          current?.status === 'downloading'
            ? { ...current, status: 'queued', updatedAt: now }
            : current,
        )
      }
    }
    let files: Set<string>
    try {
      files = new Set(await this.#storage.list())
    } catch {
      return
    }
    for (const record of records) {
      if (record.status !== 'completed') continue
      if (record.file !== undefined && files.has(record.file)) continue
      await this.#store.update(record.id, (current) => {
        if (current?.status !== 'completed') return current
        return {
          ...withoutProgress(current),
          status: 'failed',
          updatedAt: now,
          error: { code: 'file-missing', message: 'The downloaded file is gone', at: now },
        }
      })
    }
    const named = new Set(
      records.flatMap((record) => (record.file === undefined ? [] : [record.file])),
    )
    for (const file of files) {
      if (!named.has(file)) await this.#storage.remove(file).catch(() => {})
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
    let writer: DownloadWriter | undefined
    try {
      for (;;) {
        signal.throwIfAborted()
        const ctx: ProviderContext = { ...this.#context(), signal }
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
          writer ??= await this.#storage.open(file)
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
            signal,
            onProgress: (bytes) => this.#progress(job, bytes),
            onFacts: (facts) => {
              job.facts = { ...job.facts, ...facts }
            },
          })
          await writer.flush()
          await writer.close()
          writer = undefined
          await this.#complete(job, result.total, result.validator)
          return
        } catch (error) {
          if (signal.aborted) throw error
          const failure = classifyDownloadFailure(error, {
            online: this.#network.online,
            ipBound: resolved?.stream.ipBound ?? false,
          })
          if (failure.kind === 'fatal') {
            await this.#fail(job, failure.code, error)
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
          if (attempts >= config.maxAttempts) {
            await this.#fail(job, failure.code, error, attempts)
            return
          }
          const saved = attempts
          record = await this.#save(job, (current) => ({ ...current, attempts: saved }))
          const wait =
            failure.retryAfterMs ??
            config.retryDelaysMs[Math.min(attempts - 1, config.retryDelaysMs.length - 1)] ??
            0
          await delay(wait, signal)
        }
      }
    } finally {
      await writer?.close().catch(() => {})
      if (signal.aborted) await this.#saveStopped(job).catch(() => {})
    }
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
    // With the storage full, every other download would fail the same way, after spending a
    // resolution each: pause them instead, so they continue once there is room.
    if (code === 'storage-full') await this.#transitionAll(['queued'], 'paused')
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
