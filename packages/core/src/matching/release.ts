/**
 * Release facts for the re-recording guard and the tie-break: whether two albums are the same,
 * whether labels and years agree, and what a YouTube description says about a release.
 *
 * @module
 */

import { normalizeText, splitTitle } from '../text'
import { cleanArtistName } from './prepare'
import { compactText, diceSimilarity, textTokens } from './similarity'
import type { ReleaseFacts } from './types'

/**
 * How closely a candidate's album matches the source's:
 *
 * - `exact` and `core`: the same release by name. Only these tie a candidate to the source's
 *   release (the re-recording guard, the measured fallback, the classical guard) and count as
 *   `MatchSignals.sourceAlbumMatch`
 * - `similar`: a name close enough to prefer among equal scores, and nothing more
 * - `none`: anything else, or a name missing
 */
export type AlbumMatchLevel = 'exact' | 'core' | 'similar' | 'none'

/** A ": Deluxe Edition"-style ending that names an edition of the same album. */
const EDITION_SUFFIX =
  /\s*:\s*[^:]*(?:edition|deluxe|remaster(?:ed)?|expanded|anniversary|version|bonus|reissue)[^:]*$/u

/**
 * An album's name without edition qualifiers, normalized: "Hotel California (2013 Remaster)" →
 * `hotel california`, "Bleach: Deluxe Edition" → `bleach`.
 */
export function albumCore(name: string): string {
  const core = splitTitle(normalizeText(name)).core
  return normalizeText(core.replace(EDITION_SUFFIX, ''))
}

/**
 * Words that name an edition of an album rather than another album, as in "Thriller 25 Super
 * Deluxe Edition" or "OK Computer OKNOTOK 1997 2017": numbers and years, and edition words.
 */
const EDITION_WORD =
  /^(?:\d+(?:st|nd|rd|th)?|deluxe|super|edition|expanded|remaster(?:ed)?|anniversary|collectors?|special|legacy|bonus|tracks?|version|reissue|definitive|mono|stereo)$/u

/** Whether `words` are an artist's name, a leading "the" aside: a self-titled album. */
function isArtistName(words: readonly string[], artists: readonly string[]): boolean {
  const name = words.join(' ').replace(/^the /u, '')
  return artists.some(
    (artist) => textTokens(cleanArtistName(artist)).join(' ').replace(/^the /u, '') === name,
  )
}

/**
 * The level of two album names when the longer starts with all the shorter's words: `core` for
 * a reissue (the extra words are years, numbers or edition words, with at most one other word,
 * as in "OKNOTOK 1997 2017") of an album not named after its artist, `similar` for any other
 * extension that is not a compilation title, `none` otherwise.
 */
function prefixLevel(
  shorter: readonly string[],
  longer: readonly string[],
  artists: readonly string[],
): AlbumMatchLevel {
  const distinctive = shorter.length >= 2 || shorter.join('').length >= 8
  if (!distinctive || !shorter.every((word, i) => longer[i] === word)) return 'none'
  if (isGenericAlbum(longer.join(' '))) return 'none'
  const extra = longer.slice(shorter.length).filter((word) => word.length > 1)
  const editions = extra.filter((word) => EDITION_WORD.test(word)).length
  const reissue = editions > 0 && extra.length - editions <= 1
  return reissue && !isArtistName(shorter, artists) ? 'core' : 'similar'
}

/**
 * How closely two album names match:
 *
 * - `exact`: equal once normalized
 * - `core`: equal without edition qualifiers ("Hysteria" and "Hysteria (Super Deluxe)"), with
 *   the same letters and digits ("Six Evolutions: Bach Cello Suites" and "Six Evolutions - Bach:
 *   Cello Suites"), or a reissue named after the album ("OK Computer" and "OK Computer OKNOTOK
 *   1997 2017"), unless the album is named after its artist (see `artists`)
 * - `similar`: one starting with all the other's words, when those are two words or eight
 *   letters and the longer name is not a compilation title ("The Everly Brothers" and "The
 *   Everly Brothers Sing", but not "The Everly Brothers' Golden Hits"), or Dice of at least 0.9
 *   ("Greatest Hits" and "Greatest Hitz")
 * - `none`: anything else, or a name missing
 *
 * @param artists The source's artists: an album named after one of them ("The Everly Brothers")
 * starts the names of many compilations, so a longer name never counts as its reissue.
 */
