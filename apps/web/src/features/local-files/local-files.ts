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
 * - **Scans** run one at a time (`lane.ts`): others wait their turn as `queued`. Covers no file
 *   uses any more are deleted when no scan runs or waits.
 *
 * Each root's status (checking, scanning with progress, needs access, unavailable…) is in a
 * small store for the UI; the roots, files and covers themselves are in the database, which the
 * UI reads with live queries (`hooks.ts`).
 *
 * @module
 */

import {
  FxmError,
  type StreamLoudness,
  type StreamOption,
  sanitizeStreamLoudness,
  type Track,
} from '@fxm/core'
import { Dexie } from 'dexie'
import { createStore, type StoreApi } from 'zustand/vanilla'
import { getLibrary, randomUuid } from '../../db/repo'
import { type MakeThumbnail, makeThumbnail } from './artwork'
import { LOCAL_DB_NAME, openLocalDatabase } from './database'
import {
  canChooseFolders,
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
  pathInside,
  pickDirectory,
  sameFolder,
  walkDirectory,
} from './file-system'
import { SerialLane } from './lane'
import { ObjectUrlCache } from './object-urls'
import { createLocalFilesRepo, type LocalFilesRepo } from './repo'
import { type ScanOutcome, type ScanProgress, scanRoot } from './scanner'
import { type ReadTags, readTags } from './tags'
import { toLocalTracks } from './tracks'
import type { LocalAudioFormat, LocalFileRecord, LocalRootRecord } from './types'

