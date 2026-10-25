/**
 * Where the now-playing screen and the queue link into the pages of stage 2.4 (search and
 * browse), which is not merged yet: one module, so the integration only changes this file.
 *
 * - {@link searchPath} uses the search page's `?q=` from the app shell (stage 2.1), which works
 *   today.
 * - {@link entityPath} gives no links until 2.4 merges, because the shell's album, artist and
 *   playlist routes don't define their IDs yet: names show as plain text meanwhile. Integration:
 *   return 2.4's path for the entity.
 *
 * @module
 */

import type { EntityId, Track } from '@fxm/core'

/** The search page for `query`. */
export function searchPath(query: string): string {
  return `/search?${new URLSearchParams({ q: query.trim() })}`
}

/** A search for other versions of a track: its artists and its title. */
export function versionSearchPath(track: Track): string {
  const artists = track.artists.map((artist) => artist.name).join(' ')
  return searchPath(`${artists} ${track.title}`)
}

/**
 * The page of an album, artist or playlist, or `undefined` while there is none (until 2.4
 * merges).
 */
export function entityPath(_id: EntityId<'album' | 'artist' | 'playlist'>): string | undefined {
  return undefined
}
