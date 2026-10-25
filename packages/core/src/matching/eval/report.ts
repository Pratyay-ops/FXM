/**
 * The evaluation report: every case replayed offline with the matching config, then counted per
 * category and per input slice, with the MusicBrainz exact path's coverage, what the ISRC-miss
 * cap costs, the Auto gate and the state of the owner's review. `renderReport` writes it as the
 * Markdown committed next to this file (`REPORT.md`).
 *
 * @module
 */

import { DEFAULT_MATCH_THRESHOLDS, MATCHER_VERSION, type MatchThresholds } from '../types'
import { caseCategories } from './categories'
import { type EvalConfig, type EvalOutcome, evaluateCase, isRight } from './evaluate'
import { reviewPlan } from './labels'
import { type TuningResult, tuneThresholds } from './tune'
import {
  casesOf,
  EVAL_CATEGORIES,
  EVAL_SLICES,
  type EvalCategory,
  type EvalGroup,
  PRIMARY_SLICES,
} from './types'

// --- Statistics -----------------------------------------------------------------------------

/** The bands of a set of cases. */
export interface EvalCategoryStats {
  /** The category or slice. */
  name: string
  /** Cases. */
  cases: number
  /** Cases that reach Auto. */
  auto: number
  /** Auto plays of a candidate labelled `wrong`. */
  wrongAuto: number
  /** Auto plays of an unlabelled candidate. */
  unlabeledAuto: number
  /** Auto plays whose label is a draft the owner has not decided. */
  pendingAuto: number
  /** Cases that end in Suggest, and how many of those suggest the recording. */
  suggest: number
  suggestRight: number
  /** Cases that end in None. */
  none: number
  /** Cases with a missing or failed page. */
  incomplete: number
}

/** The MusicBrainz exact path's coverage for a set of groups with a Spotify track. */
export interface EvalCoverageStats {
  /** The category. */
  name: string
  /** Groups with a Spotify track (the exact path's input). */
  tracks: number
  /** Of those, the ones whose URL MusicBrainz links to exactly one recording. */
  linked: number
  /** …whose recording has exactly one ISRC (`musicbrainz-exact`). */
  oneIsrc: number
  /** …whose recording has several (`musicbrainz-exact-several`). */
  severalIsrcs: number
  /** …whose ISRCs include Spotify's own. */
  agrees: number
}

/** What the ISRC-miss cap costs, for a set of cases. */
export interface EvalIsrcCapStats {
  /** The category. */
  name: string
  /** Cases. */
  cases: number
  /** Of those, the ones with a trusted ISRC (`catalog` or `musicbrainz-exact`). */
  trusted: number
  /** Of those, the ones whose ISRC missed, so the cap applies. */
  misses: number
  /** Auto plays with the cap. */
  auto: number
  /** Auto plays with the cap lifted. */
  autoUncapped: number
  /** Wrong or unlabelled Auto plays that lifting the cap would add. */
  wrongPrevented: number
}

function emptyStats(name: string): EvalCategoryStats {
  return {
    name,
    cases: 0,
    auto: 0,
    wrongAuto: 0,
    unlabeledAuto: 0,
    pendingAuto: 0,
    suggest: 0,
    suggestRight: 0,
    none: 0,
    incomplete: 0,
  }
}

function addOutcome(stats: EvalCategoryStats, outcome: EvalOutcome): void {
  stats.cases += 1
  if (outcome.incomplete) stats.incomplete += 1
  if (outcome.band === 'auto') {
    stats.auto += 1
    if (outcome.label === 'wrong') stats.wrongAuto += 1
    if (outcome.label === undefined) stats.unlabeledAuto += 1
    if (outcome.labelPending) stats.pendingAuto += 1
  } else if (outcome.band === 'suggest') {
    stats.suggest += 1
    if (isRight(outcome.label)) stats.suggestRight += 1
  } else {
    stats.none += 1
  }
}

function statsBy(
  outcomes: readonly EvalOutcome[],
  names: readonly string[],
  keysOf: (outcome: EvalOutcome) => readonly string[],
): EvalCategoryStats[] {
  const all = emptyStats('all')
  const byName = new Map(names.map((name) => [name, emptyStats(name)]))
  for (const outcome of outcomes) {
    addOutcome(all, outcome)
    for (const key of keysOf(outcome)) {
      const stats = byName.get(key)
      if (stats !== undefined) addOutcome(stats, outcome)
    }
  }
  return [...byName.values(), all]
}

