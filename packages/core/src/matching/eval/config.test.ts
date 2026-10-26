import { describe, expect, it } from 'vitest'
import * as core from '../../index'
import { effectiveMatchBand, MATCHER_VERSION } from '../types'
import {
  isAutoMatchAvailable,
  MATCHING_CONFIG,
  type MatchingConfig,
  matchingOptions,
} from './config'

const ON: MatchingConfig = { ...MATCHING_CONFIG, auto: true, matcherVersion: MATCHER_VERSION }

describe('the matching config', () => {
  it('ships with the Auto band off: M1 is Suggest-only until the evaluation passes', () => {
    expect(MATCHING_CONFIG.auto).toBe(false)
    expect(isAutoMatchAvailable()).toBe(false)
    expect(MATCHING_CONFIG.autoReason).toMatch(/1\.12/u)
    expect(Object.isFrozen(MATCHING_CONFIG)).toBe(true)
  })

  it("never turns Auto on while the config keeps it off, whatever the user's setting", () => {
    expect(matchingOptions({ autoMatch: true, mode: 'music' })).toEqual({ mode: 'music' })
    const verdict = { band: 'auto' as const, blockers: [], matcherVersion: MATCHER_VERSION }
    expect(effectiveMatchBand(verdict, matchingOptions({ autoMatch: true }).auto === true)).toBe(
      'suggest',
    )
  })

  it("lets the user's setting decide once the config allows the band", () => {
    expect(isAutoMatchAvailable(ON)).toBe(true)
    expect(matchingOptions({ autoMatch: true }, ON).auto).toBe(true)
    expect(matchingOptions({ autoMatch: 'true' }, ON).auto).toBeUndefined()
    expect(matchingOptions({}, ON).auto).toBeUndefined()
  })

  it('keeps the band off for a matcher the report did not evaluate', () => {
    expect(isAutoMatchAvailable({ ...ON, matcherVersion: MATCHER_VERSION + 1 })).toBe(false)
  })

  it('passes the tuned thresholds and the fallback, and checks the mode', () => {
    const tuned: MatchingConfig = {
      ...ON,
      thresholds: { auto: 0.85, margin: 2 },
      requireReleaseAgreement: true,
    }
    expect(matchingOptions({ mode: 'all' }, tuned)).toEqual({
      mode: 'all',
      requireReleaseAgreement: true,
      thresholds: { auto: 0.85 },
    })
    expect(matchingOptions({ mode: 'videos' }, tuned).mode).toBeUndefined()
  })

  it('is exported from @fxm/core, with the evaluation tooling as a namespace', () => {
    expect(core.MATCHING_CONFIG).toBe(MATCHING_CONFIG)
    expect(typeof core.matchingOptions).toBe('function')
    expect(typeof core.isAutoMatchAvailable).toBe('function')
    expect(typeof core.matchingEval.replayMatch).toBe('function')
    expect(core).not.toHaveProperty('replayMatch')
    expect(core).not.toHaveProperty('buildReport')
  })
})
