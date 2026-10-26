/**
 * Where the now-playing screen and the queue link into the pages of stage 2.4 (search and
 * browse) and the library's own playlists (stage 2.6):
 *
 * - {@link searchPath} uses the search page's `?q=`;
 * - {@link entityPath} gives the album, artist or playlist page, built with 2.4's link helpers
 *   (`albumPath`, `artistPath`) and the library's `playlistPath`, for the kinds of page the
 *   entity's source has: an Internet Archive item is an album but has no artist page, and so on.
 *   Anything else shows as plain text.
 *
 * @module
 */

import { type EntityId, parseId, type SourceId, type Track } from '@fxm/core'
import { playlistPath } from '../library/paths'
import { albumPath, artistPath } from '../search/catalog/links'

/** The search page for `query`. */
export function searchPath(query: string): string {
  return `/search?${new URLSearchParams({ q: query.trim() })}`
}

/** A search for other versions of a track: its artists and its title. */
export function versionSearchPath(track: Track): string {
  const artists = track.artists.map((artist) => artist.name).join(' ')
  return searchPath(`${artists} ${track.title}`)
}

/** The kinds of page each source has (its provider's `getAlbum`, `getArtist`, `getPlaylist`). */
const PAGES: Readonly<Partial<Record<SourceId, ReadonlySet<string>>>> = {
  ytm: new Set(['album', 'artist', 'playlist']),
  yt: new Set(['artist', 'playlist']),
  spotify: new Set(['album', 'artist', 'playlist']),
  archive: new Set(['album']),
  jamendo: new Set(['album', 'artist']),
  // Local albums and artists (stage 4.4), and the library's own playlists (stage 2.6).
  local: new Set(['album', 'artist', 'playlist']),
}

/** The page of an album, artist or playlist, or `undefined` when its source has none. */
export function entityPath(id: EntityId<'album' | 'artist' | 'playlist'>): string | undefined {
  const { source, kind } = parseId(id)
  if (PAGES[source]?.has(kind) !== true) return undefined
  if (kind === 'album') return albumPath(id as EntityId<'album'>)
  if (kind === 'artist') return artistPath(id as EntityId<'artist'>)
  return playlistPath(id as EntityId<'playlist'>)
}
