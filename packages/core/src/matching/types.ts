/**
 * Types of the matching engine: what it reads (the track to match and the pages a provider
 * fetched), how it is tuned, and what it decides.
 *
 * @module
 */

import type { EntityId } from '../ids'
import type { CatalogMode } from '../mode'
import type { AlbumRef, AlbumType, ArtistRef, Track } from '../model'
import type { AudioCandidate } from '../providers'

/**
 * What the app does with the best candidate:
 *
 * - `auto`: plays it without asking. Only when the Auto setting is on (see
 *   {@link MatchOptions.auto})
 * - `suggest`: plays it only after an explicit user action, with "Not the right version?" and
 *   the ranked alternatives. Queues skip it and mark it "needs review"; imports send it to the
 *   review list
 * - `none`: does not play it; shows the alternatives and a manual search
 */
export type MatchBand = 'auto' | 'suggest' | 'none'

/** Every {@link MatchBand}, from the most to the least confident. */
export const MATCH_BANDS = ['auto', 'suggest', 'none'] as const satisfies readonly MatchBand[]

/** Whether `value` is a {@link MatchBand}, e.g. to validate a cached match read from storage. */
export function isMatchBand(value: unknown): value is MatchBand {
  return typeof value === 'string' && (MATCH_BANDS as readonly string[]).includes(value)
}

/**
 * Where the source's ISRC came from, which decides how far the engine trusts it:
 *
 * - `catalog`: the source's own metadata, e.g. Spotify's `metadata/4` or an Exportify-style CSV
 * - `musicbrainz-exact`: MusicBrainz found the recording through the Spotify track's URL
 *   relationship. Trusted like `catalog`
 * - `musicbrainz-fuzzy`: a MusicBrainz recording search by title and artist. Score-100 ties put
 *   live, compilation and soundtrack versions first, so this ISRC is only a hint for ranking: a
 *   hit is never ISRC-verified, and a miss caps nothing
 */
export type IsrcOrigin = 'catalog' | 'musicbrainz-exact' | 'musicbrainz-fuzzy'

/**
 * The track to find audio for, as the engine reads it. Every {@link Track} is one, so a Spotify
 * track can be passed as it is; imports and providers add what the track type lacks.
 */
export interface MatchSource {
  /** Title as the source shows it, e.g. "Hotel California - 2013 Remaster". */
  title: string
  /** Credited artists, main artist first. */
  artists: readonly ArtistRef[]
  /** The album the source lists the track on. */
  album?: AlbumRef
  /**
   * Duration in milliseconds. Without it the engine runs in no-duration mode: it drops the
   * duration term and never goes beyond `suggest` (Spotify's "Download your data" rows).
   */
  durationMs?: number
  /** The ISRC, in any spelling `normalizeIsrc` accepts. */
  isrc?: string
  /** Where {@link isrc} came from. `catalog` when absent. */
  isrcOrigin?: IsrcOrigin
  /** Whether the source marks the track explicit. */
  explicit?: boolean
  /** Release date of the source's album as ISO 8601, possibly partial, e.g. `2016-02-26`. */
  releaseDate?: string
  /** The record label of the source's release, e.g. "Rhino/Warner Records". */
  label?: string
  /** The source album's release type. A `single` gets no second search with the album. */
  albumType?: AlbumType
}

/**
 * What a candidate's YouTube description says about its release, from the lines YouTube
 * generates for label uploads ("Provided to YouTube by …", "℗ 2019 …", "Released on: …").
 * Providers fetch descriptions for the top two candidates only, and only when the source has a
 * label or a release date; `parseReleaseDescription` reads them.
 */
export interface ReleaseFacts {
  /** The label on the ℗ line, e.g. "ABKCO Music & Records, Inc.". */
  label?: string
  /** Who delivered the release, from "Provided to YouTube by …", e.g. "The Orchard Enterprises". */
  providedBy?: string
  /** The year the release came out ("Released on: …"), else the ℗ year. */
  releaseYear?: number
}

/**
 * The search pages a provider fetched for one source track, in YouTube Music's terms. Every
 * page is a list of tracks in page order, as the YouTube provider returns them (kind from
 * `musicVideoType`, the album with its browse ID, the duration). `nextMatchRequest` says which
 * page to fetch next, and `addMatchResponse` files the answer here.
 */
