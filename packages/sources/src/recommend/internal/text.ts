/**
 * Text helpers for telling whether two names mean the same song, album or artist, built on the
 * core text helpers. The comparison primitives are LRCLIB's lyrics matcher's, so both read
 * names the same way.
 *
 * @module
 */

import { extractVersionTags, splitTitle, stripPresentationNoise } from '@fxm/core'
import { cleanArtist, comparable, similarity } from '../../lrclib/match'

export { cleanArtist, comparable, similarity }

/** Two names at least this similar are the same. */
export const SAME_NAME = 0.9

/** Separators between the names of an artist credit: "A, B & C", "A feat. B", "A x B". */
const ARTIST_SEPARATOR = /\s*(?:[,;/&×、]|\s(?:and|x|feat\.?|ft\.?|featuring|with|vs\.?)\s)\s*/iu

/** Folds every run of whitespace into one space and trims. */
function foldSpaces(text: string): string {
  return text.replace(/\s+/gu, ' ').trim()
}

/** The {@link comparable} names in an artist credit: the whole credit, then each name in it. */
export function creditNames(credit: string): string[] {
  const folded = foldSpaces(credit)
  const names = [folded, ...folded.split(ARTIST_SEPARATOR)].map((name) =>
    comparable(cleanArtist(name)),
  )
  return [...new Set(names)].filter((name) => name !== '')
}

/**
 * How alike a credit is to any of `artists`, from 0 to 1: the best similarity between any name
 * in one and any name in the other, so "Daft Punk, Pharrell Williams & Nile Rodgers" matches
 * "Daft Punk".
 */
export function artistSimilarity(artists: readonly string[], credit: string): number {
  const theirs = creditNames(credit)
  let best = 0
  for (const name of artists.flatMap(creditNames)) {
    for (const other of theirs) best = Math.max(best, similarity(name, other))
  }
  return best
}

/** A title read for matching. */
export interface TitleReading {
  /** The title without presentation noise or an "Artist - " prefix. */
  clean: string
  /** The title proper: no qualifiers, no featured artists. */
  core: string
  /** The strong version tags of the qualifiers (live, remix, acoustic...), sorted. */
  versions: string[]
}

/** `title` without a leading "Artist - " whose names are all among `artists`. */
function withoutArtistPrefix(title: string, artists: readonly string[]): string {
  const match = /^(.+?)\s+[-–—]\s+(.+)$/u.exec(title)
  if (match === null) return title
  const [, prefix = '', rest = ''] = match
  const known = artists.flatMap(creditNames)
  const named = prefix.split(ARTIST_SEPARATOR).map(comparable)
  const all = named.every((name) => known.some((artist) => similarity(name, artist) >= SAME_NAME))
  return all ? rest : title
}

/** Reads a song or album title for matching (see {@link TitleReading}). */
export function readTitle(title: string, artists: readonly string[] = []): TitleReading {
  const clean = withoutArtistPrefix(stripPresentationNoise(foldSpaces(title)), artists).trim()
  const { core, qualifiers } = splitTitle(clean)
  const tags = qualifiers.flatMap((qualifier) => extractVersionTags(qualifier).strong)
  return { clean, core, versions: [...new Set(tags)].sort() }
}

/** Whether two sorted lists of version tags are the same. */
export function sameVersions(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((tag, index) => tag === b[index])
}

/**
 * A key that two listings of the same song share, whatever their source: the main artist and
 * the title proper, both {@link comparable}. Versions fold together ("Creep" and "Creep -
 * Remastered" share a key), which suits grouping recommendations.
 */
export function songKey(artist: string, title: string): string {
  const main = cleanArtist(artist)
  return `${comparable(main)}|${comparable(readTitle(title, [main]).core)}`
}

/** A key that two listings of the same artist share: the {@link comparable} name. */
export function artistKey(name: string): string {
  return comparable(cleanArtist(name))
}
