/**
 * The matching engine: ranks the candidates a provider found for a source track and decides
 * whether the best may play without asking (ARCHITECTURE.md §12, as corrected by the research
 * memo of 2026-10-25, sections 6 and 11.7). Pure: the provider fetches the pages, see
 * `nextMatchRequest` and `runMatch`.
 *
 * @module
 */

import { entityKey, isEntityId, normalizeIsrc, parseId, type SourceId } from '../ids'
import { type CatalogMode, isCatalogMode, isPlayable } from '../mode'
import type { Track } from '../model'
import type { AudioCandidate, MatchSignals } from '../providers'
import {
  type Compared,
  closeDurations,
  differentReleases,
  lookAlike,
  releaseIdOf,
  releaseKey,
} from './candidate'
import { checkIsrcItem, durationWindowMs, isrcTrust, runIsrcGate } from './isrc'
import { isClassicalTitle } from './prepare'
import {
  type AlbumMatchLevel,
  albumMatchLevel,
  albumMatchRank,
  compareLabels,
  compareYears,
  isGenericAlbum,
  isSameRelease,
  sanitizeReleaseFacts,
  yearOf,
} from './release'
import {
  prepareCandidateTitle,
  prepareSource,
  scoreCandidate,
  sourceSide,
  trackSide,
} from './score'
import {
  type AutoBlocker,
  type IsrcCheck,
  type IsrcPlace,
  MATCHER_VERSION,
  type MatchBand,
  type MatchOptions,
  type MatchPages,
  type MatchResult,
  type MatchSource,
  type MatchThresholds,
  type MatchVerdict,
  type ReleaseFacts,
  resolveMatchThresholds,
} from './types'

/** The confidence of an ISRC-verified candidate, whatever its text score. */
const VERIFIED_CONFIDENCE = 0.95

/** Scores this close are equal: floating-point sums of the weights differ in the last digits. */
const EPSILON = 1e-9

/** Where a candidate came from, in the order the engine prefers among equals. */
type PageName = 'isrc' | 'text' | 'album' | 'videos' | 'youtube'

