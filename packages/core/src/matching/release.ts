/**
 * Release facts for the re-recording guard and the tie-break: whether two albums are the same,
 * whether labels and years agree, and what a YouTube description says about a release.
 *
 * @module
 */

import { normalizeText, splitTitle } from '../text'
import { diceSimilarity, textTokens } from './similarity'
import type { ReleaseFacts } from './types'

/** How closely a candidate's album matches the source's. */
export type AlbumMatchLevel = 'exact' | 'core' | 'none'

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
 * How closely two album names match:
 *
 * - `exact`: equal once normalized
 * - `core`: equal without edition qualifiers ("Hysteria" and "Hysteria (Super Deluxe)"), one
 *   starting with the other's words when that has two words or eight letters ("OK Computer" and
 *   "OK Computer OKNOTOK 1997 2017"), or Dice of at least 0.9
 * - `none`: anything else, or a name missing
 */
export function albumMatchLevel(a: string | undefined, b: string | undefined): AlbumMatchLevel {
  if (a === undefined || b === undefined) return 'none'
  const left = normalizeText(a)
  const right = normalizeText(b)
  if (left === '' || right === '') return 'none'
  if (left === right) return 'exact'
  const leftCore = albumCore(a)
  const rightCore = albumCore(b)
  if (leftCore === '' || rightCore === '') return 'none'
  if (leftCore === rightCore) return 'core'
  const leftWords = textTokens(leftCore)
  const rightWords = textTokens(rightCore)
  const [shorter, longer] =
    leftWords.length <= rightWords.length ? [leftWords, rightWords] : [rightWords, leftWords]
  const distinctive = shorter.length >= 2 || shorter.join('').length >= 8
  if (distinctive && shorter.every((word, i) => longer[i] === word)) return 'core'
  return diceSimilarity(leftCore, rightCore) >= 0.9 ? 'core' : 'none'
}

/** The rank of a match level, for comparing them. */
export function albumMatchRank(level: AlbumMatchLevel): number {
  return level === 'exact' ? 2 : level === 'core' ? 1 : 0
}

/**
 * Album names that many releases share, such as "The Very Best of The Everly Brothers" or
 * "Greatest Hits": a match on one says nothing about which release, or recording, it is.
 */
const GENERIC_ALBUM =
  /(?<![\p{L}\p{N}])(?:best|greatest|hits|collection|essentials?|anthology|gold|golden|classics?|legends?|legendary|favou?rites|definitive|ultimate|platinum|number ones|retrospective|masters|all time|complete|treasury|portrait|the very|selected|singles|jukebox|oldies|years)(?![\p{L}\p{N}])/u

/** Whether an album name is a generic compilation title (see {@link GENERIC_ALBUM}). */
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
