import type { HomeShelf, Track } from '@fxm/core'
import { afterEach, describe, expect, it } from 'vitest'
import type { NewPlay } from '../../db/repo'
import { testRepo } from '../../test/library-fixtures'
import { buildHomeFeed, createCollectionCache, type FeedRequest, loadTasteProfile } from './feed'
import type { HomeServices } from './services'
import { createStableStore } from './stable-storage'
import {
  fakeCatalog,
  fakeRecommendations,
  fakeSpotifyAccount,
  homeServices,
  song,
  songsBy,
  variedSongs,
  ytmArtist,
} from './testing'

/** The test clock: Sunday 2026-10-25, 12:00 UTC, as `testRepo` starts. */
const NOW = Date.UTC(2026, 9, 25, 12)
const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

const [a1, a2, a3] = songsBy('Aurora Lane', 'a', 3) as [Track, Track, Track]
const b1 = song('b1', 'Static Bloom', 'Basalt')
const c1 = song('c1', 'Harbor Lights', 'Cinder')
const [d1, d2] = songsBy('Dune Theory', 'd', 2) as [Track, Track]
const e1 = song('e1', 'Old Ember', 'Ember Fold')

function plays(track: Track, ...daysAgo: number[]): NewPlay[] {
  return daysAgo.map((days) => ({
    track,
    playedAt: NOW - days * DAY,
    playedMs: 200_000,
    completed: true,
    skipped: false,
  }))
}

/** A library with recent favourites and old ones. */
async function library() {
  const repo = testRepo({ now: () => NOW })
  await repo.recordPlays([
    ...plays(a1, 2, 3, 4, 5, 6),
    ...plays(a2, 2.5, 4.5),
    ...plays(a3, 3.5),
    ...plays(b1, 2.2, 5.2),
    ...plays(c1, 2.4, 2.6),
    ...plays(d1, 60, 61, 62, 63),
    ...plays(d2, 60.5, 61.5, 62.5),
    ...plays(e1, 50, 51, 52),
  ])
  await repo.like(b1)
  return repo
}

const stored = new Map<string, string>()
const storage = {
  getItem: (key: string) => stored.get(key) ?? null,
  setItem: (key: string, value: string) => void stored.set(key, value),
  removeItem: (key: string) => void stored.delete(key),
} as unknown as Storage

afterEach(() => stored.clear())

async function build(services: HomeServices, extra: Partial<FeedRequest> = {}) {
  return buildHomeFeed({
    mode: 'music',
    services,
    repo: extra.repo ?? (await library()),
    stable: createStableStore(() => storage),
    now: NOW,
    utcOffsetMinutes: 0,
    cache: createCollectionCache(),
    artists: new Map(),
    ...extra,
  })
}

const types = (shelves: readonly HomeShelf[]) => shelves.map((shelf) => shelf.type)
const titles = (shelf: HomeShelf | undefined) =>
  shelf === undefined || shelf.type === 'daily-mixes' || shelf.type === 'source'
    ? []
    : shelf.items.map((item) => item.track.title)

describe('loadTasteProfile', () => {
  it('reads the affinity, the tracks it names and the recent plays from the library', async () => {
    const repo = await library()
    const profile = await loadTasteProfile(repo, {
      artists: [{ name: 'Kestrel' }],
      genres: [],
      at: NOW,
    })
    expect(profile.tracks?.find(({ entry }) => entry.key === 'youtube:track:a1')?.track).toEqual(a1)
    expect(profile.artists?.map((entry) => entry.label)).toContain('Aurora Lane')
    expect(profile.recent?.[0]).toMatchObject({ trackId: a1.id, track: a1 })
    expect(profile.picks?.artists).toEqual([{ name: 'Kestrel' }])
  })
})

