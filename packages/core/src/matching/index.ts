/**
 * The matching engine: finds the YouTube Music song for a track from another catalog, and the
 * song for an official music video. Pure functions over the pages a provider fetched; see
 * `README.md` in this folder.
 *
 * @module
 */

export { matchTrack } from './engine'
export { checkIsrc, type IsrcGateResult } from './isrc'
export {
  addMatchResponse,
  albumSearchQuery,
  type MatchRequest,
  type MatchResponse,
  nextMatchRequest,
  textSearchQuery,
  videoSearchQuery,
} from './plan'
export { isClassicalTitle, type PreparedTitle, type VersionLevel } from './prepare'
export { parseReleaseDescription } from './release'
export {
  durationSimilarity,
  type PreparedSource,
  prepareSource,
  SCORE_CAPS,
  SCORE_PENALTIES,
  SCORE_WEIGHTS,
  type ScoreBreakdown,
  type ScoreSide,
  scoreCandidate,
  sourceSide,
  trackSide,
  type VersionMismatch,
} from './score'
export { textSimilarity } from './similarity'
export * from './types'
export { matchVideoToSong } from './video'
