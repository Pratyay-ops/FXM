/**
 * The ISRC gate: which item of a YouTube Music search for the source's ISRC is the source's
 * recording, if any. ISRCs are shared by unrelated tracks, a miss returns unrelated filler, and
 * a same-title cover or another song by the same artist can sit near the right length, so every
 * check must pass on an item.
 *
 * @module
 */

import { isEntityId, normalizeIsrc } from '../ids'
import type { Track } from '../model'
import { albumMatchLevel, albumMatchRank } from './release'
import {
  type PreparedSource,
  prepareCandidateTitle,
  prepareSource,
  type ScoreBreakdown,
  scoreCandidate,
  sourceSide,
  trackSide,
} from './score'
import { inDifferentScripts } from './similarity'
import {
  type IsrcCheck,
  type IsrcPlace,
  type IsrcRejectedItem,
  type IsrcRejection,
  type MatchOptions,
  type MatchPages,
  type MatchSource,
  type MatchThresholds,
  resolveThresholds,
} from './types'

/** The duration window: max(5 s, 2 % of the source's duration). */
export function durationWindowMs(sourceMs: number, thresholds: MatchThresholds): number {
  return Math.max(thresholds.windowMs, thresholds.windowRatio * sourceMs)
}

/** One item's checks. */
interface ItemCheck {
  reasons: IsrcRejection[]
  breakdown: ScoreBreakdown
}

/**
 * Checks one item of an ISRC search. It passes only if all of these hold:
 *
 * - it is a song (`ATV`)
 * - its artist similarity is at least 0.5
 * - its duration is within max(5 s, 2 %) of the source's (skipped in no-duration mode)
 * - no strong version family differs (live, remix, cover, Taylor's Version, …)
 * - its title similarity is at least 0.8, except for item #1 of a songs search when the two
 *   titles are in different scripts ("Idol" and "アイドル")
 */
function checkItem(
  source: PreparedSource,
  item: Track,
  place: IsrcPlace,
  thresholds: MatchThresholds,
): ItemCheck {
  const side = trackSide(item)
  const prepared = prepareCandidateTitle(source, side)
  const breakdown = scoreCandidate(source, side, prepared)
  const reasons: IsrcRejection[] = []
  if (item.kind !== 'song') reasons.push('not-song')
  if (breakdown.artist < thresholds.isrcArtist) reasons.push('artist')
  const sourceMs = source.side.durationMs
  if (
    sourceMs !== undefined &&
    (breakdown.deltaMs === undefined ||
      Math.abs(breakdown.deltaMs) > durationWindowMs(sourceMs, thresholds))
  ) {
    reasons.push('duration')
  }
  if (breakdown.strongMismatch) reasons.push('version')
  const crossScript =
    place.page === 'songs' &&
    place.position === 1 &&
    inDifferentScripts(source.title.core, prepared.core)
  if (breakdown.title < thresholds.isrcTitle && !crossScript) reasons.push('title')
  return { reasons, breakdown }
}

/** What the ISRC gate returns: the outcome, and the accepted item's track. */
export interface IsrcGateResult {
  /** The outcome, as reported in `MatchResult.isrc`. */
  check: IsrcCheck
  /** The accepted item (`verified` or `hint`). */
  accepted?: Track
}

/** {@link checkIsrc} with the source already prepared, as the engine runs it. */
export function runIsrcGate(
  source: MatchSource,
  prepared: PreparedSource,
  pages: MatchPages,
  thresholds: MatchThresholds,
): IsrcGateResult {
  const isrc = normalizeIsrc(source.isrc)
  const base = { attempts: 0, checkedTopCard: false, rejected: [] as IsrcRejectedItem[] }
  if (isrc === null) return { check: { status: 'no-isrc', ...base } }
  const fuzzy = source.isrcOrigin === 'musicbrainz-fuzzy'
  const songs = pages.isrcSongs ?? []
  if (songs.length === 0 && pages.isrcTopCard === undefined) {
    return { check: { status: 'not-run', isrc, ...base } }
  }

  const check: IsrcCheck = { status: fuzzy ? 'hint-miss' : 'miss', isrc, ...base }
  const accept = (track: Track, place: IsrcPlace): IsrcGateResult => {
    check.status = fuzzy ? 'hint' : 'verified'
    if (isEntityId(track.id, 'track')) check.trackId = track.id
    check.place = place
    return { check, accepted: track }
  }

  /** Checks a list of items; returns the best one that passes. */
  const checkItems = (
    items: readonly { track: Track; place: IsrcPlace }[],
  ): { track: Track; place: IsrcPlace } | undefined => {
    const passed: { track: Track; place: IsrcPlace; albumRank: number }[] = []
    for (const { track, place } of items) {
      const { reasons } = checkItem(prepared, track, place, thresholds)
      if (reasons.length === 0) {
        const level = albumMatchLevel(source.album?.name, track.album?.name)
        passed.push({ track, place, albumRank: albumMatchRank(level) })
      } else {
        check.rejected.push({ trackId: String(track.id), ...place, reasons })
      }
    }
    passed.sort((a, b) => b.albumRank - a.albumRank || a.place.position - b.place.position)
    return passed[0]
  }

  const songsItems = (attempt: number) =>
    (songs[attempt - 1] ?? []).slice(0, thresholds.isrcTopItems).map((track, i) => ({
      track,
      place: { page: 'songs' as const, attempt, position: i + 1 },
    }))

  if (songs.length > 0) {
    check.attempts = 1
    const found = checkItems(songsItems(1))
    if (found) return accept(found.track, found.place)
  }
  if (pages.isrcTopCard !== undefined) {
    check.checkedTopCard = true
    if (pages.isrcTopCard !== null) {
      const found = checkItems([
        { track: pages.isrcTopCard, place: { page: 'top-card', attempt: 1, position: 1 } },
      ])
      if (found) return accept(found.track, found.place)
    }
  }
  for (let attempt = 2; attempt <= songs.length; attempt++) {
    check.attempts = attempt
    const found = checkItems(songsItems(attempt))
    if (found) return accept(found.track, found.place)
  }
  return { check }
}

/**
 * Runs the ISRC gate over the pages a provider fetched, in the order it fetches them: the top
 * five items of the first songs search, then the top-result card of an unfiltered search, then
 * the retry's top five. The first place where an item passes every check wins; when several
 * items of one search pass, the one from the source's album is preferred, then the higher one.
 * An item passes only if it is a song (`ATV`), its artist similarity is at least 0.5, its
 * duration is within max(5 s, 2 %) of the source's, no strong version family differs, and its
 * title similarity is at least 0.8 (stricter than §12's 0.5, see `MatchThresholds.isrcTitle`),
 * except for item #1 of a songs search when the two titles are in different scripts ("Idol" and
 * "アイドル").
 *
 * A pass is ISRC-verified for a trusted ISRC (`catalog` or `musicbrainz-exact`), and only a
 * `hint` for a fuzzy one. A trusted ISRC that never passes is a `miss`, which caps the match at
 * `suggest`. Without ISRC pages the gate is `not-run`. `matchTrack` runs it too.
 */
export function checkIsrc(
  source: MatchSource,
  pages: MatchPages,
  options: MatchOptions = {},
): IsrcGateResult {
  return runIsrcGate(source, prepareSource(sourceSide(source)), pages, resolveThresholds(options))
}
