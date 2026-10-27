/**
 * What the download manager keeps about each download, and the guards that check records read
 * back from storage, which may be stale or corrupt.
 *
 * @module
 */

import {
  type AudioCandidate,
  type Codec,
  type Container,
  entityKey,
  isCodec,
  isEntityId,
  isQualityTier,
  isSourceId,
  type QualityTier,
  type StreamLoudness,
  type StreamMedia,
  type StreamOption,
  type Track,
} from '@fxm/core'
import { isSafeFileName } from './storage'

/** Every {@link DownloadStatus}, in the order a download usually goes through them. */
export const DOWNLOAD_STATUSES = [
  'queued',
  'downloading',
  'paused',
  'failed',
  'completed',
  'removing',
] as const

/**
 * Where a download stands:
 *
 * - `queued`: waiting for a free slot, or for the network
 * - `downloading`: the manager is fetching it
 * - `paused`: the user paused it. The bytes so far stay, and it resumes where it stopped
 * - `failed`: it stopped on an error (see {@link DownloadRecord.error}). A retry resumes where it
 *   stopped when it can
 * - `completed`: the whole file is stored, so the track plays offline
 * - `removing`: the user cancelled or deleted it. The manager deletes the file and then the
 *   record; lists treat it as gone already
 */
export type DownloadStatus = (typeof DOWNLOAD_STATUSES)[number]

/** Every {@link DownloadErrorCode}. */
export const DOWNLOAD_ERROR_CODES = [
  'unsupported',
  'unavailable',
  'needs-review',
  'unverified',
  'redirected',
  'unreadable',
  'network',
  'server',
  'storage-full',
  'storage',
  'bot-check',
  'file-missing',
  'too-large',
  'unknown',
] as const

/**
 * Why a download failed, for the UI:
 *
 * - `unsupported`: this platform can't read the source's bytes now, e.g. YouTube audio without
 *   FXM Connect, the desktop app or the Android app
 * - `unavailable`: there is nothing to download: the track can't play anywhere (removed, blocked
 *   in the region, no source for it)
 * - `needs-review`: the track's match is a best guess the user hasn't confirmed, and FXM never
 *   stores a guess as a download
 * - `unverified`: no stream URL passed the end-of-file probe, or the bytes stayed unreadable
 *   after fresh resolutions
 * - `redirected`: on the web, the server moved the download to another host whose answer the
 *   browser wouldn't let the page read: googlevideo's `cms_redirect` with an FXM Connect older
 *   than 0.2.1, or a redirect to a host FXM Connect doesn't cover
 * - `unreadable`: on the web, the browser refused to let the page read the stream's bytes at all
 *   (FXM Connect's header rules didn't apply to them)
 * - `network`: the network failed too often
 * - `server`: the server refused or failed too often
 * - `storage-full`: the device, or the browser's share of it, is full
 * - `storage`: the storage can't work here, e.g. a private window blocks it or its worker failed
 * - `bot-check`: YouTube wants proof of a real user
 * - `file-missing`: the downloaded file is gone from storage
 * - `too-large`: the server sent far more than the track can take (see `maxDownloadBytes`), so
 *   nothing was kept
 * - `unknown`: anything else
 */
export type DownloadErrorCode = (typeof DOWNLOAD_ERROR_CODES)[number]

/** Why a download failed, or why the manager paused it, as stored on its record. */
export interface DownloadError {
  /** The reason, for the UI. */
  readonly code: DownloadErrorCode
  /** Details, for logs. */
  readonly message: string
  /** When it failed, as epoch milliseconds. */
  readonly at: number
}

/**
 * What a downloaded file holds: the original bytes of the stream it came from, so the codec,
 * the container and whether it is a muxed video (YouTube's itag 18) are the stream's.
 * Conversion is a later stage (4.2).
 */
export interface DownloadFileFormat {
  /** The audio codec. */
  readonly codec: Codec
  /** The file's container. */
  readonly container: Container
  /** Audio only, or a video file with an audio track. */
  readonly media: StreamMedia
  /** The audio's quality tier. */
  readonly tier: QualityTier
  /** The audio's average bitrate in kbps, when known. */
  readonly bitrateKbps?: number
  /** The sample rate in Hz, when known. */
  readonly sampleRateHz?: number
  /** Bits per sample, for lossless audio, when known. */
  readonly bitDepth?: number
  /**
   * How loud the audio is, as the stream said when it was downloaded (stage 8.1), e.g. YouTube's
   * `loudnessDb`: the offline copy plays at the same normalized level as the stream. Read it
   * through `sanitizeStreamLoudness`; a malformed value doesn't make the record invalid.
   */
  readonly loudness?: StreamLoudness
}

