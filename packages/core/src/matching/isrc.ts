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
import { isClassicalTitle } from './prepare'
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
  resolveMatchThresholds,
} from './types'

/** Similarities this close to 1 are 1: shares of credits are exact fractions. */
const EPSILON = 1e-9

/** The duration window: max(5 s, 2 % of the source's duration). */
export function durationWindowMs(
  sourceMs: number,
  thresholds: Pick<MatchThresholds, 'windowMs' | 'windowRatio'>,
): number {
  return Math.max(thresholds.windowMs, thresholds.windowRatio * sourceMs)
}

/**
 * How far the engine trusts the source's ISRC, by its origin:
 *
 * - `trusted` (`catalog`, `musicbrainz-exact`, or no origin): a pass verifies, a miss caps
 * - `one-of-several` (`musicbrainz-exact-several`): a pass verifies, a miss caps nothing
 * - `hint` (`musicbrainz-fuzzy`, and any value that is not an `IsrcOrigin`): a pass is a hint
 */
export type IsrcTrust = 'trusted' | 'one-of-several' | 'hint'

/** The {@link IsrcTrust} of an origin. Anything unknown is a hint: it fails closed. */
export function isrcTrust(origin: unknown): IsrcTrust {
  if (origin === undefined || origin === 'catalog' || origin === 'musicbrainz-exact') {
    return 'trusted'
  }
  return origin === 'musicbrainz-exact-several' ? 'one-of-several' : 'hint'
}

/** One item's checks. */
export interface ItemCheck {
  /** Every check it failed; empty when it passed. */
  reasons: IsrcRejection[]
  /** How it compares with the source. */
  breakdown: ScoreBreakdown
}

/**
 * Checks one item for the ISRC gate. It passes only if all of these hold:
 *
 * - it is a song (`ATV`)
 * - its artist similarity is at least 0.5; for a classical-looking title, every source credit
 *   is found (Spotify credits the composer, so another performer's recording of the work shares
 *   half the credits)
 * - its duration is within max(5 s, 2 %) of the source's (skipped in no-duration mode; an item
 *   without a duration fails)
 * - no strong version tag differs (live, remix, cover, Taylor's Version, …)
 * - its explicit mark agrees with the source's, when the source's is known
 * - it names no featured artist the source does not credit (a duet or remix version), unless it
 *   is item #1 of a songs search, or a candidate whose own ISRC is the source's, on the source's
 *   very album: release pages list sidemen as featured artists ("So What (feat. John Coltrane,
 *   Cannonball Adderley & Bill Evans)" on "Kind Of Blue (Legacy Edition)")
 * - its title similarity is at least 0.8, except for item #1 of a songs search, or a candidate
 *   whose own ISRC is the source's, when the two titles are in different scripts ("Idol" and
 *   "アイドル")
 */
export function checkIsrcItem(
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
  const allCredits = isClassicalTitle(source.side.title)
  if (
    !(breakdown.artist >= thresholds.isrcArtist) ||
    (allCredits && !(breakdown.artist >= 1 - EPSILON))
  ) {
    reasons.push('artist')
  }
  const sourceMs = source.side.durationMs
  if (sourceMs !== undefined) {
    const delta = breakdown.deltaMs
    // Fails closed: a missing or non-finite difference never passes.
    if (!(delta !== undefined && Math.abs(delta) <= durationWindowMs(sourceMs, thresholds))) {
      reasons.push('duration')
    }
  }
  if (breakdown.strongMismatch) reasons.push('version')
  if (breakdown.explicitMismatch) reasons.push('explicit')
  const firstPlace = (place.page === 'songs' && place.position === 1) || place.page === 'own-isrc'
  if (
    breakdown.uncreditedFeatured.length > 0 &&
    !(firstPlace && albumMatchLevel(source.side.album, item.album?.name) === 'exact')
  ) {
    reasons.push('featured')
  }
  const crossScript = firstPlace && inDifferentScripts(source.title.core, prepared.core)
  if (!(breakdown.title >= thresholds.isrcTitle) && !crossScript) reasons.push('title')
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
  const hint = isrcTrust(source.isrcOrigin) === 'hint'
  const songs = pages.isrcSongs ?? []
  if (songs.length === 0 && pages.isrcTopCard === undefined) {
    return { check: { status: 'not-run', isrc, ...base } }
  }

  const check: IsrcCheck = { status: hint ? 'hint-miss' : 'miss', isrc, ...base }
  const accept = (track: Track, place: IsrcPlace): IsrcGateResult => {
    check.status = hint ? 'hint' : 'verified'
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
      const { reasons } = checkIsrcItem(prepared, track, place, thresholds)
      if (reasons.length === 0) {
        const level = albumMatchLevel(source.album?.name, track.album?.name, prepared.side.artists)
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
 * See {@link checkIsrcItem} for the checks: a song, the artist, the duration window, the
 * version, the explicit mark, no uncredited featured artist, and a title similarity of at least
 * 0.8 (stricter than §12's 0.5, see `MatchThresholds.isrcTitle`), which item #1 of a songs
 * search may miss when the titles are in different scripts ("Idol" and "アイドル").
 *
 * A pass is ISRC-verified unless the ISRC is a hint (`musicbrainz-fuzzy`, or an origin that is
 * not an `IsrcOrigin`). A miss caps the match at `suggest` for a `catalog` or
 * `musicbrainz-exact` ISRC (see `IsrcStatus`). Without ISRC pages the gate is `not-run`.
 * `matchTrack` runs it too, and also checks candidates whose own ISRC is the source's.
 */
export function checkIsrc(
  source: MatchSource,
  pages: MatchPages,
  options: MatchOptions = {},
): IsrcGateResult {
  const thresholds = resolveMatchThresholds(options.thresholds)
  return runIsrcGate(source, prepareSource(sourceSide(source)), pages, thresholds)
}
