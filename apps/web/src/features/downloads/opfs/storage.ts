/**
 * Download files in the Origin Private File System: a `DownloadStorage` for the web app. The
 * OPFS worker writes them (sync access handles exist only in workers); the page lists them,
 * reads them and hands the player a `blob:` URL of a complete file.
 *
 * @module
 */

import {
  assertSafeFileName,
  type DownloadStorage,
  type DownloadWriter,
  storageFullError,
  storageUnavailableError,
} from '@fxm/downloads'
import {
  type DirectoryHandleLike,
  DOWNLOADS_FOLDER,
  type OpfsAnswer,
  type OpfsMessage,
  type OpfsRequest,
} from './protocol'

/** How the storage reaches the worker. Tests pass one that runs the handler in-process. */
export interface OpfsChannel {
  /** Sends `request`, transferring `transfer`, and resolves with the worker's value. */
  request(request: OpfsRequest, transfer?: Transferable[]): Promise<number | undefined>
}

/** The parts of a `Worker` the channel uses. */
export interface WorkerLike {
  postMessage(message: OpfsMessage, transfer: Transferable[]): void
  addEventListener(type: 'message', listener: (event: MessageEvent<OpfsAnswer>) => void): void
  addEventListener(type: 'error' | 'messageerror', listener: (event: Event) => void): void
  terminate?(): void
}

/** How long the worker may take over one request before it counts as stuck: 30 s. */
export const WORKER_TIMEOUT_MS = 30_000

/** Options for {@link createWorkerChannel}. */
export interface WorkerChannelOptions {
  /** How long one request may take. Default: {@link WORKER_TIMEOUT_MS}. */
  timeoutMs?: number
}

interface Waiting {
  resolve: (value: number | undefined) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

/**
 * A channel to the OPFS worker that `createWorker` starts on first use. Answers are matched to
 * requests by ID. A worker that fails (it can't load, e.g. its script is gone after an update;
 * it crashes; a message can't be read) or that stops answering for `timeoutMs` is terminated:
 * every request waiting for it rejects with `storageUnavailableError` (the download fails as
 * `storage` instead of waiting for good), and the next request starts a fresh worker.
 */
export function createWorkerChannel(
  createWorker: () => WorkerLike,
  options: WorkerChannelOptions = {},
): OpfsChannel {
  const timeoutMs = options.timeoutMs ?? WORKER_TIMEOUT_MS
  let current: { worker: WorkerLike; waiting: Map<number, Waiting> } | undefined
  let nextId = 0
  const stopWorker = (session: NonNullable<typeof current>, error: Error) => {
    if (current === session) current = undefined
    try {
      session.worker.terminate?.()
    } catch {
      // Gone already.
    }
    for (const waiting of session.waiting.values()) {
      clearTimeout(waiting.timer)
      waiting.reject(error)
    }
    session.waiting.clear()
  }
  const start = () => {
    if (current !== undefined) return current
    const worker = createWorker()
    const session = { worker, waiting: new Map<number, Waiting>() }
    worker.addEventListener('message', (event: MessageEvent<OpfsAnswer>) => {
      const { id, reply } = event.data
      const waiting = session.waiting.get(id)
      if (waiting === undefined) return
      session.waiting.delete(id)
      clearTimeout(waiting.timer)
      if (reply.ok) waiting.resolve(reply.value)
      else waiting.reject(new DOMException(reply.message, reply.name))
    })
    const failed = () => stopWorker(session, storageUnavailableError('The storage worker failed'))
    worker.addEventListener('error', failed)
    worker.addEventListener('messageerror', failed)
    current = session
    return session
  }
  return {
    request(request, transfer = []) {
      const session = start()
      nextId += 1
      const id = nextId
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () =>
            stopWorker(session, storageUnavailableError('The storage worker stopped answering')),
          timeoutMs,
        )
        session.waiting.set(id, { resolve, reject, timer })
        try {
          session.worker.postMessage({ id, request }, transfer)
        } catch (error) {
          session.waiting.delete(id)
          clearTimeout(timer)
          reject(error instanceof Error ? error : new Error(String(error)))
        }
      })
    },
  }
}

