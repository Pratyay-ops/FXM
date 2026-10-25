/**
 * The matching engine: finds the YouTube Music song for a track from another catalog, and the
 * song for an official music video. Pure functions over the pages a provider fetched; see
 * `README.md` in this folder. Only the engine's API is public: the scorer and its helpers stay
 * internal, so their names never collide with other modules in the flat `@fxm/core` barrel.
 *
 * @module
 */

export { matchTrack } from './engine'
export { addMatchResponse, nextMatchRequest, runMatch, videoSongsQuery } from './plan'
export { parseReleaseDescription } from './release'
export {
  type AutoBlocker,
  DEFAULT_MATCH_THRESHOLDS,
  effectiveMatchBand,
  type IsrcCheck,
  type IsrcOrigin,
  type IsrcPlace,
  type IsrcRejectedItem,
  type IsrcRejection,
  type IsrcStatus,
  isIsrcOrigin,
  isMatchBand,
  MATCH_BANDS,
  MATCHER_VERSION,
  type MatchBand,
  type MatchOptions,
  type MatchPages,
  type MatchRequest,
  type MatchRequestKind,
  type MatchResponse,
  type MatchResult,
  type MatchSource,
  type MatchSourceExtras,
  type MatchThresholds,
  type MatchVerdict,
  type ReleaseFacts,
  type ReleaseFactsKey,
  sanitizeMatchOptions,
  type VideoMatchOptions,
  type VideoMatchThresholds,
  type VideoSongMatch,
} from './types'
export { matchVideoToSong } from './video'
