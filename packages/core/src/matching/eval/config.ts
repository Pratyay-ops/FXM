/**
 * The matching config: whether the Auto band may be used at all, and the thresholds it uses.
 * Stage 1.12's held-out report decides it (see `README.md` and `REPORT.md` in this folder), and
 * `eval.test.ts` checks that it agrees with the committed report: Auto may be on only when the
 * held-out gate passed and the owner has reviewed the ambiguous labels, and the thresholds must
 * be the calibration split's.
 *
 * @module
 */

import { type CatalogMode, isCatalogMode } from '../../mode'
import {
  MATCHER_VERSION,
  type MatchOptions,
  type MatchThresholds,
  sanitizeMatchOptions,
} from '../types'

/** The matching config (see {@link MATCHING_CONFIG}). */
export interface MatchingConfig {
  /**
   * Whether the Auto band may be used at all. While it is `false`, the app hides its Auto setting
   * and every match is a suggestion ("Suggest-only"); while it is `true`, the user's Auto setting
   * decides.
   */
  readonly auto: boolean
  /** Why `auto` has its value, for Settings → Diagnostics and the release notes. */
  readonly autoReason: string
  /** The thresholds tuned on the calibration split: overrides of `DEFAULT_MATCH_THRESHOLDS`. */
  readonly thresholds: Readonly<Partial<MatchThresholds>>
  /** The measured fallback: a match that is not ISRC-verified needs album or year agreement. */
  readonly requireReleaseAgreement: boolean
  /**
   * The matcher version the report evaluated. A newer matcher has not been evaluated, so the Auto
   * band stays off for it until the report is made again.
   */
  readonly matcherVersion: number
}

/**
 * The matching config FXM ships with. **Auto is off:** the labelled set holds only the
 * recorder's proof run so far, far below the held-out gate's 200 groups and 150 Auto plays, and
 * the owner has not reviewed the ambiguous labels. So M1 is Suggest-only.
 */
export const MATCHING_CONFIG: MatchingConfig = Object.freeze({
  auto: false,
  autoReason:
    'Matches are suggestions until the matching evaluation (stage 1.12) passes on the full held-out set and the owner has reviewed its ambiguous labels.',
  thresholds: Object.freeze({}),
  requireReleaseAgreement: false,
  matcherVersion: 1,
})

/**
 * Whether the Auto band may be used: the config allows it and was evaluated with this matcher.
 * The app shows its Auto setting only then.
 */
export function isAutoMatchAvailable(config: MatchingConfig = MATCHING_CONFIG): boolean {
  return config.auto === true && config.matcherVersion === MATCHER_VERSION
}

/** What the app passes to {@link matchingOptions}: the user's settings, as stored. */
export interface MatchingSettings {
  /** The user's Auto setting; only `true` turns it on. */
  autoMatch?: unknown
  /** The catalog mode. */
  mode?: unknown
}

/**
 * The options to match with: the config's thresholds and fallback, the catalog mode, and the
 * Auto setting only where the config makes the band available (see
 * {@link isAutoMatchAvailable}). Settings read from storage are fine as they are: they go through
 * `sanitizeMatchOptions`.
 *
 * ```ts
 * const band = effectiveMatchBand(candidate.verdict, matchingOptions(settings).auto === true)
 * ```
 */
export function matchingOptions(
  settings: MatchingSettings = {},
  config: MatchingConfig = MATCHING_CONFIG,
): MatchOptions {
  const mode: CatalogMode | undefined = isCatalogMode(settings.mode) ? settings.mode : undefined
  return sanitizeMatchOptions({
    auto: isAutoMatchAvailable(config) && settings.autoMatch === true,
    mode,
    requireReleaseAgreement: config.requireReleaseAgreement,
    thresholds: config.thresholds,
  })
}