/**
 * One download. The manager keeps it in a {@link DownloadStore}, and every open tab sees the
 * same records: the UI, the playback policy's offline lookup and the manager all read them.
 *
 * Optional fields follow `exactOptionalPropertyTypes`: leave them out, never set `undefined`.
 */
export interface DownloadRecord {
  /** {@link downloadId} of the track: one download per track, whichever YouTube prefix names it. */
  readonly id: string
  /** The track the user downloaded, as it was then. */
  readonly track: Track
  /** Where it stands. */
  readonly status: DownloadStatus
  /** When it was first queued, as epoch milliseconds. Queued downloads start oldest first. */
  readonly createdAt: number
  /** When the record last changed, as epoch milliseconds. */
  readonly updatedAt: number
  /** When it completed, as epoch milliseconds. */
  readonly completedAt?: number
  /** How many bytes are stored so far, as last saved. */
  readonly bytesDone: number
  /** The file's size in bytes, once known. */
  readonly bytesTotal?: number
  /**
   * The name of its file in the `DownloadStorage`, once one was created: always a name
   * `isSafeFileName` accepts.
   */
  readonly file?: string
  /** The audio being downloaded, once resolved: a resume asks for the same audio. */
  readonly candidate?: AudioCandidate
  /** What the file holds, once resolved: a resume continues only a file of the same format. */
  readonly format?: DownloadFileFormat
  /**
   * The server's validator for the file (its `ETag` or `Last-Modified`), when readable. A resume
   * whose validator differs starts the file over.
   */
  readonly validator?: string
  /**
   * Failed attempts in a row that stored nothing new, reset when an attempt stores bytes, when
   * the download completes and when it is retried.
   */
  readonly attempts: number
  /**
   * Why it failed, while `failed`; why the manager paused it, while `paused` on the manager's
   * own account (the storage is full, YouTube asked for a bot check). Resuming clears it.
   */
  readonly error?: DownloadError
}

/**
 * The ID of a track's download: its `entityKey`, so the same YouTube video has one download
 * whether it is named `ytm:track:x` or `yt:track:x`.
 */
export function downloadId(track: Pick<Track, 'id'>): string {
  return entityKey(track.id)
}

/** A new, queued download of `track`. */
export function newDownloadRecord(track: Track, now: number): DownloadRecord {
  return {
    id: downloadId(track),
    track,
    status: 'queued',
    createdAt: now,
    updatedAt: now,
    bytesDone: 0,
    attempts: 0,
  }
}

/** `record` without its {@link DownloadRecord.error}. */
export function withoutError(record: DownloadRecord): DownloadRecord {
  if (record.error === undefined) return record
  const { error: _error, ...rest } = record
  return rest
}

/**
 * `record` restarted from nothing: its bytes, size, format and validator are forgotten, so the
 * next attempt resolves afresh and writes the file from the start.
 */
export function withoutProgress(record: DownloadRecord): DownloadRecord {
  const {
    bytesTotal: _total,
    format: _format,
    validator: _validator,
    candidate: _candidate,
    completedAt: _completedAt,
    ...rest
  } = record
  return { ...rest, bytesDone: 0 }
}

/** What a stream's file will hold, as a {@link DownloadFileFormat}. */
export function fileFormatOf(
  stream: Pick<
    StreamOption,
    | 'codec'
    | 'container'
    | 'media'
    | 'tier'
    | 'bitrateKbps'
    | 'sampleRateHz'
    | 'bitDepth'
    | 'loudness'
  >,
): DownloadFileFormat {
  return {
    codec: stream.codec,
    container: stream.container,
    media: stream.media,
    tier: stream.tier,
    ...(stream.bitrateKbps === undefined ? {} : { bitrateKbps: stream.bitrateKbps }),
    ...(stream.sampleRateHz === undefined ? {} : { sampleRateHz: stream.sampleRateHz }),
    ...(stream.bitDepth === undefined ? {} : { bitDepth: stream.bitDepth }),
    ...(stream.loudness === undefined ? {} : { loudness: stream.loudness }),
  }
}

