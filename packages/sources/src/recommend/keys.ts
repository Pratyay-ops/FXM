/**
 * The keys that listings of one song, or one artist, share across sources, so that the
 * recommendation engine can group and de-duplicate candidates.
 *
 * @module
 */

import { cleanArtist, nameKey, readTitle } from '../shared/names'

/**
 * A key that two listings of the same song share, whatever their source: the main artist and
 * the title proper, both normalized (see `nameKey`). Versions fold together ("Creep" and "Creep -
 * Remastered" share a key), which suits grouping recommendations; a name of symbols only, such as
 * the band "!!!", keeps a key of its own.
 */
export function songKey(artist: string, title: string): string {
  const main = cleanArtist(artist)
  return `${nameKey(main)}|${nameKey(readTitle(title, [main]).core)}`
}

/**
 * A key that two listings of the same artist share: the normalized name, without YouTube's
 * channel suffixes. Empty only for a blank name.
 */
export function artistKey(name: string): string {
  return nameKey(cleanArtist(name))
}
