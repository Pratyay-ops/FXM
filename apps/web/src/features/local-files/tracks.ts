/**
 * Local files as core tracks, and the sorting and searching the lists and the search page use.
 *
 * A local track is a `song` of source `local`, playable in both catalog modes, with its tags as
 * metadata and its cover thumbnail as artwork. Albums and artists get IDs from their names
 * (see `ids.ts`), so the tracks of one album group together across folders.
 *
 * @module
 */

import { normalizeText, type Track } from '@fxm/core'
import { localAlbumId, localArtistId, localTrackId } from './ids'
import type { LocalFileRecord, LocalPictureRecord, LocalTags } from './types'

/** A listed file with its track, as the lists show it. */
export interface LocalTrack {
  readonly track: Track
  readonly file: LocalFileRecord
}

/** The name albums of several artists are filed under. */
export const VARIOUS_ARTISTS = 'Various artists'

/** The artist an album is filed under: its album artist, else its (first) artist. */
export function albumArtistOf(tags: LocalTags): string {
  return tags.albumArtist ?? (tags.compilation ? VARIOUS_ARTISTS : (tags.artists[0] ?? ''))
}

/** The core track of a file, with `picture` as its artwork. */
export function toTrack(file: LocalFileRecord, picture?: LocalPictureRecord): Track {
  const { tags } = file
  const track: Track = {
    id: localTrackId(file.id),
    source: 'local',
    title: tags.title,
    artists: tags.artists.map((name) => ({ id: localArtistId(name), name })),
    artwork:
      picture === undefined
        ? []
        : [{ url: picture.url, width: picture.width, height: picture.height }],
    kind: 'song',
  }
  if (tags.album !== undefined) {
    track.album = { id: localAlbumId(albumArtistOf(tags), tags.album), name: tags.album }
  }
  if (tags.durationMs !== undefined) track.durationMs = tags.durationMs
  if (tags.isrc !== undefined) track.isrc = tags.isrc
  if (tags.trackNumber !== undefined) track.trackNumber = tags.trackNumber
  if (tags.discNumber !== undefined) track.discNumber = tags.discNumber
  if (tags.releaseDate !== undefined) track.releaseDate = tags.releaseDate
  return track
}

/** Files and their pictures as {@link LocalTrack}s. */
export function toLocalTracks(
  files: readonly LocalFileRecord[],
  pictures: ReadonlyMap<string, LocalPictureRecord>,
): LocalTrack[] {
  return files.map((file) => ({
    file,
    track: toTrack(file, file.pictureKey === undefined ? undefined : pictures.get(file.pictureKey)),
  }))
}

/** The orders the list of local files offers. */
export type LocalSort = 'artist' | 'album' | 'title' | 'added'

/** Every {@link LocalSort}, with its label, in menu order. */
export const LOCAL_SORTS: readonly { value: LocalSort; label: string }[] = [
  { value: 'artist', label: 'Artist' },
  { value: 'album', label: 'Album' },
  { value: 'title', label: 'Title' },
  { value: 'added', label: 'Recently added' },
]

