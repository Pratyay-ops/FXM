/**
 * The vocabulary of conversion: what a stored file holds, what a saved file gets as tags, and
 * the errors a conversion can end with.
 *
 * @module
 */

import type { Codec, Container, StreamMedia } from '@fxm/core'

/**
 * What a stored download holds: the original bytes of the stream it came from. The download
 * manager's `DownloadFileFormat` (`@fxm/downloads`) is one, so a record's `format` can be passed
 * as it is.
 */
export interface SourceAudio {
  /** The audio codec. */
  readonly codec: Codec
  /** The file's container. */
  readonly container: Container
  /** Audio only, or a video file with an audio track (YouTube's itag 18). */
  readonly media: StreamMedia
  /** The average bitrate in kbps, when known. */
  readonly bitrateKbps?: number
  /** The sample rate in Hz, when known. */
  readonly sampleRateHz?: number
  /** Bits per sample, for lossless audio, when known. */
  readonly bitDepth?: number
}

/** A cover image to embed: JPEG or PNG, which every tag format and player understands. */
export interface CoverArt {
  readonly mimeType: 'image/jpeg' | 'image/png'
  readonly data: Uint8Array
  /** Its size in pixels, when known (FLAC and Ogg pictures carry it). */
  readonly width?: number
  readonly height?: number
}

/** A line of synced lyrics: when it starts, in milliseconds, and its text. */
export interface TimedLyric {
  readonly timeMs: number
  readonly text: string
}

/**
 * The tags a saved file gets. Every format gets the same information, in its own fields: ID3v2.3
 * for MP3 (and inside WAV), Vorbis comments for FLAC and Ogg, iTunes atoms for M4A, Matroska
 * tags for WebM. Optional fields follow `exactOptionalPropertyTypes`: leave them out.
 */
export interface ExportTags {
  readonly title: string
  /** Credited artists, main artist first. Formats with one artist field get them joined. */
  readonly artists: readonly string[]
  readonly album?: string
  /** Position on its disc, from 1. */
  readonly trackNumber?: number
  /** Disc number, from 1. */
  readonly discNumber?: number
  /** Release date as ISO 8601, possibly partial: `2013`, `2013-05` or `2013-05-17`. */
  readonly releaseDate?: string
  /** The ISRC, in canonical form. */
  readonly isrc?: string
  /** The lyrics as plain text, one line per line. */
  readonly lyrics?: string
  /**
   * Synced lyrics, when the source has them. MP3 (and WAV) files get them as an ID3 SYLT frame
   * too; the other formats have no standard field for them and get the plain text only.
   */
  readonly syncedLyrics?: readonly TimedLyric[]
  readonly cover?: CoverArt
}

/** Why a conversion failed, for the UI. */
export type ConvertErrorCode =
  /** The ffmpeg core can't load here: it isn't deployed, it failed its checks, or the browser can't run it. */
  | 'core-unavailable'
  /** The file is in a format the core can't read. */
  | 'unsupported-input'
  /** The file is damaged. */
  | 'corrupt-input'
  /** The file is too large to convert in this browser's memory. */
  | 'out-of-memory'
  /** The user cancelled it. */
  | 'cancelled'
  /** Anything else. */
  | 'failed'

/** A conversion that failed: a code for the UI, details for logs. */
export class ConvertError extends Error {
  readonly code: ConvertErrorCode

  constructor(code: ConvertErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'ConvertError'
    this.code = code
  }
}

/** Whether `error` is a {@link ConvertError}, optionally of `code`. */
export function isConvertError(error: unknown, code?: ConvertErrorCode): error is ConvertError {
  return error instanceof ConvertError && (code === undefined || error.code === code)
}
