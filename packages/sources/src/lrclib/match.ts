/**
 * Picks the LRCLIB record that holds a track's lyrics from search results, which are noisy:
 * titles with an "Artist - " prefix, live and acoustic versions, YouTube rips, swapped fields
 * and missing or made-up durations (all seen in real results for "Radiohead Creep").
 *
 * A record must match the title (similarity 0.9 or more, after the core text helpers remove
 * presentation noise, the artist prefix, qualifiers and featured artists), match an artist
 * (0.6 or more) and have the same strong version tags (live, remix, acoustic...). Among those,
 * the ranking is: synced lyrics whose duration fits the track's, then any lyrics, then the rest;
 * then the score `0.40·title + 0.35·artist + 0.25·duration` (the matching engine's weights);
 * then the same album; then the closest duration; then LRCLIB's own order.
 *
 * @module
 */

import {
  extractVersionTags,
  normalizeText,
  splitTitle,
  stripPresentationNoise,
  type Track,
} from '@fxm/core'
import type { LrclibRecord } from './api'

/**
 * Synced lyrics are only trusted when the record's duration is within this many seconds of the
 * track's, LRCLIB's own tolerance for `/api/get`. Further off, the record is another cut (an
 * edit, a video with an intro, a live take) and its timestamps would run early or late.
 */
export const DURATION_TOLERANCE_S = 2

/** Below this title similarity a record is another song. */
const MIN_TITLE = 0.9
/** Below this artist similarity a record is by someone else. */
const MIN_ARTIST = 0.6
/** Two names (of an artist or an album) at least this similar are the same. */
const SAME_NAME = 0.9
/** Beyond the tolerance, the duration score falls to zero over this many seconds. */
const DURATION_FALLOFF_S = 8

/** A track as FXM looks its lyrics up. */
export interface LyricsQuery {
  /** The title without presentation noise or an "Artist - " prefix, for `/api/get`. */
  title: string
  /** The title proper, without qualifiers or featured artists, for search and scoring. */
  core: string
  /** The title's strong version tags (live, remix, acoustic...), sorted. */
  versions: string[]
  /** Artist names, main artist first, without YouTube channel suffixes. */
  artists: string[]
  /** The album, when known. */
  album?: string
  /** The duration in seconds, when known. */
  duration?: number
}

/** How a record fits a {@link LyricsQuery}. */
export interface RecordMatch {
  /** The record. */
  record: LrclibRecord
  /**
   * What the record offers: 3 = synced lyrics that fit the track's duration, 2 = lyrics (plain,
   * or synced for another cut), 1 = unknown (the response left the lyrics out), 0 = an
   * instrumental record.
   */
  content: 0 | 1 | 2 | 3
  /** `0.40·title + 0.35·artist + 0.25·duration`, from 0 to 1. */
  score: number
  /** Title similarity, from 0 to 1. */
  title: number
  /** Artist similarity, from 0 to 1. */
  artist: number
  /** Whether the record is from the track's album (false when either album is unknown). */
  sameAlbum: boolean
  /** Seconds between the record's and the track's durations, when both are known. */
  durationDiff?: number
}

