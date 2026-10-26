/**
 * Scans one root: reads the tags of new and changed files, keeps the ones that didn't change,
 * and forgets the ones that are gone.
 *
 * - **Unchanged files** (same size and modification time, read by this reader version) are
 *   not read again, so a rescan of a big folder takes seconds.
 * - **Covers**: a file's embedded cover, else its folder's image. Each image is thumbnailed
 *   once (by a hash of its bytes), however many tracks share it. A file whose thumbnail went
 *   missing is read again, so its cover comes back.
 * - **Moved files**: a file found at a new path that matches a file gone from its old one (same
 *   size, length, title, artists and album) keeps the old file's ID, so likes and playlists
 *   keep pointing at it.
 * - **Walking and reading** run side by side: the walk lists the folders ahead of the reading,
 *   so `found` is soon the whole root (`walked`), while the first songs are already listed.
 * - **Progress**: records are written in batches, soon at first, so the list fills in, then
 *   every few seconds, so the lists that show them don't reload all the time.
 * - **Failures**: a file that can't be read, or a subfolder that can't be listed, is left out
 *   and the scan goes on. Only the root itself, or the database, fails the scan.
 * - **Cancelling** keeps what was read and removes nothing: a partial walk can't tell which
 *   files are gone.
 *
 * Scans of one database must not overlap: a scan reads the IDs in use when it starts, and
 * hands out new ones from them. The facade runs one at a time (`local-files.ts`).
 *
 * @module
 */

import { normalizeText } from '@fxm/core'
import type { MakeThumbnail } from './artwork'
import { folderImageRank, folderImageType, imageKey, isRasterImage } from './artwork'
import type { FoundDirectory, FoundFile } from './file-system'
import { newTrackNativeId } from './ids'
import type { LocalFilesRepo } from './repo'
import { READER_VERSION, type ReadTags } from './tags'
import {
  fileKey,
  type LocalFileRecord,
  type LocalRootRecord,
  type SkippedCounts,
  type SkipReason,
} from './types'

/** What a scan works with; tests pass fakes. */
export interface ScanDeps {
  repo: LocalFilesRepo
  readTags: ReadTags
  thumbnail: MakeThumbnail
  now: () => number
}

/** How far a scan got. */
export interface ScanProgress {
  /** Audio files found so far. */
  found: number
  /** Audio files dealt with so far: read, found unchanged, or left out. */
  read: number
  /** Whether the walk is over, so `found` is every audio file of the root. */
  walked: boolean
}

/** What a scan did. */
export interface ScanOutcome {
  /** `cancelled` when the signal aborted: nothing was removed then. */
  status: 'done' | 'cancelled'
  added: number
  updated: number
  removed: number
  /** Files found at a new path that kept their ID. */
  moved: number
  unchanged: number
  /** Files left out, by reason. */
  skipped: SkippedCounts
  /** The records written (new, changed or moved), so the library can refresh its copies. */
  changed: LocalFileRecord[]
}

/** What to scan, and how. */
export interface ScanOptions {
  root: LocalRootRecord
  /** The root's directories, e.g. from `walkDirectory` or `groupPickedFiles`. */
  directories: AsyncIterable<FoundDirectory> | Iterable<FoundDirectory>
  /**
   * Whether the directories cover the whole root, so a listed file they lack is gone. False for
   * single picked files, which add up across picks.
   */
  complete: boolean
  signal?: AbortSignal
  onProgress?: (progress: ScanProgress) => void
  /** How many files are read at once. Default 4. */
  concurrency?: number
  /** Write the first records read within this many milliseconds. Default 750. */
  batchMs?: number
  /** Then write at least this often, in milliseconds. Default 3000. */
  laterBatchMs?: number
}

/** Records written in the first batch at most, so the first songs show up soon. */
const FIRST_BATCH_SIZE = 100

/**
 * Records written in each later batch at most. Every write makes the lists load and sort every
 * file again, so a big first scan writes seldom.
 */
const BATCH_SIZE = 1000

/** What two copies of one file share, wherever they are. */
function fingerprint(file: LocalFileRecord): string {
  const { tags } = file
  return [
    file.size,
    tags.durationMs ?? '',
    normalizeText(tags.title),
    normalizeText(tags.artists.join('\u0000')),
    normalizeText(tags.album ?? ''),
  ].join('\u0001')
}

/**
 * Runs `task` on every item, at most `limit` at a time, in order of starting. After a task
 * fails, no new one starts; the running ones finish, then the first failure is thrown.
 */