/** How much a storage estimate says FXM uses, and may use, in bytes. */
export interface StorageRoom {
  usage: number
  quota: number
}

/**
 * The room downloads leave for the rest of FXM (the library, its backups, caches), which
 * shares the browser's quota: the smaller of 10 % of the quota and 200 MB. A download that would
 * leave less fails as `storage-full`, and the queue pauses, before the library's own writes can.
 */
export function headroomBytes(quota: number): number {
  return Math.min(quota * 0.1, 200 * 1000 * 1000)
}

/** How many bytes a writer writes between two checks of the room left. */
export const ROOM_CHECK_BYTES = 8 * 1024 * 1024

/** Options for {@link createOpfsStorage}. */
export interface OpfsStorageOptions {
  /** The worker that writes files. */
  channel: OpfsChannel
  /** The Origin Private File System's root folder: `navigator.storage.getDirectory()`. */
  root: () => Promise<DirectoryHandleLike>
  /**
   * How much of the quota FXM uses (`navigator.storage.estimate()`), to keep
   * {@link headroomBytes} free: checked when a file opens and every {@link ROOM_CHECK_BYTES}
   * written. Leave it out (or resolve `undefined`) to check nothing.
   */
  estimate?: () => Promise<StorageRoom | undefined>
  /** Makes a URL for a blob. Default: `URL.createObjectURL`. */
  createUrl?: (blob: Blob) => string
  /** Releases such a URL. Default: `URL.revokeObjectURL`. */
  revokeUrl?: (url: string) => void
}

/** The OPFS storage, and a way to find out whether it works in this browser at all. */
export interface OpfsStorage extends DownloadStorage {
  /**
   * Whether this browser can keep downloads here: the page and the worker reach the downloads
   * folder (a private window may refuse it) and the worker has sync access handles. Never
   * rejects.
   */
  probe(): Promise<boolean>
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && error.name === 'NotFoundError'
}

/** The media types a downloaded file may be served as: audio, the two video containers, bytes. */
const MEDIA_TYPE =
  /^(?:audio\/[a-z0-9.+-]+|video\/(?:mp4|webm)|application\/octet-stream)(?:\s*;\s*codecs="[a-z0-9., -]*")?$/i

/**
 * `type` if it is a media type a downloaded file may be served as, else
 * `application/octet-stream`: a `blob:` URL of downloaded bytes, which anyone may have uploaded
 * to a source, must never be one a browser renders as a page in FXM's origin.
 */
export function safeMediaType(type: string): string {
  return MEDIA_TYPE.test(type.trim()) ? type.trim() : 'application/octet-stream'
}

/**
 * The web app's `DownloadStorage`: files in the `downloads` folder of the Origin Private File
 * System. Writes go through the worker; listing, sizes and reads happen on the page. Each
 * complete file keeps one playback URL (a `blob:` URL of the file, typed with its media type)
 * until it is removed. File names `isSafeFileName` refuses are rejected before anything happens.
 */
