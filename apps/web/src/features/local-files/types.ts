/**
 * What the local-files feature stores about music files on this device (see `database.ts`):
 * the folders it reads, one record per audio file with its tags and format, and the small
 * cover images the lists show.
 *
 * None of it goes into library backups: it describes files on this device only. The tracks a
 * user likes or adds to a playlist go into the library like any other track (source `local`).
 *
 * Optional fields follow `exactOptionalPropertyTypes`: leave them out, never set `undefined`.
 *
 * @module
 */

import type { Codec, Container, QualityTier } from '@fxm/core'

/**
 * Where a root's files come from:
 *
 * - `folder`: a folder the user picked with the File System Access API (Chromium). FXM keeps
 *   its handle and asks again for permission to read it in later visits
 * - `picked-folder`: a folder chosen through a file input (every other browser). The browser
 *   forgets the files when the page reloads, so the user chooses the folder again
 * - `picked-files`: single files chosen through a file input, also forgotten on reload
 */
export type LocalRootKind = 'folder' | 'picked-folder' | 'picked-files'

/** A folder, or a set of picked files, whose music FXM lists. */
export interface LocalRootRecord {
  /** A random ID. */
  id: string
  kind: LocalRootKind
  /**
   * The folder's name, e.g. `Music`. It is part of every file's ID (see `ids.ts`), so adding
   * the same folder again, also in another browser, gives its songs the same IDs.
   */
  name: string
  /** When it was added, as epoch milliseconds. */
  addedAt: number
  /** When its last complete scan finished. */
  scannedAt?: number
  /** Files the last scan found but can't list, by why. Absent when there were none. */
  skipped?: SkippedCounts
}

/** Why a file was left out of the list. */
export type SkipReason =
  /** Not a format browsers play, e.g. ALAC in an `.mp3`, Monkey's Audio, a video. */
  | 'unsupported'
  /** Its tags or audio header couldn't be read: a damaged or unfinished file. */
  | 'unreadable'

/** How many files a scan left out, by reason. */
export type SkippedCounts = Partial<Record<SkipReason, number>>

/** The audio format of a file, as the player and the quality labels need it. */
export interface LocalAudioFormat {
  codec: Codec
  container: Container
  /**
   * From `tierOf`: `lossless` for FLAC, ALAC and WAV (PCM) only, never for a lossy codec,
   * whatever its bitrate.
   */
  tier: QualityTier
  /** Average bitrate in kbps, when known. */
  bitrateKbps?: number
  /** Sample rate in Hz, when known. */
  sampleRateHz?: number
  /** Bits per sample, for lossless files. */
  bitDepth?: number
}

/** The tags FXM keeps from a file, cleaned up (see `tags.ts`). */
export interface LocalTags {
  /** The title tag, else the file name without its extension and track number. */
  title: string
  /** Credited artists, main artist first. Empty when the file names none. */
  artists: string[]
  /** The album artist, when tagged. */
  albumArtist?: string
  album?: string
  trackNumber?: number
  discNumber?: number
  /** ISO 8601, possibly partial: `2013`, `2013-05` or `2013-05-17`. */
  releaseDate?: string
  /** Canonical ISRC (`normalizeIsrc`). */
  isrc?: string
  /** Whether the file is tagged as part of a compilation. */
  compilation?: boolean
  durationMs?: number
}

/** One audio file FXM lists. */
export interface LocalFileRecord {
  /** `<rootId>/<path>`: see {@link fileKey}. */
  key: string
  rootId: string
  /**
   * Where the file is inside its root, `/`-separated and without the root's own name, e.g.
   * `Artist/Album/01 Song.flac`. For picked files: the file name.
   */
  path: string
  /**
   * The native ID of the file's track: `local:track:<id>` is its track ID. Chosen when the file
   * is first seen (see `ids.ts`) and kept across rescans, also when the file moves.
   */
  id: string
  /** File size in bytes, to notice changes. */
  size: number
  /** Last modification time, as epoch milliseconds, to notice changes. */
  lastModified: number
  tags: LocalTags
  format: LocalAudioFormat
  /** The cover image: embedded in the file, else the folder's `cover.jpg` and the like. */
  pictureKey?: string
  /** Which version of the tag reader wrote this record; older ones are read again. */
  readerVersion: number
  /** When the file was first listed, as epoch milliseconds. */
  addedAt: number
  /** When its tags were last read. */
  updatedAt: number
}

/** A cover image, small enough to keep with every track that shows it. */
export interface LocalPictureRecord {
  /** A hash of the original image's bytes, so an album's tracks share one record. */
  key: string
  /** A small JPEG or WebP as a `data:` URL, which works everywhere tracks go. */
  url: string
  width: number
  height: number
}

/** A folder handle, kept apart from the root so tests can store it in memory. */
export interface HandleRecord {
  rootId: string
  handle: FileSystemDirectoryHandle
}

/** The key of a file record: its root and its path. */
export function fileKey(rootId: string, path: string): string {
  return `${rootId}/${path}`
}

/** The name single chosen files are listed under. It is part of their IDs: don't change it. */
export const PICKED_FILES_NAME = 'Chosen files'
