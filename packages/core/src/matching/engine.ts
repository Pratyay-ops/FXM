/**
 * The matching engine: ranks the candidates a provider found for a source track and decides
 * whether the best may play without asking (ARCHITECTURE.md §12, as corrected by the research
 * memo of 2026-10-25, sections 6 and 11.7). Pure: the provider fetches the pages, see
 * `nextMatchRequest`.
 *
 * @module
 */

import { entityKey, isEntityId, parseId, type SourceId } from '../ids'
import { isPlayable } from '../mode'
import type { Track } from '../model'
import type { AudioCandidate, MatchSignals } from '../providers'
import { normalizeText } from '../text'
import { durationWindowMs, runIsrcGate } from './isrc'
import { isClassicalTitle, type PreparedTitle } from './prepare'
import {
  type AlbumMatchLevel,
  albumMatchLevel,
  albumMatchRank,
  compareLabels,
  compareYears,
  isGenericAlbum,
  labelWords,
  yearOf,
} from './release'
import {
  differentRemixes,
  type PreparedSource,
  prepareCandidateTitle,
  prepareSource,
  type ScoreBreakdown,
  scoreCandidate,
  sourceSide,
  trackSide,
} from './score'
import { textSimilarity } from './similarity'
import {
  type AutoBlocker,
  type IsrcCheck,
  type MatchBand,
  type MatchOptions,
  type MatchPages,
  type MatchResult,
  type MatchSource,
  type MatchThresholds,
  type ReleaseFacts,
  resolveThresholds,
} from './types'

/** The confidence of an ISRC-verified candidate, whatever its text score. */
const VERIFIED_CONFIDENCE = 0.95

/** Scores this close are equal: floating-point sums of the weights differ in the last digits. */
const EPSILON = 1e-9

/** Where a candidate came from, in the order the engine prefers among equals. */
type PageName = 'isrc' | 'text' | 'album' | 'videos' | 'youtube'

/** A candidate with everything the engine knows about it. */
interface Scored {
  track: Track
  /** `entityKey` of its ID, for de-duplication. */
  key: string
  /** The audio source and native ID of the `AudioCandidate` it becomes. */
  source: SourceId
  ref: string
  page: PageName
  /** Its place across all pages, for the last tie-break. */
  order: number
  prepared: PreparedTitle
  breakdown: ScoreBreakdown
  score: number
  verified: boolean
  hint: boolean
  facts?: ReleaseFacts
  year?: number
  albumLevel: AlbumMatchLevel
  yearCompare: ReturnType<typeof compareYears>
  labelCompare: ReturnType<typeof compareLabels>
  /** Whether its duration is within the window of the source's. */
  inWindow: boolean
}

/** The audio source and native ID a track plays from: YouTube's one audio source is `ytm`. */
function audioRef(track: Track): { source: SourceId; ref: string } | undefined {
  if (!isEntityId(track.id, 'track')) return undefined
  const { source, nativeId } = parseId(track.id)
  return { source: source === 'yt' ? 'ytm' : source, ref: nativeId }
}

/** Release facts by `entityKey`, so a `yt` and a `ytm` ID of one video find the same entry. */
function factsByKey(pages: MatchPages): Map<string, ReleaseFacts> {
  const map = new Map<string, ReleaseFacts>()
  for (const [id, facts] of Object.entries(pages.releaseFacts ?? {})) {
    if (isEntityId(id)) map.set(entityKey(id), facts)
  }
  return map
}

