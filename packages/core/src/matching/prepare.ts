/**
 * Turns titles, artist names and album names into what the matching engine compares, using the
 * core text helpers in their documented order: presentation noise out, a known "Artist - "
 * prefix out, `splitTitle`, version tags from the qualifiers and the album (never from the title
 * proper), `normalizeText` on the core.
 *
 * @module
 */

import { extractVersionTags, normalizeText, splitTitle, stripPresentationNoise } from '../text'
import { containsWords, diceSimilarity, textTokens } from './similarity'

/** How far apart two versions of a song are, as `extractVersionTags` grades them. */
export type VersionLevel = 'strong' | 'medium' | 'soft'

/**
 * Version tags that name the same kind of version, so "Live" on one side and "MTV Unplugged" on
 * the other are not a mismatch. Tags not listed are their own family.
 */
const VERSION_FAMILIES: Readonly<Record<string, string>> = {
  live: 'live',
  unplugged: 'live',
  concert: 'live',
  tour: 'live',
  festival: 'live',
  session: 'live',
  performance: 'live',
  'tiny desk': 'live',
  remix: 'remix',
  rework: 'remix',
  bootleg: 'remix',
  'club mix': 'remix',
  'dub mix': 'remix',
  'vip mix': 'remix',
  extended: 'extended',
  '12" version': 'extended',
  cover: 'cover',
  karaoke: 'cover',
  tribute: 'cover',
  'originally performed by': 'cover',
  'in the style of': 'cover',
  'made famous by': 'cover',
  instrumental: 'instrumental',
  'backing track': 'instrumental',
  'minus one': 'instrumental',
  'off vocal': 'instrumental',
  acoustic: 'acoustic',
  stripped: 'acoustic',
  'piano version': 'acoustic',
  orchestral: 'orchestral',
  symphonic: 'orchestral',
  'sped up': 'sped up',
  nightcore: 'sped up',
  slowed: 'slowed',
  reverb: 'slowed',
  daycore: 'slowed',
  chopped: 'chopped',
  screwed: 'chopped',
  demo: 'demo',
  rehearsal: 'demo',
  outtake: 'demo',
  'alternate take': 'demo',
  'early version': 'demo',
  "taylor's version": 're-recorded',
  're-recorded': 're-recorded',
  'recorded at': 're-recorded',
  // Every medium tag is a different edit of the same recording; the duration tells edits apart.
  'radio edit': 'edit',
  'single edit': 'edit',
  'short edit': 'edit',
  'clean edit': 'edit',
  'video edit': 'edit',
  'tv edit': 'edit',
  'tv size': 'edit',
  edit: 'edit',
}

/** The family of a version tag, e.g. `live` for "unplugged" and `demo` for "take 3". */
function familyOf(tag: string): string {
  if (Object.hasOwn(VERSION_FAMILIES, tag)) return VERSION_FAMILIES[tag] ?? tag
  if (/^take \d+$/u.test(tag)) return 'demo'
  return tag
}

/** The version families in a text, each with its level (the strongest wins). */
function versionFamilies(text: string): Map<string, VersionLevel> {
  const families = new Map<string, VersionLevel>()
  if (text.trim() === '') return families
  const tags = extractVersionTags(text)
  for (const level of ['strong', 'medium', 'soft'] as const) {
    for (const tag of tags[level]) {
      const family = familyOf(tag)
      if (!families.has(family)) families.set(family, level)
    }
  }
  return families
}

/** Words that say "remix" without naming whose: what is left names the remixer. */
const REMIX_WORDS =
  /(?<![\p{L}\p{N}])(?:re-?mix(?:es|ed)?|rmx|mix|edit|version|extended|radio|club|original|official|feat|ft|featuring|by|the|vip|dub|re-?work(?:ed)?|bootleg|refix)(?![\p{L}\p{N}])/gu

/** A title prepared for comparison. Every string is normalized. */
export interface PreparedTitle {
  /** The title proper, e.g. `song` for "Song (feat. X) - Live". */
  core: string
  /** The qualifiers, e.g. `['live']`. */
  qualifiers: string[]
  /** Featured artists named in the title. */
  featured: string[]
  /** Version families found in the qualifiers and the album, each with its level. */
  versions: ReadonlyMap<string, VersionLevel>
  /**
   * For a remix: the words of its qualifiers that name it, such as `cedric gervais` for "Cedric
   * Gervais Remix". Empty when there is no remix or it is not named.
   */
  remixDetail: string
}

