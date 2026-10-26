/**
 * Where downloaded bytes live: an interface each platform implements (the Origin Private File
 * System in the web app; the file system on desktop and Android later), and an in-memory
 * storage for tests.
 *
 * @module
 */

/**
 * Writes one stored file. The manager writes a download's bytes in order, as they arrive, so the
 * file always holds a prefix of the real file and a resume continues from its size.
 */
export interface DownloadWriter {
  /** The file's size in bytes now. */
  size(): Promise<number>
  /** Writes `bytes` at `offset`, growing the file as needed. */
  write(offset: number, bytes: Uint8Array): Promise<void>
  /** Cuts the file to `size` bytes. */
  truncate(size: number): Promise<void>
  /** Makes what was written so far survive a crash. */
  flush(): Promise<void>
  /** Flushes and releases the file. The writer can't be used afterwards. */
  close(): Promise<void>
}

/**
 * The files of downloads, by name. Names are opaque strings the manager chooses: 1 to 64 ASCII
 * letters, digits, `-` and `_` (see {@link isSafeFileName}; the manager uses random UUIDs).
 * Implementations must reject any other name (with a `TypeError`) before they touch the file
 * system, so a damaged or tampered record can never name a path outside the downloads folder.
 *
 * Errors:
 *
 * - a full disk or quota rejects with an error named `QuotaExceededError` (what browsers throw;
 *   see {@link storageFullError}), which fails the download as `storage-full`;
 * - a storage that can't work here at all (a private window, a missing browser feature, a worker
 *   that failed or stopped answering) rejects with an error named `SecurityError`,
 *   `NotAllowedError` or `NotSupportedError` (see {@link storageUnavailableError}), which fails
 *   the download as `storage`;
 * - any other rejection counts as a passing storage problem.
 *
 * Every call must settle: a storage whose backend can hang (a worker) rejects after a timeout.
 */
export interface DownloadStorage {
  /**
   * Opens `file` for writing, creating it empty if it doesn't exist. Only one writer per file at
   * a time: a second `open` before the first writer's `close` may reject.
   */
  open(file: string): Promise<DownloadWriter>
  /**
   * Deletes `file` and releases anything handed out for it ({@link playbackUrl}). Resolves when
   * there is no such file.
   */
  remove(file: string): Promise<void>
  /** The names of every stored file, so the manager can delete files no record names. */
  list(): Promise<string[]>
  /** The size of `file` in bytes, or `undefined` when it doesn't exist. Not for an open file. */
  size(file: string): Promise<number | undefined>
  /**
   * The whole of `file` as a `Blob` of MIME type `type`, or `undefined` when it doesn't exist,
   * e.g. to save a copy to the device (stage 4.2). Not for an open file.
   */
  read(file: string, type: string): Promise<Blob | undefined>
  /**
   * A URL the player can load to play a complete `file`, served as MIME type `type` (in a
   * browser, a `blob:` URL), or `undefined` when the file doesn't exist. The same file gets the
   * same URL until it is removed, so a copy that failed to play is recognized and not tried
   * again.
   */
  playbackUrl(file: string, type: string): Promise<string | undefined>
}

/**
 * The error a {@link DownloadStorage} rejects with when the disk or the browser's quota is full:
 * a `DOMException` named `QuotaExceededError`, the same as browsers throw.
 */
export function storageFullError(message = 'The storage is full'): Error {
  return new DOMException(message, 'QuotaExceededError')
}

/** Whether `error` says that the storage is full (see {@link storageFullError}). */
export function isStorageFullError(error: unknown): boolean {
  return error instanceof Error && error.name === 'QuotaExceededError'
}

/**
 * The error a {@link DownloadStorage} rejects with when it can't work here at all, e.g. its
 * worker failed to start or stopped answering: a `DOMException` named `NotSupportedError`. No
 * retry can help until the user acts (reloads the app, leaves a private window).
 */
export function storageUnavailableError(message = 'The storage is unavailable'): Error {
  return new DOMException(message, 'NotSupportedError')
}

const UNAVAILABLE_NAMES: ReadonlySet<string> = new Set([
  'SecurityError',
  'NotAllowedError',
  'NotSupportedError',
])

/**
 * Whether `error` says that the storage can't work here at all (see
 * {@link storageUnavailableError}): `SecurityError` and `NotAllowedError` (a private window, a
 * site whose data is blocked) or `NotSupportedError` (a missing feature, a failed worker).
 */
export function isStorageUnavailableError(error: unknown): boolean {
  return error instanceof Error && UNAVAILABLE_NAMES.has(error.name)
}

/** Names Windows reserves for devices, whatever the extension: never a file name. */
const DEVICE_NAME = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])$/i

/**
 * Whether `name` may name a download's file: 1 to 64 ASCII letters, digits, `-` and `_`, and not
 * a name Windows reserves for a device. No separator, dot or other character a file system
 * could read as a path gets through.
 */
export function isSafeFileName(name: unknown): name is string {
  return typeof name === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(name) && !DEVICE_NAME.test(name)
}

/** Rejects a name {@link isSafeFileName} refuses, as every {@link DownloadStorage} must. */
export function assertSafeFileName(name: string): void {
  if (!isSafeFileName(name)) {
    throw new TypeError(`${JSON.stringify(name)} is not a download file name`)
  }
}

