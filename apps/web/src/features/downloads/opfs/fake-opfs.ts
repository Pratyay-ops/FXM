/**
 * An Origin Private File System in memory, for tests: folders, files, and sync access handles
 * that lock their file the way browsers do. Not used by the app.
 *
 * @module
 */

import type { DirectoryHandleLike, FileHandleLike, SyncAccessHandleLike } from './protocol'

function failure(name: string, message: string): Error {
  return new DOMException(message, name)
}

/** One file: its bytes, and whether a sync access handle holds it. */
export class FakeFile {
  bytes = new Uint8Array(0)
  locked = false
}

/** A folder of {@link FakeFile}s and folders. Its `quotaBytes` caps every file under it. */
export class FakeDirectory implements DirectoryHandleLike {
  readonly files = new Map<string, FakeFile>()
  readonly folders = new Map<string, FakeDirectory>()
  quotaBytes = Number.POSITIVE_INFINITY

  async getFileHandle(name: string, options: { create?: boolean } = {}): Promise<FileHandleLike> {
    let file = this.files.get(name)
    if (file === undefined) {
      if (options.create !== true) throw failure('NotFoundError', `${name} not found`)
      file = new FakeFile()
      this.files.set(name, file)
    }
    return fileHandle(name, file, this)
  }

  async getDirectoryHandle(
    name: string,
    options: { create?: boolean } = {},
  ): Promise<DirectoryHandleLike> {
    let folder = this.folders.get(name)
    if (folder === undefined) {
      if (options.create !== true) throw failure('NotFoundError', `${name} not found`)
      folder = new FakeDirectory()
      folder.quotaBytes = this.quotaBytes
      this.folders.set(name, folder)
    }
    return folder
  }

  async removeEntry(name: string): Promise<void> {
    const file = this.files.get(name)
    if (file === undefined) throw failure('NotFoundError', `${name} not found`)
    if (file.locked) throw failure('NoModificationAllowedError', `${name} is open`)
    this.files.delete(name)
  }

  async *keys(): AsyncIterable<string> {
    yield* [...this.files.keys(), ...this.folders.keys()]
  }

  /** The bytes all files in this folder hold. */
  used(): number {
    return [...this.files.values()].reduce((sum, file) => sum + file.bytes.length, 0)
  }
}

function fileHandle(name: string, file: FakeFile, folder: FakeDirectory): FileHandleLike {
  return {
    async createSyncAccessHandle() {
      if (file.locked) throw failure('NoModificationAllowedError', `${name} is open`)
      file.locked = true
      return syncHandle(file, folder)
    },
    async getFile() {
      if (file.locked) throw failure('NoModificationAllowedError', `${name} is open`)
      return new File([file.bytes.slice()], name)
    },
  }
}

function syncHandle(file: FakeFile, folder: FakeDirectory): SyncAccessHandleLike {
  let closed = false
  const check = () => {
    if (closed) throw failure('InvalidStateError', 'The handle is closed')
  }
  const resize = (size: number) => {
    const next = new Uint8Array(size)
    next.set(file.bytes.subarray(0, Math.min(size, file.bytes.length)))
    file.bytes = next
  }
  return {
    write(buffer, options = {}) {
      check()
      const bytes = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
      const at = options.at ?? 0
      const end = at + bytes.length
      const growth = Math.max(0, end - file.bytes.length)
      if (folder.used() + growth > folder.quotaBytes) {
        throw failure('QuotaExceededError', 'The storage is full')
      }
      if (end > file.bytes.length) resize(end)
      file.bytes.set(bytes, at)
      return bytes.length
    },
    truncate(size) {
      check()
      resize(size)
    },
    getSize() {
      check()
      return file.bytes.length
    },
    flush() {
      check()
    },
    close() {
      closed = true
      file.locked = false
    },
  }
}
