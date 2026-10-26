/**
 * Tag values every writer shares: the artists joined for single-value fields, the year, and the
 * plain text of synced lyrics.
 *
 * @module
 */

import type { ExportTags } from '../types'

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
