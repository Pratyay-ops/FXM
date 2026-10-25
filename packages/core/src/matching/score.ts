/**
 * The scorer: how alike a candidate's title, artists and duration are to the source's, with the
 * penalties and caps of ARCHITECTURE.md §12.
 *
 * @module
 */

import type { Track } from '../model'
import {
  artistSimilarity,
  isCredited,
  type PreparedTitle,
  prepareTitle,
  type VersionLevel,
} from './prepare'
import { textSimilarity } from './similarity'
import type { MatchSource } from './types'

/** The weights of the three similarities. They add up to 1. */
export const SCORE_WEIGHTS = Object.freeze({ title: 0.4, artist: 0.35, duration: 0.25 })

/** What each kind of mismatch costs. */
export const SCORE_PENALTIES = Object.freeze({
  /** A version family on one side only, by level. */
  strong: 0.45,
  medium: 0.15,
  soft: 0.03,
  /** A featured artist in the candidate's title whom the source does not credit. */
  uncreditedFeatured: 0.45,
  /** One side explicit, the other clean: a different master. */
  explicit: 0.15,
  /** The duration off by more than 10 s, and by more than 20 s. */
  durationOver10s: 0.15,
  durationOver20s: 0.35,
})

/** The caps: a title this unlike, or no shared artist, can never score above these. */
export const SCORE_CAPS = Object.freeze({
  /** Below this title similarity the score is capped at `title`. */
  titleBelow: 0.5,
  title: 0.4,
  /** With no artist in common the score is capped at this. */
  artist: 0.45,
})

/**
 * The duration term: 1 within 2 s, 0.85 within 5 s, 0.4 within 10 s, else 0.
 *
 * @param deltaMs The candidate's duration minus the source's, in milliseconds.
 */
export function durationSimilarity(deltaMs: number): number {
  const delta = Math.abs(deltaMs)
  if (delta <= 2000) return 1
  if (delta <= 5000) return 0.85
  if (delta <= 10000) return 0.4
  return 0
}

/** One side of a comparison, as the scorer reads it. */
export interface ScoreSide {
  /** Title as shown. */
  title: string
  /** Artist names as credited (channel names for plain YouTube videos). */
  artists: readonly string[]
  /** Album name, whose version tags count too. */
  album?: string
  /** Duration in milliseconds. */
  durationMs?: number
  /** Whether the item is marked explicit. */
  explicit?: boolean
}

/** A version family on one side only. */
export interface VersionMismatch {
  /** The family, e.g. `live`, `remix` or `telugu version`. */
  family: string
  /** Its level, which sets the penalty. */
  level: VersionLevel
  /** Which side has it. */
  side: 'source' | 'candidate'
}

/** How a candidate compares with the source, part by part. */
export interface ScoreBreakdown {
  /** Title similarity, from 0 to 1. */
  title: number
  /** Artist similarity, from 0 to 1. */
  artist: number
  /** The duration term; absent in no-duration mode or without the candidate's duration. */
  duration?: number
  /** The candidate's duration minus the source's, when both are known. */
  deltaMs?: number
  /** Version families on one side only. */
  versionMismatches: VersionMismatch[]
  /** Whether two remixes name different remixers (a strong mismatch). */
  differentRemix: boolean
  /** Whether a strong version family differs, or the two name different remixes. */
  strongMismatch: boolean
  /** Featured artists in the candidate's title whom the source does not credit. */
  uncreditedFeatured: string[]
  /** One side explicit, the other clean (both known). */
  explicitMismatch: boolean
  /** Which cap applied, if any. */
  cap?: 'title' | 'artist'
  /** The final score, from 0 to 1. */
  score: number
}

/** The scorer's view of the track being matched. */
export function sourceSide(source: MatchSource): ScoreSide {
  return {
    title: source.title,
    artists: source.artists.map((artist) => artist.name),
    ...(source.album ? { album: source.album.name } : {}),
    ...(source.durationMs !== undefined ? { durationMs: source.durationMs } : {}),
    ...(source.explicit !== undefined ? { explicit: source.explicit } : {}),
  }
}

/** The scorer's view of a candidate track. */
export function trackSide(track: Track): ScoreSide {
  return {
    title: track.title,
    artists: track.artists.map((artist) => artist.name),
    ...(track.album ? { album: track.album.name } : {}),
    ...(track.durationMs !== undefined ? { durationMs: track.durationMs } : {}),
    ...(track.explicit !== undefined ? { explicit: track.explicit } : {}),
  }
}

/** The source side, prepared once and compared with every candidate. */
export interface PreparedSource {
  /** The source as given. */
  side: ScoreSide
  /** Its title, prepared. */
  title: PreparedTitle
}

/** Prepares the source's title once for many comparisons. */
export function prepareSource(side: ScoreSide): PreparedSource {
  return { side, title: prepareTitle(side.title, side.artists, side.album) }
}

/**
 * Prepares a candidate's title: presentation noise and a leading credit of its own or the
 * source's artists go, version tags come from its qualifiers and album.
 */
export function prepareCandidateTitle(source: PreparedSource, candidate: ScoreSide): PreparedTitle {
  return prepareTitle(
    candidate.title,
    [...candidate.artists, ...source.side.artists],
    candidate.album,
  )
}