/** Options for {@link createMemoryDownloadStorage}. */
export interface MemoryDownloadStorageOptions {
  /** The most bytes all files may hold together, like a quota. Default: no limit. */
  quotaBytes?: number
}

/** A {@link DownloadStorage} in memory, plus ways to look inside it and break it for tests. */
export interface MemoryDownloadStorage extends DownloadStorage {
  /** A copy of `file`'s bytes, or `undefined` when it doesn't exist. */
  bytes(file: string): Uint8Array | undefined
  /** Stores `file` with `bytes`, replacing it. */
  put(file: string, bytes: Uint8Array): void
  /** The files open for writing. */
  readonly openFiles: ReadonlySet<string>
  /** Makes the next call of an operation reject with `error`, once. */
  failNext(operation: 'open' | 'write' | 'remove' | 'list', error: Error): void
  /** The quota, which a test may change. */
  quotaBytes: number
}

/** A file's bytes with room to grow. */
class GrowableBytes {
  data: Uint8Array<ArrayBuffer> = new Uint8Array(0)
  length = 0

  constructor(bytes?: Uint8Array) {
    if (bytes !== undefined) {
      this.data = new Uint8Array(bytes)
      this.length = bytes.length
    }
  }

  write(offset: number, bytes: Uint8Array): void {
    const end = offset + bytes.length
    if (end > this.data.length) {
      const grown = new Uint8Array(Math.max(end, this.data.length * 2, 1024))
      grown.set(this.data.subarray(0, this.length))
      this.data = grown
    }
    // Writing past the end leaves zeros in the gap, as a file system does.
    if (offset > this.length) this.data.fill(0, this.length, offset)
    this.data.set(bytes, offset)
    this.length = Math.max(this.length, end)
  }

  truncate(size: number): void {
    if (size < this.length) this.length = size
    else this.write(this.length, new Uint8Array(size - this.length))
  }

  copy(): Uint8Array<ArrayBuffer> {
    return this.data.slice(0, this.length)
  }
}

function notAllowed(message: string): Error {
  return new DOMException(message, 'NoModificationAllowedError')
}

/**
 * A {@link DownloadStorage} in memory, for tests and for a platform without file storage yet.
 * It behaves like the Origin Private File System where the manager relies on it: one writer per
 * file, removing an open file fails, a full quota rejects with `QuotaExceededError`, and a name
 * {@link isSafeFileName} refuses rejects with a `TypeError` (only `put`, a test's way to fill
 * it, takes any name). Playback URLs are `memory:<file>`.
 */
export function createMemoryDownloadStorage(
  options: MemoryDownloadStorageOptions = {},
): MemoryDownloadStorage {
  const files = new Map<string, GrowableBytes>()
  const open = new Set<string>()
  const failures = new Map<string, Error>()
  const fail = (operation: string) => {
    const error = failures.get(operation)
    if (error === undefined) return
    failures.delete(operation)
    throw error
  }
  const used = () => [...files.values()].reduce((sum, file) => sum + file.length, 0)
  const storage: MemoryDownloadStorage = {
    quotaBytes: options.quotaBytes ?? Number.POSITIVE_INFINITY,
    get openFiles() {
      return open
    },
    bytes(file) {
      return files.get(file)?.copy()
    },
    put(file, bytes) {
      files.set(file, new GrowableBytes(bytes))
    },
    failNext(operation, error) {
      failures.set(operation, error)
    },
    async open(file) {
      assertSafeFileName(file)
      fail('open')
      if (open.has(file)) throw notAllowed(`${file} is already open`)
      open.add(file)
      let buffer = files.get(file)
      if (buffer === undefined) {
        buffer = new GrowableBytes()
        files.set(file, buffer)
      }
      const target = buffer
      let closed = false
      const check = () => {
        if (closed) throw new DOMException(`${file} was closed`, 'InvalidStateError')
        if (files.get(file) !== target) throw new DOMException(`${file} is gone`, 'NotFoundError')
      }
      return {
        async size() {
          check()
          return target.length
        },
        async write(offset, bytes) {
          check()
          fail('write')
          const growth = Math.max(0, offset + bytes.length - target.length)
          if (used() + growth > storage.quotaBytes) throw storageFullError()
          target.write(offset, bytes)
        },
        async truncate(size) {
          check()
          target.truncate(size)
        },
        async flush() {
          check()
        },
        async close() {
          if (closed) return
          closed = true
          open.delete(file)
        },
      }
    },
    async remove(file) {
      assertSafeFileName(file)
      fail('remove')
      if (open.has(file)) throw notAllowed(`${file} is open`)
      files.delete(file)
    },
    async list() {
      fail('list')
      return [...files.keys()]
    },
    async size(file) {
      assertSafeFileName(file)
      return files.get(file)?.length
    },
    async read(file, type) {
      assertSafeFileName(file)
      const buffer = files.get(file)
      return buffer === undefined ? undefined : new Blob([buffer.copy()], { type })
    },
    async playbackUrl(file) {
      assertSafeFileName(file)
      return files.has(file) ? `memory:${file}` : undefined
    },
  }
  return storage
}
