/**
 * The local-files feature in one object: adding folders and picked files, scanning them,
 * asking for access again, and opening a file to play it.
 *
 * - **Folders** (Chromium): `addFolder()` opens the browser's folder picker; FXM keeps the
 *   handle and, in later visits, checks whether it may still read the folder. When the browser
 *   wants to ask first, the folder shows "Allow access" (`requestAccess()`), and playing one of
 *   its songs asks too. Once readable in a visit, a folder is scanned again for changes.
 * - **Picked files** (every browser): `addPicked()` takes the files of a file input. They play
 *   until the page reloads; choosing the same folder again brings its songs back with the same
 *   IDs.
 * - **Playing**: `streamFor()` opens the file of a local track and hands out an object URL for
 *   it (`object-urls.ts`), as a `StreamOption` the player plays like any other stream.
 *
 * Each root's status (checking, scanning with progress, needs access, unavailable…) is in a
 * small store for the UI; the roots, files and covers themselves are in the database, which the
 * UI reads with live queries (`hooks.ts`).
 *
 * @module
 */

import { FxmError, type StreamOption, type Track } from '@fxm/core'
import { Dexie } from 'dexie'
import { createStore, type StoreApi } from 'zustand/vanilla'
import { getLibrary, randomUuid } from '../../db/repo'
import { type MakeThumbnail, makeThumbnail } from './artwork'
import { LOCAL_DB_NAME, openLocalDatabase } from './database'
import {
  canKeepFolders,
  type FolderAccess,
  type FoundDirectory,
  fileAt,
  folderAccess,
  folderContains,
  groupPickedFiles,
  isNotFoundError,
  isPermissionError,
  type PickedSet,
  pickDirectory,
  sameFolder,
  walkDirectory,
} from './file-system'
import { ObjectUrlCache } from './object-urls'
import { createLocalFilesRepo, type LocalFilesRepo } from './repo'
import { type ScanOutcome, scanRoot } from './scanner'
import { type ReadTags, readTags } from './tags'
import { toLocalTracks } from './tracks'
import type { LocalAudioFormat, LocalFileRecord, LocalRootRecord } from './types'

/** Where a root stands in this visit. */
export type RootStatus =
  /** Not checked yet in this visit. */
  | { state: 'checking' }
  /** Its files can be read and played. */
  | { state: 'ready' }
  /** Being scanned: `found` audio files so far, `read` of them dealt with. */
  | { state: 'scanning'; found: number; read: number }
  /** A kept folder the browser wants to ask about again before FXM reads it. */
  | { state: 'needs-access' }
  /** A kept folder the user refused access to. */
  | { state: 'denied' }
  /** Picked files the browser forgot when the page reloaded: choose them again. */
  | { state: 'unavailable' }
  /** A kept folder that was moved or deleted. */
  | { state: 'missing' }
  /** Something else went wrong. */
  | { state: 'failed'; message: string }

/** The UI state of local files: each root's status, by root ID. */
export interface LocalFilesState {
  readonly statuses: Readonly<Record<string, RootStatus>>
}

/** The status of a root without one in the store yet. */
export const CHECKING: RootStatus = { state: 'checking' }

/** What the facade works with; tests replace any of it. */
export interface LocalFilesDeps {
  repo: LocalFilesRepo
  readTags: ReadTags
  thumbnail: MakeThumbnail
  /** Refreshes the library's copies of tracks a scan changed (`LibraryRepo.refreshTracks`). */
  refreshLibraryTracks: (tracks: readonly Track[]) => Promise<unknown>
  /** Opens the folder picker; `null` when the user closes it. */
  pickDirectory: () => Promise<FileSystemDirectoryHandle | null>
  /** Whether the browser can keep access to folders. */
  canKeepFolders: () => boolean
  objectUrls: ObjectUrlCache
  now: () => number
  uuid: () => string
}

/** What adding a folder did. */
export type AddFolderResult =
  /** Added; its scan runs. */
  | { status: 'added'; root: LocalRootRecord }
  /** The user closed the picker. */
  | { status: 'cancelled' }
  /** That folder was already added: it is scanned again. */
  | { status: 'exists'; root: LocalRootRecord }
  /** That folder is inside `root`, which already lists its files. */
  | { status: 'inside'; root: LocalRootRecord }