export function albumMatchLevel(
  a: string | undefined,
  b: string | undefined,
  artists: readonly string[] = [],
): AlbumMatchLevel {
  if (a === undefined || b === undefined) return 'none'
  const left = normalizeText(a)
  const right = normalizeText(b)
  if (left === '' || right === '') return 'none'
  if (left === right) return 'exact'
  const leftCore = albumCore(a)
  const rightCore = albumCore(b)
  if (leftCore === '' || rightCore === '') return 'none'
  const leftCompact = compactText(leftCore)
  if (leftCore === rightCore || (leftCompact !== '' && leftCompact === compactText(rightCore))) {
    return 'core'
  }
  const leftWords = textTokens(leftCore)
  const rightWords = textTokens(rightCore)
  const [shorter, longer] =
    leftWords.length <= rightWords.length ? [leftWords, rightWords] : [rightWords, leftWords]
  const prefix = prefixLevel(shorter, longer, artists)
  if (prefix !== 'none') return prefix
  return diceSimilarity(leftCore, rightCore) >= 0.9 ? 'similar' : 'none'
}

/** Whether a match level names the same release (`exact` or `core`, see {@link AlbumMatchLevel}). */
export function isSameRelease(level: AlbumMatchLevel): boolean {
  return level === 'exact' || level === 'core'
}

/** The rank of a match level, for comparing them. */
export function albumMatchRank(level: AlbumMatchLevel): number {
  return level === 'exact' ? 3 : level === 'core' ? 2 : level === 'similar' ? 1 : 0
}

/**
 * Album names that many releases share, the phrases of compilations such as "The Very Best of
 * The Everly Brothers", "Greatest Hits" or "Golden Hits of 1961": a match on one says nothing
 * about which release, or recording, it is. Words that name studio albums too stay out ("Golden
 * Hour", "Platinum", "Classic", "Selected Ambient Works 85-92", "Singles").
 */
const GENERIC_ALBUM =
  /(?<![\p{L}\p{N}])(?:greatest hits|best of|very best|hits|collection|essentials?|anthology|oldies|classics|number ones|retrospective|the complete|jukebox|the singles|favou?rites|compilation)(?![\p{L}\p{N}])/u

/** Whether an album name is a compilation title (see {@link GENERIC_ALBUM}). */
export function isGenericAlbum(name: string): boolean {
  return GENERIC_ALBUM.test(normalizeText(name))
}

/** Words of a label name that say nothing about which label it is. */
const LABEL_STOPWORDS = new Set([
  'the',
  'a',
  'an',
  'and',
  'of',
  'to',
  'by',
  'under',
  'exclusive',
  'license',
  'licence',
  'marketed',
  'distributed',
  'division',
  'records',
  'record',
  'recordings',
  'recording',
  'music',
  'musik',
  'entertainment',
  'group',
  'inc',
  'llc',
  'llp',
  'ltd',
  'limited',
  'plc',
  'co',
  'corp',
  'corporation',
  'company',
  'gmbh',
  'ab',
  'bv',
  'sa',
  'label',
  'labels',
  'digital',
  'distribution',
  'publishing',
  'productions',
  'production',
  'media',
  'worldwide',
  'international',
  'enterprises',
  'holdings',
  'global',
  'audio',
])

/** The words of a label name that identify it: "ABKCO Music & Records, Inc." → `abkco`. */
export function labelWords(label: string): Set<string> {
  return new Set(
    textTokens(label).filter((word) => !LABEL_STOPWORDS.has(word) && !/^\d+$/u.test(word)),
  )
}

/** Whether two label names share an identifying word ("Rhino/Warner Records" and "Warner Records Inc."). */
function sameLabel(a: string, b: string): boolean {
  const left = labelWords(a)
  for (const word of labelWords(b)) if (left.has(word)) return true
  return false
}

