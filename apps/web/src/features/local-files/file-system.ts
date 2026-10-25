/**
 * Getting at the user's music files: a folder picked with the File System Access API where the
 * browser has it (Chromium), files chosen through a file input everywhere else, and walking
 * either the same way.
 *
 * With the API, FXM keeps the folder's handle (in IndexedDB) and can read the folder again in
 * later visits, after asking the user once per visit, or never with Chrome's "Allow on every
 * visit". A file input gives `File`s that last only as long as the page.
 *
 * @module
 */

import { FxmError } from '@fxm/core'
import { folderImageRank } from './artwork'
import { isAudioFileName } from './format'
import { PICKED_FILES_NAME } from './types'

/** A file the scanner reads. */
export interface FoundFile {
  /** Where it is inside its root, `/`-separated, e.g. `Artist/Album/01 Song.flac`. */
  path: string
  /** Its file name. */
  name: string
  getFile(): Promise<File>
}

/** One directory of a root: its audio files and its folder images (`cover.jpg` and the like). */
export interface FoundDirectory {
  /** The directory's path inside the root; empty for the root itself. */
  dir: string
  audio: FoundFile[]
  images: FoundFile[]
  /**
   * True when the directory couldn't be listed (deleted or locked while the walk ran): it has
   * no files here, but the files listed before in it aren't gone.
   */
  unlisted?: boolean
}

/** Whether FXM may read a kept folder now, or must ask first, or was refused. */
export type FolderAccess = 'granted' | 'prompt' | 'denied'

/** Chromium's permission methods, which TypeScript's DOM library doesn't declare yet. */
interface PermissionedHandle {
  queryPermission?(descriptor: { mode: 'read' }): Promise<PermissionState>
  requestPermission?(descriptor: { mode: 'read' }): Promise<PermissionState>
}

interface DirectoryPickerOptions {
  /** Remembers where the picker was last opened, separately for each ID. */
  id?: string
  mode?: 'read' | 'readwrite'
  startIn?: 'music' | 'documents' | 'desktop' | 'downloads'
}

type DirectoryPicker = (options?: DirectoryPickerOptions) => Promise<FileSystemDirectoryHandle>

function directoryPicker(): DirectoryPicker | undefined {
  const picker = (globalThis as { showDirectoryPicker?: DirectoryPicker }).showDirectoryPicker
  return typeof picker === 'function' ? picker : undefined
}

/**
 * Whether this browser can pick a folder and keep access to it across visits (the File System
 * Access API: Chrome, Edge, Brave, Opera on desktop). Elsewhere FXM uses a file input.
 */
export function canKeepFolders(): boolean {
  return directoryPicker() !== undefined
}

/**
 * Whether a file input can pick a whole folder here (`webkitdirectory`). iOS can't, for one:
 * there FXM offers music files only.
 */
export function canChooseFolders(): boolean {
  return typeof HTMLInputElement === 'function' && 'webkitdirectory' in HTMLInputElement.prototype
}

function errorName(error: unknown): string {
  return typeof error === 'object' && error !== null && 'name' in error ? String(error.name) : ''
}

/** Whether a browser error means the user closed a picker or a prompt. */
export function isAbortError(error: unknown): boolean {
  return errorName(error) === 'AbortError'
}

/** Whether a file system error means the file or folder is gone. */
export function isNotFoundError(error: unknown): boolean {
  const name = errorName(error)
  return name === 'NotFoundError' || name === 'TypeMismatchError'
}

/** Whether a file system error means FXM lost permission to read. */
export function isPermissionError(error: unknown): boolean {
  const name = errorName(error)
  return name === 'NotAllowedError' || name === 'SecurityError'
}

/**
 * Opens the browser's folder picker, in the music folder the first time. Call it straight from
 * the click that asked for it: browsers open pickers only during a user gesture. Resolves to
 * `null` when the user closes the picker.
 */
export async function pickDirectory(): Promise<FileSystemDirectoryHandle | null> {
  const picker = directoryPicker()
  if (picker === undefined) {
    throw new FxmError('Unsupported', 'This browser cannot keep access to a folder')
  }
  try {
    return await picker.call(globalThis, { id: 'fxm-local-files', mode: 'read', startIn: 'music' })
  } catch (error) {
    if (isAbortError(error)) return null
    throw error
  }
}

/**
 * Whether FXM may read `handle`. With `request`, a folder that needs asking is asked for (the
 * browser shows its prompt), which only works during a user gesture; without one the answer
 * stays `prompt`. Handles without the permission methods (an origin-private folder, say) are
 * always readable.
 */
export async function folderAccess(
  handle: FileSystemDirectoryHandle,
  { request = false }: { request?: boolean } = {},
): Promise<FolderAccess> {
  const permissioned = handle as unknown as PermissionedHandle
  if (typeof permissioned.queryPermission !== 'function') return 'granted'
  const state = await permissioned.queryPermission({ mode: 'read' })
  if (state !== 'prompt' || !request || typeof permissioned.requestPermission !== 'function') {
    return state
  }
  try {
    return await permissioned.requestPermission({ mode: 'read' })
  } catch {
    // No user gesture (SecurityError), or the prompt couldn't show.
    return 'prompt'
  }
}

/** Whether two handles are the same folder. */
export async function sameFolder(
  a: FileSystemDirectoryHandle,
  b: FileSystemDirectoryHandle,
): Promise<boolean> {
  try {
    return await a.isSameEntry(b)
  } catch {
    return false
  }
}

/**
 * Where `inner` is inside `outer`, as a `/`-separated path (`Jazz/Live`), or `undefined` when
 * it isn't inside it (or is `outer` itself).
 */
