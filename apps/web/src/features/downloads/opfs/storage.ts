/**
 * Download files in the Origin Private File System: a `DownloadStorage` for the web app. The
 * OPFS worker writes them (sync access handles exist only in workers); the page lists them,
 * reads them and hands the player a `blob:` URL of a complete file.
 *
 * @module
 */

import type { DownloadStorage, DownloadWriter } from '@fxm/downloads'
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
  addEventListener(type: 'error', listener: (event: Event) => void): void
}

/**
 * A channel to the OPFS worker that `createWorker` starts on first use. Answers are matched to
 * requests by ID; a worker that fails to start rejects every pending request.
 */
export function createWorkerChannel(createWorker: () => WorkerLike): OpfsChannel {
  let worker: WorkerLike | undefined
  let nextId = 0
  const pending = new Map<
    number,
    { resolve: (value: number | undefined) => void; reject: (error: Error) => void }
  >()
  const start = (): WorkerLike => {
    if (worker !== undefined) return worker
    const started = createWorker()
    started.addEventListener('message', (event) => {
      const { id, reply } = event.data
      const waiting = pending.get(id)
      if (waiting === undefined) return
      pending.delete(id)
      if (reply.ok) waiting.resolve(reply.value)
      else waiting.reject(new DOMException(reply.message, reply.name))
    })
    started.addEventListener('error', () => {
      for (const waiting of pending.values()) {
        waiting.reject(new DOMException('The storage worker failed', 'InvalidStateError'))
      }
      pending.clear()
    })
    worker = started
    return started
  }
  return {
    request(request, transfer = []) {
      const target = start()
      nextId += 1
      const id = nextId
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject })
        target.postMessage({ id, request }, transfer)
      })
    },
  }
}

/** Options for {@link createOpfsStorage}. */
export interface OpfsStorageOptions {
  /** The worker that writes files. */
  channel: OpfsChannel
  /** The Origin Private File System's root folder: `navigator.storage.getDirectory()`. */
  root: () => Promise<DirectoryHandleLike>
  /** Makes a URL for a blob. Default: `URL.createObjectURL`. */
  createUrl?: (blob: Blob) => string
  /** Releases such a URL. Default: `URL.revokeObjectURL`. */
  revokeUrl?: (url: string) => void
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && error.name === 'NotFoundError'
}

/**
 * The web app's `DownloadStorage`: files in the `downloads` folder of the Origin Private File
 * System. Writes go through the worker; listing, sizes and reads happen on the page. Each
 * complete file keeps one playback URL (a `blob:` URL of the file, typed with its MIME type)
 * until it is removed.
 */
export function createOpfsStorage(options: OpfsStorageOptions): DownloadStorage {
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
  return {
    async open(file) {
      await channel.request({ op: 'open', file })
      let closed = false
      const writer: DownloadWriter = {
        async size() {
          return (await channel.request({ op: 'size', file })) ?? 0
        },
        async write(offset, bytes) {
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
      return (await fileOf(file))?.size
    },
    async read(file, type) {
      const found = await fileOf(file)
      return found === undefined ? undefined : found.slice(0, found.size, type)
    },
    async playbackUrl(file, type) {
      const known = urls.get(file)
      if (known !== undefined) return known
      const found = await fileOf(file)
      if (found === undefined) return undefined
      // Another call may have made one while this one read the file.
      const raced = urls.get(file)
      if (raced !== undefined) return raced
      const url = createUrl(found.slice(0, found.size, type))
      urls.set(file, url)
      return url
    },
  }
}

/** Whether this browser can keep downloads in the Origin Private File System. */
export function opfsSupported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    typeof navigator.storage?.getDirectory === 'function' &&
    typeof Worker === 'function'
  )
}

/**
 * The OPFS storage of this browser, writing through `opfs/worker.ts`. Call only when
 * {@link opfsSupported}.
 */
export function createBrowserOpfsStorage(): DownloadStorage {
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
  })
}
