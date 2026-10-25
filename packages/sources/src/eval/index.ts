/**
 * The matching evaluation's recorder (stage 1.12): builds the labelled set's inputs from public
 * Spotify playlists and searches and from MusicBrainz, records the YouTube Music pages the
 * matching planner asks for (through the shared request budget, as bulk work), and drafts the
 * labels and the owner's review checklist. The offline replay and the report live in
 * `@fxm/core` (`matchingEval`), so core stays free of network code. See `README.md` here.
 *
 * @module
 */

export {
  type CsvRow,
  csvGroup,
  csvGroupId,
  parseExportifyCsv,
  splitArtists,
} from './csv'
export {
  buildInputs,
  buildVariants,
  exactOf,
  FIXED_INPUTS,
  INPUT_PLANS,
  type InputOptions,
  type InputProviders,
  type InputSource,
  type InputSummary,
  passesFilter,
  poolTrackOf,
  spotifyInput,
} from './inputs'
export { fetchPage, type PageProviders } from './pages'
export {
  type RecorderBudget,
  type RecorderOptions,
  type RecordSummary,
  recordGroups,
} from './recorder'
export {
  applyReview,
  type LabelSummary,
  labelGroups,
  parseCsv,
  REVIEW_FILE,
  type ReviewSummary,
  readGroups,
} from './review'
export {
  checkpointStorage,
  EVAL_DIR,
  type EvalCheckpoint,
  type EvalStore,
  emptyCheckpoint,
  fileStore,
  groupFileName,
  groupIdOf,
  memoryStore,
  type PoolTrack,
  parseCheckpoint,
  STATE_DIR,
  serializeGroup,
} from './store'
