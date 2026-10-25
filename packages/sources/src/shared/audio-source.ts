/**
 * Helpers the free audio sources share (Internet Archive and Jamendo):
 *
 * - {@link scoreCandidate}, a provisional score for candidates a source finds by searching for
 *   another source's track, e.g. an Archive file for a Spotify song. It only ranks them: the
 *   matching engine (`packages/core/src/matching`) scores every candidate itself before anything
 *   plays, so a text-only guess here stays below the engine's Auto band. It follows the engine's
 *   documented shape (ARCHITECTURE.md §12): 0.40 title, 0.35 artist and 0.25 duration, minus
 *   version and duration penalties, with the same caps.
 * - {@link orderOptions}, the order `AudioSource.resolve` returns stream options in.
 *
 * @module
 */

import {
  compareStreams,
  DOWNLOAD_FORMATS,
  extractVersionTags,
  normalizeIsrc,
  normalizeText,
  type QualityPrefs,
  type StreamOption,
  splitTitle,
  stripPresentationNoise,
  type VersionTags,
} from '@fxm/core'

/**
 * Orders stream options best first, as `compareStreams` ranks them; among equals, the codec that
 * the download format needs no conversion for comes first (`prefs` is only that hint), then the
 * order given.
 */
export function orderOptions(
  options: readonly StreamOption[],
  prefs: QualityPrefs,
): StreamOption[] {
  const wanted = DOWNLOAD_FORMATS[prefs.download.format]?.codec ?? null
  return options
    .map((option, index) => ({ option, index }))
    .sort(
      (a, b) =>
        compareStreams(a.option, b.option) ||
        Number(b.option.codec === wanted) - Number(a.option.codec === wanted) ||
        a.index - b.index,
    )
    .map(({ option }) => option)
}

/** What {@link scoreCandidate} compares: the track to find, or a candidate for it. */
export interface Comparable {
  /** The title, as the source shows it. */
  title: string
  /** The artist names, main artist first. May be one combined credit such as `A & B`. */
  artists: readonly string[]
  /** Duration in milliseconds, when known. */
  durationMs?: number
  /** The ISRC, in any spelling `normalizeIsrc` accepts, when known. */
  isrc?: string
  /**
   * Whether the source says this is a live recording although its title may not, e.g. a song
   * from a Live Music Archive concert, titled just "Jack Straw".
   */
  live?: boolean
}

/** The outcome of {@link scoreCandidate}. */
export interface CandidateScore {
  /** From 0 to 1: at most {@link TEXT_ONLY_CAP}, or exactly 1 when the ISRCs are equal. */
  confidence: number
  /** Why, for people: e.g. `title 1.00`, `artist 0.80`, `duration +1.2s`, `version live`. */
  evidence: string[]
  /** Whether both sides have an ISRC and it is the same. */
  isrcMatch: boolean
}

/**
 * The highest confidence a text-only guess gets: just below the matching engine's Auto band
 * (0.80), so that a provider's own guess never plays without the engine's checks.
 */
export const TEXT_ONLY_CAP = 0.79

/**
 * The lowest confidence worth returning as a candidate: the floor of the matching engine's
 * Suggest band (0.60). Below it the engine would show alternatives instead of playing, so a
 * provider leaves such guesses out, e.g. a concert recording of a studio track (a live tag on one
 * side costs 0.45).
 */
export const MIN_CANDIDATE_CONFIDENCE = 0.6

/** How much a version tag on one side only costs, by the strongest such tag. */
const VERSION_PENALTY: Readonly<Record<keyof VersionTags, number>> = {
  strong: 0.45,
  medium: 0.15,
  soft: 0.03,
}

/** The words of a text for comparison: normalized, split on anything but letters and digits. */
export function wordsOf(value: string): string[] {
  return normalizeText(value).match(/[\p{L}\p{N}\p{M}]+/gu) ?? []
}

/** The Dice coefficient of two word lists, counting repeated words: 0 to 1. */
function dice(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 || b.length === 0) return 0
  const counts = new Map<string, number>()
  for (const word of a) counts.set(word, (counts.get(word) ?? 0) + 1)
  let shared = 0
  for (const word of b) {
    const left = counts.get(word) ?? 0
    if (left > 0) {
      shared++
      counts.set(word, left - 1)
    }
  }
  return (2 * shared) / (a.length + b.length)
}

/** A title's core words and the version tags of its qualifiers. */
function titleParts({ title, live }: Comparable): { core: string[]; tags: VersionTags } {
  const { core, qualifiers } = splitTitle(stripPresentationNoise(title))
  const tags = extractVersionTags(qualifiers.join(' '))
  if (live === true && !tags.strong.includes('live')) tags.strong.push('live')
  return { core: wordsOf(core), tags }
}