function coverageOf(name: string, groups: readonly EvalGroup[]): EvalCoverageStats {
  const stats: EvalCoverageStats = {
    name,
    tracks: 0,
    linked: 0,
    oneIsrc: 0,
    severalIsrcs: 0,
    agrees: 0,
  }
  for (const group of groups) {
    const exact = group.musicBrainz?.exact
    if (group.spotify === undefined || exact === undefined) continue
    stats.tracks += 1
    if (exact === null) continue
    stats.linked += 1
    if (exact.isrcs.length === 1) stats.oneIsrc += 1
    if (exact.isrcs.length > 1) stats.severalIsrcs += 1
    const spotifyIsrc = group.variants.find((variant) => variant.slice === 'spotify')?.source.isrc
    if (spotifyIsrc !== undefined && exact.isrcs.includes(spotifyIsrc)) stats.agrees += 1
  }
  return stats
}

function capStatsOf(name: string, outcomes: readonly EvalOutcome[]): EvalIsrcCapStats {
  const stats: EvalIsrcCapStats = {
    name,
    cases: 0,
    trusted: 0,
    misses: 0,
    auto: 0,
    autoUncapped: 0,
    wrongPrevented: 0,
  }
  for (const outcome of outcomes) {
    stats.cases += 1
    if (outcome.trustedIsrc) stats.trusted += 1
    if (outcome.band === 'auto') stats.auto += 1
    const uncapped = outcome.uncapped
    if (uncapped === undefined) {
      if (outcome.band === 'auto') stats.autoUncapped += 1
      continue
    }
    stats.misses += 1
    if (uncapped.band === 'auto') {
      stats.autoUncapped += 1
      if (!isRight(uncapped.label)) stats.wrongPrevented += 1
    }
  }
  return stats
}

// --- The gate --------------------------------------------------------------------------------

/**
 * What the held-out report must show before the matching config may turn the Auto band on
 * (PLAN.md 1.12): at least 200 held-out groups, at least 150 Auto plays (so that zero wrong
 * bounds the wrong-Auto rate below about 2 % at 95 % confidence), no wrong and no unlabelled Auto
 * play, and at least 85 % Auto on at least 40 mainstream cases.
 */
export const EVAL_GATE = Object.freeze({
  minHeldOutGroups: 200,
  minAutoPlays: 150,
  minMainstreamCases: 40,
  minMainstreamAutoRate: 0.85,
})

/** The gate's verdict on the held-out split. */
export interface EvalGateResult {
  /** Whether every condition holds. */
  passed: boolean
  /** Every condition that does not hold, for people. */
  failures: string[]
  /** Held-out groups with a recording. */
  groups: number
  /** Auto plays, all held-out cases. */
  autoPlays: number
  /** Wrong and unlabelled Auto plays. */
  wrongAuto: number
  unlabeledAuto: number
  /** Auto plays whose label the owner has not decided. */
  pendingAuto: number
  /** Mainstream cases, and the share that reaches Auto. */
  mainstreamCases: number
  mainstreamAutoRate: number
  /**
   * The one-sided 95 % upper bound of the wrong-Auto rate when no Auto play is wrong:
   * 1 − 0.05^(1/n), about 3/n. `undefined` when an Auto play is wrong or there are none.
   */
  upperBound?: number
}