export async function forEachLimit<T>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0
  let failure: { error: unknown } | undefined
  const worker = async () => {
    while (failure === undefined && next < items.length) {
      const item = items[next++] as T
      try {
        await task(item)
      } catch (error) {
        failure ??= { error }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  if (failure !== undefined) throw failure.error
}

/** The best folder image of a directory, if it has one. */
function folderImage(images: readonly FoundFile[]): FoundFile | undefined {
  let best: { image: FoundFile; rank: number } | undefined
  for (const image of images) {
    const rank = folderImageRank(image.name)
    if (rank !== undefined && (best === undefined || rank < best.rank)) best = { image, rank }
  }
  return best?.image
}

/** What looking at one file found. */
type Examined =
  /** Unchanged; `update` when a folder image now covers it. */
  | { kind: 'unchanged'; update?: LocalFileRecord }
  /** Read: a new record, or a changed one. */
  | { kind: 'read'; record: LocalFileRecord }
  | { kind: 'skipped'; reason: SkipReason }

/** Scans `options.root`; see the module documentation. */
export async function scanRoot(deps: ScanDeps, options: ScanOptions): Promise<ScanOutcome> {
  const { repo, readTags, thumbnail, now } = deps
  const {
    root,
    signal,
    onProgress,
    concurrency = 4,
    batchMs = 750,
    laterBatchMs = Math.max(batchMs, 3000),
  } = options
  const existing = new Map((await repo.filesOfRoot(root.id)).map((file) => [file.path, file]))
  const taken = await repo.nativeIds()
  const stored = await repo.pictureKeys()
  const seen = new Set<string>()
  /** Directories that couldn't be listed: what they held stays listed. */
  const unlisted: string[] = []
  const fresh: LocalFileRecord[] = []
  const changed: LocalFileRecord[] = []
  const skipped: SkippedCounts = {}
  const progress: ScanProgress = { found: 0, read: 0, walked: false }
  const counts = { added: 0, updated: 0, unchanged: 0 }
  const pictures = new Map<string, Promise<string | undefined>>()
  let pending: LocalFileRecord[] = []
  let unreadable: string[] = []
  let writes = 0
  let lastWrite = now()
  /** A batch written on time while no file finished (slow files), and how that went. */
  let timer: ReturnType<typeof setTimeout> | undefined
  let timedWrite: Promise<void> = Promise.resolve()
  let writeFailure: { error: unknown } | undefined

  const report = () => onProgress?.({ ...progress })

  const skip = (reason: SkipReason) => {
    skipped[reason] = (skipped[reason] ?? 0) + 1
  }

  const flush = async () => {
    clearTimeout(timer)
    timer = undefined
    const put = pending
    const remove = unreadable
    pending = []
    unreadable = []
    lastWrite = now()
    if (put.length === 0 && remove.length === 0) return
    writes++
    await repo.applyFiles({ put, remove })
  }

  /**
   * Writes the batch when it is big or old enough. Otherwise its time is set, so slow files (a
   * network drive, a file being synced) don't hold back the songs read before them.
   */
  const flushWhenDue = async () => {
    if (writeFailure !== undefined) throw writeFailure.error
    const [size, ms] = writes === 0 ? [FIRST_BATCH_SIZE, batchMs] : [BATCH_SIZE, laterBatchMs]
    const waiting = pending.length + unreadable.length
    if (waiting >= size || now() - lastWrite >= ms) {
      await flush()
    } else if (waiting > 0 && timer === undefined) {
      timer = setTimeout(
        () => {
          timer = undefined
          timedWrite = flush().catch((error: unknown) => {
            writeFailure ??= { error }
          })
        },
        Math.max(0, ms - (now() - lastWrite)),
      )
    }
  }

  /** The key of the stored thumbnail of an image, making it once. */
  const storePicture = (bytes: Uint8Array, type: string): Promise<string | undefined> => {
    if (!isRasterImage(type) || bytes.length === 0) return Promise.resolve(undefined)
    const key = imageKey(bytes)
    let made = pictures.get(key)
    if (made === undefined) {
      made = (async () => {
        if (stored.has(key) || (await repo.hasPicture(key))) return key
        const image = await thumbnail(new Blob([bytes as Uint8Array<ArrayBuffer>], { type }))
        if (image === undefined) return undefined
        await repo.putPicture({ key, ...image })
        stored.add(key)
        return key
      })().catch(() => undefined)
      pictures.set(key, made)
    }
    return made
  }

  const readFolderImage = async (image: FoundFile): Promise<string | undefined> => {
    try {
      const file = await image.getFile()
      return await storePicture(
        new Uint8Array(await file.arrayBuffer()),
        folderImageType(image.name),
      )
    } catch {
      return undefined
    }
  }

  /** Looks at one file: unchanged, read again, or left out. Throws when it can't be read. */
  const examine = async (
    entry: FoundFile,
    old: LocalFileRecord | undefined,
    folderPicture: () => Promise<string | undefined>,
  ): Promise<Examined> => {
    const file = await entry.getFile()
    if (
      old !== undefined &&
      old.size === file.size &&
      old.lastModified === file.lastModified &&
      old.readerVersion === READER_VERSION &&
      // A thumbnail gone missing is made again from the file.
      (old.pictureKey === undefined || stored.has(old.pictureKey))
    ) {
      // A folder image added since the last scan covers the files that have none.
      if (old.pictureKey !== undefined) return { kind: 'unchanged' }
      const pictureKey = await folderPicture()
      return pictureKey === undefined
        ? { kind: 'unchanged' }
        : { kind: 'unchanged', update: { ...old, pictureKey } }
    }
    const result = await readTags(file, entry.name)
    if (!result.ok) return { kind: 'skipped', reason: result.reason }
    let pictureKey: string | undefined
    if (result.picture !== undefined) {
      pictureKey = await storePicture(result.picture.data, result.picture.format)
    }
    pictureKey ??= await folderPicture()
    const id = old?.id ?? newTrackNativeId(root.name, entry.path, taken)
    taken.add(id)
    const at = now()
    const record: LocalFileRecord = {
      key: fileKey(root.id, entry.path),
      rootId: root.id,
      path: entry.path,
      id,
      size: file.size,
      lastModified: file.lastModified,
      tags: result.tags,
      format: result.format,
      readerVersion: READER_VERSION,
      addedAt: old?.addedAt ?? at,
      updatedAt: at,
    }
    if (pictureKey !== undefined) record.pictureKey = pictureKey
    return { kind: 'read', record }
  }

  const scanFile = async (entry: FoundFile, folderPicture: () => Promise<string | undefined>) => {
    if (signal?.aborted) return
    seen.add(entry.path)
    const old = existing.get(entry.path)
    let examined: Examined
    try {
      examined = await examine(entry, old, folderPicture)
    } catch {
      // Deleted, locked or changed while the scan read it (a folder that syncs, say).
      examined = { kind: 'skipped', reason: 'unreadable' }
    }
    progress.read++
    if (examined.kind === 'skipped') {
      skip(examined.reason)
      if (old !== undefined) unreadable.push(old.key)
    } else if (examined.kind === 'unchanged') {
      counts.unchanged++
      if (examined.update !== undefined) pending.push(examined.update)
    } else {
      const { record } = examined
      if (old === undefined) {
        counts.added++
        fresh.push(record)
      } else {
        counts.updated++
      }
      changed.push(record)
      pending.push(record)
    }
    report()
    // A write that fails (a full disk) fails the scan: what it read would be lost otherwise.
    await flushWhenDue()
  }

  const readDirectory = async (directory: FoundDirectory) => {
    if (directory.unlisted) unlisted.push(directory.dir)
    const image = folderImage(directory.images)
    let folderPicture: Promise<string | undefined> | undefined
    const pictureOfFolder = () => {
      if (image === undefined) return Promise.resolve(undefined)
      folderPicture ??= readFolderImage(image)
      return folderPicture
    }
    await forEachLimit(directory.audio, concurrency, (entry) => scanFile(entry, pictureOfFolder))
  }

  // The walk runs ahead of the reading: it finds what there is quickly, while reading tags is
  // slow. The reading takes the directories in the order the walk found them.
  const queue: FoundDirectory[] = []
  let walkFailure: { error: unknown } | undefined
  let stopWalk = false
  let wake: (() => void) | undefined
  const walk = (async () => {
    try {
      for await (const directory of options.directories) {
        if (signal?.aborted || stopWalk) break
        queue.push(directory)
        progress.found += directory.audio.length
        report()
        wake?.()
      }
    } catch (error) {
      walkFailure = { error }
    } finally {
      progress.walked = true
      report()
      wake?.()
    }
  })()

  try {
    for (;;) {
      if (signal?.aborted || walkFailure !== undefined) break
      const directory = queue.shift()
      if (directory !== undefined) {
        await readDirectory(directory)
      } else if (progress.walked) {
        break
      } else {
        await new Promise<void>((resolve) => {
          wake = resolve
        })
        wake = undefined
      }
    }
  } finally {
    stopWalk = true
    await walk
    clearTimeout(timer)
    await timedWrite
    await flush()
  }
  if (writeFailure !== undefined) throw writeFailure.error
  // A walk stopped by the signal is a cancelled scan, not a failed one.
  if (walkFailure !== undefined && !signal?.aborted) throw walkFailure.error

  const outcome = (status: ScanOutcome['status'], removed: number, moved: number) => ({
    status,
    added: counts.added - moved,
    updated: counts.updated,
    unchanged: counts.unchanged,
    removed,
    moved,
    skipped,
    changed,
  })
  if (signal?.aborted || !options.complete)
    return outcome(signal?.aborted ? 'cancelled' : 'done', 0, 0)

  // Files the walk didn't see are gone, unless they turn up at a new path, or their folder
  // couldn't be listed this time.
  const inUnlisted = (path: string) => unlisted.some((dir) => path.startsWith(`${dir}/`))
  const gone = [...existing.values()].filter(
    (file) => !seen.has(file.path) && !inUnlisted(file.path),
  )
  const goneByPrint = new Map<string, LocalFileRecord[]>()
  for (const file of gone) {
    const print = fingerprint(file)
    goneByPrint.set(print, [...(goneByPrint.get(print) ?? []), file])
  }
  const moved: LocalFileRecord[] = []
  for (const record of fresh) {
    const match = goneByPrint.get(fingerprint(record))?.shift()
    if (match === undefined) continue
    const kept = { ...record, id: match.id, addedAt: match.addedAt }
    moved.push(kept)
    changed[changed.indexOf(record)] = kept
  }
  await repo.applyFiles({ put: moved, remove: gone.map((file) => file.key) })
  return outcome('done', gone.length - moved.length, moved.length)
}