/**
 * How a candidate's labels compare with the source's: `match` when one shares an identifying
 * word with it, `conflict` when both are known and none does, `unknown` otherwise. The
 * candidate's labels are its ℗ label and the "Provided to YouTube by" distributor; either may
 * name the source's label.
 */
export function compareLabels(
  sourceLabel: string | undefined,
  facts: ReleaseFacts | undefined,
): 'match' | 'conflict' | 'unknown' {
  if (sourceLabel === undefined || labelWords(sourceLabel).size === 0) return 'unknown'
  const labels = [facts?.label, facts?.providedBy].filter(
    (label): label is string => label !== undefined && labelWords(label).size > 0,
  )
  if (labels.length === 0) return 'unknown'
  return labels.some((label) => sameLabel(sourceLabel, label)) ? 'match' : 'conflict'
}

/** The year of an ISO 8601 date such as `2013`, `2013-05` or `2013-05-17`. */
export function yearOf(date: string | undefined): number | undefined {
  const match = date === undefined ? null : /^\s*(\d{4})/u.exec(date)
  return match ? Number(match[1]) : undefined
}

/**
 * How a candidate's release year compares with the source's: `match` when equal, `conflict`
 * when the candidate's release came out two years or more before the source's (so it cannot
 * carry a recording the source's release introduced; a lead single a year before its album is
 * not a conflict), `unknown` when either is missing, and `later` otherwise (a reissue or a
 * compilation is normal).
 */
export function compareYears(
  sourceYear: number | undefined,
  candidateYear: number | undefined,
): 'match' | 'conflict' | 'later' | 'unknown' {
  if (sourceYear === undefined || candidateYear === undefined) return 'unknown'
  if (candidateYear === sourceYear) return 'match'
  if (candidateYear <= sourceYear - 2) return 'conflict'
  return 'later'
}

/** A year as a release year: a whole number with four digits. */
function isReleaseYear(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1000 && value <= 9999
}

/** A label name worth keeping: a string with something but whitespace in it. */
function labelText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/**
 * Valid {@link ReleaseFacts} from a provider's answer: labels that are non-empty strings and a
 * four-digit year; anything else is left out, so a malformed entry says nothing rather than
 * something wrong.
 */
export function sanitizeReleaseFacts(value: unknown): ReleaseFacts {
  const given =
    typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
  const facts: ReleaseFacts = {}
  const label = labelText(given.label)
  if (label !== undefined) facts.label = label
  const providedBy = labelText(given.providedBy)
  if (providedBy !== undefined) facts.providedBy = providedBy
  if (isReleaseYear(given.releaseYear)) facts.releaseYear = given.releaseYear
  return facts
}

/**
 * Reads the release facts from a YouTube description, the text YouTube generates for label
 * uploads:
 *
 * ```text
 * Provided to YouTube by The Orchard Enterprises
 *
 * The Twist · Chubby Checker
 *
 * Chubby Checker Classics
 *
 * ℗ 1958 TEEC Recording Company
 *
 * Released on: 1962-01-01
 * ```
 *
 * `releaseYear` is the "Released on" year, else the ℗ year. Lines that are missing leave their
 * field out, so any description, even an empty one, is safe to pass.
 */
export function parseReleaseDescription(description: string): ReleaseFacts {
  const facts: ReleaseFacts = {}
  const lines = description.split(/\r?\n/u).map((line) => line.trim())
  for (const line of lines) {
    const provided = /^Provided to YouTube by\s+(.+)$/iu.exec(line)
    if (provided?.[1] && facts.providedBy === undefined) facts.providedBy = provided[1].trim()
    const phonogram = /^(?:℗|\(P\))\s*((?:\d{4}\s+)*)(.*)$/iu.exec(line)
    if (phonogram && facts.label === undefined) {
      const label = (phonogram[2] ?? '').trim()
      if (label !== '') facts.label = label
      const year = /\d{4}/u.exec(phonogram[1] ?? '')
      if (year && facts.releaseYear === undefined) facts.releaseYear = Number(year[0])
    }
    const released = /^Released on:\s*(\d{4})/iu.exec(line)
    if (released?.[1]) facts.releaseYear = Number(released[1])
  }
  return facts
}
