/**
 * Every place where recommendations meet another stage's code. Each is an interface, or a core
 * type, with a default here and a fake in `@fxm/sources/recommend/testing`, so the collector works
 * and is tested on its own. The app passes the real implementations to
 * `createRecommendationCollector` or `createArtworkFiller` (the README's "Wiring" section shows
 * each one with the merged stages' APIs).
 *
 * | Touch-point | Stage | Here |
 * |---|---|---|
 * | YouTube Music radio and home | 1.3 | {@link YouTubeRadio} |
 * | Classifying a YouTube video (song, official video, upload) | 1.3 | {@link YouTubeLookup} |
 * | A YouTube seed for a seed from another source | 1.3, 1.7 | {@link YouTubeSeedFinder} |
 * | Spotify radio, home, related artists and artist search | 1.5 | {@link SpotifyRadio}, {@link SpotifyMetadata} |
 * | The user's Spotify switch | 1.5 (`isAvailable`), settings | {@link SpotifySwitch} |
 * | The request budget's room and priority for classifying station items | 1.2 | {@link ClassificationBudget} |
 * | The video-to-song rule for official videos | 1.7 | {@link SongForVideo} |
 * | The user's Auto setting for matches | 1.7, settings | {@link AutoMatchSetting} |
 * | MusicBrainz IDs for artists and releases | 1.6 | {@link ArtistMbidLookup}, {@link ReleaseMbidLookup} |
 *
 * Last.fm stations need the Full tier: the station reader's own `reachable` option is that
 * check, which the collector asks too (see `createLastfmStations`).
 *
 * @module
 */

import type {
  ArtistRef,
  MatchVerdict,
  MetadataProvider,
  ProviderContext,
  RadioSeed,
  RecommendationProvider,
  Track,
} from '@fxm/core'
import type { RecommendationSeed } from './types'

/**
 * YouTube Music's radio (`next` with `RDAMVM<videoId>`) and home feed: the YouTube Music
 * provider of stage 1.3 (`createYouTubeProviders().music`), as a core `RecommendationProvider`
 * with the ID `ytm`. Every InnerTube call it makes draws on the request budget through
 * `ctx.fetch`. Its radio starts only from a track with a YouTube ID (its own, or
 * `externalIds.ytm`) or an artist with a YouTube channel ID; see {@link YouTubeSeedFinder}.
 */
export type YouTubeRadio = RecommendationProvider

/**
 * One YouTube video's details, to classify a Last.fm station item before it is queued in Music
 * mode: the YouTube Music provider of stage 1.3 (`getTrack` on `ytm:track:<videoId>`, which
 * returns its `kind` from `musicVideoType`). **Cost:** one InnerTube call from the request
 * budget per call; the collector counts each against its classification allowance.
 */
export type YouTubeLookup = Pick<MetadataProvider, 'getTrack'>

/**
 * A seed YouTube Music radio can start from, for a seed that has no YouTube ID: for a track,
 * its YouTube Music song (the matching engine's `matchTrack` over a YouTube Music search, or the
 * match cache); for an artist, its YouTube Music artist (an artist search whose top result has
 * the same name). `null` when there is none. Answer for a track only with a match the engine is
 * sure of: a guess may be another song, whose radio has nothing to do with the seed. The
 * collector checks that the answer is a track with a YouTube ID (a song, in Music mode) or an
 * artist with a YouTube channel ID, that a track's answer is a track by its main artist with its
 * title and version, and that the radio follows the track (see `RecommendationCollector`), and
 * skips YouTube Music radio otherwise. **Cost:** whatever the app's implementation calls,
 * typically one InnerTube search from the request budget.
 */
export type YouTubeSeedFinder = (
  seed: RecommendationSeed,
  ctx: ProviderContext,
) => Promise<RadioSeed | null>

/**
 * The Spotify provider's own answer to "may FXM use Spotify now": its switch and whether the
 * platform can reach Spotify (stage 1.5's `SpotifyProvider.isAvailable`).
 */
export interface SpotifyAvailability {
  /** Whether Spotify is switched on and reachable. */
  isAvailable(ctx: Pick<ProviderContext, 'capabilities'>): boolean
}

/**
 * Spotify's radio and home feed: the Spotify provider of stage 1.5. When it has `isAvailable`,
 * as the real provider does, the collector follows its switch unless `spotifyEnabled` is given.
 */
export type SpotifyRadio = RecommendationProvider & Partial<SpotifyAvailability>

/**
 * Spotify's related artists (`queryArtistRelated`) and artist search, to find the Spotify artist
 * of a seed from another source: the Spotify provider of stage 1.5.
 */
