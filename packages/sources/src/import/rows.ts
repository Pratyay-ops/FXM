/**
 * Helpers for import rows: cleaning the text and numbers files hold, telling duplicates apart,
 * and the library track a row stands for.
 *
 * @module
 */

import {
  type EntityId,
  entityKey,
  formatId,
  normalizeIsrc,
  normalizeText,
  parseId,
  type Track,
} from '@fxm/core'
import type { ImportCollection, ImportRow, ImportSkips, StoredRow } from './types'

/** The longest title, album or label an import keeps. */
export const MAX_TEXT_LENGTH = 300

/** The most artists an import keeps for one row. */
export const MAX_ARTISTS = 16

/** The most rows one playlist of an import holds (the library's limit is higher). */
export const MAX_IMPORT_ROWS = 20_000

/** The longest track an import believes, in milliseconds: 24 hours. */
const MAX_DURATION_MS = 24 * 60 * 60 * 1000

/**
 * `value` as one line of text: trimmed, inner whitespace collapsed, control characters dropped,
 * at most `max` characters. `undefined` when nothing is left.
 */
export function cleanText(value: unknown, max = MAX_TEXT_LENGTH): string | undefined {
  if (typeof value !== 'string') return undefined
  const clean = value
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, max)
    .trim()
  return clean === '' ? undefined : clean
}

/** Cleaned artist names, each once, at most {@link MAX_ARTISTS}. */
export function cleanArtists(names: readonly unknown[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const name of names) {
    const clean = cleanText(name)
    if (clean === undefined) continue
    const key = clean.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    result.push(clean)
    if (result.length >= MAX_ARTISTS) break
  }
  return result
}

/** A length in milliseconds, when it is a believable one (1 s to 24 h); otherwise `undefined`. */
export function cleanDuration(ms: unknown): number | undefined {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return undefined
  const rounded = Math.round(ms)
  return rounded >= 1000 && rounded <= MAX_DURATION_MS ? rounded : undefined
}

/**
 * A length written as text: `3:45`, `1:02:03`, or a number. A number counts as milliseconds when
 * `unit` says so, or when it is 10,000 or more; below that, as seconds. `undefined` when it is
 * none or not believable.
 */
export function parseDurationText(text: unknown, unit?: 'ms' | 's'): number | undefined {
  const value = cleanText(text, 32)
  if (value === undefined) return undefined
  const clock = /^(?:(\d{1,2}):)?(\d{1,3}):(\d{2})(?:\.\d+)?$/u.exec(value)
  if (clock) {
    const [, hours = '0', minutes = '0', seconds = '0'] = clock
    return cleanDuration((Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds)) * 1000)
  }
  if (!/^\d+(?:\.\d+)?$/u.test(value)) return undefined
  const number = Number(value)
  const ms = unit === 'ms' || (unit === undefined && number >= 10_000) ? number : number * 1000
  return cleanDuration(ms)
}

/** `true` or `false` from `true`/`false`, `yes`/`no` and `1`/`0`; `undefined` otherwise. */
export function parseBoolean(text: unknown): boolean | undefined {
  const value = cleanText(text, 8)?.toLowerCase()
  if (value === 'true' || value === 'yes' || value === '1') return true
  if (value === 'false' || value === 'no' || value === '0') return false
  return undefined
}

/** A release date as ISO 8601, possibly partial (`2013`, `2013-05`, `2013-05-17`); else `undefined`. */
export function cleanReleaseDate(text: unknown): string | undefined {
  const value = cleanText(text, 32)
  if (value === undefined) return undefined
  const match = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?/u.exec(value)
  if (!match) return undefined
  const [, year = '', month, day] = match
  if (Number(year) < 1000) return undefined
  if (month === undefined || Number(month) < 1 || Number(month) > 12) return year
  if (day === undefined || Number(day) < 1 || Number(day) > 31) return `${year}-${month}`
  return `${year}-${month}-${day}`
}

/** A moment written as text (ISO 8601, or anything `Date.parse` reads), as epoch ms; else `undefined`. */
export function parseTime(text: unknown): number | undefined {
  const value = cleanText(text, 64)
  if (value === undefined) return undefined
  const time = Date.parse(value)
  return Number.isFinite(time) && time > 0 ? time : undefined
}