/** What adding picked files did. */
export type AddPickedResult =
  /** A new root; its scan runs. */
  | { status: 'added'; root: LocalRootRecord }
  /** A root chosen again (or more single files): its scan runs. */
  | { status: 'updated'; root: LocalRootRecord }
  /** None of the files is a format FXM reads. */
  | { status: 'empty' }

/** A local file opened for playing. */
export interface OpenedFile {
  file: File
  record: LocalFileRecord
  root: LocalRootRecord
}

/** The stream to play a local file from its object URL. */
export function streamOptionOf(format: LocalAudioFormat, url: string): StreamOption {
  const stream: StreamOption = {
    url,
    codec: format.codec,
    container: format.container,
    media: 'audio',
    tier: format.tier,
    protocol: 'progressive',
    ipBound: false,
    // The whole file is on this device: nothing can cut it short the way capped URLs are.
    fullLength: 'verified',
  }
  if (format.bitrateKbps !== undefined) stream.bitrateKbps = format.bitrateKbps
  if (format.sampleRateHz !== undefined) stream.sampleRateHz = format.sampleRateHz
  if (format.bitDepth !== undefined) stream.bitDepth = format.bitDepth
  return stream
}

/** The status a failed scan or read leaves a root in. */
function statusForError(error: unknown): RootStatus {
  if (isNotFoundError(error)) return { state: 'missing' }
  if (isPermissionError(error)) return { state: 'needs-access' }
  const message = error instanceof Error && error.message ? error.message : String(error)
  return { state: 'failed', message }
}

/** How often, at most, a scan's progress reaches the UI, in milliseconds. */
const PROGRESS_INTERVAL_MS = 150