export function createOpfsStorage(options: OpfsStorageOptions): OpfsStorage {
  const { channel } = options
  const createUrl = options.createUrl ?? ((blob: Blob) => URL.createObjectURL(blob))
  const revokeUrl = options.revokeUrl ?? ((url: string) => URL.revokeObjectURL(url))
  const urls = new Map<string, string>()
  let folder: Promise<DirectoryHandleLike> | undefined
  const directory = () => {
    folder ??= options
      .root()
      .then((root) => root.getDirectoryHandle(DOWNLOADS_FOLDER, { create: true }))
    // A failure (a private window) may pass: try again next time.
    folder.catch(() => {
      folder = undefined
    })
    return folder
  }
  const fileOf = async (file: string): Promise<File | undefined> => {
    try {
      const handle = await (await directory()).getFileHandle(file)
      return await handle.getFile()
    } catch (error) {
      if (isNotFound(error)) return undefined
      throw error
    }
  }
  /** Rejects as a full storage when downloads would leave the rest of FXM too little room. */
  const ensureRoom = async () => {
    const room = await options.estimate?.().catch(() => undefined)
    if (room === undefined || !(room.quota > 0)) return
    if (room.quota - room.usage < headroomBytes(room.quota)) {
      throw storageFullError('Downloads would leave too little room for the rest of FXM')
    }
  }
  return {
    async probe() {
      try {
        await directory()
        return (await channel.request({ op: 'probe' })) === 1
      } catch {
        return false
      }
    },
    async open(file) {
      assertSafeFileName(file)
      await ensureRoom()
      await channel.request({ op: 'open', file })
      let closed = false
      let unchecked = 0
      const writer: DownloadWriter = {
        async size() {
          return (await channel.request({ op: 'size', file })) ?? 0
        },
        async write(offset, bytes) {
          unchecked += bytes.length
          if (unchecked >= ROOM_CHECK_BYTES) {
            unchecked = 0
            await ensureRoom()
          }
          // A copy the worker can own: the transfer detaches it here.
          const data = bytes.slice().buffer
          await channel.request({ op: 'write', file, offset, data }, [data])
        },
        async truncate(size) {
          await channel.request({ op: 'truncate', file, size })
        },
        async flush() {
          await channel.request({ op: 'flush', file })
        },
        async close() {
          if (closed) return
          closed = true
          await channel.request({ op: 'close', file })
        },
      }
      return writer
    },
    async remove(file) {
      assertSafeFileName(file)
      const url = urls.get(file)
      if (url !== undefined) {
        urls.delete(file)
        revokeUrl(url)
      }
      await channel.request({ op: 'remove', file })
    },
    async list() {
      const names: string[] = []
      for await (const name of (await directory()).keys()) names.push(name)
      return names
    },
    async size(file) {
      assertSafeFileName(file)
      return (await fileOf(file))?.size
    },
    async read(file, type) {
      assertSafeFileName(file)
      const found = await fileOf(file)
      return found === undefined ? undefined : found.slice(0, found.size, safeMediaType(type))
    },
    async playbackUrl(file, type) {
      assertSafeFileName(file)
      const known = urls.get(file)
      if (known !== undefined) return known
      const found = await fileOf(file)
      if (found === undefined) return undefined
      // Another call may have made one while this one read the file.
      const raced = urls.get(file)
      if (raced !== undefined) return raced
      const url = createUrl(found.slice(0, found.size, safeMediaType(type)))
      urls.set(file, url)
      return url
    },
  }
}

/**
 * Whether this browser has what downloads need in the Origin Private File System: the root
 * folder and workers. Only a first check: {@link OpfsStorage.probe} finds out whether they work.
 */
export function opfsSupported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    typeof navigator.storage?.getDirectory === 'function' &&
    typeof Worker === 'function'
  )
}

/**
 * The OPFS storage of this browser, writing through `opfs/worker.ts` and keeping room for the
 * rest of FXM with `estimate`. Call only when {@link opfsSupported}.
 */
export function createBrowserOpfsStorage(
  estimate?: () => Promise<StorageRoom | undefined>,
): OpfsStorage {
  return createOpfsStorage({
    channel: createWorkerChannel(
      () =>
        new Worker(new URL('./worker.ts', import.meta.url), {
          type: 'module',
          name: 'fxm-downloads',
        }),
    ),
    root: () =>
      navigator.storage.getDirectory() as Promise<unknown> as Promise<DirectoryHandleLike>,
    ...(estimate === undefined ? {} : { estimate }),
  })
}