describe('buildHomeFeed', () => {
  it("keeps to the user's own music in the Free-only tier", async () => {
    const recommendations = fakeRecommendations({ radio: { '*': variedSongs('r', 30) } })
    const feed = await build(homeServices('free', { recommendations }))
    expect(feed.recommending).toBe(false)
    expect(recommendations.calls).toEqual([])
    expect(types(feed.shelves)).toEqual(['on-repeat', 'rediscover'])
    expect(titles(feed.shelves[1]).sort()).toEqual([
      'Dune Theory Song 1',
      'Dune Theory Song 2',
      'Old Ember',
    ])
  })

  it('collects for every planned seed, with its parts, where YouTube Music is reachable', async () => {
    const recommendations = fakeRecommendations({ radio: { '*': variedSongs('r', 40) } })
    const feed = await build(homeServices('lite', { recommendations }))
    expect(feed.recommending).toBe(true)
    expect(
      recommendations.calls.map(({ seed }) => ('title' in seed ? seed.title : seed.name)),
    ).toEqual(['Aurora Lane Song 1', 'Static Bloom', 'Harbor Lights'])
    expect(recommendations.calls[0]?.parts).toEqual(['radio', 'similar-artists', 'station'])
    expect(types(feed.shelves)).toEqual(
      expect.arrayContaining(['quick-picks', 'discover', 'because', 'on-repeat', 'rediscover']),
    )
    expect(feed.shelves.some((shelf) => shelf.type === 'source')).toBe(false)
  })

  it("shows Spotify's sections only when Spotify is on, reachable and connected", async () => {
    const home = [
      {
        source: 'spotify',
        shelf: {
          id: 'made-for-you',
          title: 'Made For You',
          items: [{ type: 'track' as const, track: song('s1', 'Somewhere', 'Halcyon') }],
        },
      },
      {
        source: 'ytm',
        shelf: { id: 'charts', title: 'Charts', items: [{ type: 'track' as const, track: a1 }] },
      },
    ]
    const sections = async (services: HomeServices) =>
      (await build(services)).shelves
        .filter((shelf) => shelf.type === 'source')
        .map((shelf) => shelf.id)
    const connected = fakeSpotifyAccount(true)
    expect(
      await sections(
        homeServices('full', {
          recommendations: fakeRecommendations({ home }),
          spotifyAccount: connected,
        }),
      ),
    ).toEqual(['spotify:made-for-you'])
    expect(
      await sections(
        homeServices('full', {
          recommendations: fakeRecommendations({ home }),
          spotifyAccount: connected,
          spotifyEnabled: false,
        }),
      ),
    ).toEqual([])
    expect(
      await sections(
        homeServices('full', {
          recommendations: fakeRecommendations({ home }),
          spotifyAccount: fakeSpotifyAccount(false),
        }),
      ),
    ).toEqual([])
    expect(
      await sections(
        homeServices('full', {
          recommendations: fakeRecommendations({ home }),
          spotifyAccount: fakeSpotifyAccount(new Error('Spotify is paused')),
        }),
      ),
    ).toEqual([])
    expect(
      await sections(
        homeServices('lite', {
          recommendations: fakeRecommendations({ home }),
          spotifyAccount: connected,
        }),
      ),
    ).toEqual([])
  })

  it('turns the best similar artists and song searches into tracks through the catalog', async () => {
    const recommendations = fakeRecommendations({
      radio: { '*': variedSongs('r', 12) },
      similar: { 'Aurora Lane Song 1': ['Lumen Bay', 'Moss Avenue'] },
      searches: { 'Aurora Lane Song 1': [['Opal Rivers', 'Night Drive']] },
    })
    const catalog = fakeCatalog({
      topTracks: {
        'Lumen Bay': songsBy('Lumen Bay', 'l', 5),
        'Moss Avenue': songsBy('Moss Avenue', 'm', 5),
      },
      songs: { 'Night Drive': song('o1', 'Night Drive', 'Opal Rivers') },
    })
    const feed = await build(homeServices('lite', { recommendations, catalog }))
    expect(catalog.asked).toEqual(
      expect.arrayContaining(['tracks:Lumen Bay', 'tracks:Moss Avenue', 'song:Night Drive']),
    )
    const shown = feed.shelves.flatMap((shelf) =>
      shelf.type === 'daily-mixes'
        ? shelf.mixes.flatMap((mix) => mix.tracks.map((item) => item.track.title))
        : titles(shelf),
    )
    expect(shown).toEqual(expect.arrayContaining(['Lumen Bay Song 1', 'Night Drive']))
  })

  it("starts YouTube Music's radio from the onboarding picks' own artists", async () => {
    const recommendations = fakeRecommendations({ radio: { '*': variedSongs('r', 20) } })
    const catalog = fakeCatalog({
      artists: {
        'Fable Kin': ytmArtist('Fable Kin', 'UCfable'),
        // A search that finds someone else is no answer.
        'Glass Choir': ytmArtist('The Glass Choir Tribute', 'UCother'),
      },
    })
    const feed = await build(homeServices('lite', { recommendations, catalog }), {
      repo: testRepo({ now: () => NOW }),
      picks: {
        artists: [{ name: 'Fable Kin' }, { name: 'Glass Choir' }, { name: 'Halcyon' }],
        genres: ['Dream Pop'],
        at: NOW - HOUR,
      },
    })
    expect(feed.coldStart).toBe(false)
    expect(recommendations.calls.map(({ seed }) => seed)).toEqual([
      { name: 'Fable Kin', id: 'ytm:artist:UCfable' },
      { name: 'Glass Choir' },
      { name: 'Halcyon' },
    ])
    expect(feed.shelves.length).toBeGreaterThan(0)
  })

  it('asks for onboarding when it knows nothing yet', async () => {
    const feed = await build(homeServices('lite', { recommendations: fakeRecommendations() }), {
      repo: testRepo({ now: () => NOW }),
    })
    expect(feed.coldStart).toBe(true)
    expect(feed.shelves).toEqual([])
  })

  it('reuses collections for half an hour', async () => {
    const recommendations = fakeRecommendations({ radio: { '*': variedSongs('r', 20) } })
    const cache = createCollectionCache()
    const repo = await library()
    const services = homeServices('lite', { recommendations })
    await build(services, { repo, cache })
    const first = recommendations.calls.length
    await build(services, { repo, cache, now: NOW + 10 * 60_000 })
    expect(recommendations.calls).toHaveLength(first)
    await build(services, { repo, cache, now: NOW + 31 * 60_000 })
    expect(recommendations.calls).toHaveLength(2 * first)
  })

  it('keeps Discover for the week in storage', async () => {
    const repo = await library()
    const first = await build(
      homeServices('lite', {
        recommendations: fakeRecommendations({ radio: { '*': variedSongs('r', 100) } }),
      }),
      { repo },
    )
    const discover = first.shelves.find((shelf) => shelf.type === 'discover')
    expect(titles(discover).length).toBeGreaterThanOrEqual(10)
    const later = await build(
      homeServices('lite', {
        recommendations: fakeRecommendations({ radio: { '*': variedSongs('x', 100) } }),
      }),
      { repo, now: NOW + DAY },
    )
    // Sunday to Monday is a new week.
    expect(titles(later.shelves.find((shelf) => shelf.type === 'discover'))).not.toEqual(
      titles(discover),
    )
    const sameWeek = await build(
      homeServices('lite', {
        recommendations: fakeRecommendations({ radio: { '*': variedSongs('y', 100) } }),
      }),
      { repo, now: NOW + DAY + HOUR },
    )
    expect(titles(sameWeek.shelves.find((shelf) => shelf.type === 'discover'))).toEqual(
      titles(later.shelves.find((shelf) => shelf.type === 'discover')),
    )
  })

  it('builds from the other seeds when one fails', async () => {
    const recommendations = fakeRecommendations({
      radio: { '*': variedSongs('r', 40) },
      failing: ['Aurora Lane Song 1'],
    })
    const feed = await build(homeServices('lite', { recommendations }))
    expect(types(feed.shelves)).toContain('because')
  })

  it('stops when cancelled', async () => {
    const controller = new AbortController()
    controller.abort(new Error('Left Home'))
    await expect(
      build(homeServices('lite', { recommendations: fakeRecommendations() }), {
        signal: controller.signal,
      }),
    ).rejects.toThrow('Left Home')
  })
})

