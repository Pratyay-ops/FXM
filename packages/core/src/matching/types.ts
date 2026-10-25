/**
 * Types of the matching engine: what it reads (the track to match and the pages a provider
 * fetched), how it is tuned, and what it decides. Also the guards for options and verdicts read
 * from storage.
 *
 * @module
 */

import type { EntityId, SourceId } from '../ids'
import { type CatalogMode, isCatalogMode } from '../mode'
import type { AlbumRef, AlbumType, ArtistRef, Track } from '../model'
import type { AudioCandidate } from '../providers'

/**
 * The version of the engine's rules, bumped whenever the scoring, a guard or a default threshold
 * changes. Every decision carries it ({@link MatchResult.matcherVersion}, {@link MatchVerdict}),
 * so a match cache can drop what an older engine decided, and {@link effectiveMatchBand} never
 * lets such a stale `auto` play without asking.
 */
export const MATCHER_VERSION = 1

/**
 * What the app does with the best candidate:
 *
 * - `auto`: plays it without asking. Only when the Auto setting is on (see
 *   {@link MatchOptions.auto} and {@link effectiveMatchBand})
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
 * - `catalog`: the source's own metadata, e.g. Spotify's `metadata/4` or an Exportify-style CSV.
 *   A pass of the ISRC gate makes the match ISRC-verified; a miss caps it at `suggest`
 * - `musicbrainz-exact`: MusicBrainz found the recording through the Spotify track's URL
 *   relationship, and the recording has this one ISRC. Trusted like `catalog`
 * - `musicbrainz-exact-several`: the same, but the recording lists several ISRCs and nothing says
 *   which one the source uses; the caller passes one. A pass is ISRC-verified, but a miss caps
 *   nothing, since YouTube Music may index the recording under another of them
 * - `musicbrainz-fuzzy`: a MusicBrainz recording search by title and artist. Score-100 ties put
 *   live, compilation and soundtrack versions first, so this ISRC is only a hint for ranking: a
 *   pass is never ISRC-verified, and a miss caps nothing
 *
 * Stage 1.6's MusicBrainz helpers map onto it: `{ kind: 'exact', isrcs: [one] }` is
 * `musicbrainz-exact`, `{ kind: 'exact', isrcs: [first, …more] }` is `musicbrainz-exact-several`
 * with the first, and `{ kind: 'hint' }` is `musicbrainz-fuzzy`.
 */
export type IsrcOrigin =
  | 'catalog'
  | 'musicbrainz-exact'
  | 'musicbrainz-exact-several'
  | 'musicbrainz-fuzzy'

/** Every {@link IsrcOrigin}. */
const ISRC_ORIGINS = [
  'catalog',
  'musicbrainz-exact',
  'musicbrainz-exact-several',
  'musicbrainz-fuzzy',
] as const satisfies readonly IsrcOrigin[]

/**
 * Whether `value` is an {@link IsrcOrigin}, e.g. to validate an import row read back from
 * storage. The engine itself treats any other origin as a hint, never as trusted.
 */
export function isIsrcOrigin(value: unknown): value is IsrcOrigin {
  return typeof value === 'string' && (ISRC_ORIGINS as readonly string[]).includes(value)
}

/**
 * The track to find audio for, as the engine reads it. Every {@link Track} is one, so a Spotify
 * track can be passed as it is; imports and providers add what the track type lacks (see
 * {@link MatchSourceExtras}).
 */