/** Creates the facade; the app uses {@link getLocalFiles}. */
export function createLocalFiles(deps: LocalFilesDeps) {
  const { repo, now, uuid, objectUrls } = deps
  const store = createStore<LocalFilesState>()(() => ({ statuses: {} }))
  /** Folder handles read so far, so a click can ask for access without waiting for storage. */
  const handles = new Map<string, FileSystemDirectoryHandle>()
  /** The picked files of each picked root that is available in this visit. */
  const sessions = new Map<string, PickedSet>()
  const scans = new Map<string, { controller: AbortController; done: Promise<unknown> }>()
  /** Folders scanned in this visit: checking them again doesn't rescan them. */
  const scannedThisVisit = new Set<string>()
  let checking: Promise<void> | undefined

  function setStatus(rootId: string, status: RootStatus): void {
    store.setState((state) => ({ statuses: { ...state.statuses, [rootId]: status } }))
  }

  function clearStatus(rootId: string): void {
    store.setState((state) => {
      const { [rootId]: _removed, ...statuses } = state.statuses
      return { statuses }
    })
  }

  async function handleOf(rootId: string): Promise<FileSystemDirectoryHandle | undefined> {
    const cached = handles.get(rootId)
    if (cached !== undefined) return cached
    const stored = await repo.handles.get(rootId)
    if (stored !== undefined) handles.set(rootId, stored)
    return stored
  }

  async function refreshLibrary(changed: readonly LocalFileRecord[]): Promise<void> {
    if (changed.length === 0) return
    const keys = [...new Set(changed.flatMap((file) => file.pictureKey ?? []))]
    const tracks = toLocalTracks(changed, await repo.getPictures(keys)).map(({ track }) => track)
    try {
      await deps.refreshLibraryTracks(tracks)
    } catch {
      // The library can't be written (a private window, a full disk): it refreshes next time.
    }
  }

  /**
   * Scans `root` from `directories`, unless it is already being scanned. Roots in `absorb` are
   * folders inside it: their files keep their IDs here, and the roots go once the scan is done.
   */
  function runScan(
    root: LocalRootRecord,
    directories: (signal: AbortSignal) => AsyncIterable<FoundDirectory> | Iterable<FoundDirectory>,
    absorb: readonly LocalRootRecord[] = [],
  ): Promise<unknown> {
    const running = scans.get(root.id)
    if (running !== undefined) return running.done
    const controller = new AbortController()
    const done = (async () => {
      setStatus(root.id, { state: 'scanning', found: 0, read: 0 })
      let reportedAt = Number.NEGATIVE_INFINITY
      try {
        const absorbed = (
          await Promise.all(absorb.map((other) => repo.filesOfRoot(other.id)))
        ).flat()
        const outcome: ScanOutcome = await scanRoot(deps, {
          root,
          directories: directories(controller.signal),
          complete: root.kind !== 'picked-files',
          absorb: absorbed,
          signal: controller.signal,
          onProgress: (progress) => {
            if (now() - reportedAt < PROGRESS_INTERVAL_MS) return
            reportedAt = now()
            setStatus(root.id, { state: 'scanning', ...progress })
          },
        })
        if (outcome.status === 'done') {
          scannedThisVisit.add(root.id)
          const latest = await repo.getRoot(root.id)
          if (latest !== undefined) {
            const { skipped: _previous, ...rest } = latest
            const skipped = Object.keys(outcome.skipped).length > 0 ? outcome.skipped : undefined
            await repo.putRoot({ ...rest, scannedAt: now(), ...(skipped ? { skipped } : {}) })
          }
          for (const other of absorb) {
            await repo.removeRoot(other.id)
            handles.delete(other.id)
            clearStatus(other.id)
          }
        }
        await refreshLibrary(outcome.changed)
        setStatus(root.id, { state: 'ready' })
      } catch (error) {
        setStatus(root.id, statusForError(error))
      } finally {
        scans.delete(root.id)
      }
    })()
    scans.set(root.id, { controller, done })
    return done
  }

  async function cancelAndWait(rootId: string): Promise<void> {
    const running = scans.get(rootId)
    if (running === undefined) return
    running.controller.abort()
    await running.done
  }

  /** Scans a kept folder again, when FXM may read it. */
  async function rescanFolder(root: LocalRootRecord): Promise<unknown> {
    const handle = await handleOf(root.id)
    if (handle === undefined) {
      setStatus(root.id, { state: 'failed', message: 'FXM lost track of this folder' })
      return
    }
    const access = await folderAccess(handle)
    if (access !== 'granted') {
      setStatus(root.id, { state: access === 'denied' ? 'denied' : 'needs-access' })
      return
    }
    return runScan(root, (signal) => walkDirectory(handle, signal))
  }

  async function checkAll(): Promise<void> {
    for (const root of await repo.listRoots()) {
      if (scans.has(root.id)) continue
      if (root.kind !== 'folder') {
        setStatus(root.id, sessions.has(root.id) ? { state: 'ready' } : { state: 'unavailable' })
        continue
      }
      const handle = await handleOf(root.id)
      if (handle === undefined) {
        setStatus(root.id, { state: 'failed', message: 'FXM lost track of this folder' })
        continue
      }
      let access: FolderAccess
      try {
        access = await folderAccess(handle)
      } catch (error) {
        setStatus(root.id, statusForError(error))
        continue
      }
      if (access !== 'granted') {
        setStatus(root.id, { state: access === 'denied' ? 'denied' : 'needs-access' })
      } else if (scannedThisVisit.has(root.id)) {
        setStatus(root.id, { state: 'ready' })
      } else {
        // Readable again in a new visit: pick up what changed while FXM was closed.
        void runScan(root, (signal) => walkDirectory(handle, signal))
      }
    }
  }

  const facade = {
    /** The UI state: each root's status. */
    store: store as StoreApi<LocalFilesState>,
    /** The repository, for reads. */
    repo,

    /** Whether this browser can keep access to folders (else: file inputs). */
    canKeepFolders: deps.canKeepFolders,

    /** The status of a root in this visit. */
    statusOf(rootId: string): RootStatus {
      return store.getState().statuses[rootId] ?? CHECKING
    },

    /**
     * Checks every root once: whether kept folders may be read (and scans those again for
     * changes, once per visit) and which picked roots are available. Safe to call often.
     */
    checkRoots(): Promise<void> {
      checking ??= checkAll().finally(() => {
        checking = undefined
      })
      return checking
    },

    /**
     * Opens the folder picker and adds the folder. Call it straight from a click: the picker
     * opens only during a user gesture. A folder that holds folders added before replaces them,
     * and their songs keep their IDs.
     */
    async addFolder(): Promise<AddFolderResult> {
      const handle = await deps.pickDirectory()
      if (handle === null) return { status: 'cancelled' }
      const absorb: LocalRootRecord[] = []
      for (const root of await repo.listRoots()) {
        if (root.kind !== 'folder') continue
        const other = await handleOf(root.id)
        if (other === undefined) continue
        if (await sameFolder(other, handle)) {
          // Picking it again grants access again: keep the new handle and look for changes.
          await repo.handles.put(root.id, handle)
          handles.set(root.id, handle)
          scannedThisVisit.delete(root.id)
          void runScan(root, (signal) => walkDirectory(handle, signal))
          return { status: 'exists', root }
        }
        if (await folderContains(other, handle)) return { status: 'inside', root }
        if (await folderContains(handle, other)) absorb.push(root)
      }
      const root: LocalRootRecord = {
        id: uuid(),
        kind: 'folder',
        name: handle.name,
        addedAt: now(),
      }
      await repo.handles.put(root.id, handle)
      handles.set(root.id, handle)
      await repo.putRoot(root)
      await Promise.all(absorb.map((other) => cancelAndWait(other.id)))
      void runScan(root, (signal) => walkDirectory(handle, signal), absorb)
      return { status: 'added', root }
    },

    /**
     * Adds files chosen through a file input: a folder (`webkitdirectory`) or single files. A
     * folder chosen again under the same name is the same root: its songs come back with their
     * IDs, and files no longer in it go. Single files add up.
     */
    async addPicked(files: readonly File[]): Promise<AddPickedResult> {
      const picked = groupPickedFiles(files)
      if (picked.files.size === 0) return { status: 'empty' }
      let root = await repo.findPickedRoot(picked.kind, picked.rootName)
      const status = root === undefined ? 'added' : 'updated'
      if (root === undefined) {
        root = { id: uuid(), kind: picked.kind, name: picked.rootName, addedAt: now() }
        await repo.putRoot(root)
      }
      await cancelAndWait(root.id)
      const previous = sessions.get(root.id)
      if (picked.kind === 'picked-files' && previous !== undefined) {
        // Single files add up: keep the ones chosen before in this visit playable too.
        sessions.set(root.id, {
          ...picked,
          directories: [...previous.directories, ...picked.directories],
          files: new Map([...previous.files, ...picked.files]),
        })
      } else {
        sessions.set(root.id, picked)
      }
      void runScan(root, () => picked.directories)
      return { status, root }
    },

    /**
     * Asks the browser for access to a kept folder again. Call it straight from a click: the
     * browser shows its prompt only during a user gesture. Scans the folder once allowed.
     */
    async requestAccess(rootId: string): Promise<FolderAccess> {
      // From memory when the folder was checked: the prompt must open within the click.
      const handle = await handleOf(rootId)
      if (handle === undefined) return 'denied'
      const access = await folderAccess(handle, { request: true })
      if (access === 'granted') {
        const root = await repo.getRoot(rootId)
        if (root !== undefined) {
          scannedThisVisit.delete(rootId)
          void runScan(root, (signal) => walkDirectory(handle, signal))
        }
      } else {
        setStatus(rootId, { state: access === 'denied' ? 'denied' : 'needs-access' })
      }
      return access
    },

    /** Scans a root again for changes, when its files can be read. */
    async rescan(rootId: string): Promise<void> {
      const root = await repo.getRoot(rootId)
      if (root === undefined) return
      if (root.kind === 'folder') {
        await rescanFolder(root)
        return
      }
      const session = sessions.get(rootId)
      if (session === undefined) {
        setStatus(rootId, { state: 'unavailable' })
        return
      }
      await runScan(root, () => session.directories)
    },

    /** Stops a running scan; what it read so far stays listed. */
    cancelScan(rootId: string): void {
      scans.get(rootId)?.controller.abort()
    },

    /** Resolves when a running scan of the root (if any) is over. For tests and the UI. */
    async whenScanned(rootId: string): Promise<void> {
      await scans.get(rootId)?.done
    },

    /**
     * Removes a root and its songs from local files. The files on the device stay, and so do
     * the library's likes and playlist entries, which play again once the folder is added again.
     */
    async removeRoot(rootId: string): Promise<void> {
      await cancelAndWait(rootId)
      sessions.delete(rootId)
      handles.delete(rootId)
      scannedThisVisit.delete(rootId)
      await repo.removeRoot(rootId)
      clearStatus(rootId)
    },

    /**
     * Opens the file of the local track with native ID `nativeId`, asking for access to its
     * folder when needed (which works during a user gesture, such as the click on Play). Rejects
     * with an `FxmError`: `NotFound` when the file is gone, `AuthRequired` when FXM may not read
     * it until the user acts (allows access, or chooses picked files again).
     */
    async openFile(nativeId: string): Promise<OpenedFile> {
      const record = await repo.fileById(nativeId)
      const root = record === undefined ? undefined : await repo.getRoot(record.rootId)
      if (record === undefined || root === undefined) {
        throw new FxmError('NotFound', 'This song is no longer in your local files')
      }
      if (root.kind !== 'folder') {
        const file = sessions.get(root.id)?.files.get(record.path)
        if (file === undefined) {
          setStatus(root.id, { state: 'unavailable' })
          const what = root.kind === 'picked-folder' ? `“${root.name}”` : 'your files'
          throw new FxmError('AuthRequired', `Choose ${what} again to play this song`)
        }
        return { file, record, root }
      }
      const handle = await handleOf(root.id)
      const access = handle === undefined ? 'denied' : await folderAccess(handle, { request: true })
      if (handle === undefined || access !== 'granted') {
        setStatus(root.id, { state: access === 'denied' ? 'denied' : 'needs-access' })
        throw new FxmError('AuthRequired', `Allow FXM to read “${root.name}” to play this song`)
      }
      try {
        return { file: await fileAt(handle, record.path), record, root }
      } catch (error) {
        if (isNotFoundError(error)) {
          throw new FxmError('NotFound', `“${record.tags.title}” is no longer in “${root.name}”`, {
            cause: error,
          })
        }
        if (isPermissionError(error)) {
          setStatus(root.id, { state: 'needs-access' })
          throw new FxmError('AuthRequired', `Allow FXM to read “${root.name}” to play this song`, {
            cause: error,
          })
        }
        throw error
      }
    },

    /**
     * The stream to play a local track from: its file's object URL, with its codec, container
     * and tier (lossless for FLAC, ALAC and WAV only). Rejects like {@link openFile}.
     */
    async streamFor(nativeId: string): Promise<StreamOption> {
      const { file, record } = await facade.openFile(nativeId)
      const url = objectUrls.urlFor(`${record.key}|${file.size}|${file.lastModified}`, file)
      return streamOptionOf(record.format, url)
    },

    /** Stops every scan and revokes every object URL. */
    dispose(): void {
      for (const { controller } of scans.values()) controller.abort()
      objectUrls.clear()
    },
  }
  return facade
}