function gateOf(outcomes: readonly EvalOutcome[], groups: number): EvalGateResult {
  const auto = outcomes.filter((outcome) => outcome.band === 'auto')
  const wrongAuto = auto.filter((outcome) => outcome.label === 'wrong').length
  const unlabeledAuto = auto.filter((outcome) => outcome.label === undefined).length
  const pendingAuto = auto.filter((outcome) => outcome.labelPending).length
  const mainstream = outcomes.filter(
    (outcome) =>
      PRIMARY_SLICES.includes(outcome.slice) && outcome.categories.includes('mainstream'),
  )
  const mainstreamAuto = mainstream.filter((outcome) => outcome.band === 'auto').length
  const rate = mainstream.length === 0 ? 0 : mainstreamAuto / mainstream.length
  const failures: string[] = []
  if (groups < EVAL_GATE.minHeldOutGroups) {
    failures.push(`${groups} held-out groups, fewer than ${EVAL_GATE.minHeldOutGroups}`)
  }
  if (auto.length < EVAL_GATE.minAutoPlays) {
    failures.push(`${auto.length} Auto plays, fewer than ${EVAL_GATE.minAutoPlays}`)
  }
  if (wrongAuto > 0) failures.push(`${wrongAuto} wrong Auto plays`)
  if (unlabeledAuto > 0) failures.push(`${unlabeledAuto} unlabelled Auto plays`)
  if (mainstream.length < EVAL_GATE.minMainstreamCases) {
    failures.push(
      `${mainstream.length} mainstream cases, fewer than ${EVAL_GATE.minMainstreamCases}`,
    )
  }
  if (rate < EVAL_GATE.minMainstreamAutoRate) {
    failures.push(
      `${percent(rate)} Auto on mainstream tracks, below ${percent(EVAL_GATE.minMainstreamAutoRate)}`,
    )
  }
  const result: EvalGateResult = {
    passed: failures.length === 0,
    failures,
    groups,
    autoPlays: auto.length,
    wrongAuto,
    unlabeledAuto,
    pendingAuto,
    mainstreamCases: mainstream.length,
    mainstreamAutoRate: rate,
  }
  if (auto.length > 0 && wrongAuto === 0) result.upperBound = 1 - 0.05 ** (1 / auto.length)
  return result
}

// --- The report ------------------------------------------------------------------------------

/** How far the owner's review got (see `reviewPlan`). */
export interface EvalReviewStatus {
  /** Ambiguous labels, and how many the owner decided. */
  ambiguous: number
  decided: number
  /** Certain labels, how many the 10 % spot check needs, and how many it checked. */
  certain: number
  spotChecksRequired: number
  spotChecked: number
  /** Rows still in the checklist. */
  pending: number
  /** Whether the review is done: every ambiguous label decided and the spot check complete. */
  complete: boolean
  /** About how long the rest takes, in minutes: 3 per ambiguous row, 1.5 per spot check. */
  minutesLeft: number
}

/** One split's numbers. */
export interface EvalSplitReport {
  /** Groups with a recording. */
  groups: number
  /** Cases replayed. */
  cases: number
  /** Per category (primary inputs and data-export rows), then `all`. */
  categories: EvalCategoryStats[]
  /** Per input slice, then `all`. */
  slices: EvalCategoryStats[]
  /** The MusicBrainz exact path's coverage per category, then `all`. */
  coverage: EvalCoverageStats[]
  /** What the ISRC-miss cap costs per category, then `all`. */
  isrcCap: EvalIsrcCapStats[]
  /** Every Auto play whose pick is not labelled as the recording. */
  badAuto: EvalOutcome[]
  /** Every case's outcome. */
  outcomes: EvalOutcome[]
}

/** The whole report. */
export interface EvalReport {
  /** The matcher version the cases were replayed with. */
  matcherVersion: number
  /** The configuration evaluated. */
  config: EvalConfig
  /** What the tuner chose on the calibration split (the config must equal it). */
  tuning: TuningResult
  /** When the pages were recorded: the first and last UTC dates. */
  recordedAt: { first?: string; last?: string }
  /** Groups not recorded yet. */
  unrecorded: number
  /** The held-out split. */
  heldOut: EvalSplitReport
  /** The calibration split. */
  calibration: EvalSplitReport
  /** The Auto gate, on the held-out split. */
  gate: EvalGateResult
  /** The owner's review. */
  review: EvalReviewStatus
  /** Whether the report lets the matching config turn Auto on: the gate passed and the review is complete. */
  autoAllowed: boolean
}