describe('the collection cache', () => {
  it('keeps no collection that a source failed, and no failed artist search', async () => {
    const repo = await library()
    const cache = createCollectionCache()
    let failing = true
    const calls: string[] = []
    const services = homeServices('lite', {
      recommendations: {
        async collect(seed) {
          calls.push('title' in seed ? seed.title : seed.name)
          return {
            candidates: [],
            outcomes: [{ status: failing ? 'failed' : 'ok' }],
          }
        },
        async home() {
          return { shelves: [] }
        },
      },
    })
    await build(services, { repo, cache })
    const first = calls.length
    expect(first).toBeGreaterThan(0)
    failing = false
    await build(services, { repo, cache })
    expect(calls).toHaveLength(2 * first)
    await build(services, { repo, cache })
    expect(calls).toHaveLength(2 * first)
  })

  it('asks for an artist again after a failed search', async () => {
    let failing = true
    const asked: string[] = []
    const catalog = {
      async findArtist(name: string) {
        asked.push(name)
        if (failing) throw new Error('Offline')
        return ytmArtist(name, `UC-${name}`)
      },
    }
    const recommendations = fakeRecommendations({ radio: { '*': variedSongs('r', 10) } })
    const artists = new Map()
    const picks = {
      artists: [{ name: 'Fable Kin' }, { name: 'Glass Choir' }, { name: 'Halcyon' }],
      genres: [],
      at: NOW - HOUR,
    }
    const repo = testRepo({ now: () => NOW })
    await build(homeServices('lite', { recommendations, catalog }), { repo, picks, artists })
    expect(asked).toHaveLength(3)
    failing = false
    await build(homeServices('lite', { recommendations, catalog }), { repo, picks, artists })
    expect(asked).toHaveLength(6)
    expect(recommendations.calls.at(-1)?.seed).toEqual({
      name: 'Halcyon',
      id: 'ytm:artist:UC-Halcyon',
    })
    await build(homeServices('lite', { recommendations, catalog }), { repo, picks, artists })
    expect(asked).toHaveLength(6)
  })
})