/**
 * Title similarity of two prepared titles: {@link textSimilarity} of their cores only, so a
 * shared qualifier such as "(Taylor's Version)" never makes two songs alike.
 */
export function titleSimilarity(a: PreparedTitle, b: PreparedTitle): number {
  return textSimilarity(a.core, b.core)
}

/** The version families on one side only. */
export function versionMismatches(
  source: PreparedTitle,
  candidate: PreparedTitle,
): VersionMismatch[] {
  const mismatches: VersionMismatch[] = []
  for (const [family, level] of source.versions) {
    if (!candidate.versions.has(family)) mismatches.push({ family, level, side: 'source' })
  }
  for (const [family, level] of candidate.versions) {
    if (!source.versions.has(family)) mismatches.push({ family, level, side: 'candidate' })
  }
  return mismatches
}

/** Whether both are remixes that name different remixers ("Tiësto Remix" and "Alok Remix"). */
export function differentRemixes(a: PreparedTitle, b: PreparedTitle): boolean {
  return (
    a.versions.has('remix') &&
    b.versions.has('remix') &&
    a.remixDetail !== '' &&
    b.remixDetail !== '' &&
    textSimilarity(a.remixDetail, b.remixDetail) < 0.5
  )
}

/**
 * Scores a candidate against the source:
 *
 * **0.40 × title + 0.35 × artist + 0.25 × duration**, where title is the larger of Dice on
 * character bigrams and token-set overlap between the title cores (after presentation noise and
 * known artist prefixes are gone), artist is the share of the source's artists found among the
 * candidate's (featured artists in its title included), and duration is
 * {@link durationSimilarity}. In no-duration mode (no source duration) the duration term is
 * dropped and the rest is scaled to 1. Then:
 *
 * - a version family on one side only costs 0.45 (strong), 0.15 (medium) or 0.03 (soft), and
 *   two remixes that name different remixers count as a strong mismatch
 * - a featured artist in the candidate's title whom the source does not credit costs 0.45
 * - one side explicit and the other clean costs 0.15
 * - a duration off by more than 10 s costs 0.15, by more than 20 s 0.35
 * - the score stays within 0 and 1; a title similarity below 0.5 caps it at 0.40, and no shared
 *   artist caps it at 0.45
 *
 * @param prepared The candidate's title from {@link prepareCandidateTitle}, when already made.
 */
export function scoreCandidate(
  source: PreparedSource,
  candidate: ScoreSide,
  prepared: PreparedTitle = prepareCandidateTitle(source, candidate),
): ScoreBreakdown {
  const title = titleSimilarity(source.title, prepared)
  const artist = artistSimilarity(source.side.artists, [...candidate.artists, ...prepared.featured])
  const credits = [...source.side.artists, ...source.title.featured]
  const uncreditedFeatured = prepared.featured.filter((name) => !isCredited(name, credits))
  const mismatches = versionMismatches(source.title, prepared)
  const differentRemix = differentRemixes(source.title, prepared)
  const explicitMismatch =
    source.side.explicit !== undefined &&
    candidate.explicit !== undefined &&
    source.side.explicit !== candidate.explicit

  const sourceMs = source.side.durationMs
  const deltaMs =
    sourceMs !== undefined && candidate.durationMs !== undefined
      ? candidate.durationMs - sourceMs
      : undefined
  const duration = deltaMs === undefined ? undefined : durationSimilarity(deltaMs)

  let score =
    sourceMs === undefined
      ? (SCORE_WEIGHTS.title * title + SCORE_WEIGHTS.artist * artist) /
        (SCORE_WEIGHTS.title + SCORE_WEIGHTS.artist)
      : SCORE_WEIGHTS.title * title +
        SCORE_WEIGHTS.artist * artist +
        SCORE_WEIGHTS.duration * (duration ?? 0)
  for (const mismatch of mismatches) score -= SCORE_PENALTIES[mismatch.level]
  if (differentRemix) score -= SCORE_PENALTIES.strong
  if (uncreditedFeatured.length > 0) score -= SCORE_PENALTIES.uncreditedFeatured
  if (explicitMismatch) score -= SCORE_PENALTIES.explicit
  const off = deltaMs === undefined ? 0 : Math.abs(deltaMs)
  if (off > 20000) score -= SCORE_PENALTIES.durationOver20s
  else if (off > 10000) score -= SCORE_PENALTIES.durationOver10s
  score = Math.min(1, Math.max(0, score))

  let cap: ScoreBreakdown['cap']
  if (title < SCORE_CAPS.titleBelow && score > SCORE_CAPS.title) {
    score = SCORE_CAPS.title
    cap = 'title'
  } else if (artist === 0 && score > SCORE_CAPS.artist) {
    score = SCORE_CAPS.artist
    cap = 'artist'
  }

  const breakdown: ScoreBreakdown = {
    title,
    artist,
    versionMismatches: mismatches,
    differentRemix,
    strongMismatch: differentRemix || mismatches.some((mismatch) => mismatch.level === 'strong'),
    uncreditedFeatured,
    explicitMismatch,
    score,
  }
  if (duration !== undefined) breakdown.duration = duration
  if (deltaMs !== undefined) breakdown.deltaMs = deltaMs
  if (cap !== undefined) breakdown.cap = cap
  return breakdown
}
