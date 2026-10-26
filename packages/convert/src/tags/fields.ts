/**
 * Tag values every writer shares: the artists joined for single-value fields, the year, and the
 * plain text of synced lyrics.
 *
 * @module
 */

import { CODEC_LABELS } from '@fxm/core'
import type { ExportTags } from '../types'

/**
 * The tag that names the lossy codec a converted file came from, e.g. `opus` (a core `Codec`):
 * FXM's own name, written in every format's free-form field (a Vorbis comment, an ID3 `TXXX`
 * frame, an iTunes `----` atom, a Matroska tag), so programs, FXM's Local files among them, can
 * tell a FLAC made from Opus from a lossless one.
 */
export const SOURCE_CODEC_TAG = 'FXM_SOURCE_CODEC'

/** The tag that holds that source's average bitrate in kbps, a whole number, when known. */
export const SOURCE_BITRATE_TAG = 'FXM_SOURCE_BITRATE'

/** The artists as one value, for formats with a single artist field: "A, B". */
export function joinedArtists(tags: Pick<ExportTags, 'artists'>): string {
  return tags.artists.filter((artist) => artist.trim() !== '').join(', ')
}

/** The release year of an ISO 8601 date such as `2013-05-17`, when it has one. */
export function releaseYear(date: string | undefined): string | undefined {
  const year = date === undefined ? undefined : /^(\d{4})/.exec(date)?.[1]
  return year
}

/** A positive whole number, or `undefined` for anything else (bad data). */
export function positive(value: number | undefined): number | undefined {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

/** The lyrics as plain text: the given text, or the lines of the synced lyrics. */
export function plainLyrics(tags: Pick<ExportTags, 'lyrics' | 'syncedLyrics'>): string | undefined {
  if (tags.lyrics !== undefined && tags.lyrics.trim() !== '') return tags.lyrics
  if (tags.syncedLyrics === undefined || tags.syncedLyrics.length === 0) return undefined
  return tags.syncedLyrics.map((line) => line.text).join('\n')
}

/** A bitrate fit for a tag: a positive whole number of kbps, or `undefined` for anything else. */
function kbps(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) && value > 0 ? Math.round(value) : undefined
}

/**
 * The note for people on a file converted from lossy audio, in its comment field: "Converted by
 * FXM from Opus (lossy, 160 kbps)", or "… from the AAC audio of a video (lossy)" for itag 18.
 * `undefined` for a file that wasn't.
 */
export function conversionNote(tags: Pick<ExportTags, 'convertedFrom'>): string | undefined {
  const from = tags.convertedFrom
  if (from === undefined) return undefined
  const codec = CODEC_LABELS[from.codec] ?? String(from.codec)
  const what = from.media === 'muxed-video' ? `the ${codec} audio of a video` : codec
  const rate = kbps(from.bitrateKbps)
  return `Converted by FXM from ${what} (lossy${rate === undefined ? '' : `, ${rate} kbps`})`
}

/**
 * The machine-readable fields of a file converted from lossy audio, as name and value:
 * {@link SOURCE_CODEC_TAG}, and {@link SOURCE_BITRATE_TAG} when the bitrate is known. None for a
 * file that wasn't.
 */
export function sourceFields(tags: Pick<ExportTags, 'convertedFrom'>): [string, string][] {
  const from = tags.convertedFrom
  if (from === undefined) return []
  const rate = kbps(from.bitrateKbps)
  const fields: [string, string][] = [[SOURCE_CODEC_TAG, from.codec]]
  if (rate !== undefined) fields.push([SOURCE_BITRATE_TAG, String(rate)])
  return fields
}