export interface MatchPages {
  /**
   * The songs search with the ISRC as the query: the first attempt, then the retry. Only the
   * top five items of each are checked.
   */
  isrcSongs?: readonly (readonly Track[])[]
  /**
   * The top-result card of an unfiltered search for the ISRC: the card's track, or `null` when
   * the page had none. Absent when it was not fetched.
   */
  isrcTopCard?: Track | null
  /** The songs search for all artists plus the title. */
  text?: readonly Track[]
  /** The second songs search, with the album added. */
  album?: readonly Track[]
  /** Music + Video mode only: the YouTube Music search with the videos filter. */
  videos?: readonly Track[]
  /** Music + Video mode only: a regular YouTube search ("artists - title"). */
  youtube?: readonly Track[]
  /** What candidates' descriptions say about their releases, keyed by the candidate's track ID. */
  releaseFacts?: Readonly<Record<string, ReleaseFacts>>
}

/** The thresholds the engine decides with. 1.12 tunes them on its calibration split. */
export interface MatchThresholds {
  /** The lowest score that may play without asking. */
  auto: number
  /**
   * The lowest title similarity that may play without asking (unless ISRC-verified). A safety
   * margin on top of the score: another song by the same artist whose title is partly the same
   * ("Twist It Up" for "The Twist"), at the same length, still scores above 0.80.
   */
  autoTitle: number
  /** The lowest score worth suggesting; below it the band is `none`. */
  suggest: number
  /** How far the best must lead the best candidate that is not the same version. */
  margin: number
  /** The duration window is the larger of this, in milliseconds… */
  windowMs: number
  /** …and this share of the source's duration. */
  windowRatio: number
  /** The ISRC gate's lowest artist similarity. */
  isrcArtist: number
  /**
   * The ISRC gate's lowest title similarity. ARCHITECTURE.md §12 names 0.5 as the floor; the
   * default is 0.8, because another song by the same artist whose title is partly the same
   * ("Twist It Up" for "The Twist") at the same length scores about 0.53, while every ISRC hit
   * measured on 2026-10-25 scored 1.00 or was in another script (which item #1 may be).
   */
  isrcTitle: number
  /** How many items of each ISRC songs search the gate checks. */
  isrcTopItems: number
  /** Official video → song: the lowest title similarity. */
  videoTitle: number
  /** Official video → song: the lowest artist similarity. */
  videoArtist: number
  /** Official video → song: how much longer than the video the song may be, in milliseconds. */
  videoSlackMs: number
}

/** The thresholds measured on 2026-10-25 (ARCHITECTURE.md §12). */
export const DEFAULT_MATCH_THRESHOLDS: Readonly<MatchThresholds> = Object.freeze({
  auto: 0.8,
  autoTitle: 0.8,
  suggest: 0.6,
  margin: 0.05,
  windowMs: 5000,
  windowRatio: 0.02,
  isrcArtist: 0.5,
  isrcTitle: 0.8,
  isrcTopItems: 5,
  videoTitle: 0.8,
  videoArtist: 0.5,
  videoSlackMs: 5000,
})

/** How a match runs. */
export interface MatchOptions {
  /**
   * The Auto setting: whether a match may reach the `auto` band at all. Off unless the app turns
   * it on, which it does only once stage 1.12's held-out report passes.
   */
  auto?: boolean
  /**
   * The catalog mode. In `music` (the default) only songs are candidates; in `all`, videos are
   * too, but never reach `auto`.
   */
  mode?: CatalogMode
  /**
   * The re-recording guard's measured fallback (trigger 4): a match that is not ISRC-verified
   * reaches `auto` only when it agrees with the source's album or release year. Off by default;
   * 1.12 turns it on if it still finds wrong Auto plays from text alone.
   */
  requireReleaseAgreement?: boolean
  /** Overrides for {@link DEFAULT_MATCH_THRESHOLDS}. */
  thresholds?: Partial<MatchThresholds>
}

/**
 * What the ISRC gate concluded:
 *
 * - `verified`: an item passed every check; it is the match
 * - `miss`: the gate ran and nothing passed. With a trusted ISRC this caps the match at
 *   `suggest`: YouTube Music probably lacks that master (Spotify Singles, compilation-only ISRCs)
 * - `hint`: a fuzzy ISRC's item passed; it is preferred among equals but proves nothing
 * - `hint-miss`: a fuzzy ISRC's search found nothing that passes; nothing follows from it
 * - `not-run`: the source has an ISRC but no ISRC page was fetched
 * - `no-isrc`: the source has no valid ISRC
 */