/** Whether `value` is a {@link LocalSort}, e.g. from the URL. */
export function isLocalSort(value: unknown): value is LocalSort {
  return LOCAL_SORTS.some((sort) => sort.value === value)
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

/** Compares text, with empty text (no album, no artist) last. */
function compareText(a: string, b: string): number {
  if (a === '' || b === '') return Number(a === '') - Number(b === '')
  return collator.compare(a, b)
}

/**
 * Each distinct value's place in collation order, so a sort compares numbers instead of text:
 * sorting the few hundred artists or albums once costs far fewer collator calls than comparing
 * text at every step of sorting thousands of tracks. Values the collator finds equal ("ABBA" and
 * "Abba") share a place; empty text comes last.
 */
function places(values: readonly string[]): Map<string, number> {
  const distinct = [...new Set(values)].sort(compareText)
  const place = new Map<string, number>()
  let at = 0
  distinct.forEach((value, index) => {
    if (index > 0 && compareText(distinct[index - 1] as string, value) !== 0) at++
    place.set(value, at)
  })
  return place
}

/** A track with what the sorts compare, worked out once per sort. */
interface SortKeys {
  item: LocalTrack
  /** The album artist's place among all of them. */
  artist: number
  /** The album's place among all of them. */
  album: number
  disc: number
  track: number
  title: string
  addedAt: number
}

/** Album order: by disc, then by track number, files without numbers after, then by title. */
function compareInAlbum(a: SortKeys, b: SortKeys): number {
  return a.disc - b.disc || a.track - b.track || compareText(a.title, b.title)
}

const COMPARE: Readonly<Record<LocalSort, (a: SortKeys, b: SortKeys) => number>> = {
  artist: (a, b) => a.artist - b.artist || a.album - b.album || compareInAlbum(a, b),
  album: (a, b) => a.album - b.album || a.artist - b.artist || compareInAlbum(a, b),
  title: (a, b) => compareText(a.title, b.title) || a.artist - b.artist,
  added: (a, b) => b.addedAt - a.addedAt || COMPARE.artist(a, b),
}

/** `tracks` in `sort` order, in a new array; ties keep the file path order. */
export function sortLocalTracks(tracks: readonly LocalTrack[], sort: LocalSort): LocalTrack[] {
  const artists = tracks.map(({ file }) => albumArtistOf(file.tags))
  const albums = tracks.map(({ file }) => file.tags.album ?? '')
  const artistPlaces = places(artists)
  const albumPlaces = places(albums)
  const keyed = tracks.map(
    (item, index): SortKeys => ({
      item,
      artist: artistPlaces.get(artists[index] as string) ?? 0,
      album: albumPlaces.get(albums[index] as string) ?? 0,
      disc: item.file.tags.discNumber ?? 1,
      track: item.file.tags.trackNumber ?? Number.MAX_SAFE_INTEGER,
      title: item.file.tags.title,
      addedAt: item.file.addedAt,
    }),
  )
  const compare = COMPARE[sort]
  keyed.sort((a, b) => compare(a, b) || collator.compare(a.item.file.key, b.item.file.key))
  return keyed.map(({ item }) => item)
}

/** The normalized text a search looks through, per field. */
interface SearchFields {
  title: string
  artists: string
  album: string
  file: string
}

const fieldsCache = new WeakMap<LocalFileRecord, SearchFields>()

function searchFields(file: LocalFileRecord): SearchFields {
  let fields = fieldsCache.get(file)
  if (fields === undefined) {
    const { tags } = file
    fields = {
      title: normalizeText(tags.title),
      artists: normalizeText([...tags.artists, tags.albumArtist ?? ''].join(' ')),
      album: normalizeText(tags.album ?? ''),
      file: normalizeText(file.path.slice(file.path.lastIndexOf('/') + 1)),
    }
    fieldsCache.set(file, fields)
  }
  return fields
}

/** How much a match in each field counts. */
const WEIGHTS: Readonly<Record<keyof SearchFields, number>> = {
  title: 4,
  artists: 3,
  album: 2,
  file: 1,
}

/** How well a file matches the query's words: 0 when one of them is in none of its fields. */
function matchScore(fields: SearchFields, words: readonly string[], needle: string): number {
  let score = 0
  for (const word of words) {
    let best = 0
    for (const field of Object.keys(WEIGHTS) as (keyof SearchFields)[]) {
      if (fields[field].includes(word)) best = Math.max(best, WEIGHTS[field])
    }
    if (best === 0) return 0
    score += best
  }
  if (fields.title === needle) score += 10
  else if (fields.title.startsWith(needle)) score += 5
  return score
}

/** A query as search compares it: normalized, and split into words. */
function parseQuery(query: string): { needle: string; words: string[] } {
  const needle = normalizeText(query)
  return { needle, words: needle.split(' ').filter((word) => word !== '') }
}

/**
 * The tracks matching `query`, in the order given. Every word of the query has to appear in
 * the title, the artists, the album or the file name; case, accents and spacing don't matter
 * (see `normalizeText`). A query without words matches everything.
 */
export function filterLocalTracks(tracks: readonly LocalTrack[], query: string): LocalTrack[] {
  const { needle, words } = parseQuery(query)
  if (words.length === 0) return [...tracks]
  return tracks.filter((item) => matchScore(searchFields(item.file), words, needle) > 0)
}

/**
 * The tracks matching `query` (as {@link filterLocalTracks} matches), best first: titles count
 * most, and a title that starts with the query most of all.
 */
export function searchLocalTracks(tracks: readonly LocalTrack[], query: string): LocalTrack[] {
  const { needle, words } = parseQuery(query)
  if (words.length === 0) return []
  const scored: { item: LocalTrack; score: number }[] = []
  for (const item of tracks) {
    const score = matchScore(searchFields(item.file), words, needle)
    if (score > 0) scored.push({ item, score })
  }
  return scored
    .sort(
      (a, b) =>
        b.score - a.score ||
        compareText(a.item.file.tags.title, b.item.file.tags.title) ||
        compareText(albumArtistOf(a.item.file.tags), albumArtistOf(b.item.file.tags)) ||
        collator.compare(a.item.file.key, b.item.file.key),
    )
    .map(({ item }) => item)
}