/** Text reduced for comparison: normalized, `&` read as "and", without punctuation. */
export function comparable(text: string): string {
  return normalizeText(text)
    .replace(/&/gu, ' and ')
    .replace(/['.]/gu, '')
    .replace(/[\p{P}\p{S}\s]+/gu, ' ')
    .trim()
}

/**
 * Similarity of two {@link comparable} strings from 0 to 1: the Sørensen-Dice coefficient of
 * their character pairs, spaces ignored, so "taylorswift" equals "taylor swift".
 */
export function similarity(a: string, b: string): number {
  const left = Array.from(a.replace(/ /gu, ''))
  const right = Array.from(b.replace(/ /gu, ''))
  if (left.join('') === right.join('')) return left.length > 0 ? 1 : 0
  if (left.length < 2 || right.length < 2) return 0
  const pairs = new Map<string, number>()
  for (let i = 1; i < left.length; i++) {
    const pair = `${left[i - 1]}${left[i]}`
    pairs.set(pair, (pairs.get(pair) ?? 0) + 1)
  }
  let shared = 0
  for (let i = 1; i < right.length; i++) {
    const pair = `${right[i - 1]}${right[i]}`
    const count = pairs.get(pair) ?? 0
    if (count > 0) {
      shared++
      pairs.set(pair, count - 1)
    }
  }
  return (2 * shared) / (left.length - 1 + right.length - 1)
}

/** An artist name without YouTube's channel suffixes: "RadioheadVEVO", "Radiohead - Topic". */
export function cleanArtist(name: string): string {
  const cleaned = name
    .trim()
    .replace(/\s+-\s+topic$/iu, '')
    .replace(/(?<=\S)\s*vevo$/iu, '')
    .trim()
  return cleaned === '' ? name.trim() : cleaned
}

/** Separators between the names of an artist credit: "A, B & C", "A feat. B", "A x B". */
const ARTIST_SEPARATOR = /\s*(?:[,;/&×、]|\s(?:and|x|feat\.?|ft\.?|featuring|with|vs\.?)\s)\s*/iu

/** The {@link comparable} names in an artist credit: the whole credit, then each name in it. */
function namesIn(credit: string): string[] {
  const names = [credit, ...credit.split(ARTIST_SEPARATOR)].map(comparable)
  return [...new Set(names)].filter((name) => name !== '')
}

/** The best similarity between any name in `credits` and any name in `credit`. */
function artistSimilarity(credits: readonly string[], credit: string): number {
  const theirs = namesIn(credit)
  let best = 0
  for (const name of credits.flatMap(namesIn)) {
    for (const other of theirs) best = Math.max(best, similarity(name, other))
  }
  return best
}

/** `title` without a leading "Artist - " whose names are all among `artists`. */
function withoutArtistPrefix(title: string, artists: readonly string[]): string {
  const match = /^(.+?)\s+[-–—]\s+(.+)$/u.exec(title)
  if (match === null) return title
  const [, prefix = '', rest = ''] = match
  const known = artists.flatMap(namesIn)
  const named = prefix.split(ARTIST_SEPARATOR).map(comparable)
  const all = named.every((name) => known.some((artist) => similarity(name, artist) >= SAME_NAME))
  return all ? rest : title
}

/** The strong version tags of a title's qualifiers, sorted. */
function versionsOf(qualifiers: readonly string[]): string[] {
  const tags = qualifiers.flatMap((qualifier) => extractVersionTags(qualifier).strong)
  return [...new Set(tags)].sort()
}

/** A title split for matching: the cleaned title, its core and its strong version tags. */
function readTitle(title: string, artists: readonly string[]) {
  const clean = withoutArtistPrefix(stripPresentationNoise(title), artists).trim()
  const { core, qualifiers } = splitTitle(clean)
  return { clean, core, versions: versionsOf(qualifiers) }
}

/**
 * What to look `track` up by, or `null` when it has no title or no artist: LRCLIB needs both,
 * and a title alone matches too many songs.
 */
export function queryFor(track: Track): LyricsQuery | null {
  const artists = track.artists.map((artist) => cleanArtist(artist.name)).filter(Boolean)
  if (artists.length === 0 || track.title.trim() === '') return null
  const { clean, core, versions } = readTitle(track.title, artists)
  const query: LyricsQuery = { title: clean, core, versions, artists }
  const album = track.album?.name.trim()
  if (album) query.album = album
  const { durationMs } = track
  if (durationMs !== undefined && Number.isFinite(durationMs) && durationMs > 0) {
    query.duration = durationMs / 1000
  }
  return query
}

/** Whether a string holds anything but whitespace. */
export function hasText(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

/**
 * Whether a record's synced lyrics can be trusted to keep time with the track: its duration is
 * within {@link DURATION_TOLERANCE_S} of the track's, or the track's duration is unknown (then
 * nothing can be checked, and LRCLIB's pick is the best guess).
 */
export function syncedFits(query: LyricsQuery, record: LrclibRecord): boolean {
  if (query.duration === undefined) return true
  return (
    record.duration !== undefined &&
    Math.abs(record.duration - query.duration) <= DURATION_TOLERANCE_S
  )
}

/** Whether two album names are the same album, editions aside ("Pablo Honey (Deluxe)"). */
function sameAlbum(album: string, other: string | undefined): boolean {
  if (other === undefined) return false
  const core = (name: string) => comparable(splitTitle(name).core)
  return similarity(core(album), core(other)) >= SAME_NAME
}

/** What a record offers for the query, or `null` when it holds nothing at all. */
function contentOf(query: LyricsQuery, record: LrclibRecord): RecordMatch['content'] | null {
  if (record.instrumental) return 0
  if (hasText(record.syncedLyrics) && syncedFits(query, record)) return 3
  if (hasText(record.syncedLyrics) || hasText(record.plainLyrics)) return 2
  if (record.syncedLyrics === undefined && record.plainLyrics === undefined) return 1
  return null
}

/**
 * How `record` fits `query`, or `null` when it is another song, by another artist, another
 * version (a strong version tag on one side only), or holds nothing.
 */
export function matchRecord(query: LyricsQuery, record: LrclibRecord): RecordMatch | null {
  const theirs = readTitle(record.trackName, [record.artistName, ...query.artists])
  const title = similarity(comparable(query.core), comparable(theirs.core))
  const artist = artistSimilarity(query.artists, record.artistName)
  if (title < MIN_TITLE || artist < MIN_ARTIST) return null
  if (theirs.versions.join('|') !== query.versions.join('|')) return null
  const content = contentOf(query, record)
  if (content === null) return null
  const durationDiff =
    query.duration === undefined || record.duration === undefined
      ? undefined
      : Math.abs(record.duration - query.duration)
  const durationScore =
    durationDiff === undefined
      ? 0.5
      : Math.max(0, Math.min(1, 1 - (durationDiff - DURATION_TOLERANCE_S) / DURATION_FALLOFF_S))
  const match: RecordMatch = {
    record,
    content,
    score: 0.4 * title + 0.35 * artist + 0.25 * durationScore,
    title,
    artist,
    sameAlbum: query.album !== undefined && sameAlbum(query.album, record.albumName),
  }
  if (durationDiff !== undefined) match.durationDiff = durationDiff
  return match
}

/** The best record for `query` (see the module documentation), or `null` when none fits. */
export function bestMatch(
  query: LyricsQuery,
  records: readonly LrclibRecord[],
): RecordMatch | null {
  const matches = records
    .map((record) => matchRecord(query, record))
    .filter((match) => match !== null)
  matches.sort(
    (a, b) =>
      b.content - a.content ||
      b.score - a.score ||
      Number(b.sameAlbum) - Number(a.sameAlbum) ||
      (a.durationDiff ?? Number.POSITIVE_INFINITY) - (b.durationDiff ?? Number.POSITIVE_INFINITY),
  )
  return matches[0] ?? null
}
