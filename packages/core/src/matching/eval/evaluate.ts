/**
 * One case's outcome: the case replayed offline with a configuration and the Auto setting on,
 * and the label of what it picked.
 *
 * @module
 */

import { normalizeIsrc } from '../../ids'
import { isrcTrust } from '../isrc'
import type { AutoBlocker, IsrcStatus, MatchBand, MatchOptions, MatchThresholds } from '../types'
import { caseCategories } from './categories'
import { MATCHING_CONFIG, type MatchingConfig } from './config'
import { withoutIsrcCap } from './recording'
import { replayMatch } from './replay'
import type { EvalCase, EvalCategory, EvalGroup, EvalLabel, EvalSlice, EvalSplit } from './types'

/** The settings the matcher is evaluated with: the matching config's. */
export interface EvalConfig {
  /** Threshold overrides (an empty object for the defaults). */
  thresholds: Partial<MatchThresholds>
  /** The measured fallback: text-only Auto needs album or year agreement. */
  requireReleaseAgreement: boolean
}

/** The research's settings: the default thresholds, the measured fallback off. */
export const DEFAULT_EVAL_CONFIG: Readonly<EvalConfig> = Object.freeze({
  thresholds: Object.freeze({}),
  requireReleaseAgreement: false,
})

/** The settings a matching config ships (by default `MATCHING_CONFIG`'s): what the report evaluates. */
export function evalConfigOf(config: MatchingConfig = MATCHING_CONFIG): EvalConfig {
  return {
    thresholds: { ...config.thresholds },
    requireReleaseAgreement: config.requireReleaseAgreement,
  }
}

/**
 * The match options of a configuration, with the Auto setting on: the band Auto would give. The
 * defaults give exactly the recorder's first option set (see `RECORDING_OPTIONS`), so the two
 * share their replays.
 */
export function optionsOf(config: EvalConfig): MatchOptions {
  return {
    auto: true,
    mode: 'music',
    ...(config.requireReleaseAgreement ? { requireReleaseAgreement: true } : {}),
    ...(Object.keys(config.thresholds).length > 0 ? { thresholds: config.thresholds } : {}),
  }
}

/** What one case came to. */
export interface EvalOutcome {
  /** The case. */
  caseId: string
  /** Its group. */
  groupId: string
  /** Its split. */
  split: EvalSplit
  /** Its input slice. */
  slice: EvalSlice
  /** The categories it counts in (see `caseCategories`). */
  categories: EvalCategory[]
  /** The band, with the Auto setting on. */
  band: MatchBand
  /** The pick: the best candidate's videoId, whatever the band. */
  pick?: string
  /** The pick's label; `undefined` when it has none. */
  label?: EvalLabel
  /** Whether that label is a draft the owner has not decided. */
  labelPending: boolean
  /** Whether the pick is ISRC-verified. */
  verified: boolean
  /** Whether the input has a trusted ISRC (`catalog` or `musicbrainz-exact`). */
  trustedIsrc: boolean
  /** The ISRC gate's verdict. */
  isrc: IsrcStatus
  /** Why the pick did not reach Auto. */
  blockers: AutoBlocker[]
  /** Whether a page the plan asked for was missing or had failed. */
  incomplete: boolean
  /** The pages the replay lacked: never recorded, or recorded as a failure (`error`). */
  gaps: string[]
  /**
   * Whether the songs search for the input's ISRC put a recording labelled `wrong` first: filler
   * when YouTube Music lacks the ISRC, or a recording that claims it.
   */
  isrcLedByOther: boolean
  /**
   * For a trusted ISRC that missed: the band and pick with the ISRC-miss cap lifted (see
   * `withoutIsrcCap`), and the pick's label.
   */
  uncapped?: { band: MatchBand; pick?: string; label?: EvalLabel }
}

/** Whether a label marks the recording. */
export function isRight(label: EvalLabel | undefined): boolean {
  return label === 'exact' || label === 'equivalent'
}

/** Whether the first item of the songs search for `isrc` is labelled `wrong` (see {@link EvalOutcome}). */
function ledByOther(group: EvalGroup, isrc: string | undefined): boolean {
  const canonical = normalizeIsrc(isrc)
  const page = canonical === null ? undefined : group.recording?.pages[`isrc-songs/1/${canonical}`]
  const first = page !== undefined && 'items' in page ? page.items[0] : undefined
  return first !== undefined && group.labels?.[first]?.label === 'wrong'
}

/**
 * Replays one case with a configuration and the Auto setting on, and looks up the pick's label.
 * A case of a group without a recording comes out as `none` and `incomplete`.
 */
export function evaluateCase(
  evalCase: EvalCase,
  config: EvalConfig,
  categories: EvalCategory[] = caseCategories(evalCase),
): EvalOutcome {
  const { group, variant } = evalCase
  const trustedIsrc =
    variant.source.isrc !== undefined && isrcTrust(variant.source.isrcOrigin) === 'trusted'
  const base = {
    caseId: evalCase.id,
    groupId: group.id,
    split: group.split,
    slice: variant.slice,
    categories,
    trustedIsrc,
    isrcLedByOther: ledByOther(group, variant.source.isrc),
  }
  const recording = group.recording
  if (recording === undefined) {
    return {
      ...base,
      band: 'none',
      labelPending: false,
      verified: false,
      isrc: 'not-run',
      blockers: ['no-candidates'],
      incomplete: true,
      gaps: [],
    }
  }
  const options = optionsOf(config)
  const replay = replayMatch(variant.source, recording, options)
  const { result } = replay
  const pick = result.best?.source === 'ytm' ? result.best.ref : undefined
  const entry = pick === undefined ? undefined : group.labels?.[pick]
  const outcome: EvalOutcome = {
    ...base,
    band: result.band,
    labelPending: entry?.ambiguous === true && entry.by !== 'owner',
    verified: result.best?.signals?.isrcVerified === true,
    isrc: result.isrc.status,
    blockers: result.autoBlockers,
    incomplete: result.incomplete,
    gaps: [...replay.unrecorded, ...replay.failed],
  }
  if (pick !== undefined) outcome.pick = pick
  if (entry !== undefined) outcome.label = entry.label
  const uncappedSource = withoutIsrcCap(variant.source)
  if (trustedIsrc && result.isrc.status === 'miss' && uncappedSource !== undefined) {
    const uncapped = replayMatch(uncappedSource, recording, options).result
    const uncappedPick = uncapped.best?.source === 'ytm' ? uncapped.best.ref : undefined
    const uncappedLabel = uncappedPick === undefined ? undefined : group.labels?.[uncappedPick]
    outcome.uncapped = { band: uncapped.band }
    if (uncappedPick !== undefined) outcome.uncapped.pick = uncappedPick
    if (uncappedLabel !== undefined) outcome.uncapped.label = uncappedLabel.label
  }
  return outcome
}