export interface MatchSource {
  /** Title as the source shows it, e.g. "Hotel California - 2013 Remaster". */
  title: string
  /** Credited artists, main artist first. */
  artists: readonly ArtistRef[]
  /** The album the source lists the track on. */
  album?: AlbumRef
  /**
   * Duration in milliseconds. Anything but a finite number above 0 (`NaN`, `0`, a negative
   * number) counts as absent. Without it the engine runs in no-duration mode: it drops the
   * duration term and never goes beyond `suggest` (Spotify's "Download your data" rows).
   */
  durationMs?: number
  /**
   * The recording's ISRC, in any spelling `normalizeIsrc` accepts. It is trusted unless
   * {@link isrcOrigin} says otherwise: an ISRC that is only a guess must always come with its
   * origin, e.g. a MusicBrainz recording search's with `isrcOrigin: 'musicbrainz-fuzzy'`. Never
   * store such a guess in `Track.isrc`, which holds the catalog's own ISRC.
   */
  isrc?: string
  /** Where {@link isrc} came from; `catalog` when absent. Any other value counts as a hint. */
  isrcOrigin?: IsrcOrigin
  /** Whether the source marks the track explicit. Absent when unknown. */
  explicit?: boolean
  /** Release date of the source's album as ISO 8601, possibly partial, e.g. `2016-02-26`. */
  releaseDate?: string
  /** The record label of the source's release, e.g. "Rhino/Warner Records". */
  label?: string
  /** The source album's release type. A `single` gets no second search with the album. */
  albumType?: AlbumType
}

/**
 * What a {@link MatchSource} adds to a {@link Track}. `AudioSource.match` takes a track with these
 * fields, so an import or a provider that knows them (Spotify's label and album type, a
 * MusicBrainz ISRC's origin) passes them along, and a plain track still fits.
 */
export type MatchSourceExtras = Pick<MatchSource, 'label' | 'albumType' | 'isrcOrigin'>

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
 * A full track ID as a key, e.g. `ytm:track:dQw4w9WgXcQ`: what {@link MatchPages.releaseFacts}
 * is keyed by. A bare videoId does not fit, so TypeScript refuses it.
 */
export type ReleaseFactsKey = `${SourceId}:track:${string}`

/**
 * A page the engine needs, in YouTube Music's terms, as `nextMatchRequest` asks for it. The
 * provider answers each with a {@link MatchResponse} (or `null` when it cannot fetch the page).
 */
export type MatchRequest =
  /** A YouTube Music songs search with the ISRC as the query (`attempt` 2 is the retry). */
  | { kind: 'isrc-songs'; query: string; attempt: number }
  /** An unfiltered YouTube Music search for the ISRC; only its top-result card is read. */
  | { kind: 'isrc-top-card'; query: string }
  /** A YouTube Music songs search for all artists plus the title. */
  | { kind: 'text-songs'; query: string }
  /** The same with the album added. */
  | { kind: 'album-songs'; query: string }
  /**
   * The descriptions of these candidates (one `next` or `player` call each), for their label and
   * release year. Read them with `parseReleaseDescription`.
   */
  | { kind: 'release-facts'; trackIds: EntityId<'track'>[] }
  /** Music + Video mode: a YouTube Music search with the videos filter. */
  | { kind: 'videos'; query: string }
  /** Music + Video mode: a regular YouTube search. */
  | { kind: 'youtube'; query: string }

/** The kind of a {@link MatchRequest}. */
export type MatchRequestKind = MatchRequest['kind']

/** The answer to a {@link MatchRequest}, of the same kind. */
export type MatchResponse =
  | {
      kind: 'isrc-songs' | 'text-songs' | 'album-songs' | 'videos' | 'youtube'
      /** The page's items in order. */
      tracks: readonly Track[]
    }
  | {
      kind: 'isrc-top-card'
      /** The top-result card's track, or `null` when the page had none. */
      card: Track | null
    }
  | {
      kind: 'release-facts'
      /**
       * What each description says, keyed by the track ID the request listed. A track left out
       * counts as described with nothing to say.
       */
      facts: Readonly<Record<ReleaseFactsKey, ReleaseFacts>>
    }

