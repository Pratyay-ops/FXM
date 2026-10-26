import { describe, expect, it } from 'vitest'
import { TIER_CAPABILITIES } from './testing'
import {
  featuresAddedBy,
  hasFeature,
  includesTier,
  missingFeatures,
  missingSummary,
  TIER_FEATURES,
  TIER_INFO,
  tierLabel,
  tierOf,
} from './tiers'

describe('tierOf', () => {
  it('follows YouTube access: full is Full, simple is Lite, none is Free only', () => {
    expect(tierOf(TIER_CAPABILITIES.full)).toBe('full')
    expect(tierOf(TIER_CAPABILITIES.lite)).toBe('lite')
    expect(tierOf(TIER_CAPABILITIES.free)).toBe('free')
  })

  it('ignores Spotify: reaching it without YouTube is still Free only', () => {
    expect(tierOf({ youtube: 'none' })).toBe('free')
  })
})

describe('the tiers', () => {
  it('names Lite as experimental and the others plainly', () => {
    expect(tierLabel('lite')).toBe('Lite (experimental)')
    expect(tierLabel('free')).toBe('Free only')
    expect(tierLabel('full')).toBe('Full')
  })

  it('stack: each has everything the one below has', () => {
    expect(includesTier('full', 'lite')).toBe(true)
    expect(includesTier('lite', 'free')).toBe(true)
    expect(includesTier('free', 'lite')).toBe(false)
    expect(includesTier('lite', 'full')).toBe(false)
    for (const feature of TIER_FEATURES) expect(hasFeature('full', feature)).toBe(true)
  })

  it('gives Free only the free sources, the library, lyrics and local files', () => {
    expect(featuresAddedBy('free').map((feature) => feature.id)).toEqual([
      'free-sources',
      'library',
      'lyrics',
      'local-files',
    ])
    // Stage 4.4 plays them in every browser: a folder in Chromium, picked files elsewhere.
    expect(featuresAddedBy('free').find((feature) => feature.id === 'local-files')?.released).toBe(
      true,
    )
  })

  it('gives Lite YouTube Music and Full Spotify, never Spotify in Lite', () => {
    expect(featuresAddedBy('lite').map((feature) => feature.id)).toEqual([
      'youtube-music',
      'youtube-audio',
    ])
    const spotify = TIER_FEATURES.find((feature) => feature.id === 'spotify')
    expect(spotify?.from).toBe('full')
    if (spotify !== undefined) expect(hasFeature('lite', spotify)).toBe(false)
  })

  it('marks the apps of Full as coming soon until they are out', () => {
    expect(TIER_INFO.full.how).toBe(
      'FXM Connect, the desktop app or the Android app (coming soon).',
    )
  })

  it('keeps downloads and the Spotify account to Full, marked unreleased for now', () => {
    for (const id of ['downloads', 'spotify-account']) {
      const feature = TIER_FEATURES.find((candidate) => candidate.id === id)
      expect(feature).toMatchObject({ from: 'full', released: false })
    }
  })
})

describe('missingFeatures', () => {
  it('lists what Lite and Full would add to Free only, lowest tier first', () => {
    const missing = missingFeatures('free')
    expect(missing.map((group) => group.tier)).toEqual(['lite', 'full'])
    expect(missing[0]?.features.map((feature) => feature.id)).toContain('youtube-music')
    expect(missing[1]?.features.map((feature) => feature.id)).toContain('spotify')
  })

  it('lists only what Full adds to Lite, and nothing for Full', () => {
    expect(missingFeatures('lite').map((group) => group.tier)).toEqual(['full'])
    expect(missingFeatures('full')).toEqual([])
  })
})

describe('missingSummary', () => {
  it('sums up what Lite and Full would add to Free only, with what comes later', () => {
    expect(missingSummary('free')).toEqual([
      { tier: 'lite', adds: 'YouTube Music and its ad-free audio' },
      {
        tier: 'full',
        adds: "YouTube Music without Lite's experimental route, and Spotify search and related artists",
        later: 'A read-only sync of your Spotify account and downloads are coming soon.',
      },
    ])
  })

  it('sums up only what Full adds to Lite, and nothing for Full', () => {
    expect(missingSummary('lite').map((line) => line.tier)).toEqual(['full'])
    expect(missingSummary('full')).toEqual([])
  })
})
