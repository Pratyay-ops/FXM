/**
 * Scans one root: reads the tags of new and changed files, keeps the ones that didn't change,
 * and forgets the ones that are gone.
 *
 * - **Unchanged files** (same size and modification time, read by this reader version) are
 *   not read again, so a rescan of a big folder takes seconds.
 * - **Covers**: a file's embedded cover, else its folder's image. Each image is thumbnailed
 *   once (by a hash of its bytes), however many tracks share it.
 * - **Moved files**: a file found at a new path that matches a file gone from its old one (same
 *   size, length, title, artists and album) keeps the old file's ID, so likes and playlists
 *   keep pointing at it. The same happens to the files of folders a new, bigger folder replaces.
 * - **Progress**: records are written in batches, so the list fills in while the scan runs.
 * - **Cancelling** keeps what was read and removes nothing: a partial walk can't tell which
 *   files are gone.
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
  /** Audio files dealt with so far: read, or found unchanged. */
  read: number
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
  /** Files of other roots this one replaces: found here, they keep their IDs. */
  absorb?: readonly LocalFileRecord[]
  signal?: AbortSignal
  onProgress?: (progress: ScanProgress) => void
  /** How many files are read at once. Default 4. */
  concurrency?: number
  /** Write read records at least this often, in milliseconds. Default 750. */
  batchMs?: number
}

/** Records written in one batch at most. */
const BATCH_SIZE = 100

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

/** Runs `task` on every item, at most `limit` at a time, in order of starting. */
async function forEachLimit<T>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++] as T
      await task(item)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
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

/** Scans `options.root`; see the module documentation. */
export async function scanRoot(deps: ScanDeps, options: ScanOptions): Promise<ScanOutcome> {
  const { repo, readTags, thumbnail, now } = deps
  const { root, signal, onProgress, concurrency = 4, batchMs = 750 } = options
  const existing = new Map((await repo.filesOfRoot(root.id)).map((file) => [file.path, file]))
  const taken = await repo.nativeIds()
  const seen = new Set<string>()
  const fresh: LocalFileRecord[] = []
  const changed: LocalFileRecord[] = []
  const skipped: SkippedCounts = {}
  const progress: ScanProgress = { found: 0, read: 0 }
  const counts = { added: 0, updated: 0, unchanged: 0 }
  const pictures = new Map<string, Promise<string | undefined>>()
  let pending: LocalFileRecord[] = []
  let unreadable: string[] = []
  let lastWrite = now()

  const skip = (reason: SkipReason) => {
    skipped[reason] = (skipped[reason] ?? 0) + 1
  }

  const flush = async () => {
    const put = pending
    const remove = unreadable
    pending = []
    unreadable = []
    lastWrite = now()
    await repo.applyFiles({ put, remove })
  }

  /** The key of the stored thumbnail of an image, making it once. */
  const storePicture = (bytes: Uint8Array, type: string): Promise<string | undefined> => {
    if (!isRasterImage(type) || bytes.length === 0) return Promise.resolve(undefined)
    const key = imageKey(bytes)
    let stored = pictures.get(key)
    if (stored === undefined) {
      stored = (async () => {
        if (await repo.hasPicture(key)) return key
        const made = await thumbnail(new Blob([bytes as Uint8Array<ArrayBuffer>], { type }))
        if (made === undefined) return undefined
        await repo.putPicture({ key, ...made })
        return key
      })().catch(() => undefined)
      pictures.set(key, stored)
    }
    return stored
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

  const scanFile = async (entry: FoundFile, folderPicture: () => Promise<string | undefined>) => {
    if (signal?.aborted) return
    seen.add(entry.path)
    const old = existing.get(entry.path)
    let file: File
    try {
      file = await entry.getFile()
    } catch {
      // Deleted or locked while the scan ran.
      progress.read++
      skip('unreadable')
      if (old !== undefined) unreadable.push(old.key)
      return
    }
    if (
      old !== undefined &&
      old.size === file.size &&
      old.lastModified === file.lastModified &&
      old.readerVersion === READER_VERSION
    ) {
      counts.unchanged++
      progress.read++
      // A folder image added since the last scan covers the files that have none.
      if (old.pictureKey === undefined) {
        const pictureKey = await folderPicture()
        if (pictureKey !== undefined) pending.push({ ...old, pictureKey })
      }
      return
    }
    const result = await readTags(file, entry.name)
    progress.read++
    if (!result.ok) {
      skip(result.reason)
      if (old !== undefined) unreadable.push(old.key)
      return
    }
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
    if (old === undefined) {
      counts.added++
      fresh.push(record)
    } else {
      counts.updated++
    }
    changed.push(record)
    pending.push(record)
    if (pending.length >= BATCH_SIZE || now() - lastWrite >= batchMs) await flush()
  }

  try {
    for await (const directory of options.directories) {
      if (signal?.aborted) break
      progress.found += directory.audio.length
      onProgress?.({ ...progress })
      const image = folderImage(directory.images)
      let folderPicture: Promise<string | undefined> | undefined
      const pictureOfFolder = () => {
        if (image === undefined) return Promise.resolve(undefined)
        folderPicture ??= readFolderImage(image)
        return folderPicture
      }
      await forEachLimit(directory.audio, concurrency, async (entry) => {
        await scanFile(entry, pictureOfFolder)
        onProgress?.({ ...progress })
      })
    }
  } catch (error) {
    // A walk stopped by the signal is a cancelled scan, not a failed one.
    if (!signal?.aborted) throw error
  } finally {
    await flush()
  }

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

  // Files the walk didn't see are gone, unless they turn up at a new path.
  const gone = [...existing.values()].filter((file) => !seen.has(file.path))
  gone.push(...(options.absorb ?? []))
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
