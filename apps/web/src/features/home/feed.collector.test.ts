// Home with stage 3.2's real collector behind the seam: the collector's candidate format goes
// into the engine as it is, and its tier and Spotify rules hold on Home.
import { isTrackSeed, type RadioSeed, type Track } from '@fxm/core'
import { createRecommendationCollector } from '@fxm/sources/recommend'
import { fakeRadio, spotifyTrack } from '@fxm/sources/recommend/testing'
import { describe, expect, it } from 'vitest'
import { testRepo } from '../../test/library-fixtures'
import { buildHomeFeed, createCollectionCache } from './feed'
import type { HomeRecommendations } from './services'
import { createStableStore } from './stable-storage'
import { fakeSpotifyAccount, homeServices, song, variedSongs } from './testing'

const NOW = Date.UTC(2026, 9, 25, 12)
const DAY = 24 * 60 * 60 * 1000

const favourites = [
  song('a1', 'Copper Sun', 'Aurora Lane'),
  song('b1', 'Static Bloom', 'Basalt'),
  song('c1', 'Harbor Lights', 'Cinder'),
]

async function library() {
  const repo = testRepo({ now: () => NOW })
  await repo.recordPlays(
    favourites.flatMap((track, index) =>
      [1, 2, 3].map((days) => ({
        track,
        playedAt: NOW - (days + index / 10) * DAY,
        playedMs: 200_000,
        completed: true,
        skipped: false,
      })),
    ),
  )
  return repo
}

/** YouTube Music radio: twenty varied songs per seed. */
const youtube = fakeRadio('ytm', (seed: RadioSeed) =>
  variedSongs(`${isTrackSeed(seed) ? seed.title : seed.name} radio`.replace(/\s+/gu, '-'), 20),
)

/** Spotify's radio and home feed. */
const spotify = fakeRadio(
  'spotify',
  (seed: RadioSeed): Track[] =>
    Array.from({ length: 6 }, (_, index) =>
      spotifyTrack(
        `sp${index}${isTrackSeed(seed) ? seed.title.length : 0}`,
        `Spotify pick ${index}`,
        `Artist ${index}`,
      ),
    ),
  [
    {
      id: 'made-for-you',
      title: 'Made For You',
      items: [{ type: 'track', track: spotifyTrack('x', 'Somewhere', 'Halcyon') }],
    },
  ],
)

async function build(tier: 'lite' | 'full', spotifyEnabled = true) {
  const collector = createRecommendationCollector({
    youtube,
    spotify,
    spotifyEnabled: () => spotifyEnabled,
  })
  // The collector is Home's recommendation seam as it is.
  const recommendations: HomeRecommendations = collector
  const stored = new Map<string, string>()
  return buildHomeFeed({
    mode: 'music',
    services: homeServices(tier, {
      recommendations,
      spotifyAccount: fakeSpotifyAccount(true),
      spotifyEnabled,
    }),
    repo: await library(),
    stable: createStableStore(
      () =>
        ({
          getItem: (key: string) => stored.get(key) ?? null,
          setItem: (key: string, value: string) => void stored.set(key, value),
          removeItem: (key: string) => void stored.delete(key),
        }) as unknown as Storage,
    ),
    now: NOW,
    utcOffsetMinutes: 0,
    cache: createCollectionCache(),
    artists: new Map(),
  })
}

describe('Home with the recommendation collector', () => {
  it('builds its shelves from YouTube Music radio in the Lite tier, without Spotify', async () => {
    const feed = await build('lite')
    expect(feed.shelves.map((shelf) => shelf.type)).toEqual(
      expect.arrayContaining(['quick-picks', 'discover', 'because']),
    )
    const shown = feed.shelves.flatMap((shelf) =>
      shelf.type === 'daily-mixes' || shelf.type === 'source' ? [] : shelf.items,
    )
    expect(shown.some((item) => item.track.source === 'spotify')).toBe(false)
    expect(feed.shelves.some((shelf) => shelf.type === 'source')).toBe(false)
  })

  it("adds Spotify's radio and a connected account's sections in the Full tier", async () => {
    const feed = await build('full')
    expect(feed.spotifyConnected).toBe(true)
    expect(
      feed.shelves.filter((shelf) => shelf.type === 'source').map((shelf) => shelf.id),
    ).toEqual(['spotify:made-for-you'])
  })

  it('leaves Spotify out when it is switched off', async () => {
    const feed = await build('full', false)
    expect(feed.spotifyConnected).toBe(false)
    expect(feed.shelves.some((shelf) => shelf.type === 'source')).toBe(false)
  })
})
