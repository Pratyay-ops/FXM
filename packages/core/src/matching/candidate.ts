/**
 * What the engine and the video matcher ask of two candidates: whether they are the same version
 * of the same song, and whether they come from different releases.
 *
 * @module
 */

import { entityKey, isEntityId, parseId, type SourceId } from '../ids'
import type { Track } from '../model'
import { normalizeText } from '../text'
import { durationWindowMs } from './isrc'
import type { PreparedTitle } from './prepare'
import { labelWords } from './release'
import { type ScoreBreakdown, sameVersion, validDurationMs } from './score'
import { textSimilarity } from './similarity'
import type { MatchThresholds, ReleaseFacts } from './types'

/** A scored candidate, as far as these checks read it. */
export interface Compared {
  /** The candidate's track. */
  track: Track
  /** `entityKey` of its ID. */
  key: string
  /** Its prepared title. */
  prepared: PreparedTitle
  /** How it compares with the source. */
  breakdown: ScoreBreakdown
  /** What its description says about its release, when fetched. */
  facts?: ReleaseFacts
  /** Its release year, from the facts or the track. */
  year?: number
}

/**
 * The native ID of a track's album in the audio source `source`, for `MatchSignals.releaseId`:
 * `undefined` when the album has no ID or belongs to another source (`yt` counts as `ytm`).
 */
export function releaseIdOf(track: Track, source: SourceId): string | undefined {
  const album = track.album?.id
  if (album === undefined || !isEntityId(album, 'album')) return undefined
  const parts = parseId(album)
  const albumSource = parts.source === 'yt' ? 'ytm' : parts.source
  return albumSource === source ? parts.nativeId : undefined
}

/** Which release a candidate is on: its album's ID, else its album's name. */
export function releaseKey(candidate: Compared): string {
  const album = candidate.track.album
  if (album?.id !== undefined) return `id:${entityKey(album.id)}`
  if (album !== undefined) return `name:${normalizeText(album.name)}`
  return `track:${candidate.key}`
}

/** Whether two candidates' labels are both known and share no identifying word. */
function labelsDiffer(a: ReleaseFacts | undefined, b: ReleaseFacts | undefined): boolean {
  const words = (facts: ReleaseFacts | undefined) =>
    [facts?.label, facts?.providedBy].flatMap((label) => (label ? [...labelWords(label)] : []))
  const left = new Set(words(a))
  const right = words(b)
  return left.size > 0 && right.length > 0 && !right.some((word) => left.has(word))
}

/** Whether two candidates come from different releases: album IDs, years or labels. */
export function differentReleases(a: Compared, b: Compared): boolean {
  if (releaseKey(a) !== releaseKey(b)) return true
  if (a.year !== undefined && b.year !== undefined && a.year !== b.year) return true
  return labelsDiffer(a.facts, b.facts)
}

/**
 * Whether two candidates read as the same version of the same song by the source's artist: the
 * same title core, the same version (see `sameVersion`), the same explicit mark, and the
 * source's artist on both.
 */
export function lookAlike(a: Compared, b: Compared): boolean {
  return (
    textSimilarity(a.prepared.core, b.prepared.core) >= 0.9 &&
    sameVersion(a.prepared, b.prepared) &&
    (a.track.explicit === true) === (b.track.explicit === true) &&
    a.breakdown.artist >= 0.5 &&
    b.breakdown.artist >= 0.5
  )
}

/**
 * Whether two candidates' durations are within the window of each other, the window taken from
 * `referenceMs` (the source's duration) or else from the longer of the two. True when either
 * duration is unknown.
 */
export function closeDurations(
  a: Compared,
  b: Compared,
  referenceMs: number | undefined,
  thresholds: Pick<MatchThresholds, 'windowMs' | 'windowRatio'>,
): boolean {
  const left = validDurationMs(a.track.durationMs)
  const right = validDurationMs(b.track.durationMs)
  if (left === undefined || right === undefined) return true
  const reference = referenceMs ?? Math.max(left, right)
  return Math.abs(left - right) <= durationWindowMs(reference, thresholds)
}