export type SpotifyMetadata = Pick<MetadataProvider, 'search' | 'getRelatedArtists'> &
  Partial<SpotifyAvailability>

/**
 * Whether the user's Spotify switch is on. The default is the Spotify provider's own
 * `isAvailable(ctx)` (its `isEnabled` option is the one place the setting lives), else on.
 * Reachability (`capabilities.spotify`) is checked separately, so that the outcome can say which
 * one stopped Spotify.
 */
export type SpotifySwitch = (ctx: ProviderContext) => boolean

/** A switch that is always on, for an app without a Spotify setting. */
export const SPOTIFY_ON: SpotifySwitch = () => true

/**
 * The request budget's say in classifying Last.fm station items, each with one or more InnerTube
 * calls (stage 1.2's budget): how many calls fit now, and which priority they draw at.
 */
export interface ClassificationBudget {
  /**
   * How many InnerTube calls classification may make now without eating into what playback and
   * the user's own browsing need, e.g. the budget's `snapshot().remaining` minus the reserve
   * above the priority classification draws at. 0 when it is short; a value that is not a number
   * counts as 0. The collector never makes more than its own `maxClassifications` either.
   */
  allowance(ctx: ProviderContext): number
  /**
   * The provider context for classification calls, e.g. one whose YouTube calls draw at
   * `prefetch` rather than at the priority radio was asked at:
   * `(ctx) => platform.context({ mode: ctx.mode, priority: 'prefetch' })`. The collector keeps
   * the caller's catalog mode and cancellation signal on it. Default: the caller's context.
   */
  context?(ctx: ProviderContext): ProviderContext
}

/**
 * The default: no limit of its own, and the caller's context. The collector's
 * `maxClassifications` and the platform budget's refusals bound the calls.
 */
export const UNLIMITED_CLASSIFICATION_BUDGET: ClassificationBudget = {
  allowance: () => Number.POSITIVE_INFINITY,
}

/** The song of an official music video, as the video-to-song rule found it. */
export interface VideoSong {
  /** The song. */
  song: Track
  /** A song link from the video's source (no guess), or a match by the matching engine. */
  via: 'link' | 'match'
  /**
   * The engine's verdict on a `match` (stage 1.7's `VideoSongMatch.best.verdict`). A `match`
   * without one is `suggest`, and never plays unasked.
   */
  verdict?: MatchVerdict
}

/**
 * The matching engine's video-to-song rule (stage 1.7's `matchVideoToSong`, over a YouTube Music
 * songs search for `videoSongsQuery(video)`): the song of an official music video, with how it
 * was found and the engine's verdict, or `null` when it maps to none (band `none`).
 *
 * A `suggest` match may be returned: the collector only seeds YouTube Music radio with it. It
 * queues a song as a candidate only when it is a link, or a match whose verdict is `auto` under
 * the user's Auto setting ({@link AutoMatchSetting}), and keeps the verdict on the candidate so
 * that the player checks it again at play time. Never return a `suggest` or `none` song as if
 * it were a link. **Cost:** one YouTube Music songs search (an InnerTube call) per call. The
 * collector counts each call it makes for a station against its classification allowance; the
 * one call for an official video seeding YouTube Music radio is not counted.
 */
export type SongForVideo = (video: Track, ctx: ProviderContext) => Promise<VideoSong | null>

/** Whether the user's Auto setting lets matches play without asking (stage 1.7's `auto`). */
export type AutoMatchSetting = (ctx: ProviderContext) => boolean

/** The default {@link AutoMatchSetting}: off, so that no guess plays unasked. */
export const AUTO_MATCH_OFF: AutoMatchSetting = () => false

/**
 * An artist's MusicBrainz ID, or `null` (stage 1.6 has no artist search yet). ListenBrainz needs
 * it for an artist seed without one; for a track, the collector finds it through ListenBrainz's
 * own lookup. Return it in its canonical form, a lower-case UUID; the collector normalizes it
 * anyway, and ListenBrainz refuses anything that is not an MBID.
 */
export type ArtistMbidLookup = (artist: ArtistRef, ctx: ProviderContext) => Promise<string | null>

/**
 * The MusicBrainz release of a track, or `null`: e.g. from MusicBrainz (stage 1.6), the release
 * among a `searchRecordings` hit's `releases` that is the track's album. The artwork filler
 * trusts it as the track's own release and tries it before ListenBrainz's lookup. Return it in
 * its canonical form, a lower-case UUID; the Cover Art Archive client refuses anything that is
 * not an MBID.
 */
export type ReleaseMbidLookup = (track: Track, ctx: ProviderContext) => Promise<string | null>
