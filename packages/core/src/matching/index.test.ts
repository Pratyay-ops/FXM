import { describe, expect, expectTypeOf, it } from 'vitest'
import * as core from '../index'
import type { Track } from '../model'
import type { AudioCandidate, AudioSource } from '../providers'
import {
  DEFAULT_MATCH_THRESHOLDS,
  effectiveMatchBand,
  isIsrcOrigin,
  isMatchBand,
  MATCH_BANDS,
  MATCHER_VERSION,
  type MatchSourceExtras,
  type MatchThresholds,
  type MatchVerdict,
  type ReleaseFactsKey,
  resolveMatchThresholds,
  sanitizeMatchOptions,
} from './types'

describe('the matching API', () => {
  it('is re-exported from @fxm/core', () => {
    for (const name of [
      'matchTrack',
      'matchVideoToSong',
      'nextMatchRequest',
      'addMatchResponse',
      'runMatch',
      'videoSongsQuery',
      'parseReleaseDescription',
      'MATCH_BANDS',
      'MATCHER_VERSION',
      'isMatchBand',
      'isIsrcOrigin',
      'effectiveMatchBand',
      'sanitizeMatchOptions',
      'DEFAULT_MATCH_THRESHOLDS',
    ]) {
      expect(core).toHaveProperty(name)
    }
  })

  it('keeps the scorer and its helpers internal', () => {
    for (const name of [
      'scoreCandidate',
      'prepareSource',
      'sourceSide',
      'trackSide',
      'durationSimilarity',
      'textSimilarity',
      'SCORE_WEIGHTS',
      'SCORE_PENALTIES',
      'SCORE_CAPS',
      'checkIsrc',
      'isClassicalTitle',
      'textSearchQuery',
      'resolveThresholds',
      'resolveMatchThresholds',
    ]) {
      expect(core).not.toHaveProperty(name)
    }
  })

  it('lets AudioSource.match read the extras and carry the verdict', () => {
    expectTypeOf<Parameters<AudioSource['match']>[0]>().toEqualTypeOf<Track & MatchSourceExtras>()
    expectTypeOf<Track>().toExtend<Parameters<AudioSource['match']>[0]>()
    expectTypeOf<AudioCandidate['verdict']>().toEqualTypeOf<MatchVerdict | undefined>()
  })

  it('keys release facts by full track IDs only', () => {
    expectTypeOf<'ytm:track:abc'>().toExtend<ReleaseFactsKey>()
    expectTypeOf<'abc'>().not.toExtend<ReleaseFactsKey>()
    expectTypeOf<'ytm:album:abc'>().not.toExtend<ReleaseFactsKey>()
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

describe('effectiveMatchBand', () => {
  const verdict = (band: MatchVerdict['band'], matcherVersion = MATCHER_VERSION): MatchVerdict => ({
    band,
    blockers: [],
    matcherVersion,
  })

  it('plays an auto verdict without asking only while the setting is on', () => {
    expect(effectiveMatchBand(verdict('auto'), true)).toBe('auto')
    expect(effectiveMatchBand(verdict('auto'), false)).toBe('suggest')
    expect(effectiveMatchBand(verdict('suggest'), true)).toBe('suggest')
    expect(effectiveMatchBand(verdict('none'), true)).toBe('none')
  })

  it('never auto-plays a verdict of another matcher version or a malformed one', () => {
    expect(effectiveMatchBand(verdict('auto', MATCHER_VERSION - 1), true)).toBe('suggest')
    expect(effectiveMatchBand(undefined, true)).toBe('suggest')
    expect(effectiveMatchBand({ band: 'yes' } as unknown as MatchVerdict, true)).toBe('suggest')
    expect(effectiveMatchBand('auto' as unknown as MatchVerdict, true)).toBe('suggest')
    expect(effectiveMatchBand(verdict('auto'), 'true' as unknown as boolean)).toBe('suggest')
  })
})

describe('ISRC origins', () => {
  it('validates an origin read from storage', () => {
    for (const origin of [
      'catalog',
      'musicbrainz-exact',
      'musicbrainz-exact-several',
      'musicbrainz-fuzzy',
    ]) {
      expect(isIsrcOrigin(origin)).toBe(true)
    }
    expect(isIsrcOrigin('musicbrainz-guess')).toBe(false)
    expect(isIsrcOrigin(undefined)).toBe(false)
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

  it('takes valid overrides and keeps the default for anything else', () => {
    expect(resolveMatchThresholds()).toEqual(DEFAULT_MATCH_THRESHOLDS)
    expect(resolveMatchThresholds({ auto: 0.9, windowMs: 0, isrcTopItems: 3 })).toEqual({
      ...DEFAULT_MATCH_THRESHOLDS,
      auto: 0.9,
      windowMs: 0,
      isrcTopItems: 3,
    })
    expect(
      resolveMatchThresholds({
        auto: null,
        autoTitle: Number.NaN,
        suggest: 1.5,
        margin: '0.1',
        windowMs: -1,
        windowRatio: Number.POSITIVE_INFINITY,
        isrcTopItems: 2.5,
        isrcTitle: -0.1,
      }),
    ).toEqual(DEFAULT_MATCH_THRESHOLDS)
    expect(resolveMatchThresholds('strict')).toEqual(DEFAULT_MATCH_THRESHOLDS)
    expect(resolveMatchThresholds({ isrcTopItems: 0 })).toEqual(DEFAULT_MATCH_THRESHOLDS)
  })
})

describe('sanitizeMatchOptions', () => {
  it('keeps exactly what is valid', () => {
    expect(sanitizeMatchOptions(undefined)).toEqual({})
    expect(sanitizeMatchOptions('auto')).toEqual({})
    expect(
      sanitizeMatchOptions({
        auto: 'false',
        mode: 'everything',
        requireReleaseAgreement: 1,
        thresholds: { auto: null },
      }),
    ).toEqual({})
    expect(
      sanitizeMatchOptions({
        auto: true,
        mode: 'all',
        requireReleaseAgreement: true,
        thresholds: { margin: 0.1, auto: 2 },
        extra: 1,
      }),
    ).toEqual({
      auto: true,
      mode: 'all',
      requireReleaseAgreement: true,
      thresholds: { margin: 0.1 },
    })
  })

  it('returns a fresh object every time', () => {
    expect(sanitizeMatchOptions({})).not.toBe(sanitizeMatchOptions({}))
  })
})
