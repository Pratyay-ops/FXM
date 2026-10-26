/**
 * Helpers for telling whether two names mean the same song, album or artist, shared by the
 * providers that match other services' listings: LRCLIB's lyrics matcher, iTunes Search's
 * artwork matcher, Last.fm's stations and the recommendation collector. Built on the core text
 * helpers (`normalizeText`, `splitTitle`, `extractVersionTags`).
 *
 * @module
 */

import { extractVersionTags, normalizeText, splitTitle, stripPresentationNoise } from '@fxm/core'

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

/**
 * `text` with each run of whitespace folded into one space, and trimmed. Patterns that start with
 * `\s*` or `\s+` backtrack through a long run of spaces from every position in it, so text from
 * outside goes through this first.
 */
export function foldSpaces(text: string): string {
  return text.replace(/\s+/gu, ' ').trim()
}

/** An artist name without YouTube's channel suffixes: "RadioheadVEVO", "Radiohead - Topic". */
export function cleanArtist(name: string): string {
  const folded = foldSpaces(name)
  const cleaned = folded
    .replace(/\s+-\s+topic$/iu, '')
    .replace(/(?<=\S)\s*vevo$/iu, '')
    .trim()
  return cleaned === '' ? folded : cleaned
}

/**
 * A key for `name` that spellings of the same name share: its {@link comparable} form. A name
 * of punctuation and symbols only ("!!!", "✝✝✝"), which that leaves empty, keeps its normalized
 * form instead, so that two such names never share a key. Empty only for a blank name.
 */
export function nameKey(name: string): string {
  return comparable(name) || normalizeText(name)
}

/** Two names at least this similar are the same. */
export const SAME_NAME = 0.9

/** Separators between the names of an artist credit: "A, B & C", "A feat. B", "A x B". */
const ARTIST_SEPARATOR = /\s*(?:[,;/&×、]|\s(?:and|x|feat\.?|ft\.?|featuring|with|vs\.?)\s)\s*/iu

/** The {@link nameKey}s in an artist credit: the whole credit, then each name in it. */
export function creditNames(credit: string): string[] {
  const folded = foldSpaces(credit)
  const names = [folded, ...folded.split(ARTIST_SEPARATOR)].map((name) =>
    nameKey(cleanArtist(name)),
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

/**
 * Whether a credit names one of `artists`: some name in it is the {@link SAME_NAME} as one of
 * theirs. A tribute, karaoke or cover act whose name merely contains the artist's ("Radiohead
 * Tribute", "Amuse" for Muse) does not count.
 */
export function sameArtist(artists: readonly string[], credit: string): boolean {
  return artistSimilarity(artists, credit) >= SAME_NAME
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
  const named = prefix.split(ARTIST_SEPARATOR).map(nameKey)
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

/**
 * The name to look a song up by in a catalogue: the title proper, or, for a version (live,
 * acoustic, "Taylor's Version"...), the clean title with its qualifiers, so that the lookup can
 * find that version rather than the original.
 */
export function lookupTitle(reading: TitleReading): string {
  return reading.versions.length > 0 ? reading.clean : reading.core
}

/** Whether two sorted lists of version tags are the same. */
export function sameVersions(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((tag, index) => tag === b[index])
}