export type IsrcStatus = 'verified' | 'miss' | 'hint' | 'hint-miss' | 'not-run' | 'no-isrc'

/** Why the ISRC gate turned an item down. */
export type IsrcRejection = 'not-song' | 'artist' | 'duration' | 'version' | 'title'

/** Where the ISRC gate found an item. */
export interface IsrcPlace {
  /** The songs search or the unfiltered search's top-result card. */
  page: 'songs' | 'top-card'
  /** Which songs search, from 1 (the card counts as attempt 1). */
  attempt: number
  /** The item's position on its page, from 1. */
  position: number
}

/** One item the ISRC gate checked and turned down. */
export interface IsrcRejectedItem extends IsrcPlace {
  /** The item's track ID. */
  trackId: string
  /** Every check it failed. */
  reasons: IsrcRejection[]
}

/** The ISRC gate's outcome. */
export interface IsrcCheck {
  /** What it concluded. */
  status: IsrcStatus
  /** The canonical ISRC, when the source has a valid one. */
  isrc?: string
  /** The accepted item (`verified` or `hint`). */
  trackId?: EntityId<'track'>
  /** Where the accepted item was. */
  place?: IsrcPlace
  /** How many songs searches were checked. */
  attempts: number
  /** Whether the top-result card was checked. */
  checkedTopCard: boolean
  /** The items turned down, in the order they were checked. */
  rejected: IsrcRejectedItem[]
}

/**
 * Why the best candidate did not reach `auto`:
 *
 * - `setting-off`: the Auto setting is off
 * - `no-duration`: no-duration mode
 * - `low-score`: the score is below the Auto threshold
 * - `low-title`: the title similarity is below 0.8
 * - `duration-window`: the duration differs by more than the window, max(5 s, 2 %)
 * - `margin`: a candidate that is not the same version scores too close
 * - `not-song`: the candidate is a video; only official songs (`ATV`) reach `auto`
 * - `explicit-mismatch`: one side is explicit and the other clean
 * - `classical`: a classical-looking title without an album match
 * - `rivals`: re-recording guard 1, look-alikes from different releases and nothing that ties
 *   the best to the source's release
 * - `isrc-miss`: re-recording guard 2, the trusted ISRC never passed the gate
 * - `release-conflict`: re-recording guard 3, the candidate's label or release year contradicts
 *   the source's
 * - `release-agreement-required`: re-recording guard 4, the measured fallback is on and the
 *   candidate agrees with neither the source's album nor its year
 * - `no-candidates`: nothing to choose from
 */
export type AutoBlocker =
  | 'setting-off'
  | 'no-duration'
  | 'low-score'
  | 'low-title'
  | 'duration-window'
  | 'margin'
  | 'not-song'
  | 'explicit-mismatch'
  | 'classical'
  | 'rivals'
  | 'isrc-miss'
  | 'release-conflict'
  | 'release-agreement-required'
  | 'no-candidates'

/** The engine's decision for one source track. */
export interface MatchResult {
  /** What to do with {@link best}. */
  band: MatchBand
  /** The best candidate; absent when there were none. */
  best?: AudioCandidate
  /**
   * Every candidate, best first, with its `confidence` (the score), `evidence` and `signals`.
   * The alternatives for "Not the right version?".
   */
  candidates: AudioCandidate[]
  /** The ISRC gate's outcome. */
  isrc: IsrcCheck
  /** Why the best did not reach `auto`; empty when it did. */
  autoBlockers: AutoBlocker[]
  /** How far the best leads the best candidate that is not the same version, when there is one. */
  margin?: number
  /** Why, for people: the gate, the band and what blocked Auto. */
  evidence: string[]
}

/** The song an official music video maps to in Music mode. */
export interface VideoSongMatch {
  /** `auto` for a song link (and for a match when the Auto setting is on), else as decided. */
  band: MatchBand
  /** A song link from the video's source, a match by the rules, or none. */
  via: 'link' | 'match' | 'none'
  /** The song's track ID. */
  songId?: EntityId<'track'>
  /** The matched song as a candidate (absent for a link, which needs no scoring). */
  best?: AudioCandidate
  /** The songs that passed every rule, best first. */
  candidates: AudioCandidate[]
  /** Why, for people. */
  evidence: string[]
}

/** The thresholds of a match: the defaults with the options' overrides. */
export function resolveThresholds(options: MatchOptions = {}): MatchThresholds {
  return { ...DEFAULT_MATCH_THRESHOLDS, ...options.thresholds }
}