/**
 * The search pages a provider fetched for one source track, in YouTube Music's terms. Every
 * page is a list of tracks in page order, as the YouTube provider returns them (kind from
 * `musicVideoType`, the album with its browse ID, the duration, `explicit: true` on songs with
 * the explicit badge). Other sources' tracks, e.g. from Internet Archive or Jamendo, go in
 * {@link text}. `nextMatchRequest` says which page to fetch next, and `addMatchResponse` files
 * the answer here.
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
  /**
   * What candidates' descriptions say about their releases, keyed by the candidate's full track
   * ID (`ytm:track:<videoId>`, as the request lists it). `matchTrack` refuses any other key with a
   * `RangeError`, since a dropped entry would silently turn a guard off. An empty entry means the
   * description was fetched, or skipped, and said nothing.
   */
  releaseFacts?: Readonly<Record<ReleaseFactsKey, ReleaseFacts>>
  /**
   * The requests the provider could not answer (`addMatchResponse` with `null`): a failed fetch,
   * or a request the budget refused. A match with any is `incomplete`.
   */
  skipped?: readonly MatchRequestKind[]
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
  /** The ISRC gate's lowest artist similarity (1 for classical-looking titles). */
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

/** How a match runs. Validate options read from storage with {@link sanitizeMatchOptions}. */
export interface MatchOptions {
  /**
   * The Auto setting: whether a match may reach the `auto` band at all. Off unless it is `true`
   * (a string such as `"false"` read from storage is off too), and the app turns it on only once
   * stage 1.12's held-out report passes. It changes `MatchResult.band` only: the verdict on the
   * best candidate ({@link MatchVerdict}) is the same either way, so a provider can leave it out
   * and the app apply it at play time with {@link effectiveMatchBand}.
   */
  auto?: boolean
  /**
   * The catalog mode. In `music` (the default, also for any unknown value) only songs are
   * candidates; in `all`, videos are too, but never reach `auto`.
   */
  mode?: CatalogMode
  /**
   * The re-recording guard's measured fallback (trigger 4): a match that is not ISRC-verified
   * reaches `auto` only when it agrees with the source's album or release year. Off unless it is
   * `true`; 1.12 turns it on if it still finds wrong Auto plays from text alone.
   */
  requireReleaseAgreement?: boolean
  /**
   * Overrides for {@link DEFAULT_MATCH_THRESHOLDS}. An override that is not a finite number in
   * range (0 to 1 for scores, similarities and ratios, at least 0 for milliseconds, a whole
   * number of at least 1 for `isrcTopItems`) is ignored, so the default applies.
   */
  thresholds?: Partial<MatchThresholds>
}

/** The thresholds an official video → song match reads. */
export type VideoMatchThresholds = Pick<
  MatchThresholds,
  | 'auto'
  | 'suggest'
  | 'margin'
  | 'windowMs'
  | 'windowRatio'
  | 'videoTitle'
  | 'videoArtist'
  | 'videoSlackMs'
>

/** How an official video → song match runs (`matchVideoToSong`). */
export interface VideoMatchOptions {
  /** The Auto setting, as in {@link MatchOptions.auto}. */
  auto?: boolean
  /**
   * Match by the rules even when the video links its song: for a linked song that turned out
   * not to be playable, which leaves the video `needs-song-match` (see `songForVideo`).
   */
  ignoreLink?: boolean
  /** Overrides for the thresholds it reads, validated as in {@link MatchOptions.thresholds}. */
  thresholds?: Partial<VideoMatchThresholds>
}

/**
 * What the ISRC gate concluded:
 *
 * - `verified`: an item passed every check; it is the match
 * - `miss`: the gate ran and nothing passed. With a `catalog` or `musicbrainz-exact` ISRC this
 *   caps the match at `suggest`: YouTube Music probably lacks that master (Spotify Singles,
 *   compilation-only ISRCs). One of several MusicBrainz ISRCs caps nothing
 * - `hint`: a fuzzy ISRC's item passed; it is preferred among equals but proves nothing
 * - `hint-miss`: a fuzzy ISRC's search found nothing that passes; nothing follows from it
 * - `not-run`: the source has an ISRC but no ISRC page was fetched, and no candidate carries it
 * - `no-isrc`: the source has no valid ISRC
 */
