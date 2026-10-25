/**
 * The matching evaluation's tooling (stage 1.12), re-exported from `@fxm/core` as the
 * `matchingEval` namespace: the labelled set's data model, the offline replay, the label rules,
 * the calibration and the report. Only the recorder and the tests use it; the app reads the
 * outcome, `MATCHING_CONFIG`. See `README.md` in this folder.
 *
 * @module
 */

export {
  CALIBRATION_PERCENT,
  caseCategories,
  categoriesOfInput,
  type InputFacts,
  LONG_TAIL_POPULARITY,
  MAINSTREAM_POPULARITY,
  splitOf,
  stableHash,
} from './categories'
export {
  DEFAULT_EVAL_CONFIG,
  type EvalConfig,
  type EvalOutcome,
  evaluateCase,
  optionsOf,
} from './evaluate'
export {
  type DraftLabel,
  draftLabel,
  draftLabels,
  labelTargets,
  REVIEW_COLUMNS,
  type ReviewPlan,
  type ReviewRow,
  referenceSource,
  renderReviewCsv,
  reviewPlan,
  reviewRows,
  trustedIsrcs,
} from './labels'
export {
  answerFromRecording,
  decodeItem,
  descriptionExcerpt,
  emptyRecording,
  encodeTrack,
  fileItems,
  isRecorded,
  type PageKeyParts,
  pageKeys,
  parsePageKey,
  RECORDING_OPTIONS,
  recordedFacts,
  recordedTracks,
  videoIdOf,
  withoutIsrcCap,
} from './recording'
export { type EvalReplay, replayMatch } from './replay'
export {
  buildReport,
  EVAL_GATE,
  type EvalCategoryStats,
  type EvalCoverageStats,
  type EvalGateResult,
  type EvalIsrcCapStats,
  type EvalReport,
  type EvalReviewStatus,
  type EvalSplitReport,
  renderReport,
} from './report'
export { TUNING_GRID, type TuningResult, tuneThresholds } from './tune'
export {
  casesOf,
  EVAL_CATEGORIES,
  EVAL_LABELS,
  EVAL_SLICES,
  EVAL_SPLITS,
  type EvalCase,
  type EvalCategory,
  EvalFixtureError,
  type EvalGroup,
  type EvalItem,
  type EvalLabel,
  type EvalLabelAuthor,
  type EvalLabelEntry,
  type EvalMusicBrainzExact,
  type EvalMusicBrainzFuzzy,
  type EvalPage,
  type EvalRecording,
  type EvalSlice,
  type EvalSplit,
  type EvalVariant,
  PRIMARY_SLICES,
  parseEvalGroup,
} from './types'
