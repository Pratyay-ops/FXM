// Home with stage 3.2's real collector behind the seam: the collector's candidate format goes
// into the engine as it is, and its tier and Spotify rules hold on Home.
import { formatId, isTrackSeed, type RadioSeed, type Track } from '@fxm/core'
import { createRecommendationCollector } from '@fxm/sources/recommend'
import { fakeRadio, fakeYouTubeSeed, spotifyTrack } from '@fxm/sources/recommend/testing'
import { describe, expect, it } from 'vitest'
import { testRepo } from '../../test/library-fixtures'
import { buildHomeFeed, createCollectionCache } from './feed'
import type { HomeRecommendations } from './services'
import { createStableStore } from './stable-storage'
import { fakeSpotifyAccount, homeServices, song, songsBy, variedSongs } from './testing'

const NOW = Date.UTC(2026, 9, 25, 12)
const DAY = 24 * 60 * 60 * 1000

// Real-looking YouTube video IDs (11 characters): the collector seeds YouTube Music radio only
// from those.
const favourites = [
  song('copperSun01', 'Copper Sun', 'Aurora Lane'),
  song('staticBloom', 'Static Bloom', 'Basalt'),
  song('harborLight', 'Harbor Lights', 'Cinder'),
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

describe('Home after a play from another source', () => {
  // A fresh profile that played a YouTube Music song and an Internet Archive track, once each.
  const anthem = song('basementAnt', 'Basement Anthem', 'Rivet Kids')
  const rag: Track = {
    id: formatId('archive', 'track', 'harbor_rag_rolls/harbor_rag.mp3'),
    source: 'archive',
    title: 'Harbor rag (Opal Rivers)',
    artists: [{ name: 'Opal Rivers, piano rolls' }],
    artwork: [],
    durationMs: 190_000,
    kind: 'song',
  }
  // The rag's own song on YouTube Music, and another song a weak match may find instead.
  const ownSong = song('harborRag01', 'Harbor Rag', 'Opal Rivers')
  const wrongSong = song('wheelsRound', 'Wheels Go Round', 'Little Sprouts TV')
  const radios = new Map<string, Track[]>([
    [anthem.id, variedSongs('punk', 20)],
    [ownSong.id, [...songsBy('Opal Rivers', 'opal', 4), ...variedSongs('rag', 16)]],
    // What the report found: kids' channels and regional pop.
    [
      wrongSong.id,
      [...songsBy('Little Sprouts TV', 'kids', 10), ...songsBy('Coastal Hits', 'pop', 10)],
    ],
  ])

  async function homeWith(match: Track) {
    const repo = testRepo({ now: () => NOW })
    await repo.recordPlays(
      [anthem, rag].map((track, index) => ({
        track,
        playedAt: NOW - (2 - index) * 60 * 60 * 1000,
        playedMs: 190_000,
        completed: true,
        skipped: false,
      })),
    )
    const youtube = fakeRadio('ytm', (seed: RadioSeed) =>
      isTrackSeed(seed) ? (radios.get(seed.id) ?? []) : [],
    )
    // The app's matching engine, as `youtubeSeed`: the Internet Archive track's song.
    const youtubeSeed = fakeYouTubeSeed((seed) =>
      isTrackSeed(seed) && seed.id === rag.id ? match : null,
    )
    const recommendations: HomeRecommendations = createRecommendationCollector({
      youtube,
      youtubeSeed,
    })
    const stored = new Map<string, string>()
    const feed = await buildHomeFeed({
      mode: 'music',
      services: homeServices('lite', { recommendations }),
      repo,
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
    const shown = feed.shelves.flatMap((shelf) =>
      shelf.type === 'daily-mixes'
        ? shelf.mixes.flatMap((mix) => mix.tracks)
        : shelf.type === 'source'
          ? []
          : shelf.items,
    )
    const because = feed.shelves.flatMap((shelf) =>
      shelf.type === 'because' ? [shelf.seed.name] : [],
    )
    return { feed, shown, because, kept: stored.size > 0, asked: youtube.seeds }
  }

  it("builds no shelf from the radio of the track's match when it is another song", async () => {
    const { shown, because, kept, asked } = await homeWith(wrongSong)
    expect(asked).not.toContainEqual(wrongSong)
    expect(shown.filter((item) => /^ytm:track:(kids|pop)/u.test(item.track.id))).toEqual([])
    expect(because).toEqual(['Basement Anthem'])
    // A Home without the track's radio isn't kept for the week.
    expect(kept).toBe(false)
  })

  it("builds the track's Because shelf from the radio of its own song", async () => {
    const { shown, because, kept, asked } = await homeWith(ownSong)
    expect(asked).toContainEqual(ownSong)
    expect(because).toEqual(['Harbor rag (Opal Rivers)', 'Basement Anthem'])
    expect(shown.some((item) => item.track.artists[0]?.name === 'Opal Rivers')).toBe(true)
    expect(kept).toBe(true)
  })
})