/** The local-files facade. */
export type LocalFiles = ReturnType<typeof createLocalFiles>

/** The facade's dependencies in the app. */
export function defaultLocalFilesDeps(): LocalFilesDeps {
  return {
    repo: createLocalFilesRepo(openLocalDatabase()),
    readTags,
    thumbnail: makeThumbnail,
    refreshLibraryTracks: (tracks) => getLibrary().refreshTracks(tracks),
    pickDirectory,
    canKeepFolders,
    objectUrls: new ObjectUrlCache(),
    now: () => Date.now(),
    uuid: randomUuid,
  }
}

let current: LocalFiles | undefined

/** The app's local files, created on first use. */
export function getLocalFiles(): LocalFiles {
  current ??= createLocalFiles(defaultLocalFilesDeps())
  return current
}

/**
 * Tests only: drops the app's local files and deletes their database, then starts over with
 * `deps` replacing the defaults. Returns the new facade.
 */
export async function resetLocalFiles(deps: Partial<LocalFilesDeps> = {}): Promise<LocalFiles> {
  if (current !== undefined) {
    current.dispose()
    current.repo.db.close()
  }
  await Dexie.delete(LOCAL_DB_NAME)
  current = createLocalFiles({ ...defaultLocalFilesDeps(), ...deps })
  return current
}