/** Opening and closing quotes that set a title off after an artist name. */
const QUOTED_TITLE = /^(.+?)(?:\s*「(.+?)」|\s*『(.+?)』|\s+'(.+?)'|\s+"(.+?)")(.*)$/u

/** "Artist - Title", "Artist | Title" or "Artist ~ Title". */
const DASHED_TITLE = /^(.+?)\s+[-|~]\s+(.+)$/u

/** Separators between the names of a credit: "A, B & C", "A x B", "A feat. B". */
const NAME_SEPARATORS =
  /\s*(?:,|、|・|&|\+|\/|\s(?:and|x|×|vs\.?|feat\.?|ft\.?|featuring|with)\s)\s*/u

/** Bracketed parts of a name, such as "(방탄소년단)" or "(CV: Akina)". */
const NAME_BRACKETS = /\s*(?:\([^)]*\)|\[[^\]]*\]|（[^）]*）)\s*/gu

/**
 * A channel or artist name as the engine compares it: normalized, without bracketed parts and
 * without the channel decorations " - Topic", "VEVO" and "Official".
 */
export function cleanArtistName(name: string): string {
  return normalizeText(name)
    .replace(NAME_BRACKETS, ' ')
    .replace(/\s*-\s*topic$/u, '')
    .replace(/\s*vevo$/u, '')
    .replace(/(?<![\p{L}\p{N}])official(?![\p{L}\p{N}])/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
}

/** The separate names in one credit: "Luis Fonsi & Daddy Yankee" → both names. */
export function splitArtistNames(name: string): string[] {
  return cleanArtistName(name)
    .split(NAME_SEPARATORS)
    .map((part) => part.trim())
    .filter((part) => part !== '')
}

/** Without a leading "the". */
function withoutArticle(name: string): string {
  return name.replace(/^the\s+/u, '')
}

/**
 * Whether the cleaned artist name `name` is found as `other`: equal (a leading "The" aside), Dice
 * on character bigrams of at least 0.8 ("Everly Brothers" and "Every Brothers"), or `other`
 * containing `name` as whole words when `name` has two words or more ("Jeff Buckley" in "Jeff
 * Buckley Music"). Containment runs one way only, and never for a one-word name: "Bill Haley" is
 * not "Bill Haley & His Comets", and "Queen" is not "Queen Naija".
 */
export function sameArtist(name: string, other: string): boolean {
  if (name === '' || other === '') return false
  if (withoutArticle(name) === withoutArticle(other)) return true
  if (diceSimilarity(name, other) >= 0.8) return true
  return textTokens(name).length >= 2 && containsWords(other, name)
}

/** Every name a credit list offers for matching: each credit, and each name within it. */
function namePool(credits: readonly string[]): string[] {
  const pool = new Set<string>()
  for (const credit of credits) {
    const clean = cleanArtistName(credit)
    if (clean !== '') pool.add(clean)
    for (const part of splitArtistNames(credit)) pool.add(part)
  }
  return [...pool]
}

/** Whether `name` is found as any name of the pool (see {@link sameArtist}). */
function inPool(name: string, pool: readonly string[]): boolean {
  return pool.some((other) => sameArtist(name, other))
}

/**
 * The share of the source's artists found among a candidate's, from 0 to 1. A source credit
 * counts fully when it is found among the candidate's names (see {@link sameArtist}); otherwise,
 * a credit that joins several names ("Bill Haley & His Comets") counts by the share of its names
 * found. The candidate's names include featured artists named in its title.
 */
export function artistSimilarity(
  sourceArtists: readonly string[],
  candidateArtists: readonly string[],
): number {
  const credits = sourceArtists.map(cleanArtistName).filter((name) => name !== '')
  if (credits.length === 0) return 0
  const pool = namePool(candidateArtists)
  if (pool.length === 0) return 0
  let found = 0
  for (const credit of credits) {
    if (inPool(credit, pool)) {
      found += 1
      continue
    }
    const parts = splitArtistNames(credit)
    if (parts.length > 1) found += parts.filter((part) => inPool(part, pool)).length / parts.length
  }
  return found / credits.length
}

/** Whether every name of `credit` matches one of `artists` ("BTS (방탄소년단)" → BTS). */
function isArtistCredit(credit: string, artists: readonly string[]): boolean {
  const names = splitArtistNames(credit)
  const pool = namePool(artists)
  return names.length > 0 && names.every((name) => inPool(name, pool))
}

/**
 * Whether `name` is among `credits`: as a whole, or name by name when it joins several ("Sia &
 * Diplo"). Used to tell a featured artist the source credits from one it does not.
 */
export function isCredited(name: string, credits: readonly string[]): boolean {
  const pool = namePool(credits)
  const clean = cleanArtistName(name)
  if (clean !== '' && inPool(clean, pool)) return true
  const names = splitArtistNames(name)
  return names.length > 1 && names.every((part) => inPool(part, pool))
}

/**
 * Removes a leading credit of known artists from a title: "The Weeknd - Blinding Lights",
 * "Luis Fonsi, Daddy Yankee - Despacito", "YOASOBI「アイドル」", "BTS (방탄소년단) 'Dynamite'".
 * Whatever follows a quoted title becomes a bracketed qualifier: "Artist 'Song' Remix" reads as
 * "Song (Remix)". The title comes back as it was when nothing before the separator is a known
 * artist.
 */
export function stripArtistPrefix(title: string, artists: readonly string[]): string {
  if (artists.length === 0) return title
  const quoted = QUOTED_TITLE.exec(title)
  if (quoted) {
    const inner = (quoted[2] ?? quoted[3] ?? quoted[4] ?? quoted[5] ?? '').trim()
    const rest = (quoted[6] ?? '').trim()
    if (inner !== '' && isArtistCredit(quoted[1] ?? '', artists)) {
      return rest === '' ? inner : `${inner} (${rest})`
    }
  }
  const dashed = DASHED_TITLE.exec(title)
  if (dashed && isArtistCredit(dashed[1] ?? '', artists)) return (dashed[2] ?? '').trim()
  return title
}

/**
 * Prepares a title for comparison:
 *
 * 1. `stripPresentationNoise`, then `normalizeText`
 * 2. a leading credit of `artists` goes ({@link stripArtistPrefix}), so "Artist - Stripped"
 *    keeps "Stripped" as its title
 * 3. `splitTitle` gives the core, the qualifiers and featured artists
 * 4. version families come from the qualifiers and from `album`, never from the core, so "Live
 *    Forever" is not live while a track of "MTV Unplugged in New York" is
 */
export function prepareTitle(
  title: string,
  artists: readonly string[] = [],
  album?: string,
): PreparedTitle {
  const parts = splitTitle(stripArtistPrefix(normalizeText(stripPresentationNoise(title)), artists))
  const qualifiers = parts.qualifiers.map(normalizeText)
  const versions = versionFamilies(qualifiers.join(' | '))
  if (album !== undefined) {
    for (const [family, level] of versionFamilies(album)) {
      if (!versions.has(family)) versions.set(family, level)
    }
  }
  const remixDetail = qualifiers
    .filter((qualifier) => versionFamilies(qualifier).has('remix'))
    .map((qualifier) => qualifier.replace(REMIX_WORDS, ' '))
    .join(' ')
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
  return {
    core: normalizeText(parts.core),
    qualifiers,
    featured: parts.featured.map(normalizeText),
    versions,
    remixDetail,
  }
}

/** Catalogue numbers, keys and forms that only classical works carry in their titles. */
const CLASSICAL = new RegExp(
  [
    String.raw`(?<![\p{L}\p{N}])(?:bwv|kv|hwv|op|opus|hob|rv|woo|sz|k\.|d\.)\s*\.?\s*\d+`,
    String.raw`(?<![\p{L}\p{N}])in\s+[a-g](?:[\s-](?:flat|sharp))?[\s-](?:major|minor|dur|moll)(?![\p{L}\p{N}])`,
    String.raw`(?<![\p{L}\p{N}])(?:symphon(?:y|ie|ies)|concerto|sonata|sonatina|suite|prelude|fugue|nocturne|etude|mazurka|polonaise|cantata|requiem|oratorio|overture|toccata|partita|allemande|courante|sarabande|gigue|minuet|menuet|scherzo|rondo|allegro|adagio|andante|largo|presto|lento|moderato|vivace)(?![\p{L}\p{N}])`,
    String.raw`:\s*[ivx]+\.\s`,
  ].join('|'),
  'u',
)

/**
 * Whether a title looks like a classical work ("Cello Suite No. 1 in G Major, BWV 1007: I.
 * Prélude"), whose title alone fits many recordings by many performers.
 */
export function isClassicalTitle(title: string): boolean {
  return CLASSICAL.test(normalizeText(title))
}
