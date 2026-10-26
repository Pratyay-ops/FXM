import { afterEach, describe, expect, it, vi } from 'vitest'
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

afterEach(() => {
  vi.unstubAllEnvs()
})

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

  it('gives Free only the free sources, the library, lyrics, local files and their downloads', () => {
    expect(featuresAddedBy('free').map((feature) => feature.id)).toEqual([
      'free-sources',
      'library',
      'lyrics',
      'local-files',
      'free-downloads',
    ])
    // Stage 4.4 plays them in every browser: a folder in Chromium, picked files elsewhere.
    expect(featuresAddedBy('free').find((feature) => feature.id === 'local-files')?.released).toBe(
      true,
    )
    // Internet Archive and Jamendo download in every browser, as their files come (stage 4.1),
    // and Save to device converts a copy (stage 4.2).
    expect(
      featuresAddedBy('free').find((feature) => feature.id === 'free-downloads'),
    ).toMatchObject({
      released: true,
      label: 'Downloads of free music for offline listening, to save in the format you want',
    })
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

  it('names Jamendo among the free sources only in a build that offers it', () => {
    const free = TIER_FEATURES.find((feature) => feature.id === 'free-sources')
    expect(TIER_INFO.free.summary).toBe('Free music from Internet Archive.')
    expect(free?.label).toBe('Free music from Internet Archive, in lossless FLAC where it has it')
    expect(free?.short).toBe('free music from Internet Archive')
    vi.stubEnv('VITE_FXM_JAMENDO_CLIENT_ID', 'public-id')
    expect(TIER_INFO.free.summary).toBe('Free music from Internet Archive and Jamendo.')
    expect(free?.label).toBe(
      'Free music from Internet Archive and Jamendo, in lossless FLAC where they have it',
    )
    expect(free?.short).toBe('free music from Internet Archive and Jamendo')
  })

  it('marks the apps of Full as coming soon until they are out', () => {
    expect(TIER_INFO.full.how).toBe(
      'FXM Connect, the desktop app (coming soon) or the Android app (coming soon).',
    )
  })

  it('keeps downloads and the Spotify account to Full, both released', () => {
    const feature = (id: string) => TIER_FEATURES.find((candidate) => candidate.id === id)
    // Stage 3.5: the web app with FXM Connect connects a Spotify account.
    // Out, but experimental: tested with a stand-in for Spotify only, never a real account.
    expect(feature('spotify-account')).toMatchObject({
      from: 'full',
      released: true,
      experimental: true,
    })
    expect(TIER_FEATURES.filter((one) => one.experimental === true).map((one) => one.id)).toEqual([
      'spotify-account',
    ])
    // Downloads are out, and so are conversions (stage 4.2): a download stays the original file,
    // and Save to device converts a copy.
    expect(feature('downloads')).toMatchObject({
      from: 'full',
      released: true,
      label: 'Downloads of YouTube Music songs, to save in the format you want',
    })
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
  it('sums up what Lite and Full would add to Free only, everything released', () => {
    expect(missingSummary('free')).toEqual([
      { tier: 'lite', adds: 'YouTube Music and its ad-free audio' },
      {
        tier: 'full',
        adds: "YouTube Music without Lite's experimental route, YouTube Music downloads, Spotify search and related artists and a read-only sync of your Spotify account (experimental)",
      },
    ])
  })

  it('sums up only what Full adds to Lite, and nothing for Full', () => {
    expect(missingSummary('lite').map((line) => line.tier)).toEqual(['full'])
    expect(missingSummary('full')).toEqual([])
  })

  it('says what comes later in one sentence, whatever the features are called', async () => {
    vi.resetModules()
    vi.doMock('./config', async (importOriginal) => {
      const actual = await importOriginal<typeof import('./config')>()
      return {
        ...actual,
        RELEASED: { ...actual.RELEASED, downloads: false, spotifyAccount: false },
      }
    })
    try {
      const { missingSummary: summary } = await import('./tiers')
      expect(summary('lite')).toEqual([
        {
          tier: 'full',
          adds: "YouTube Music without Lite's experimental route and Spotify search and related artists",
          later:
            'Coming soon: YouTube Music downloads and a read-only sync of your Spotify account.',
        },
      ])
    } finally {
      vi.doUnmock('./config')
      vi.resetModules()
    }
  })
})