export async function pathInside(
  outer: FileSystemDirectoryHandle,
  inner: FileSystemDirectoryHandle,
): Promise<string | undefined> {
  try {
    const path = await outer.resolve(inner)
    return path !== null && path.length > 0 ? path.join('/') : undefined
  } catch {
    return undefined
  }
}

/** Whether `inner` is a folder somewhere inside `outer` (not `outer` itself). */
export async function folderContains(
  outer: FileSystemDirectoryHandle,
  inner: FileSystemDirectoryHandle,
): Promise<boolean> {
  return (await pathInside(outer, inner)) !== undefined
}

function joinPath(dir: string, name: string): string {
  return dir === '' ? name : `${dir}/${name}`
}

const byName = new Intl.Collator('en', { numeric: true, sensitivity: 'base' })

/**
 * Walks a folder depth-first, in name order, one directory at a time: its audio files (see
 * `AUDIO_EXTENSIONS`) and folder images. Hidden files and folders (a leading `.`, which also
 * covers macOS's `._` copies on USB drives) are skipped. A subfolder that can't be listed comes
 * out `unlisted`, and the walk goes on. Throws the signal's reason when it aborts, and whatever
 * the browser throws when the folder itself can't be read.
 */
export async function* walkDirectory(
  root: FileSystemDirectoryHandle,
  signal?: AbortSignal,
): AsyncGenerator<FoundDirectory> {
  const stack: { handle: FileSystemDirectoryHandle; dir: string }[] = [{ handle: root, dir: '' }]
  for (let next = stack.pop(); next !== undefined; next = stack.pop()) {
    const { handle, dir } = next
    const audio: FoundFile[] = []
    const images: FoundFile[] = []
    const subdirectories: { handle: FileSystemDirectoryHandle; dir: string }[] = []
    try {
      for await (const entry of handle.values()) {
        signal?.throwIfAborted()
        if (entry.name.startsWith('.')) continue
        const path = joinPath(dir, entry.name)
        if (entry.kind === 'directory') {
          subdirectories.push({ handle: entry as FileSystemDirectoryHandle, dir: path })
        } else if (isAudioFileName(entry.name) || folderImageRank(entry.name) !== undefined) {
          const file = entry as FileSystemFileHandle
          const found = { path, name: entry.name, getFile: () => file.getFile() }
          if (isAudioFileName(entry.name)) audio.push(found)
          else images.push(found)
        }
      }
    } catch (error) {
      // The folder itself failing is the caller's to report (moved, deleted, no permission).
      if (dir === '' || signal?.aborted) throw error
      yield { dir, audio: [], images: [], unlisted: true }
      continue
    }
    audio.sort((a, b) => byName.compare(a.name, b.name))
    yield { dir, audio, images }
    // Pushed in reverse, so the first subdirectory by name is walked next.
    subdirectories.sort((a, b) => byName.compare(b.dir, a.dir))
    stack.push(...subdirectories)
  }
}

/** The file at `path` inside `root`. Throws `NotFoundError` when it is gone. */
export async function fileAt(root: FileSystemDirectoryHandle, path: string): Promise<File> {
  const parts = path.split('/')
  const name = parts.pop() ?? ''
  let dir = root
  for (const part of parts) dir = await dir.getDirectoryHandle(part)
  return (await dir.getFileHandle(name)).getFile()
}

/** Files chosen through a file input, sorted into a root like a walked folder. */
export interface PickedSet {
  /** `picked-folder` when a whole folder was chosen, else `picked-files`. */
  kind: 'picked-folder' | 'picked-files'
  /** The chosen folder's name, or {@link PICKED_FILES_NAME}. */
  rootName: string
  directories: FoundDirectory[]
  /** Every chosen audio file by its path, to play from. */
  files: Map<string, File>
}

/**
 * Sorts the files of a file input into directories. A folder input gives each file a
 * `webkitRelativePath` that starts with the folder's name; single files have none, and are
 * filed under their size and name (`1234/Song.mp3`), so two different files of the same name
 * never share an ID. Files FXM doesn't read are left out.
 */
export function groupPickedFiles(files: readonly File[]): PickedSet {
  // Some environments leave the property out for single files.
  const relativePath = (file: File) => file.webkitRelativePath ?? ''
  const folderFile = files.find((file) => relativePath(file).includes('/'))
  const fromFolder = folderFile !== undefined
  const rootName =
    folderFile === undefined
      ? PICKED_FILES_NAME
      : (relativePath(folderFile).split('/')[0] ?? PICKED_FILES_NAME)
  const directories = new Map<string, FoundDirectory>()
  const byPath = new Map<string, File>()
  for (const file of files) {
    const isAudio = isAudioFileName(file.name)
    if (!isAudio && (!fromFolder || folderImageRank(file.name) === undefined)) continue
    let path: string
    if (fromFolder) {
      const parts = relativePath(file).split('/').slice(1)
      if (parts.length === 0 || parts.some((part) => part.startsWith('.'))) continue
      path = parts.join('/')
    } else {
      path = `${file.size}/${file.name}`
    }
    const dir = fromFolder ? path.slice(0, Math.max(0, path.lastIndexOf('/'))) : ''
    let directory = directories.get(dir)
    if (directory === undefined) {
      directory = { dir, audio: [], images: [] }
      directories.set(dir, directory)
    }
    const found: FoundFile = { path, name: file.name, getFile: async () => file }
    if (isAudio) {
      directory.audio.push(found)
      byPath.set(path, file)
    } else {
      directory.images.push(found)
    }
  }
  const sorted = [...directories.values()].sort((a, b) => byName.compare(a.dir, b.dir))
  for (const directory of sorted) directory.audio.sort((a, b) => byName.compare(a.path, b.path))
  return {
    kind: fromFolder ? 'picked-folder' : 'picked-files',
    rootName,
    directories: sorted,
    files: byPath,
  }
}
