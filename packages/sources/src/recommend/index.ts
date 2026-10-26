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
  AUTO_MATCH_OFF,
  type AutoMatchSetting,
  type ClassificationBudget,
  type ReleaseMbidLookup,
  type SongForVideo,
  SPOTIFY_ON,
  type SpotifyAvailability,
  type SpotifyMetadata,
  type SpotifyRadio,
  type SpotifySwitch,
  UNLIMITED_CLASSIFICATION_BUDGET,
  type VideoSong,
  type YouTubeLookup,
  type YouTubeRadio,
  type YouTubeSeedFinder,
} from './adapters'
export {
  type ArtworkFiller,
  type ArtworkFillerOptions,
  type ArtworkOptions,
  type ArtworkResult,
  createArtworkFiller,
} from './artwork'
export {
  type CollectOptions,
  createRecommendationCollector,
  DEFAULT_LIMIT,
  DEFAULT_MAX_CLASSIFICATIONS,
  DEFAULT_PARTS,
  type HomeOptions,
  type RecommendationCollector,
  type RecommendationCollectorOptions,
  tracksForMode,
} from './collector'
export { artistKey, songKey } from './keys'
export {
  isMusicMode,
  isYouTubeRadioSeed,
  seedArtistMbid,
  seedArtistName,
  seedRef,
  seedTitle,
  type YouTubeRadioStart,
  type YouTubeSeedAdapters,
  youtubeRadioSeed,
  youtubeRadioStart,
} from './seeds'
export {
  DEFAULT_MAX_CLASSIFICATION_MS,
  namesSameSong,
  rankScore,
  type SongName,
  type StationOptions,
  stationCandidates,
} from './stations'
export type {
  ArtistCandidate,
  ArtistSeed,
  CandidateArtist,
  CandidateBase,
  CandidatePart,
  Collection,
  HomeCollection,
  RecommendationCandidate,
  RecommendationPart,
  RecommendationSeed,
  RecommendationSource,
  SeedRef,
  SkipReason,
  SongMatch,
  SongSearchCandidate,
  SourceOutcome,
  SourceResult,
  SourceShelf,
  SourceShelves,
  TrackCandidate,
} from './types'
