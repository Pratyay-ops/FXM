/**
 * Fake File System Access handles for tests: folders of `File`s with the permission methods
 * Chromium has, so tests can grant, refuse or ask, and move and delete files between scans.
 *
 * @module
 */

/** A browser-style error, e.g. `NotFoundError`. */
export function domError(name: string, message = name): DOMException {
  return new DOMException(message, name)
}

/** A fake `FileSystemFileHandle`. */
export class FakeFileHandle {
  readonly kind = 'file'
  readonly name: string
  file: File

  constructor(name: string, file: File) {
    this.name = name
    this.file = file
  }

  async getFile(): Promise<File> {
    return this.file
  }
}

/** A fake `FileSystemDirectoryHandle`. */
export class FakeDirectoryHandle {
  readonly kind = 'directory'
  readonly name: string
  readonly children = new Map<string, FakeDirectoryHandle | FakeFileHandle>()
  /** What `queryPermission` answers. */
  permission: PermissionState = 'granted'
  /** What `requestPermission` turns the permission into. */
  answer: PermissionState = 'granted'
  /** How many times `requestPermission` was called. */
  requests = 0
  /** When set, listing this folder throws it, e.g. after the folder was deleted. */
  listError: Error | undefined

  constructor(name: string) {
    this.name = name
  }

  async *values(): AsyncGenerator<FakeDirectoryHandle | FakeFileHandle> {
    if (this.listError !== undefined) throw this.listError
    for (const entry of this.children.values()) yield entry
  }

  async getDirectoryHandle(name: string): Promise<FakeDirectoryHandle> {
    const entry = this.children.get(name)
    if (!(entry instanceof FakeDirectoryHandle)) throw domError('NotFoundError')
    return entry
  }

  async getFileHandle(name: string): Promise<FakeFileHandle> {
    const entry = this.children.get(name)
    if (!(entry instanceof FakeFileHandle)) throw domError('NotFoundError')
    return entry
  }

  async queryPermission(): Promise<PermissionState> {
    return this.permission
  }

  async requestPermission(): Promise<PermissionState> {
    this.requests++
    this.permission = this.answer
    return this.permission
  }

  async isSameEntry(other: unknown): Promise<boolean> {
    return other === this
  }

  /** The path from this folder to `other`, or `null` when `other` isn't inside it. */
  async resolve(other: unknown): Promise<string[] | null> {
    if (other === this) return []
    for (const [name, entry] of this.children) {
      if (entry === other) return [name]
      if (entry instanceof FakeDirectoryHandle) {
        const below = await entry.resolve(other)
        if (below !== null) return [name, ...below]
      }
    }
    return null
  }

  /** The folder at `path` inside this one, made when missing. */
  folder(path: string): FakeDirectoryHandle {
    let dir: FakeDirectoryHandle = this
    for (const part of path.split('/').filter(Boolean)) {
      let next = dir.children.get(part)
      if (!(next instanceof FakeDirectoryHandle)) {
        next = new FakeDirectoryHandle(part)
        dir.children.set(part, next)
      }
      dir = next
    }
    return dir
  }

  /** Puts `file` at `path` (folders included), replacing what was there. */
  put(path: string, file: File): FakeFileHandle {
    const parts = path.split('/')
    const name = parts.pop() ?? path
    const handle = new FakeFileHandle(name, file)
    this.folder(parts.join('/')).children.set(name, handle)
    return handle
  }

  /** Deletes the file or folder at `path`. */
  delete(path: string): void {
    const parts = path.split('/')
    const name = parts.pop() ?? path
    this.folder(parts.join('/')).children.delete(name)
  }

  /** Moves the file at `from` to `to`. */
  move(from: string, to: string): void {
    const parts = from.split('/')
    const name = parts.pop() ?? from
    const entry = this.folder(parts.join('/')).children.get(name)
    if (!(entry instanceof FakeFileHandle)) throw new Error(`No file at ${from}`)
    this.delete(from)
    this.put(to, entry.file)
  }
}

/** A fake folder named `name` holding `files` by path. */
export function fakeFolder(name: string, files: Record<string, File> = {}): FakeDirectoryHandle {
  const folder = new FakeDirectoryHandle(name)
  for (const [path, file] of Object.entries(files)) folder.put(path, file)
  return folder
}

/** A fake folder typed as the real handle, for code that takes one. */
export function asHandle(folder: FakeDirectoryHandle): FileSystemDirectoryHandle {
  return folder as unknown as FileSystemDirectoryHandle
}

/** `file` as a file input of a whole folder gives it: with a `webkitRelativePath`. */
export function inFolder(file: File, relativePath: string): File {
  Object.defineProperty(file, 'webkitRelativePath', { value: relativePath, configurable: true })
  return file
}
