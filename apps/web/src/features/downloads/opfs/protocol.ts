/**
 * The messages between the page and the OPFS worker (`worker.ts`), and the parts of the Origin
 * Private File System API that FXM uses, typed structurally: the DOM library types the worker-only
 * `createSyncAccessHandle` nowhere, and tests pass fakes of the same shape.
 *
 * @module
 */

/** One request to the worker. Offsets and sizes are in bytes. */
export type OpfsRequest =
  | { op: 'open'; file: string }
  | { op: 'size'; file: string }
  | { op: 'write'; file: string; offset: number; data: ArrayBuffer }
  | { op: 'truncate'; file: string; size: number }
  | { op: 'flush'; file: string }
  | { op: 'close'; file: string }
  | { op: 'remove'; file: string }

/**
 * The worker's answer: a number for `open` and `size` (the file's size) and `write` (the bytes
 * written), nothing otherwise; or the error's `DOMException` name and message.
 */
export type OpfsReply = { ok: true; value?: number } | { ok: false; name: string; message: string }

/** A request as posted to the worker, with an ID to match its answer. */
export interface OpfsMessage {
  id: number
  request: OpfsRequest
}

/** An answer as posted back by the worker. */
export interface OpfsAnswer {
  id: number
  reply: OpfsReply
}

/**
 * A `FileSystemSyncAccessHandle`: in-place, synchronous file access, only in dedicated workers.
 * Safari before 17 returned promises from some methods, so callers await every result.
 */
export interface SyncAccessHandleLike {
  write(buffer: ArrayBufferView, options?: { at?: number }): number
  truncate(size: number): unknown
  getSize(): number | Promise<number>
  flush(): unknown
  close(): unknown
}

/** The parts of a `FileSystemFileHandle` FXM uses. */
export interface FileHandleLike {
  /** Only in dedicated workers. */
  createSyncAccessHandle?(): Promise<SyncAccessHandleLike>
  getFile(): Promise<File>
}

/** The parts of a `FileSystemDirectoryHandle` FXM uses. */
export interface DirectoryHandleLike {
  getFileHandle(name: string, options?: { create?: boolean }): Promise<FileHandleLike>
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<DirectoryHandleLike>
  removeEntry(name: string): Promise<void>
  keys(): AsyncIterable<string>
}

/** The folder of the Origin Private File System that holds the downloads. */
export const DOWNLOADS_FOLDER = 'downloads'