/** A candidate with everything the engine knows about it. */
interface Scored extends Compared {
  /** The audio source and native ID of the `AudioCandidate` it becomes. */
  source: SourceId
  ref: string
  page: PageName
  /** Its place across all pages, for the last tie-break. */
  order: number
  score: number
  verified: boolean
  hint: boolean
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

/**
 * Release facts by `entityKey`, so a `yt` and a `ytm` ID of one video find the same entry.
 *
 * @throws RangeError for a key that is not a track ID, such as a bare videoId: dropping it would
 * silently turn the conflicting-release-facts guard off.
 */
function factsByKey(pages: MatchPages): Map<string, ReleaseFacts> {
  const map = new Map<string, ReleaseFacts>()
  for (const [id, facts] of Object.entries(pages.releaseFacts ?? {})) {
    if (!isEntityId(id, 'track')) {
      throw new RangeError(
        `Release facts are keyed by a full track ID such as ytm:track:<videoId>, not ${JSON.stringify(id)}`,
      )
    }
    map.set(entityKey(id), sanitizeReleaseFacts(facts))
  }
  return map
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

/** Where an ISRC-verified item was, for people. */
function placeText(place: IsrcPlace): string {
  if (place.page === 'top-card') return 'top-result card'
  if (place.page === 'own-isrc') return 'its own ISRC'
  return `songs search ${place.attempt} #${place.position}`
}

/** What a candidate's evidence says, for people. */
function evidenceOf(candidate: Scored, isrc: IsrcCheck): string[] {
  const { breakdown } = candidate
  const lines: string[] = []
  if (candidate.verified) {
    const own = isrc.trackId !== undefined && entityKey(isrc.trackId) === candidate.key
    lines.push(own && isrc.place ? `isrc verified (${placeText(isrc.place)})` : 'isrc verified')
  }
  if (candidate.hint) lines.push('isrc hint (fuzzy)')
  lines.push(`title ${breakdown.title.toFixed(2)}`, `artist ${breakdown.artist.toFixed(2)}`)
  lines.push(
    breakdown.deltaMs === undefined ? 'duration unknown' : `duration ${seconds(breakdown.deltaMs)}`,
  )
  for (const mismatch of breakdown.versionMismatches) {
    lines.push(`${mismatch.side === 'candidate' ? '+' : '-'}${mismatch.tag} (${mismatch.level})`)
  }
  if (breakdown.differentRemix) lines.push('different remix')
  for (const name of breakdown.uncreditedFeatured) lines.push(`uncredited feat. ${name}`)
  if (breakdown.explicitMismatch) lines.push('explicit mismatch')
  if (candidate.albumLevel !== 'none') lines.push(`album match (${candidate.albumLevel})`)
  if (candidate.year !== undefined) lines.push(`year ${candidate.year} (${candidate.yearCompare})`)
  if (candidate.labelCompare !== 'unknown') lines.push(`label ${candidate.labelCompare}`)
  if (candidate.facts?.providedBy !== undefined) {
    lines.push(`provided by ${candidate.facts.providedBy}`)
  }
  if (breakdown.cap) lines.push(`cap: ${breakdown.cap}`)
  lines.push(`score ${round(candidate.score).toFixed(2)}`)
  return lines
}

/** A scored candidate as the `AudioCandidate` the provider returns. */
function toAudioCandidate(
  candidate: Scored,
  isrc: IsrcCheck,
  verdict: MatchVerdict | undefined,
): AudioCandidate {
  const { track } = candidate
  const signals: MatchSignals = {
    isrcVerified: candidate.verified,
    sourceAlbumMatch: isSameRelease(candidate.albumLevel),
  }
  const releaseId = releaseIdOf(track, candidate.source)
  if (releaseId !== undefined) signals.releaseId = releaseId
  if (candidate.year !== undefined) signals.releaseYear = candidate.year
  // The ℗ label only: "Provided to YouTube by" names the distributor, which stays in evidence.
  if (candidate.facts?.label !== undefined) signals.label = candidate.facts.label
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
  const durationMs = trackSide(track).durationMs
  if (durationMs !== undefined) result.durationMs = durationMs
  if (verdict !== undefined) result.verdict = verdict
  return result
}

/** What the guards need to know about the ranked candidates. */
interface Ranked {
  source: MatchSource
  sourceMs: number | undefined
  thresholds: MatchThresholds
  candidates: Scored[]
}

/**
 * Whether the best candidate's album ties it to the source's release: the same release by name
 * (`exact` or `core`, never merely `similar`), neither album name a compilation title, and no
 * other release by the source's artist on the pages matching as well (two releases named "The
 * Everly Brothers" tie neither).
 */
function albumAnchor(best: Scored, ranked: Ranked): boolean {
  const album = ranked.source.album?.name
  const own = best.track.album?.name
  if (!isSameRelease(best.albumLevel) || album === undefined || own === undefined) return false
  if (isGenericAlbum(album) || isGenericAlbum(own)) return false
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

/**
 * Checks the candidates whose own ISRC is the source's (an Internet Archive or Jamendo track
 * with ISRC metadata, say) with the ISRC gate's item checks, and returns the gate's outcome with
 * them added: a pass is ISRC-verified, or a hint for a fuzzy ISRC.
 */
function checkOwnIsrcs(
  candidates: Scored[],
  check: IsrcCheck,
  context: { source: MatchSource; prepared: ReturnType<typeof prepareSource> },
  thresholds: MatchThresholds,
): IsrcCheck {
  const isrc = check.isrc
  if (isrc === undefined) return check
  const result: IsrcCheck = { ...check, rejected: [...check.rejected] }
  const hint = isrcTrust(context.source.isrcOrigin) === 'hint'
  for (const candidate of candidates) {
    if (candidate.verified || normalizeIsrc(candidate.track.isrc) !== isrc) continue
    const place: IsrcPlace = { page: 'own-isrc', attempt: 0, position: candidate.order + 1 }
    const { reasons } = checkIsrcItem(context.prepared, candidate.track, place, thresholds)
    if (reasons.length > 0) {
      result.rejected.push({ trackId: String(candidate.track.id), ...place, reasons })
      continue
    }
    if (hint) candidate.hint = true
    else candidate.verified = true
    if (result.status === 'verified' || (hint && result.status === 'hint')) continue
    result.status = hint ? 'hint' : 'verified'
    result.trackId = candidate.track.id
    result.place = place
  }
  return result
}

/**
 * Ranks the candidates a provider found for `source` and decides what to do with the best.
 *
 * 1. **ISRC gate** (see `checkIsrc`): a trusted ISRC's accepted item is ISRC-verified and ranks
 *    first; a trusted ISRC that never passes caps the match at `suggest`. A candidate whose own
 *    ISRC is the source's is checked the same way.
 * 2. **Candidates:** the gate's item, then every item of the text search, the album search and,
 *    in Music + Video mode, the video searches, de-duplicated and kept only if the mode lets
 *    them play as they are (`isPlayable`: songs only in Music mode).
 * 3. **Score** (see `scoreCandidate`), then rank: ISRC-verified first, then by score, and among
 *    equal scores by agreement with the source's album, year and label, an ISRC hint, and the
 *    page order. The tie-break comes after the 1.0 cap, so equal scores of different releases
 *    are decided by release facts rather than YouTube's result order. In Music + Video mode the
 *    best song wins when it reaches `suggest`.
 * 4. **Band:** `auto` only when the Auto setting is on and the source has a duration, and the
 *    best is ISRC-verified, or it scores at least 0.80 with a title similarity of at least 0.80,
 *    its duration is within max(5 s, 2 %), it leads the best candidate that is not the same
 *    version by 0.05, it is an official song, its explicit mark agrees with the source's, and
 *    no guard fires: the classical guard (a classical-looking title needs a distinctive album
 *    match and every source credit) and the re-recording guard (rivals from other releases with
 *    nothing tying the best to the source's release; an ISRC miss; a conflicting label or year;
 *    and, when {@link MatchOptions.requireReleaseAgreement} is on, no album or year agreement).
 *    Otherwise `suggest` from 0.60 (or when ISRC-verified), else `none`. `autoBlockers` lists
 *    every reason, and `best` is set whatever the band, as the first of the alternatives,
 *    carrying the verdict without the setting (`autoEligible`).
 *
 * Options are read defensively: only `auto: true` turns the setting on, an unknown mode is
 * `music`, and an invalid threshold keeps its default.
 *
 * @throws RangeError when {@link MatchPages.releaseFacts} has a key that is not a track ID.
 */
export function matchTrack(
  source: MatchSource,
  pages: MatchPages,
  options: MatchOptions = {},
): MatchResult {
  const thresholds = resolveMatchThresholds(options.thresholds)
  const mode: CatalogMode = isCatalogMode(options.mode) ? options.mode : 'music'
  const prepared = prepareSource(sourceSide(source))
  const sourceMs = prepared.side.durationMs
  const gate = runIsrcGate(source, prepared, pages, thresholds)
  const facts = factsByKey(pages)
  const sourceYear = yearOf(source.releaseDate)
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
        albumLevel: albumMatchLevel(source.album?.name, track.album?.name, prepared.side.artists),
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
  const isrc = checkOwnIsrcs(candidates, gate.check, { source, prepared }, thresholds)

  candidates.sort(compareScored)
  const best =
    candidates.find(
      (c) => c.track.kind === 'song' && (c.verified || atLeast(c.score, thresholds.suggest)),
    ) ?? candidates[0]
  const ordered = best ? [best, ...candidates.filter((c) => c !== best)] : []
  const ranked: Ranked = { source, sourceMs, thresholds, candidates: ordered }

  // The blockers without the setting: the verdict on the best.
  const blockers: AutoBlocker[] = []
  if (sourceMs === undefined) blockers.push('no-duration')
  let margin: number | undefined
  let eligibleBand: MatchBand = 'none'
  if (best === undefined) {
    blockers.push('no-candidates')
  } else {
    const rival = ordered.find(
      (c) => c !== best && !(lookAlike(best, c) && closeDurations(best, c, sourceMs, thresholds)),
    )
    margin = round(best.score - (rival?.score ?? 0))
    if (!best.verified) {
      if (!atLeast(best.score, thresholds.auto)) blockers.push('low-score')
      if (!atLeast(best.breakdown.title, thresholds.autoTitle)) blockers.push('low-title')
      if (sourceMs !== undefined && !best.inWindow) blockers.push('duration-window')
      if (!atLeast(margin, thresholds.margin)) blockers.push('margin')
      if (best.track.kind !== 'song') blockers.push('not-song')
      if (best.breakdown.explicitMismatch) blockers.push('explicit-mismatch')
      const anchored = albumAnchor(best, ranked)
      if (isClassicalTitle(source.title) && !(anchored && atLeast(best.breakdown.artist, 1))) {
        blockers.push('classical')
      }
      const tied = anchored || best.yearCompare === 'match' || best.labelCompare === 'match'
      if (!tied && rivalsOf(best, ranked).length > 0) blockers.push('rivals')
      if (isrc.status === 'miss' && isrcTrust(source.isrcOrigin) === 'trusted') {
        blockers.push('isrc-miss')
      }
      if (best.yearCompare === 'conflict' || best.labelCompare === 'conflict') {
        blockers.push('release-conflict')
      }
      if (options.requireReleaseAgreement === true && !(anchored || best.yearCompare === 'match')) {
        blockers.push('release-agreement-required')
      }
    }
    if (blockers.length === 0) eligibleBand = 'auto'
    else if (best.verified || atLeast(best.score, thresholds.suggest)) eligibleBand = 'suggest'
  }

  const autoOn = options.auto === true
  const band: MatchBand = eligibleBand === 'auto' && !autoOn ? 'suggest' : eligibleBand
  const autoBlockers: AutoBlocker[] = autoOn ? blockers : ['setting-off', ...blockers]
  const evidence: string[] = [`isrc ${isrc.status}`]
  if (best !== undefined && margin !== undefined) {
    evidence.push(`best score ${round(best.score).toFixed(2)}`, `margin ${margin.toFixed(2)}`)
  }
  evidence.push(`band ${band}`, ...autoBlockers.map((blocker) => `blocked: ${blocker}`))

  const verdict: MatchVerdict = {
    band: eligibleBand,
    blockers: [...blockers],
    matcherVersion: MATCHER_VERSION,
  }
  const audio = ordered.map((candidate) =>
    toAudioCandidate(candidate, isrc, candidate === best ? verdict : undefined),
  )
  const result: MatchResult = {
    band,
    autoEligible: eligibleBand === 'auto',
    candidates: audio,
    isrc,
    autoBlockers,
    evidence,
    matcherVersion: MATCHER_VERSION,
    incomplete: (pages.skipped?.length ?? 0) > 0,
  }
  if (audio[0] !== undefined) result.best = audio[0]
  if (margin !== undefined) result.margin = margin
  return result
}
