/**
 * Every place where recommendations meet a stage that was not merged when this module was
 * written. Each is an interface, or a core type, with a default here and a fake in
 * `@fxm/sources/recommend/testing`, so the collector works and is tested without them. When a
 * stage merges, the app passes its real implementation to `createRecommendationCollector` or
 * `createArtworkFiller` instead (the README's "Wiring" section lists each one).
 *
 * | Touch-point | Stage | Here |
 * |---|---|---|
 * | YouTube Music radio and home | 1.3 | {@link YouTubeRadio} |
 * | Classifying a YouTube video (song, official video, upload) | 1.3 | {@link YouTubeLookup} |
 * | Spotify radio, home, related artists and artist search | 1.5 | {@link SpotifyRadio}, {@link SpotifyMetadata} |
 * | The user's Spotify switch | 2.1, 3.5 (settings) | {@link SpotifySwitch} |
 * | The request budget's room for classifying station items | 1.2 | {@link ClassificationBudget} |
 * | The Full tier, for Last.fm stations | 1.2 | {@link TierCheck} |
 * | The video-to-song rule for official videos | 1.7 | {@link SongForVideo} |
 * | MusicBrainz IDs for artists and releases | 1.6 | {@link ArtistMbidLookup}, {@link ReleaseMbidLookup} |
 *
 * @module
 */

import type {
  ArtistRef,
  MetadataProvider,
  NetworkCapabilities,
  ProviderContext,
  RecommendationProvider,
  Track,
} from '@fxm/core'
import { lastfmStationsReachable } from '../lastfm/station'

/**
 * YouTube Music's radio (`next` with `RDAMVM<videoId>`) and home feed: the YouTube Music
 * provider of stage 1.3, as a core `RecommendationProvider` with the ID `ytm`. Every InnerTube
 * call it makes draws on the request budget through `ctx.fetch`.
 */
export type YouTubeRadio = RecommendationProvider

/**
 * One YouTube video's details, to classify a Last.fm station item before it is queued in Music
 * mode: the YouTube Music provider of stage 1.3 (`getTrack` on `ytm:track:<videoId>`, which
 * returns its `kind` from `musicVideoType`). Each call is one InnerTube call from the budget.
 */
export type YouTubeLookup = Pick<MetadataProvider, 'getTrack'>

/** Spotify's radio and home feed: the Spotify provider of stage 1.5. */
export type SpotifyRadio = RecommendationProvider

/**
 * Spotify's related artists (`queryArtistRelated`) and artist search, to find the Spotify artist
 * of a seed from another source: the Spotify provider of stage 1.5.
 */
export type SpotifyMetadata = Pick<MetadataProvider, 'search' | 'getRelatedArtists'>

/**
 * Whether the user's Spotify switch is on: an app setting, on by default wherever Spotify can be
 * reached. Reachability itself is `capabilities.spotify`.
 */
export type SpotifySwitch = () => boolean

/** Spotify is on unless the app says otherwise. */
export const SPOTIFY_ON: SpotifySwitch = () => true

/**
 * How many Last.fm station items FXM may classify now, each with one InnerTube call, without
 * eating into what playback and the user's own browsing need: stage 1.2's request budget. The
 * collector never classifies more than its own `maxClassifications` either. Calls beyond the
 * budget fail with `RateLimited` (the platform's budget refuses them), and the collector then
 * stops classifying and keeps the rest as song searches.
 */
export interface ClassificationBudget {
  /** How many classifications fit in the budget now: 0 when it is short. */
  allowance(ctx: ProviderContext): number
}

/**
 * The default: no limit of its own. The collector's `maxClassifications` and the platform
 * budget's refusals bound the calls.
 */
export const UNLIMITED_CLASSIFICATION_BUDGET: ClassificationBudget = {
  allowance: () => Number.POSITIVE_INFINITY,
}

/**
 * Whether the platform is in the Full tier, which Last.fm's station JSON needs (FXM Connect,
 * the desktop app, the Android app). The default reads `capabilities.youtube === 'full'`; a
 * platform that reports FXM Connect's features (stage 1.2) may check its `lastfm` rule instead.
 */
export type TierCheck = (capabilities: NetworkCapabilities) => boolean

/** The default {@link TierCheck}: `capabilities.youtube === 'full'`. */
export const FULL_TIER: TierCheck = lastfmStationsReachable

/**
 * The matching engine's video-to-song rule (stage 1.7, with stage 1.3's song search): the song
 * of an official music video, or `null` when there is no confident match. Used in Music mode for
 * a radio seed that is an official video, and for station items that turn out to be one.
 */
export type SongForVideo = (video: Track, ctx: ProviderContext) => Promise<Track | null>

/**
 * An artist's MusicBrainz ID, e.g. through MusicBrainz's search or URL relationships (stage 1.6),
 * or `null`. ListenBrainz needs it for a radio seeded with an artist; for a track, the collector
 * finds it through ListenBrainz's own lookup.
 */
export type ArtistMbidLookup = (artist: ArtistRef, ctx: ProviderContext) => Promise<string | null>

/**
 * The MusicBrainz release of a track, e.g. from MusicBrainz's exact path for a Spotify track
 * (stage 1.6), or `null`. The artwork filler tries it before ListenBrainz's lookup.
 */
export type ReleaseMbidLookup = (track: Track, ctx: ProviderContext) => Promise<string | null>