/** Where a root stands in this visit. */
export type RootStatus =
  /** Not checked yet in this visit. */
  | { state: 'checking' }
  /** Its files can be read and played. */
  | { state: 'ready' }
  /** Waiting for another root's scan to finish before its own starts. */
  | { state: 'queued' }
  /**
   * Being scanned: `found` audio files so far (all of them once `walked`), `read` of them
   * dealt with.
   */
  | ({ state: 'scanning' } & ScanProgress)
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
  /** Whether a file input can pick a whole folder. */
  canChooseFolders: () => boolean
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
  /** The folder asked for with `replace` now reads from the one picked; its scan runs. */
  | { status: 'replaced'; root: LocalRootRecord }
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
export function streamOptionOf(
  format: LocalAudioFormat,
  url: string,
  loudness?: StreamLoudness,
): StreamOption {
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
  if (loudness !== undefined) stream.loudness = loudness
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

/** A scan that runs or waits its turn. */
interface Scan {
  controller: AbortController
  /** Its outcome; `undefined` when it failed or never ran. */
  done: Promise<ScanOutcome | undefined>
}

/** A kept folder inside another, by its path there: `Jazz` for `Music/Jazz`. */
interface FolderMove {
  rootId: string
  path: string
}

/** Creates the facade; the app uses {@link getLocalFiles}. */
export function createLocalFiles(deps: LocalFilesDeps) {
  const { repo, now, uuid, objectUrls } = deps
  const store = createStore<LocalFilesState>()(() => ({ statuses: {} }))
  /** Folder handles read so far, so a click can ask for access without waiting for storage. */
  const handles = new Map<string, FileSystemDirectoryHandle>()
  /** The picked files of each picked root that is available in this visit. */
  const sessions = new Map<string, PickedSet>()
  /** Scans that run or wait, by root ID. */
  const scans = new Map<string, Scan>()
  /** Runs the scans, and pruning, one at a time. */
  const lane = new SerialLane()
  /** Whether covers may have lost their last file since the last prune. */
  let pruneWanted = false
  /**
   * Folders scanned in this visit, or whose scan the user stopped: checking them again doesn't
   * scan them. Scan for changes, Allow access and adding the folder again still do.
   */
  const scannedThisVisit = new Set<string>()
  let checking: Promise<void> | undefined

  // Covers are pruned only while no scan runs or waits: a scan stores a cover before the
  // records that use it.
  lane.onIdle = () => {
    if (!pruneWanted) return
    pruneWanted = false
    void lane.run(() => repo.prunePictures().catch(() => 0))
  }

  function prune(): void {
    pruneWanted = true
    if (!lane.busy) lane.onIdle?.()
  }

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
   * Shows a scan's progress at most every {@link PROGRESS_INTERVAL_MS}: the end of the walk at
   * once (the bar turns from "found so far" into "x of y"), and the last news before a pause (a
   * slow file) a moment later. News of a scan that is over never shows.
   */
  function progressOf(rootId: string, current: () => boolean) {
    let shownAt = Number.NEGATIVE_INFINITY
    let walked = false
    let latest: ScanProgress | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    const show = () => {
      timer = undefined
      if (latest === undefined || !current()) return
      shownAt = now()
      walked = latest.walked
      setStatus(rootId, { state: 'scanning', ...latest })
      latest = undefined
    }
    return {
      report(progress: ScanProgress): void {
        if (!current()) return
        latest = progress
        if (progress.walked !== walked || now() - shownAt >= PROGRESS_INTERVAL_MS) show()
        else timer ??= setTimeout(show, PROGRESS_INTERVAL_MS)
      },
      stop(): void {
        clearTimeout(timer)
        timer = undefined
        latest = undefined
      },
    }
  }

  /** One scan of `root`, once its turn in the lane came. */
  async function scanNow(
    root: LocalRootRecord,
    directories: (signal: AbortSignal) => AsyncIterable<FoundDirectory> | Iterable<FoundDirectory>,
    signal: AbortSignal,
    current: () => boolean,
  ): Promise<ScanOutcome | undefined> {
    setStatus(root.id, { state: 'scanning', found: 0, read: 0, walked: false })
    const progress = progressOf(root.id, current)
    try {
      const outcome = await scanRoot(deps, {
        root,
        directories: directories(signal),
        complete: root.kind !== 'picked-files',
        signal,
        onProgress: progress.report,
      }).finally(progress.stop)
      if (outcome.status === 'done') {
        scannedThisVisit.add(root.id)
        const latest = await repo.getRoot(root.id)
        if (latest !== undefined) {
          const { skipped: _previous, ...rest } = latest
          const skipped = Object.keys(outcome.skipped).length > 0 ? outcome.skipped : undefined
          await repo.putRoot({ ...rest, scannedAt: now(), ...(skipped ? { skipped } : {}) })
        }
      }
      // Removed, changed or unreadable files may leave covers no file uses.
      const { removed, updated, moved, skipped } = outcome
      if (removed + updated + moved > 0 || Object.keys(skipped).length > 0) pruneWanted = true
      await refreshLibrary(outcome.changed)
      setStatus(root.id, { state: 'ready' })
      return outcome
    } catch (error) {
      setStatus(root.id, statusForError(error))
      return undefined
    }
  }

  /**
   * Scans `root` from `directories` once the scans queued before it are over, unless it is
   * already being scanned or waits for its turn.
   */
  function runScan(
    root: LocalRootRecord,
    directories: (signal: AbortSignal) => AsyncIterable<FoundDirectory> | Iterable<FoundDirectory>,
  ): Promise<ScanOutcome | undefined> {
    const running = scans.get(root.id)
    if (running !== undefined) return running.done
    const controller = new AbortController()
    const { signal } = controller
    const scan: Scan = { controller, done: Promise.resolve(undefined) }
    scans.set(root.id, scan)
    const current = () => scans.get(root.id) === scan
    setStatus(root.id, { state: 'queued' })
    let started = false
    scan.done = (async () => {
      try {
        const outcome = await lane.run(() => {
          started = true
          return scanNow(root, directories, signal, current)
        }, signal)
        // Stopped before its turn: nothing changed.
        if (!started && current()) setStatus(root.id, { state: 'ready' })
        return outcome
      } finally {
        if (current()) scans.delete(root.id)
      }
    })()
    return scan.done
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
      // Without its handle FXM can't find the folder: it has to be picked again.
      setStatus(root.id, { state: 'missing' })
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
        setStatus(root.id, { state: 'missing' })
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

  /** The kept folders inside `handle`, but `except`, with their paths inside it. */
  async function foldersInside(
    handle: FileSystemDirectoryHandle,
    kept: readonly { root: LocalRootRecord; handle: FileSystemDirectoryHandle }[],
    except?: string,
  ): Promise<FolderMove[]> {
    const moves: FolderMove[] = []
    for (const { root, handle: other } of kept) {
      if (root.id === except) continue
      const path = await pathInside(handle, other)
      if (path !== undefined) moves.push({ rootId: root.id, path })
    }
    return moves
  }

  /**
   * Makes `root` read from `handle`: keeps the handle, moves the files of the folders in `moves`
   * into it by path (they keep their IDs and aren't read again) and scans it. `write` puts the
   * root record, for a new or renamed root.
   */
  async function adopt(
    root: LocalRootRecord,
    handle: FileSystemDirectoryHandle,
    moves: readonly FolderMove[],
    write: boolean,
  ): Promise<void> {
    // Files about to move must not be written by a scan meanwhile.
    if (moves.length > 0 || write) {
      await Promise.all([root.id, ...moves.map((move) => move.rootId)].map(cancelAndWait))
    }
    await repo.handles.put(root.id, handle)
    handles.set(root.id, handle)
    if (moves.length > 0 || write) await repo.adoptRoot(root, moves)
    for (const { rootId } of moves) {
      if (rootId === root.id) continue
      handles.delete(rootId)
      scannedThisVisit.delete(rootId)
      clearStatus(rootId)
    }
    scannedThisVisit.delete(root.id)
    void runScan(root, (signal) => walkDirectory(handle, signal))
  }

  const facade = {
    /** The UI state: each root's status. */
    store: store as StoreApi<LocalFilesState>,
    /** The repository, for reads. */
    repo,

    /** Whether this browser can keep access to folders (else: file inputs). */
    canKeepFolders: deps.canKeepFolders,

    /** Whether a file input can pick a whole folder here (else: music files only). */
    canChooseFolders: deps.canChooseFolders,

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
     * opens only during a user gesture. A folder that holds folders added before replaces them:
     * their songs move into it with their IDs, unread.
     *
     * With `replace`, the folder picked becomes that root's folder, for a folder that was moved
     * (or that FXM was refused): its songs keep their IDs where the paths inside match.
     */
    async addFolder({ replace }: { replace?: string } = {}): Promise<AddFolderResult> {
      const handle = await deps.pickDirectory()
      if (handle === null) return { status: 'cancelled' }
      const kept: { root: LocalRootRecord; handle: FileSystemDirectoryHandle }[] = []
      for (const root of await repo.listRoots()) {
        if (root.kind !== 'folder') continue
        const other = await handleOf(root.id)
        if (other !== undefined) kept.push({ root, handle: other })
      }
      for (const { root, handle: other } of kept) {
        if (await sameFolder(other, handle)) {
          // Picking it again grants access again: keep the new handle and look for changes.
          // Folders added inside it before (when it wasn't listed yet) join it.
          const moves = await foldersInside(handle, kept, root.id)
          await adopt(root, handle, moves, false)
          return { status: root.id === replace ? 'replaced' : 'exists', root }
        }
      }
      for (const { root, handle: other } of kept) {
        if (root.id !== replace && (await folderContains(other, handle))) {
          return { status: 'inside', root }
        }
      }
      const moves = await foldersInside(handle, kept)
      const target = replace === undefined ? undefined : await repo.getRoot(replace)
      if (target?.kind === 'folder') {
        const root: LocalRootRecord = { ...target, name: handle.name }
        await adopt(root, handle, moves, true)
        return { status: 'replaced', root }
      }
      const root: LocalRootRecord = {
        id: uuid(),
        kind: 'folder',
        name: handle.name,
        addedAt: now(),
      }
      await adopt(root, handle, moves, true)
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

    /**
     * Stops a running or waiting scan; what it read so far stays listed. The folder isn't
     * scanned again in this visit unless the user asks.
     */
    cancelScan(rootId: string): void {
      const scan = scans.get(rootId)
      if (scan === undefined) return
      scannedThisVisit.add(rootId)
      scan.controller.abort()
    },

    /**
     * The outcome of the root's running or waiting scan, once it is over: `undefined` when it
     * failed, never ran, or there is none.
     */
    async whenScanned(rootId: string): Promise<ScanOutcome | undefined> {
      return scans.get(rootId)?.done
    },

    /** Resolves once no scan runs or waits, nor any cleaning up after them. For tests. */
    settled(): Promise<void> {
      return lane.whenIdle()
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
      prune()
    },

    /**
     * Opens the file of the local track with native ID `nativeId`, asking for access to its
     * folder when needed (which works during a user gesture, such as the click on Play). Rejects
     * with an `FxmError`: `NotFound` when the file is gone; `Unavailable` for chosen files the
     * browser forgot when the page reloaded (the player skips them: only choosing them again
     * brings them back, which nothing in a queue can do); `AuthRequired` when FXM may not read
     * the folder until the user allows it (the player stops: one click allows a whole folder).
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
          throw new FxmError('Unavailable', `Choose ${what} again to play this song`)
        }
        return { file, record, root }
      }
      const handle = await handleOf(root.id)
      if (handle === undefined) {
        setStatus(root.id, { state: 'missing' })
        throw new FxmError('NotFound', `“${root.name}” was moved or deleted`)
      }
      const access = await folderAccess(handle, { request: true })
      if (access !== 'granted') {
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
      return streamOptionOf(record.format, url, sanitizeStreamLoudness(record.tags.loudness))
    },

    /** Stops every scan and revokes every object URL. */
    dispose(): void {
      lane.onIdle = undefined
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
    canChooseFolders,
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
 * `deps` replacing the defaults. With `newVisit`, the data stays: the new facade is the next
 * visit (after a reload) over the same database. Returns the new facade.
 */
export async function resetLocalFiles(
  deps: Partial<LocalFilesDeps> = {},
  { newVisit = false }: { newVisit?: boolean } = {},
): Promise<LocalFiles> {
  if (current !== undefined) {
    current.dispose()
    if (!newVisit) current.repo.db.close()
  }
  if (!newVisit) await Dexie.delete(LOCAL_DB_NAME)
  current = createLocalFiles({ ...defaultLocalFilesDeps(), ...deps })
  return current
}