/** How alike two titles' cores are: 1 when equal, else the Dice coefficient of their words. */
function titleSimilarity(a: readonly string[], b: readonly string[]): number {
  return a.length > 0 && a.join(' ') === b.join(' ') ? 1 : dice(a, b)
}

/**
 * How alike the track's main artist is to the candidate's best-matching artist: 1 when all of
 * its words appear in that credit (so "Dua Lipa" fits "Calvin Harris, Dua Lipa"), else the Dice
 * coefficient of their words.
 */
function artistSimilarity(track: readonly string[], candidate: readonly string[]): number {
  const main = wordsOf(track[0] ?? '')
  if (main.length === 0) return 0
  let best = 0
  for (const name of candidate) {
    const words = wordsOf(name)
    if (main.every((word) => words.includes(word))) return 1
    best = Math.max(best, dice(main, words))
  }
  return best
}

/** The strongest version level found on one side only, or `undefined`. */
function versionMismatch(a: VersionTags, b: VersionTags): keyof VersionTags | undefined {
  for (const level of ['strong', 'medium', 'soft'] as const) {
    const left = new Set(a[level])
    const right = new Set(b[level])
    if (left.size !== right.size || [...left].some((tag) => !right.has(tag))) return level
  }
  return undefined
}

/** The tags of one level that only one side has, for the evidence. */
function lonelyTags(a: VersionTags, b: VersionTags, level: keyof VersionTags): string[] {
  const left = new Set(a[level])
  const right = new Set(b[level])
  return [...left, ...right].filter((tag) => !(left.has(tag) && right.has(tag)))
}

function fixed(value: number): string {
  return value.toFixed(2)
}

/**
 * Scores `candidate` as a match for `track`: 0.40 × title + 0.35 × artist + 0.25 × duration,
 * where the duration term is 1 within max(5 s, 2 %), falls to 0 at 30 s past that and is 0.5
 * when either duration is unknown. Then:
 *
 * - a version tag on one side only (live, remix, radio edit, remaster… see
 *   `extractVersionTags`) costs 0.45 when strong, 0.15 when medium and 0.03 when soft
 * - a duration more than 10 s off costs 0.15, more than 20 s off 0.35
 * - a title similarity below 0.5 caps the score at 0.40, and an artist similarity of 0 at 0.45
 * - the result is at most {@link TEXT_ONLY_CAP}
 *
 * Equal ISRCs give exactly 1.
 */
export function scoreCandidate(track: Comparable, candidate: Comparable): CandidateScore {
  const trackIsrc = normalizeIsrc(track.isrc)
  const isrcMatch = trackIsrc !== null && trackIsrc === normalizeIsrc(candidate.isrc)
  const wanted = titleParts(track)
  const found = titleParts(candidate)
  const title = titleSimilarity(wanted.core, found.core)
  const artist = artistSimilarity(track.artists, candidate.artists)
  const evidence = [`title ${fixed(title)}`, `artist ${fixed(artist)}`]

  let duration = 0.5
  let durationPenalty = 0
  if (track.durationMs !== undefined && candidate.durationMs !== undefined) {
    const delta = candidate.durationMs - track.durationMs
    const off = Math.abs(delta)
    const window = Math.max(5_000, 0.02 * track.durationMs)
    duration = off <= window ? 1 : Math.max(0, 1 - (off - window) / 30_000)
    if (off > 20_000) durationPenalty = 0.35
    else if (off > 10_000) durationPenalty = 0.15
    evidence.push(`duration ${delta >= 0 ? '+' : '-'}${(off / 1000).toFixed(1)}s`)
  } else {
    evidence.push('duration unknown')
  }

  let score = 0.4 * title + 0.35 * artist + 0.25 * duration - durationPenalty
  const mismatch = versionMismatch(wanted.tags, found.tags)
  if (mismatch !== undefined) {
    score -= VERSION_PENALTY[mismatch]
    evidence.push(`version ${lonelyTags(wanted.tags, found.tags, mismatch).join(', ')}`)
  }
  if (title < 0.5) score = Math.min(score, 0.4)
  if (artist === 0) score = Math.min(score, 0.45)
  const confidence = Math.min(Math.max(score, 0), TEXT_ONLY_CAP)
  if (isrcMatch) return { confidence: 1, evidence: ['isrc', ...evidence], isrcMatch }
  return { confidence: Math.round(confidence * 100) / 100, evidence, isrcMatch }
}