/** A canonical ISRC from text, or `undefined`. */
export function cleanIsrc(text: unknown): string | undefined {
  return normalizeIsrc(text) ?? undefined
}

/**
 * What makes two rows the same track: the catalog track's `entityKey` when the row names one,
 * else its title, artists and album, normalized.
 */
export function rowKey(row: Pick<ImportRow, 'trackId' | 'title' | 'artists' | 'album'>): string {
  if (row.trackId !== undefined) return `id:${entityKey(row.trackId)}`
  const artists = row.artists.map((name) => normalizeText(name)).join(',')
  return `text:${normalizeText(row.title)}|${artists}|${normalizeText(row.album ?? '')}`
}

/**
 * The collection with each track once (the first row of a track stays) and at most
 * {@link MAX_IMPORT_ROWS} rows. The rows dropped are counted in `skips.duplicates`, and those over
 * the limit in `skips.overLimit`.
 */
export function dedupeCollection(
  collection: ImportCollection,
  skips: ImportSkips,
): ImportCollection {
  const seen = new Set<string>()
  const rows: ImportRow[] = []
  for (const row of collection.rows) {
    const key = rowKey(row)
    if (seen.has(key)) {
      skips.duplicates++
      continue
    }
    seen.add(key)
    if (rows.length >= MAX_IMPORT_ROWS) {
      skips.overLimit++
      continue
    }
    rows.push(row)
  }
  return { ...collection, rows }
}

/** The row as saved with an import's progress: without its whole track. */
export function storedRow(row: ImportRow): StoredRow {
  const { track: _track, ...stored } = row
  return stored
}

/** Whether a row names a Spotify track. */
export function isSpotifyRow(row: Pick<ImportRow, 'trackId'>): boolean {
  return row.trackId?.startsWith('spotify:track:') === true
}

/** Whether a row names a YouTube or YouTube Music track. */
export function isYouTubeRow(row: Pick<ImportRow, 'trackId'>): boolean {
  const source = row.trackId === undefined ? undefined : parseId(row.trackId).source
  return source === 'ytm' || source === 'yt'
}

/**
 * The library track a row stands for before any matching: its whole track when the input came
 * from a catalog, or a Spotify track made from what the row says. `undefined` for a row without
 * a catalog track, and for a row that only links its track (no title, or a YouTube video of an
 * unknown kind, as in an M3U line), which the import loads first.
 */
export function catalogTrackOf(row: ImportRow | StoredRow): Track | undefined {
  if ('track' in row && row.track !== undefined) return row.track
  const id = row.trackId
  if (id === undefined || row.title === '') return undefined
  const { source, nativeId } = parseId(id)
  if (source === 'spotify') {
    return {
      ...trackFields(row, id),
      source: 'spotify',
      kind: 'song',
      externalIds: { spotify: nativeId },
    }
  }
  if ((source === 'ytm' || source === 'yt') && row.kind !== undefined) {
    return {
      ...trackFields(row, id),
      source,
      kind: row.kind,
      ...(row.songId === undefined ? {} : { songId: row.songId }),
    }
  }
  return undefined
}

/** The fields every track made from a row has. */
function trackFields(
  row: ImportRow | StoredRow,
  id: EntityId<'track'>,
): Omit<Track, 'source' | 'kind'> {
  const track: Omit<Track, 'source' | 'kind'> = {
    id,
    title: row.title,
    artists: row.artists.map((name) => ({ name })),
    artwork: [],
  }
  if (row.album !== undefined) track.album = { name: row.album }
  if (row.durationMs !== undefined) track.durationMs = row.durationMs
  if (row.explicit !== undefined) track.explicit = row.explicit
  if (row.isrc !== undefined) track.isrc = row.isrc
  if (row.releaseDate !== undefined) track.releaseDate = row.releaseDate
  return track
}

/** A Spotify track ID from a bare 22-character base62 ID, as some CSV files write it. */
export function spotifyTrackIdFromBareId(text: unknown): EntityId<'track'> | undefined {
  const value = cleanText(text, 64)
  return value !== undefined && /^[0-9A-Za-z]{22}$/u.test(value)
    ? formatId('spotify', 'track', value)
    : undefined
}