function splitReport(groups: readonly EvalGroup[], config: EvalConfig): EvalSplitReport {
  const recorded = groups.filter((group) => group.recording !== undefined)
  const cases = casesOf(recorded)
  const outcomes = cases.map((evalCase) => evaluateCase(evalCase, config))
  // The category table counts the primary inputs and the data-export rows; the MusicBrainz
  // inputs have only the slice table, so its `all` row is every case.
  const categorized = outcomes.filter(
    (outcome) => PRIMARY_SLICES.includes(outcome.slice) || outcome.slice === 'data-export',
  )
  const categoryNames = EVAL_CATEGORIES as readonly string[]
  const categories = statsBy(categorized, categoryNames, (outcome) => outcome.categories)
  const slices = statsBy(outcomes, EVAL_SLICES, (outcome) => [outcome.slice])
  const primaryCategories = (group: EvalGroup): EvalCategory[] => {
    const primary = cases.find(
      (evalCase) => evalCase.group === group && PRIMARY_SLICES.includes(evalCase.variant.slice),
    )
    return primary === undefined ? [] : caseCategories(primary)
  }
  const coverage = [
    ...EVAL_CATEGORIES.filter((name) => name !== 'data-export').map((name) =>
      coverageOf(
        name,
        recorded.filter((group) => primaryCategories(group).includes(name)),
      ),
    ),
    coverageOf(
      'data-export',
      recorded.filter((group) => group.variants.some((variant) => variant.slice === 'data-export')),
    ),
    coverageOf('all', recorded),
  ]
  const primaryOutcomes = outcomes.filter((outcome) => PRIMARY_SLICES.includes(outcome.slice))
  const isrcCap = [
    ...EVAL_CATEGORIES.filter((name) => name !== 'data-export').map((name) =>
      capStatsOf(
        name,
        primaryOutcomes.filter((outcome) => outcome.categories.includes(name)),
      ),
    ),
    capStatsOf('all', primaryOutcomes),
  ]
  const badAuto = outcomes.filter((outcome) => outcome.band === 'auto' && !isRight(outcome.label))
  return {
    groups: recorded.length,
    cases: cases.length,
    categories,
    slices,
    coverage,
    isrcCap,
    badAuto,
    outcomes,
  }
}

function reviewStatus(groups: readonly EvalGroup[]): EvalReviewStatus {
  const plan = reviewPlan(groups)
  const pendingAmbiguous = plan.ambiguous.total - plan.ambiguous.decided
  const pendingSpot = Math.max(0, plan.spotCheck.required - plan.spotCheck.checked)
  return {
    ambiguous: plan.ambiguous.total,
    decided: plan.ambiguous.decided,
    certain: plan.spotCheck.labels,
    spotChecksRequired: plan.spotCheck.required,
    spotChecked: plan.spotCheck.checked,
    pending: plan.pending.length,
    complete: pendingAmbiguous === 0 && pendingSpot === 0,
    minutesLeft: Math.round(pendingAmbiguous * 3 + pendingSpot * 1.5),
  }
}

/**
 * Builds the report of a labelled set with a configuration (the matching config's; by default
 * the tuner's choice on the calibration split).
 */
export function buildReport(groups: readonly EvalGroup[], config?: EvalConfig): EvalReport {
  const tuning = tuneThresholds(groups)
  const evaluated = config ?? tuning.config
  const dates = groups.flatMap((group) => group.recording?.recordedAt ?? []).sort()
  const heldOutGroups = groups.filter((group) => group.split === 'held-out')
  const heldOut = splitReport(heldOutGroups, evaluated)
  const gate = gateOf(heldOut.outcomes, heldOut.groups)
  const review = reviewStatus(groups)
  const recordedAt: EvalReport['recordedAt'] = {}
  const [first] = dates
  const last = dates.at(-1)
  if (first !== undefined) recordedAt.first = first
  if (last !== undefined) recordedAt.last = last
  return {
    matcherVersion: MATCHER_VERSION,
    config: evaluated,
    tuning,
    recordedAt,
    unrecorded: groups.filter((group) => group.recording === undefined).length,
    heldOut,
    calibration: splitReport(
      groups.filter((group) => group.split === 'calibration'),
      evaluated,
    ),
    gate,
    review,
    autoAllowed: gate.passed && review.complete,
  }
}

// --- Rendering -------------------------------------------------------------------------------

function percent(value: number): string {
  return `${Math.round(value * 1000) / 10} %`
}

function points(value: number): string {
  return `${Math.round(value * 1000) / 10}`
}

function share(count: number, total: number): string {
  return total === 0 ? '–' : `${count} (${percent(count / total)})`
}

