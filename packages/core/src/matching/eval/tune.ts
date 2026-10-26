/**
 * Tuning the Auto band on the calibration split, and only there: the held-out split never
 * influences the thresholds it is judged with.
 *
 * The grid only tightens the research's thresholds (ARCHITECTURE.md §12): the evaluation exists
 * to show that Auto is safe, so it may make Auto stricter where calibration finds wrong Auto
 * plays (the plan's "measured fallback" first), never looser.
 *
 * @module
 */

import type { MatchThresholds } from '../types'
import { caseCategories } from './categories'
import { type EvalConfig, type EvalOutcome, evaluateCase } from './evaluate'
import { casesOf, type EvalGroup } from './types'

/** The values the tuner tries, each at least as strict as the default. */
export const TUNING_GRID = Object.freeze({
  auto: [0.8, 0.85, 0.9],
  autoTitle: [0.8, 0.9],
  margin: [0.05, 0.1],
  requireReleaseAgreement: [false, true],
})

/** What the tuner chose, and what it rests on. */
export interface TuningResult {
  /** The chosen configuration. */
  config: EvalConfig
  /** How it does on the calibration split. */
  calibration: {
    /** Cases replayed (recorded inputs of calibration groups). */
    cases: number
    /** Cases that reach Auto. */
    auto: number
    /** Auto plays of a candidate labelled `wrong`. */
    wrongAuto: number
    /** Auto plays of an unlabelled candidate. */
    unlabeledAuto: number
    /** Mainstream cases, and how many reach Auto. */
    mainstream: number
    mainstreamAuto: number
  }
  /** How many configurations were tried. */
  tried: number
  /** How many of them had no wrong or unlabelled Auto play on the calibration split. */
  safe: number
}

/** Every configuration of the grid. */
function gridConfigs(): EvalConfig[] {
  const configs: EvalConfig[] = []
  for (const requireReleaseAgreement of TUNING_GRID.requireReleaseAgreement) {
    for (const auto of TUNING_GRID.auto) {
      for (const autoTitle of TUNING_GRID.autoTitle) {
        for (const margin of TUNING_GRID.margin) {
          const thresholds: Partial<MatchThresholds> = {}
          if (auto !== 0.8) thresholds.auto = auto
          if (autoTitle !== 0.8) thresholds.autoTitle = autoTitle
          if (margin !== 0.05) thresholds.margin = margin
          configs.push({ thresholds, requireReleaseAgreement })
        }
      }
    }
  }
  return configs
}

/** How far a configuration is from the defaults: how many settings it changes. */
function changes(config: EvalConfig): number {
  return Object.keys(config.thresholds).length + (config.requireReleaseAgreement ? 1 : 0)
}

/** How strict a configuration is, to break the last ties towards safety. */
function strictness(config: EvalConfig): number {
  const { auto = 0.8, autoTitle = 0.8, margin = 0.05 } = config.thresholds
  return auto + autoTitle + margin + (config.requireReleaseAgreement ? 1 : 0)
}

/** A configuration's calibration numbers. */
function measure(outcomes: readonly EvalOutcome[]): TuningResult['calibration'] {
  const auto = outcomes.filter((outcome) => outcome.band === 'auto')
  const mainstream = outcomes.filter((outcome) => outcome.categories.includes('mainstream'))
  return {
    cases: outcomes.length,
    auto: auto.length,
    wrongAuto: auto.filter((outcome) => outcome.label === 'wrong').length,
    unlabeledAuto: auto.filter((outcome) => outcome.label === undefined).length,
    mainstream: mainstream.length,
    mainstreamAuto: mainstream.filter((outcome) => outcome.band === 'auto').length,
  }
}

/** Whether a configuration's calibration numbers show no wrong and no unlabelled Auto play. */
function isSafe(numbers: TuningResult['calibration']): boolean {
  return numbers.wrongAuto === 0 && numbers.unlabeledAuto === 0
}

/**
 * Picks the configuration for the Auto band from the calibration split. No change without
 * evidence: when the research's defaults have no wrong and no unlabelled Auto play there, they
 * stay (every grid configuration is stricter, so it can only lose Auto plays). Otherwise, of the
 * grid's configurations without one, the one with the most mainstream Auto plays, then the most
 * Auto plays, then the fewest changes from the defaults, then the strictest; when none is safe,
 * the strictest of all, and the report's gate fails anyway.
 */
export function tuneThresholds(groups: readonly EvalGroup[]): TuningResult {
  const cases = casesOf(groups.filter((group) => group.split === 'calibration')).filter(
    (evalCase) => evalCase.group.recording !== undefined,
  )
  const configs = gridConfigs()
  const measureConfig = (config: EvalConfig) =>
    measure(cases.map((evalCase) => evaluateCase(evalCase, config, caseCategories(evalCase))))
  const [defaults] = configs
  if (defaults !== undefined) {
    const numbers = measureConfig(defaults)
    if (isSafe(numbers)) {
      return { config: defaults, calibration: numbers, tried: 1, safe: 1 }
    }
  }
  const measured = configs.map((config) => ({
    config,
    numbers: measureConfig(config),
  }))
  const safe = measured.filter(({ numbers }) => isSafe(numbers))
  const pool = safe.length > 0 ? safe : measured
  const [best] = [...pool].sort(
    (a, b) =>
      (safe.length > 0 ? 0 : strictness(b.config) - strictness(a.config)) ||
      b.numbers.mainstreamAuto - a.numbers.mainstreamAuto ||
      b.numbers.auto - a.numbers.auto ||
      changes(a.config) - changes(b.config) ||
      strictness(b.config) - strictness(a.config),
  )
  const chosen = best ?? {
    config: { thresholds: {}, requireReleaseAgreement: false },
    numbers: measure([]),
  }
  return {
    config: chosen.config,
    calibration: chosen.numbers,
    tried: configs.length,
    safe: safe.length,
  }
}
