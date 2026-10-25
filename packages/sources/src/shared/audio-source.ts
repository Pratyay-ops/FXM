/**
 * Helpers the free audio sources share (Internet Archive and Jamendo):
 *
 * - {@link provisionalScore}, a provisional score for candidates a source finds by searching for
 *   another source's track, e.g. an Archive file for a Spotify song. It follows the shape of the
 *   matching engine's scorer (ARCHITECTURE.md §12): 0.40 title, 0.35 artist and 0.25 duration,
 *   minus version and duration penalties, with the same caps. It is not the engine's scorer
 *   (word-level similarity and a linear duration fall-off), so its numbers are not on the
 *   engine's scale: they rank one source's candidates, nothing more.
 * - {@link orderOptions}, the order `AudioSource.resolve` returns stream options in.
 *
 * **The contract for the playback policy (stage 2.3).** A free-source candidate found by text
 * alone is at most Suggest: its confidence is capped at {@link TEXT_ONLY_CAP}, below the Auto
 * band, and nothing re-scores it on the way to the player (1.7's `matchTrack` reads YouTube Music
 * pages only). Only a candidate with `signals.isrcVerified` may play without asking: equal ISRCs
 * that also pass the ISRC gate's checks (see {@link provisionalScore}). Once 1.7's engine is
 * merged, free-source candidates should be scored with its scorer instead.
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

/** What {@link provisionalScore} compares: the track to find, or a candidate for it. */
export interface Comparable {
  /** The title, as the source shows it. */
  title: string
  /** The artist names, main artist first. May be one combined credit such as `A & B`. */
  artists: readonly string[]
  /**
   * The album (for an Archive file, its item's title). Its version tags count like the title's
   * qualifiers, on both sides, as in the matching engine: a track of "MTV Unplugged in New York"
   * is live, and so is an Archive item called "Live Through This", which the Spotify album of
   * that name then matches.
   */
  album?: string
  /** Duration in milliseconds, when known. */
  durationMs?: number
  /** The ISRC, in any spelling `normalizeIsrc` accepts, when known. */
  isrc?: string
  /**
   * Whether the source says this is a live recording although neither its title nor its album
   * may, e.g. a song from a Live Music Archive concert, titled just "Jack Straw".
   */
  live?: boolean
}

/** The outcome of {@link provisionalScore}. */
export interface CandidateScore {
  /** From 0 to 1: at most {@link TEXT_ONLY_CAP}, or exactly 1 when ISRC-verified. */
  confidence: number
  /**
   * Why, for people: e.g. `title 1.00`, `artist 0.80`, `duration +1.2s`, `version live`, and
   * `isrc` or `isrc conflict (title, duration)` when both sides have the same ISRC.
   */
  evidence: string[]
  /**
   * Whether the candidate is ISRC-verified: both sides have the same ISRC and the candidate
   * passes the ISRC gate's checks too (see {@link provisionalScore}).
   */
  isrcVerified: boolean
}

/**
 * The highest confidence a text-only guess gets: just below the matching engine's Auto band
 * (0.80), so that a provider's own guess is at most a suggestion.
 */
export const TEXT_ONLY_CAP = 0.79

/**
 * The lowest confidence worth returning as a candidate: the floor of the matching engine's
 * Suggest band (0.60). Below it the engine would show alternatives instead of playing, so a
 * provider leaves such guesses out, e.g. a concert recording of a studio track (a live tag on one
 * side costs 0.45).
 */
export const MIN_CANDIDATE_CONFIDENCE = 0.6

/**
 * The ISRC gate's checks (memo §6.1, and 1.7's `DEFAULT_MATCH_THRESHOLDS`): ISRCs are shared by
 * unrelated tracks, and an uploader may copy one tag onto every file, so equal ISRCs count only
 * when the title, the artist and the duration agree too and no strong version tag differs.
 */
const ISRC_GATE = {
  /** The lowest title similarity: 1.7's default (§12 names 0.5 as the floor). */
  title: 0.8,
  /** The lowest artist similarity. */
  artist: 0.5,
} as const

/** How much a version tag on one side only costs, by the strongest such tag. */
const VERSION_PENALTY: Readonly<Record<keyof VersionTags, number>> = {
  strong: 0.45,
  medium: 0.15,
  soft: 0.03,
}

/**
 * Strong tags that name a live performance, compared as one (the matching engine's `live`
 * family): "Live" on one side and "MTV Unplugged" on the other is no mismatch.
 */
const LIVE_FAMILY = new Set([
  'live',
  'unplugged',
  'concert',
  'tour',
  'festival',
  'session',
  'performance',
  'tiny desk',
])

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

/**
 * The version tags of a side: those of its title's qualifiers and of its album, plus `live` when
 * the source says so; live-family tags count as `live`.
 */