function table(header: readonly string[], rows: readonly (readonly string[])[]): string[] {
  return [
    `| ${header.join(' | ')} |`,
    `|${header.map((_, index) => (index === 0 ? '---' : '---:')).join('|')}|`,
    ...rows.map((row) => `| ${row.join(' | ')} |`),
  ]
}

function bandTable(stats: readonly EvalCategoryStats[]): string[] {
  return table(
    ['', 'Cases', 'Auto', 'Wrong Auto', 'Suggest', 'Right suggestion', 'None', 'Incomplete'],
    stats
      .filter((row) => row.cases > 0 || row.name === 'all')
      .map((row) => [
        row.name === 'all' ? '**all**' : row.name,
        String(row.cases),
        share(row.auto, row.cases),
        `${row.wrongAuto + row.unlabeledAuto}${row.unlabeledAuto > 0 ? ` (${row.unlabeledAuto} unlabelled)` : ''}${row.pendingAuto > 0 ? `, ${row.pendingAuto} on draft labels` : ''}`,
        share(row.suggest, row.cases),
        share(row.suggestRight, row.suggest),
        share(row.none, row.cases),
        String(row.incomplete),
      ]),
  )
}

function coverageTable(stats: readonly EvalCoverageStats[]): string[] {
  return table(
    [
      '',
      'Spotify tracks',
      'Linked to one recording',
      'One ISRC',
      'Several ISRCs',
      "Includes Spotify's ISRC",
    ],
    stats
      .filter((row) => row.tracks > 0 || row.name === 'all')
      .map((row) => [
        row.name === 'all' ? '**all**' : row.name,
        String(row.tracks),
        share(row.linked, row.tracks),
        share(row.oneIsrc, row.tracks),
        share(row.severalIsrcs, row.tracks),
        share(row.agrees, row.tracks),
      ]),
  )
}

function capTable(stats: readonly EvalIsrcCapStats[]): string[] {
  return table(
    [
      '',
      'Cases',
      'Trusted ISRC',
      'ISRC missed',
      'Auto with the cap',
      'Auto without it',
      'Cost (points of Auto rate)',
      'Wrong Auto prevented',
    ],
    stats
      .filter((row) => row.trusted > 0 || row.name === 'all')
      .map((row) => [
        row.name === 'all' ? '**all**' : row.name,
        String(row.cases),
        String(row.trusted),
        String(row.misses),
        share(row.auto, row.cases),
        share(row.autoUncapped, row.cases),
        row.cases === 0 ? '–' : points((row.autoUncapped - row.auto) / row.cases),
        String(row.wrongPrevented),
      ]),
  )
}

function tuningText(tuning: TuningResult): string {
  const { calibration } = tuning
  const numbers = `${calibration.auto} Auto plays of ${calibration.cases} cases, ${calibration.mainstreamAuto} of ${calibration.mainstream} mainstream, ${calibration.wrongAuto} wrong`
  if (tuning.tried === 1) {
    return `Calibration kept the research's defaults: they make no wrong Auto play on the calibration split (${numbers}).`
  }
  return tuning.safe > 0
    ? `Calibration found wrong Auto plays with the defaults and chose the setting above from ${tuning.tried} stricter ones, ${tuning.safe} of them safe there (${numbers}).`
    : `Calibration found no setting of the ${tuning.tried} it tried without a wrong Auto play there, and fell back to the strictest (${numbers}).`
}

function configText(config: EvalConfig): string {
  const entries = Object.entries(config.thresholds) as Array<[keyof MatchThresholds, number]>
  const thresholds =
    entries.length === 0
      ? 'the default thresholds'
      : entries
          .map(([key, value]) => `${key} ${value} (default ${DEFAULT_MATCH_THRESHOLDS[key]})`)
          .join(', ')
  return `${thresholds}; measured fallback ${config.requireReleaseAgreement ? 'on' : 'off'}`
}

/**
 * The report as Markdown, for `REPORT.md`. Deterministic: the same labelled set always gives the
 * same text, so CI can compare it with the committed file.
 */
