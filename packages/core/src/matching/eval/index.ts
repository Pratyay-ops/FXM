/**
 * The matching evaluation (stage 1.12). The app reads its outcome, the matching config; the
 * evaluation's tooling (the labelled set's data model, the offline replay, the labels and the
 * report) is the `matchingEval` namespace, for the recorder in `@fxm/sources/eval` and the tests.
 * See `README.md` in this folder.
 *
 * @module
 */

export {
  isAutoMatchAvailable,
  MATCHING_CONFIG,
  type MatchingConfig,
  type MatchingSettings,
  matchingOptions,
} from './config'
export * as matchingEval from './tooling'
