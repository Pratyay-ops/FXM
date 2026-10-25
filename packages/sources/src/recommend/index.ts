/**
 * Recommendation sources in one candidate format, for the recommendation engine (stage 3.3):
 * YouTube Music and Spotify radio, Spotify's related artists and home feed, Last.fm's stations
 * and similar artists, and ListenBrainz's similar artists, all mode-aware. Also fills tracks'
 * artwork gaps from the Cover Art Archive and iTunes Search.
 *
 * ```ts
 * import { createRecommendationCollector } from '@fxm/sources/recommend'
 *
 * const collector = createRecommendationCollector({ youtube, spotify, lastfmStations, listenbrainz })
 * const { candidates, outcomes } = await collector.collect(track, ctx)
 * ```
 *
 * @module
 */

export {
  type ArtistMbidLookup,
  type ClassificationBudget,
  FULL_TIER,
  type ReleaseMbidLookup,
  type SongForVideo,
  SPOTIFY_ON,
  type SpotifyMetadata,
  type SpotifyRadio,
  type SpotifySwitch,
  type TierCheck,
  UNLIMITED_CLASSIFICATION_BUDGET,
  type YouTubeLookup,
  type YouTubeRadio,
} from './adapters'
export { type ArtworkFiller, type ArtworkFillerOptions, createArtworkFiller } from './artwork'
export {
  type CollectOptions,
  createRecommendationCollector,
  DEFAULT_PARTS,
  type RecommendationCollector,
  type RecommendationCollectorOptions,
  tracksForMode,
} from './collector'
export { artistKey, songKey } from './internal/text'
export { seedArtistName, seedRef, seedTitle, youtubeRadioSeed } from './seeds'
export { namesSameSong, rankScore, type StationOptions, stationCandidates } from './stations'
export type {
  ArtistCandidate,
  CandidateArtist,
  CandidateBase,
  Collection,
  HomeCollection,
  RecommendationCandidate,
  RecommendationPart,
  RecommendationSource,
  SeedRef,
  SkipReason,
  SongSearchCandidate,
  SourceOutcome,
  SourceShelf,
  TrackCandidate,
} from './types'
