import { describe, expect, it } from 'vitest'
import * as core from '../index'
import {
  DEFAULT_MATCH_THRESHOLDS,
  isMatchBand,
  MATCH_BANDS,
  type MatchThresholds,
  resolveThresholds,
} from './types'

describe('the matching API', () => {
  it('is re-exported from @fxm/core', () => {
    for (const name of [
      'matchTrack',
      'matchVideoToSong',
      'checkIsrc',
      'nextMatchRequest',
      'addMatchResponse',
      'textSearchQuery',
      'albumSearchQuery',
      'videoSearchQuery',
      'parseReleaseDescription',
      'scoreCandidate',
      'prepareSource',
      'sourceSide',
      'trackSide',
      'durationSimilarity',
      'isClassicalTitle',
      'textSimilarity',
      'SCORE_WEIGHTS',
      'SCORE_PENALTIES',
      'SCORE_CAPS',
      'MATCH_BANDS',
      'isMatchBand',
      'DEFAULT_MATCH_THRESHOLDS',
      'resolveThresholds',
    ]) {
      expect(core).toHaveProperty(name)
    }
  })
})

describe('match bands', () => {
  it('lists the bands from the most confident', () => {
    expect(MATCH_BANDS).toEqual(['auto', 'suggest', 'none'])
  })

  it('validates a band read from storage', () => {
    for (const band of MATCH_BANDS) expect(isMatchBand(band)).toBe(true)
    expect(isMatchBand('maybe')).toBe(false)
    expect(isMatchBand('toString')).toBe(false)
    expect(isMatchBand(undefined)).toBe(false)
  })
})

describe('thresholds', () => {
  it('holds the measured defaults, frozen', () => {
    expect(DEFAULT_MATCH_THRESHOLDS).toEqual({
      auto: 0.8,
      autoTitle: 0.8,
      suggest: 0.6,
      margin: 0.05,
      windowMs: 5000,
      windowRatio: 0.02,
      isrcArtist: 0.5,
      isrcTitle: 0.8,
      isrcTopItems: 5,
      videoTitle: 0.8,
      videoArtist: 0.5,
      videoSlackMs: 5000,
    } satisfies MatchThresholds)
    expect(Object.isFrozen(DEFAULT_MATCH_THRESHOLDS)).toBe(true)
  })

  it('takes overrides from the options', () => {
    expect(resolveThresholds()).toEqual(DEFAULT_MATCH_THRESHOLDS)
    expect(resolveThresholds({ thresholds: { auto: 0.9 } })).toEqual({
      ...DEFAULT_MATCH_THRESHOLDS,
      auto: 0.9,
    })
  })
})