export type IsrcStatus = 'verified' | 'miss' | 'hint' | 'hint-miss' | 'not-run' | 'no-isrc'

/**
 * Why the ISRC gate turned an item down: not a song, the artist (for a classical-looking title,
 * any source credit missing), the duration, a strong version mismatch, one side explicit and the
 * other clean, a featured artist the source does not credit, or the title.
 */
export type IsrcRejection =
  | 'not-song'
  | 'artist'
  | 'duration'
  | 'version'
  | 'explicit'
  | 'featured'
  | 'title'

/** Where the ISRC gate found an item. */
export interface IsrcPlace {
  /**
   * The songs search, the unfiltered search's top-result card, or a candidate whose own ISRC is
   * the source's (`own-isrc`, e.g. an Internet Archive track with ISRC metadata).
   */
  page: 'songs' | 'top-card' | 'own-isrc'
  /** Which songs search, from 1 (the card counts as attempt 1, an own ISRC as 0). */
  attempt: number
  /** The item's position on its page, from 1 (for an own ISRC, among all candidates). */
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
 * - `explicit-mismatch`: one side is explicit and the other clean (a candidate without the
 *   explicit mark counts as clean)
 * - `classical`: a classical-looking title without a distinctive album match, or with a source
 *   credit (performer or composer) the candidate lacks
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

/**
 * The engine's verdict on the candidate it ranked first, which that candidate carries as
 * `AudioCandidate.verdict`. It leaves the user's Auto setting out, so a provider needs no
 * settings, and a cached match follows the setting as it changes: apply it at play time with
 * {@link effectiveMatchBand}. A cache stores the verdict as it is, never a band with the setting
 * already applied.
 */
export interface MatchVerdict {
  /**
   * The band with the Auto setting on: `auto` when every rule but the setting holds, else
   * `suggest` or `none`.
   */
  band: MatchBand
  /** Why it falls short of `auto`, the setting aside; empty when it does not. */
  blockers: AutoBlocker[]
  /** The {@link MATCHER_VERSION} that decided. */
  matcherVersion: number
}

/** The engine's decision for one source track. */
export interface MatchResult {
  /** What to do with {@link best}, with the Auto setting as {@link MatchOptions.auto} gives it. */
  band: MatchBand
  /**
   * Whether the best clears every rule but the Auto setting: with the setting on, `band` is
   * `auto` exactly when this is true. The same as `best.verdict.band === 'auto'`.
   */
  autoEligible: boolean
  /** The best candidate, carrying the {@link MatchVerdict}; absent when there were none. */
  best?: AudioCandidate
  /**
   * Every candidate, best first, with its `confidence` (the score), `evidence` and `signals`.
   * The alternatives for "Not the right version?".
   */
  candidates: AudioCandidate[]
  /** The ISRC gate's outcome. */
  isrc: IsrcCheck
  /** Why the best did not reach `auto`, `setting-off` included; empty when it did. */
  autoBlockers: AutoBlocker[]
  /** How far the best leads the best candidate that is not the same version, when there is one. */
  margin?: number
  /** Why, for people: the gate, the band and what blocked Auto. */
  evidence: string[]
  /** The {@link MATCHER_VERSION} that decided. */
  matcherVersion: number
  /**
   * Whether a page the plan asked for could not be fetched ({@link MatchPages.skipped}). Such a
   * result may be shown and played as decided, but a cache must not keep it as final.
   */
  incomplete: boolean
}

/** The song an official music video maps to in Music mode. */
export interface VideoSongMatch {
  /**
   * `auto` for a song link; for a match by the rules, as the bands decide with the Auto setting
   * as given. With `none`, Music mode hides the video.
   */
  band: MatchBand
  /** Whether a match clears every rule but the Auto setting (always true for a link). */
  autoEligible: boolean
  /** A song link from the video's source, a match by the rules, or none. */
  via: 'link' | 'match' | 'none'
  /** The song's track ID; absent when the band is `none`. */
  songId?: EntityId<'track'>
  /**
   * The matched song as a candidate, carrying the {@link MatchVerdict} (absent for a link, which
   * needs no scoring, and when the band is `none`).
   */
  best?: AudioCandidate
  /** The songs that passed every rule, best first. */
  candidates: AudioCandidate[]
  /** Why the match did not reach `auto`, `setting-off` included; empty when it did. */
  autoBlockers: AutoBlocker[]
  /** Why, for people. */
  evidence: string[]
  /** The {@link MATCHER_VERSION} that decided. */
  matcherVersion: number
}

/**
 * The band a match plays with under the user's Auto setting, at play time: a verdict of `auto`
 * plays without asking only while the setting is on (`autoOn` is `true`) and only when the
 * verdict comes from this {@link MATCHER_VERSION}; otherwise it is `suggest`. `suggest` and
 * `none` stay as they are. A missing or malformed verdict, e.g. from storage or from a candidate
 * no engine ranked, is `suggest`: only the engine's own verdict lets a match play unasked.
 */
export function effectiveMatchBand(verdict: MatchVerdict | undefined, autoOn: boolean): MatchBand {
  const record = asRecord(verdict)
  const band = record.band
  if (!isMatchBand(band)) return 'suggest'
  if (band !== 'auto') return band
  return autoOn === true && record.matcherVersion === MATCHER_VERSION ? 'auto' : 'suggest'
}

/** `value` itself when it is a non-null object, else an empty one. */
function asRecord(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

/** The thresholds that are shares or similarities, from 0 to 1. */
const RATIO_THRESHOLDS: ReadonlySet<keyof MatchThresholds> = new Set([
  'auto',
  'autoTitle',
  'suggest',
  'margin',
  'windowRatio',
  'isrcArtist',
  'isrcTitle',
  'videoTitle',
  'videoArtist',
])

/** Whether `value` is a usable value for the threshold `key`. */
function isThresholdValue(key: keyof MatchThresholds, value: unknown): value is number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return false
  if (key === 'isrcTopItems') return Number.isInteger(value) && value >= 1
  if (RATIO_THRESHOLDS.has(key)) return value >= 0 && value <= 1
  return value >= 0
}

/** The valid overrides among `value`, a {@link MatchThresholds} subset from anywhere. */
function thresholdOverrides(value: unknown): Partial<MatchThresholds> {
  const given = asRecord(value)
  const overrides: Partial<MatchThresholds> = {}
  for (const key of Object.keys(DEFAULT_MATCH_THRESHOLDS) as (keyof MatchThresholds)[]) {
    const candidate = Object.hasOwn(given, key) ? given[key] : undefined
    if (isThresholdValue(key, candidate)) overrides[key] = candidate
  }
  return overrides
}

/**
 * The thresholds of a match: {@link DEFAULT_MATCH_THRESHOLDS} with the valid overrides of
 * `thresholds` (see {@link MatchOptions.thresholds}); anything invalid keeps its default.
 */
export function resolveMatchThresholds(thresholds?: unknown): MatchThresholds {
  return { ...DEFAULT_MATCH_THRESHOLDS, ...thresholdOverrides(thresholds) }
}

/**
 * Valid {@link MatchOptions} from an untrusted value, such as settings read from storage or a
 * JSON config: `auto` and `requireReleaseAgreement` only when exactly `true`, `mode` only when it
 * is a catalog mode, and the thresholds that are finite and in range. Everything else is left
 * out, so the defaults apply. Never throws; the result is a fresh object.
 */
export function sanitizeMatchOptions(value: unknown): MatchOptions {
  const given = asRecord(value)
  const options: MatchOptions = {}
  if (given.auto === true) options.auto = true
  if (isCatalogMode(given.mode)) options.mode = given.mode
  if (given.requireReleaseAgreement === true) options.requireReleaseAgreement = true
  const thresholds = thresholdOverrides(given.thresholds)
  if (Object.keys(thresholds).length > 0) options.thresholds = thresholds
  return options
}