/**
 * Whether two formats describe the same file encoding: the same codec, container and media, and
 * the same bitrate when both know it. A partial file is continued only with a stream of the
 * same format.
 */
export function sameFileFormat(a: DownloadFileFormat, b: DownloadFileFormat): boolean {
  return (
    a.codec === b.codec &&
    a.container === b.container &&
    a.media === b.media &&
    (a.bitrateKbps === undefined || b.bitrateKbps === undefined || a.bitrateKbps === b.bitrateKbps)
  )
}

/** Whether a download is still on its way: queued, downloading, paused or failed. */
export function isPendingDownload(record: Pick<DownloadRecord, 'status'>): boolean {
  return record.status !== 'completed' && record.status !== 'removing'
}

const CONTAINERS: ReadonlySet<string> = new Set([
  'webm',
  'mp4',
  'm4a',
  'mp3',
  'ogg',
  'flac',
  'wav',
] satisfies Container[])

function asRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Readonly<Record<string, unknown>>)
    : undefined
}

function isTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function isByteCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function optional(value: unknown, check: (value: unknown) => boolean): boolean {
  return value === undefined || check(value)
}

/** Whether `value` looks like a core `Track`: what the manager and the lists rely on. */
function isTrackLike(value: unknown): value is Track {
  const track = asRecord(value)
  return (
    track !== undefined &&
    isEntityId(track.id, 'track') &&
    isSourceId(track.source) &&
    typeof track.title === 'string' &&
    Array.isArray(track.artists) &&
    Array.isArray(track.artwork) &&
    typeof track.kind === 'string'
  )
}

/** Whether `value` looks like an `AudioCandidate`. */
function isCandidateLike(value: unknown): value is AudioCandidate {
  const candidate = asRecord(value)
  return (
    candidate !== undefined &&
    isSourceId(candidate.source) &&
    typeof candidate.ref === 'string' &&
    candidate.ref !== '' &&
    typeof candidate.kind === 'string' &&
    typeof candidate.title === 'string' &&
    Array.isArray(candidate.artists) &&
    typeof candidate.confidence === 'number' &&
    Array.isArray(candidate.evidence)
  )
}

/** Whether `value` is a well-formed {@link DownloadFileFormat}. */
export function isDownloadFileFormat(value: unknown): value is DownloadFileFormat {
  const format = asRecord(value)
  return (
    format !== undefined &&
    isCodec(format.codec) &&
    typeof format.container === 'string' &&
    CONTAINERS.has(format.container) &&
    (format.media === 'audio' || format.media === 'muxed-video') &&
    isQualityTier(format.tier) &&
    optional(format.bitrateKbps, isTime) &&
    optional(format.sampleRateHz, isTime) &&
    optional(format.bitDepth, isTime)
  )
}

function isDownloadError(value: unknown): value is DownloadError {
  const error = asRecord(value)
  return (
    error !== undefined &&
    (DOWNLOAD_ERROR_CODES as readonly unknown[]).includes(error.code) &&
    typeof error.message === 'string' &&
    isTime(error.at)
  )
}

/**
 * Whether `value` is a well-formed {@link DownloadRecord}, e.g. one read back from IndexedDB.
 * The manager and the offline lookup ignore anything else, so a corrupt record never plays or
 * breaks the queue.
 */
export function isDownloadRecord(value: unknown): value is DownloadRecord {
  const record = asRecord(value)
  if (record === undefined || !isTrackLike(record.track)) return false
  return (
    typeof record.id === 'string' &&
    record.id === downloadId(record.track) &&
    (DOWNLOAD_STATUSES as readonly unknown[]).includes(record.status) &&
    isTime(record.createdAt) &&
    isTime(record.updatedAt) &&
    optional(record.completedAt, isTime) &&
    isByteCount(record.bytesDone) &&
    optional(record.bytesTotal, isByteCount) &&
    optional(record.file, isSafeFileName) &&
    optional(record.candidate, isCandidateLike) &&
    optional(record.format, isDownloadFileFormat) &&
    optional(record.validator, (validator) => typeof validator === 'string') &&
    isByteCount(record.attempts) &&
    optional(record.error, isDownloadError)
  )
}
