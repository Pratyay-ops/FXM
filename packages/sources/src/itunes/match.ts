/**
 * Picks the iTunes result whose cover belongs to a track. Searches are noisy: for "Radiohead
 * Creep" the US store's top 25 held covers, lullaby versions, an acoustic EP and other artists'
 * songs called "Creep", but not the original. So a result must be by the track's artist (by name,
 * not a tribute or karaoke act whose name contains it) and have its title (or album) and its
 * version; anything else gives no artwork rather than a wrong one.
 *
 * @module
 */

import { comparable, readTitle, sameArtist, sameVersions, similarity } from '../shared/names'
import type { ItunesAlbum, ItunesSong } from './api'

/** What a cover is looked up for. */
export interface ItunesArtworkQuery {
  /** The track's title. */
  title: string
  /** Its artists' names, main artist first. */
  artists: string[]
  /** Its album, when known. */
  album?: string
  /** Its duration in milliseconds, when known. */
  durationMs?: number
}

/** A title or album name must be at least this similar. */
const MIN_NAME = 0.9
/** A song whose duration is further off than this is another cut, e.g. a remix. */
const MAX_DURATION_DIFF_MS = 30_000

/** An album's name without Apple's " - Single" or " - EP" suffix. */
function albumName(name: string): string {
  return name.replace(/\s+-\s+(?:single|ep)$/iu, '')
}

/** How alike two titles are, and whether their versions agree, after `readTitle`. */
function compareTitles(wanted: string, theirs: string, artists: readonly string[]) {
  const a = readTitle(wanted, artists)
  const b = readTitle(theirs, artists)
  return {
    score: similarity(comparable(a.core), comparable(b.core)),
    exact: comparable(a.clean) === comparable(b.clean),
    sameVersion: sameVersions(a.versions, b.versions),
  }
}

/**
 * The song among `songs` that is the track: by its artist (a name of the credit at least 0.9
 * similar to one of the track's artists), with its title (0.9 or more for the title proper) and
 * the same strong version tags, and no more than 30 s longer or shorter when both durations are
 * known. Among those, the exact title wins, then the track's album, then Apple's order. `null`
 * when none qualifies.
 */
export function bestItunesSong(
  songs: readonly ItunesSong[],
  query: ItunesArtworkQuery,
): ItunesSong | null {
  let best: { song: ItunesSong; rank: number } | null = null
  for (const song of songs) {
    if (!sameArtist(query.artists, song.artist)) continue
    const title = compareTitles(query.title, song.title, query.artists)
    if (title.score < MIN_NAME || !title.sameVersion) continue
    const { durationMs } = query
    if (
      durationMs !== undefined &&
      song.durationMs !== undefined &&
      Math.abs(durationMs - song.durationMs) > MAX_DURATION_DIFF_MS
    ) {
      continue
    }
    const sameAlbum =
      query.album !== undefined &&
      song.album !== undefined &&
      similarity(comparable(albumName(query.album)), comparable(albumName(song.album))) >= MIN_NAME
    const rank = (title.exact ? 2 : 0) + (sameAlbum ? 1 : 0)
    if (best === null || rank > best.rank) best = { song, rank }
  }
  return best?.song ?? null
}

/**
 * The album among `albums` that is the track's: by its artist (as for {@link bestItunesSong}),
 * named like it (0.9 or more for the name proper, without " - Single" or " - EP") with the same
 * strong version tags. The exact name wins over an edition such as "(10th Anniversary Edition)",
 * then Apple's order. `null` when none qualifies, or the query has no album.
 */
export function bestItunesAlbum(
  albums: readonly ItunesAlbum[],
  query: ItunesArtworkQuery,
): ItunesAlbum | null {
  if (query.album === undefined) return null
  const wanted = albumName(query.album)
  let best: { album: ItunesAlbum; rank: number } | null = null
  for (const album of albums) {
    if (!sameArtist(query.artists, album.artist)) continue
    const name = compareTitles(wanted, albumName(album.name), query.artists)
    if (name.score < MIN_NAME || !name.sameVersion) continue
    const rank = name.exact ? 1 : 0
    if (best === null || rank > best.rank) best = { album, rank }
  }
  return best?.album ?? null
}