function versionTagsOf({ album, live }: Comparable, qualifiers: readonly string[]): VersionTags {
  const found = extractVersionTags(qualifiers.join(' | '))
  if (album !== undefined && album.trim() !== '') {
    const fromAlbum = extractVersionTags(album)
    for (const level of ['strong', 'medium', 'soft'] as const)
      found[level].push(...fromAlbum[level])
  }
  const strong = found.strong.map((tag) => (LIVE_FAMILY.has(tag) ? 'live' : tag))
  if (live === true) strong.push('live')
  return {
    strong: [...new Set(strong)],
    medium: [...new Set(found.medium)],
    soft: [...new Set(found.soft)],
  }
}

/** A title's core words and the version tags of its side. */
function titleParts(side: Comparable): { core: string[]; tags: VersionTags } {
  const { core, qualifiers } = splitTitle(stripPresentationNoise(side.title))
  return { core: wordsOf(core), tags: versionTagsOf(side, qualifiers) }
}

/**
 * Whether a track or candidate is a live performance by its tags: a live-family tag in its
 * title's qualifiers or its album, or the source saying so (`live`).
 */
export function isLive(side: Comparable): boolean {
  return titleParts(side).tags.strong.includes('live')
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
 *   `extractVersionTags`), read from the title's qualifiers and the album, costs 0.45 when
 *   strong, 0.15 when medium and 0.03 when soft
 * - a duration more than 10 s off costs 0.15, more than 20 s off 0.35
 * - a title similarity below 0.5 caps the score at 0.40, and an artist similarity of 0 at 0.45
 * - the result is at most {@link TEXT_ONLY_CAP}
 *
 * Equal ISRCs give exactly 1 and `isrcVerified`, but only when the candidate also passes the
 * ISRC gate's checks: a title similarity of at least 0.8, an artist similarity of at least 0.5,
 * a duration within max(5 s, 2 %) of the track's when the track has one, and no strong version
 * tag on one side only. Otherwise the text score stands, with an `isrc conflict` entry in the
 * evidence that names the failed checks.
 *
 * `track.isrc` must be a trusted ISRC (the catalog's, or MusicBrainz's exact path), never a hint
 * from a fuzzy MusicBrainz search.
 */
export function provisionalScore(track: Comparable, candidate: Comparable): CandidateScore {
  const trackIsrc = normalizeIsrc(track.isrc)
  const sameIsrc = trackIsrc !== null && trackIsrc === normalizeIsrc(candidate.isrc)
  const wanted = titleParts(track)
  const found = titleParts(candidate)
  const title = titleSimilarity(wanted.core, found.core)
  const artist = artistSimilarity(track.artists, candidate.artists)
  const evidence = [`title ${fixed(title)}`, `artist ${fixed(artist)}`]

  let duration = 0.5
  let durationPenalty = 0
  // The ISRC gate's duration check, skipped when the track has no duration.
  let inWindow = track.durationMs === undefined
  if (track.durationMs !== undefined && candidate.durationMs !== undefined) {
    const delta = candidate.durationMs - track.durationMs
    const off = Math.abs(delta)
    const window = Math.max(5_000, 0.02 * track.durationMs)
    inWindow = off <= window
    duration = inWindow ? 1 : Math.max(0, 1 - (off - window) / 30_000)
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
  const confidence = Math.round(Math.min(Math.max(score, 0), TEXT_ONLY_CAP) * 100) / 100
  if (!sameIsrc) return { confidence, evidence, isrcVerified: false }

  const failed = [
    ...(title < ISRC_GATE.title ? ['title'] : []),
    ...(artist < ISRC_GATE.artist ? ['artist'] : []),
    ...(inWindow ? [] : ['duration']),
    ...(mismatch === 'strong' ? ['version'] : []),
  ]
  if (failed.length === 0) {
    return { confidence: 1, evidence: ['isrc', ...evidence], isrcVerified: true }
  }
  return {
    confidence,
    evidence: [`isrc conflict (${failed.join(', ')})`, ...evidence],
    isrcVerified: false,
  }
}

/**
 * What crediting a free-source track takes: Creative Commons licences ask for the title, the
 * author, the source and the licence, and Jamendo's API terms (§4.1) for crediting the artist
 * and Jamendo with a link to the track's page.
 */
export interface Attribution {
  /** The track's title. */
  title: string
  /** The credited artists, main artist first. */
  artists: string[]
  /** Who provides the track, to credit as its source: `Internet Archive` or `Jamendo`. */
  provider: string
  /** The page to link to: the Archive item's page, or the track's page on Jamendo. */
  pageUrl: string
  /** The licence's URL, e.g. a Creative Commons deed, when the source states one. */
  licenseUrl?: string
}