export function renderReport(report: EvalReport): string {
  const { gate, review } = report
  const lines: string[] = [
    '# Matching evaluation report',
    '',
    'Generated by `packages/core/src/matching/eval/eval.test.ts` from the labelled set in `fixtures/groups/`; do not edit by hand. See [README.md](README.md) for how it is built.',
    '',
    ...(gate.groups < EVAL_GATE.minHeldOutGroups
      ? [
          `**The set is not complete yet:** ${gate.groups} held-out groups of the ${EVAL_GATE.minHeldOutGroups} the gate needs${report.unrecorded > 0 ? `, and ${report.unrecorded} groups still to record` : ''}. The numbers below show that the pipeline works, not how the matcher does; README.md says how to record the full set.`,
          '',
        ]
      : []),
    '## Verdict',
    '',
    `- **Auto setting: ${report.autoAllowed ? 'may be ON' : 'OFF'}.** ${
      report.autoAllowed
        ? 'The held-out gate passed and the owner reviewed every ambiguous label.'
        : `It stays off until the held-out gate passes and the owner has reviewed the ambiguous labels; until then M1 is Suggest-only.`
    }`,
    `- Held-out gate: **${gate.passed ? 'passed' : 'not passed'}**${gate.failures.length > 0 ? `: ${gate.failures.join('; ')}` : ''}.`,
    `- Wrong Auto plays on the held-out split: ${gate.wrongAuto} of ${gate.autoPlays}${gate.unlabeledAuto > 0 ? `, plus ${gate.unlabeledAuto} unlabelled` : ''}${gate.upperBound === undefined ? '' : `; with none wrong, the wrong-Auto rate is below ${percent(gate.upperBound)} at 95 % confidence`}.`,
    `- Mainstream Auto rate (held-out): ${percent(gate.mainstreamAutoRate)} of ${gate.mainstreamCases} cases (needed: ${percent(EVAL_GATE.minMainstreamAutoRate)} of at least ${EVAL_GATE.minMainstreamCases}).`,
    `- Owner review: ${review.complete ? 'complete' : 'pending'}: ${review.decided} of ${review.ambiguous} ambiguous labels decided, ${review.spotChecked} of ${review.spotChecksRequired} spot checks done; about ${review.minutesLeft} minutes left (\`REVIEW.csv\`, ${review.pending} rows).`,
    gate.pendingAuto > 0
      ? `- ${gate.pendingAuto} held-out Auto plays rest on draft labels the owner has not reviewed.`
      : '- No held-out Auto play rests on a draft label.',
    '',
    '## Set',
    '',
    `- Matcher version ${report.matcherVersion}; evaluated with ${configText(report.config)}.`,
    `- ${tuningText(report.tuning)}`,
    `- Held-out: ${report.heldOut.groups} groups, ${report.heldOut.cases} cases. Calibration: ${report.calibration.groups} groups, ${report.calibration.cases} cases.${report.unrecorded > 0 ? ` Not recorded yet: ${report.unrecorded} groups.` : ''}`,
    `- Recorded ${report.recordedAt.first ?? '–'}${report.recordedAt.last !== report.recordedAt.first ? ` to ${report.recordedAt.last ?? '–'}` : ''} (UTC).`,
    '',
  ]
  for (const [title, split] of [
    ['Held-out split', report.heldOut],
    ['Calibration split', report.calibration],
  ] as const) {
    lines.push(
      `## ${title}`,
      '',
      'Bands with the Auto setting on, per category: the Spotify, CSV and fixed inputs, and the data-export rows in a row of their own (`all` counts both). "Right suggestion" is the share of Suggest cases whose pick is the recording.',
      '',
      ...bandTable(split.categories),
      '',
      'Per input slice, every case:',
      '',
      ...bandTable(split.slices),
      '',
      'MusicBrainz exact-path coverage (the Spotify track URL looked up through URL relationships):',
      '',
      ...coverageTable(split.coverage),
      '',
      'What the ISRC-miss cap costs: Auto plays with the cap and without it (a missed trusted ISRC then caps nothing), and the wrong or unlabelled Auto plays the cap prevents:',
      '',
      ...capTable(split.isrcCap),
      '',
    )
    if (split.badAuto.length > 0) {
      lines.push('Auto plays that are wrong or unlabelled:', '')
      for (const outcome of split.badAuto) {
        lines.push(`- ${outcome.caseId}: ${outcome.pick ?? '?'} (${outcome.label ?? 'unlabelled'})`)
      }
      lines.push('')
    }
  }
  return `${lines.join('\n').trimEnd()}\n`
}