/** Which release a candidate is on: its album's ID, else its album's name. */
function releaseKey(candidate: Scored): string {
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
function differentReleases(a: Scored, b: Scored): boolean {
  if (releaseKey(a) !== releaseKey(b)) return true
  if (a.year !== undefined && b.year !== undefined && a.year !== b.year) return true
  return labelsDiffer(a.facts, b.facts)
}

/** The strong and medium version families of a title, which tell versions apart. */
function hardVersions(title: PreparedTitle): string {
  return [...title.versions]
    .filter(([, level]) => level !== 'soft')
    .map(([family]) => family)
    .sort()
    .join('|')
}

/**
 * Whether two candidates read as the same version of the same song by the source's artist: the
 * same title core and strong or medium version families, the same remix, the same explicit flag
 * when both are known, and the source's artist on both.
 */
function lookAlike(a: Scored, b: Scored): boolean {
  const { explicit: left } = a.track
  const { explicit: right } = b.track
  return (
    textSimilarity(a.prepared.core, b.prepared.core) >= 0.9 &&
    hardVersions(a.prepared) === hardVersions(b.prepared) &&
    !differentRemixes(a.prepared, b.prepared) &&
    (left === undefined || right === undefined || left === right) &&
    a.breakdown.artist >= 0.5 &&
    b.breakdown.artist >= 0.5
  )
}

/** Orders candidates: ISRC-verified, score, release agreement, ISRC hint, page order. */
function compareScored(a: Scored, b: Scored): number {
  if (a.verified !== b.verified) return a.verified ? -1 : 1
  if (Math.abs(a.score - b.score) > EPSILON) return b.score - a.score
  const agreement = (c: Scored) => [
    albumMatchRank(c.albumLevel),
    c.yearCompare === 'match' ? 1 : 0,
    c.labelCompare === 'match' ? 1 : 0,
    c.hint ? 1 : 0,
  ]
  const left = agreement(a)
  const right = agreement(b)
  for (let i = 0; i < left.length; i++) {
    const diff = (right[i] ?? 0) - (left[i] ?? 0)
    if (diff !== 0) return diff
  }
  return a.order - b.order
}

/** Whether `value` reaches `threshold`, ignoring floating-point noise. */
function atLeast(value: number, threshold: number): boolean {
  return value >= threshold - EPSILON
}

/** Rounds a score for output. */
function round(value: number): number {
  return Math.round(value * 10000) / 10000
}

/** Formats a duration difference in seconds, e.g. `+1.2s`. */
function seconds(deltaMs: number): string {
  const value = (deltaMs / 1000).toFixed(1)
  return deltaMs >= 0 ? `+${value}s` : `${value}s`
}

/** What a candidate's evidence says, for people. */
function evidenceOf(candidate: Scored, isrc: IsrcCheck): string[] {
  const { breakdown } = candidate
  const lines: string[] = []
  if (candidate.verified && isrc.place) {
    const where =
      isrc.place.page === 'top-card'
        ? 'top-result card'
        : `songs search ${isrc.place.attempt} #${isrc.place.position}`
    lines.push(`isrc verified (${where})`)
  }
  if (candidate.hint) lines.push('isrc hint (fuzzy)')
  lines.push(`title ${breakdown.title.toFixed(2)}`, `artist ${breakdown.artist.toFixed(2)}`)
  lines.push(
    breakdown.deltaMs === undefined ? 'duration unknown' : `duration ${seconds(breakdown.deltaMs)}`,
  )
  for (const mismatch of breakdown.versionMismatches) {
    lines.push(`${mismatch.side === 'candidate' ? '+' : '-'}${mismatch.family} (${mismatch.level})`)
  }
  if (breakdown.differentRemix) lines.push('different remix')
  for (const name of breakdown.uncreditedFeatured) lines.push(`uncredited feat. ${name}`)
  if (breakdown.explicitMismatch) lines.push('explicit mismatch')
  if (candidate.albumLevel !== 'none') lines.push(`album match (${candidate.albumLevel})`)
  if (candidate.year !== undefined) lines.push(`year ${candidate.year} (${candidate.yearCompare})`)
  if (candidate.labelCompare !== 'unknown') lines.push(`label ${candidate.labelCompare}`)
  if (breakdown.cap) lines.push(`cap: ${breakdown.cap}`)
  lines.push(`score ${round(candidate.score).toFixed(2)}`)
  return lines
}

/** A scored candidate as the `AudioCandidate` the provider returns. */
function toAudioCandidate(candidate: Scored, isrc: IsrcCheck): AudioCandidate {
  const { track } = candidate
  const signals: MatchSignals = {
    isrcVerified: candidate.verified,
    sourceAlbumMatch: candidate.albumLevel !== 'none',
  }
  const album = track.album?.id
  if (album !== undefined && isEntityId(album, 'album')) {
    const parts = parseId(album)
    const albumSource = parts.source === 'yt' ? 'ytm' : parts.source
    if (albumSource === candidate.source) signals.releaseId = parts.nativeId
  }
  if (candidate.year !== undefined) signals.releaseYear = candidate.year
  const label = candidate.facts?.label ?? candidate.facts?.providedBy
  if (label !== undefined) signals.label = label
  const result: AudioCandidate = {
    source: candidate.source,
    ref: candidate.ref,
    kind: track.kind,
    title: track.title,
    artists: track.artists.map((artist) => artist.name),
    confidence: round(
      candidate.verified ? Math.max(candidate.score, VERIFIED_CONFIDENCE) : candidate.score,
    ),
    evidence: evidenceOf(candidate, isrc),
    signals,
  }
  if (track.durationMs !== undefined) result.durationMs = track.durationMs
  return result
}

/** What the guards need to know about the ranked candidates. */
interface Ranked {
  source: MatchSource
  thresholds: MatchThresholds
  candidates: Scored[]
}

/**
 * Whether the best candidate's album ties it to the source's release: it matches the source's
 * album, the album is not a generic compilation title, and no other release by the source's
 * artist on the pages matches as well (two releases named "The Everly Brothers" tie neither).
 */
function albumAnchor(best: Scored, ranked: Ranked): boolean {
  const album = ranked.source.album?.name
  if (best.albumLevel === 'none' || album === undefined || isGenericAlbum(album)) return false
  const rank = albumMatchRank(best.albumLevel)
  const bestRelease = releaseKey(best)
  return !ranked.candidates.some(
    (other) =>
      other !== best &&
      other.track.kind === 'song' &&
      other.breakdown.artist >= 0.5 &&
      releaseKey(other) !== bestRelease &&
      albumMatchRank(other.albumLevel) >= rank,
  )
}

/**
 * Re-recording guard 1: other candidates that look like the best (title core, artist, version)
 * inside the duration window, from different releases.
 */
function rivalsOf(best: Scored, ranked: Ranked): Scored[] {
  return ranked.candidates.filter(
    (other) =>
      other !== best &&
      other.track.kind === 'song' &&
      other.inWindow &&
      lookAlike(best, other) &&
      differentReleases(best, other),
  )
}

/** Whether two durations are within the window of each other (true when either is unknown). */
function closeDurations(a: Scored, b: Scored, ranked: Ranked): boolean {
  const left = a.track.durationMs
  const right = b.track.durationMs
  if (left === undefined || right === undefined) return true
  const reference = ranked.source.durationMs ?? Math.max(left, right)
  return Math.abs(left - right) <= durationWindowMs(reference, ranked.thresholds)
}

/**
 * Ranks the candidates a provider found for `source` and decides what to do with the best.
 *
 * 1. **ISRC gate** (see `checkIsrc`): a trusted ISRC's accepted item is ISRC-verified and ranks
 *    first; a trusted ISRC that never passes caps the match at `suggest`.
 * 2. **Candidates:** the gate's item, then every item of the text search, the album search and,
 *    in Music + Video mode, the video searches, de-duplicated and kept only if `ctx.mode` lets
 *    them play as they are (`isPlayable`: songs only in Music mode).
 * 3. **Score** (see `scoreCandidate`), then rank: ISRC-verified first, then by score, and among
 *    equal scores by agreement with the source's album, year and label, an ISRC hint, and the
 *    page order. The tie-break comes after the 1.0 cap, so equal scores of different releases
 *    are decided by release facts rather than YouTube's result order. In Music + Video mode the
 *    best song wins when it reaches `suggest`.
 * 4. **Band:** `auto` only when the Auto setting is on and the source has a duration, and the
 *    best is ISRC-verified, or it scores at least 0.80 with a title similarity of at least 0.80,
 *    its duration is within max(5 s, 2 %), it leads the best candidate that is not the same
 *    version by 0.05, it is an official song, its explicit flag agrees with the source's, and
 *    no guard fires: the classical guard (a classical-looking title needs an album match) and
 *    the re-recording guard (rivals from other releases with nothing tying the best to the
 *    source's release; an ISRC miss; a conflicting label or year; and, when
 *    {@link MatchOptions.requireReleaseAgreement} is on, no album or year agreement). Otherwise
 *    `suggest` from 0.60 (or when ISRC-verified), else `none`. `autoBlockers` lists every
 *    reason, and `best` is set whatever the band, as the first of the alternatives.
 */
export function matchTrack(
  source: MatchSource,
  pages: MatchPages,
  options: MatchOptions = {},
): MatchResult {
  const thresholds = resolveThresholds(options)
  const mode = options.mode ?? 'music'
  const prepared: PreparedSource = prepareSource(sourceSide(source))
  const gate = runIsrcGate(source, prepared, pages, thresholds)
  const facts = factsByKey(pages)
  const sourceYear = yearOf(source.releaseDate)
  const sourceMs = source.durationMs
  const hintKey =
    gate.check.status === 'hint' && gate.accepted ? entityKey(gate.accepted.id) : undefined

  const lists: Array<readonly [PageName, readonly Track[]]> = [
    ['isrc', gate.check.status === 'verified' && gate.accepted ? [gate.accepted] : []],
    ['isrc', gate.check.status === 'hint' && gate.accepted ? [gate.accepted] : []],
    ['text', pages.text ?? []],
    ['album', pages.album ?? []],
    ['videos', mode === 'all' ? (pages.videos ?? []) : []],
    ['youtube', mode === 'all' ? (pages.youtube ?? []) : []],
  ]
  const seen = new Set<string>()
  const candidates: Scored[] = []
  for (const [page, tracks] of lists) {
    for (const track of tracks) {
      const ref = audioRef(track)
      if (ref === undefined || !isPlayable(track, mode)) continue
      const key = entityKey(track.id)
      if (seen.has(key)) continue
      seen.add(key)
      const side = trackSide(track)
      const title = prepareCandidateTitle(prepared, side)
      const breakdown = scoreCandidate(prepared, side, title)
      const candidateFacts = facts.get(key)
      const year = candidateFacts?.releaseYear ?? yearOf(track.releaseDate)
      const scored: Scored = {
        track,
        key,
        ...ref,
        page,
        order: candidates.length,
        prepared: title,
        breakdown,
        score: breakdown.score,
        verified: page === 'isrc' && gate.check.status === 'verified',
        hint: key === hintKey,
        albumLevel: albumMatchLevel(source.album?.name, track.album?.name),
        yearCompare: compareYears(sourceYear, year),
        labelCompare: compareLabels(source.label, candidateFacts),
        inWindow:
          sourceMs !== undefined &&
          breakdown.deltaMs !== undefined &&
          Math.abs(breakdown.deltaMs) <= durationWindowMs(sourceMs, thresholds),
      }
      if (candidateFacts !== undefined) scored.facts = candidateFacts
      if (year !== undefined) scored.year = year
      candidates.push(scored)
    }
  }

  candidates.sort(compareScored)
  const best =
    candidates.find(
      (c) => c.track.kind === 'song' && (c.verified || atLeast(c.score, thresholds.suggest)),
    ) ?? candidates[0]
  const ordered = best ? [best, ...candidates.filter((c) => c !== best)] : []
  const ranked: Ranked = { source, thresholds, candidates: ordered }

  const blockers: AutoBlocker[] = []
  const evidence: string[] = [`isrc ${gate.check.status}`]
  if (!options.auto) blockers.push('setting-off')
  if (sourceMs === undefined) blockers.push('no-duration')

  let margin: number | undefined
  let band: MatchBand = 'none'
  if (best === undefined) {
    blockers.push('no-candidates')
  } else {
    const rival = ordered.find(
      (c) => c !== best && !(lookAlike(best, c) && closeDurations(best, c, ranked)),
    )
    margin = round(best.score - (rival?.score ?? 0))
    if (!best.verified) {
      if (!atLeast(best.score, thresholds.auto)) blockers.push('low-score')
      if (!atLeast(best.breakdown.title, thresholds.autoTitle)) blockers.push('low-title')
      if (sourceMs !== undefined && !best.inWindow) blockers.push('duration-window')
      if (!atLeast(margin, thresholds.margin)) blockers.push('margin')
      if (best.track.kind !== 'song') blockers.push('not-song')
      if (best.breakdown.explicitMismatch) blockers.push('explicit-mismatch')
      if (isClassicalTitle(source.title) && best.albumLevel === 'none') blockers.push('classical')
      const anchored =
        albumAnchor(best, ranked) || best.yearCompare === 'match' || best.labelCompare === 'match'
      if (!anchored && rivalsOf(best, ranked).length > 0) blockers.push('rivals')
      if (gate.check.status === 'miss') blockers.push('isrc-miss')
      if (best.yearCompare === 'conflict' || best.labelCompare === 'conflict') {
        blockers.push('release-conflict')
      }
      if (
        options.requireReleaseAgreement &&
        !(albumAnchor(best, ranked) || best.yearCompare === 'match')
      ) {
        blockers.push('release-agreement-required')
      }
    }
    if (blockers.length === 0) band = 'auto'
    else if (best.verified || atLeast(best.score, thresholds.suggest)) band = 'suggest'
    evidence.push(`best score ${round(best.score).toFixed(2)}`, `margin ${margin.toFixed(2)}`)
  }
  evidence.push(`band ${band}`, ...blockers.map((blocker) => `blocked: ${blocker}`))

  const audio = ordered.map((candidate) => toAudioCandidate(candidate, gate.check))
  const result: MatchResult = {
    band,
    candidates: audio,
    isrc: gate.check,
    autoBlockers: blockers,
    evidence,
  }
  if (audio[0] !== undefined) result.best = audio[0]
  if (margin !== undefined) result.margin = margin
  return result
}
