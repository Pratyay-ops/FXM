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

/** Album order: by disc, then by track number, files without numbers after, then by title. */
function compareInAlbum(a: LocalTags, b: LocalTags): number {
  return (
    (a.discNumber ?? 1) - (b.discNumber ?? 1) ||
    (a.trackNumber ?? Number.MAX_SAFE_INTEGER) - (b.trackNumber ?? Number.MAX_SAFE_INTEGER) ||
    compareText(a.title, b.title)
  )
}

const COMPARE: Readonly<Record<LocalSort, (a: LocalFileRecord, b: LocalFileRecord) => number>> = {
  artist: (a, b) =>
    compareText(albumArtistOf(a.tags), albumArtistOf(b.tags)) ||
    compareText(a.tags.album ?? '', b.tags.album ?? '') ||
    compareInAlbum(a.tags, b.tags),
  album: (a, b) =>
    compareText(a.tags.album ?? '', b.tags.album ?? '') ||
    compareText(albumArtistOf(a.tags), albumArtistOf(b.tags)) ||
    compareInAlbum(a.tags, b.tags),
  title: (a, b) =>
    compareText(a.tags.title, b.tags.title) ||
    compareText(albumArtistOf(a.tags), albumArtistOf(b.tags)),
  added: (a, b) => b.addedAt - a.addedAt || COMPARE.artist(a, b),
}

/** `tracks` in `sort` order, in a new array; ties keep the file path order. */
export function sortLocalTracks(tracks: readonly LocalTrack[], sort: LocalSort): LocalTrack[] {
  const compare = COMPARE[sort]
  return [...tracks].sort(
    (a, b) => compare(a.file, b.file) || collator.compare(a.file.key, b.file.key),
  )
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

/**
 * The tracks matching `query`, best first. Every word of the query has to appear in the title,
 * the artists, the album or the file name; case, accents and spacing don't matter (see
 * `normalizeText`). Titles count most, and a title that starts with the query most of all.
 */
export function searchLocalTracks(tracks: readonly LocalTrack[], query: string): LocalTrack[] {
  const needle = normalizeText(query)
  const words = needle.split(' ').filter((word) => word !== '')
  if (words.length === 0) return []
  const scored: { item: LocalTrack; score: number }[] = []
  for (const item of tracks) {
    const fields = searchFields(item.file)
    let score = 0
    for (const word of words) {
      let best = 0
      for (const field of Object.keys(WEIGHTS) as (keyof SearchFields)[]) {
        if (fields[field].includes(word)) best = Math.max(best, WEIGHTS[field])
      }
      if (best === 0) {
        score = 0
        break
      }
      score += best
    }
    if (score === 0) continue
    if (fields.title === needle) score += 10
    else if (fields.title.startsWith(needle)) score += 5
    scored.push({ item, score })
  }
  return scored
    .sort(
      (a, b) =>
        b.score - a.score ||
        COMPARE.title(a.item.file, b.item.file) ||
        collator.compare(a.item.file.key, b.item.file.key),
    )
    .map(({ item }) => item)
}
