import { type HomeShelf, type HomeTrack, isTrackSeed, type Track } from '@fxm/core'
import { afterEach, describe, expect, it } from 'vitest'
import type { NewPlay } from '../../db/repo'
import { testRepo } from '../../test/library-fixtures'
import {
  buildHomeFeed,
  createCollectionCache,
  type FeedRequest,
  type HomeFeedResult,
  loadTasteProfile,
} from './feed'
import type { HomeRecommendations, HomeServices } from './services'
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
/** Every song on a shelf, a mix's included. */
const listed = (shelf: HomeShelf): readonly HomeTrack[] =>
  shelf.type === 'daily-mixes'
    ? shelf.mixes.flatMap((mix) => mix.tracks)
    : shelf.type === 'source'
      ? []
      : shelf.items

/** Lets what is still on its way settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

/** Plays that the user skipped at once. */
function skips(track: Track, ...daysAgo: number[]): NewPlay[] {
  return daysAgo.map((days) => ({
    track,
    playedAt: NOW - days * DAY,
    playedMs: 0,
    completed: false,
    skipped: true,
  }))
}

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

  it('brings in a recent song the user skips at once, which the top of the affinity leaves out', async () => {
    const repo = await library()
    const skipped = song('g1', 'Glass Song', 'Glass Choir')
    await repo.recordPlays(skips(skipped, 1, 1.5))
    const profile = await loadTasteProfile(repo)
    const entry = profile.tracks?.find((one) => one.entry.key === 'youtube:track:g1')
    expect(entry?.entry).toMatchObject({ score: 0, plays: 2 })
    expect(entry?.entry.skips).toBeGreaterThan(1)
    // With its metadata, so other sources' listings of the song count as skipped too.
    expect(entry?.track).toEqual(skipped)
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

  it("takes Spotify's sections from the account's sync when it keeps them", async () => {
    const synced = {
      id: 'spotify:section:made-for-you',
      title: 'Made For You',
      items: [{ type: 'track' as const, track: song('s1', 'Somewhere', 'Halcyon') }],
    }
    const asked: string[] = []
    const spotifyAccount = {
      ...fakeSpotifyAccount(true),
      async sections() {
        asked.push('sections')
        return [synced]
      },
    }
    const sections = async (services: HomeServices) =>
      (await build(services)).shelves
        .filter((shelf) => shelf.type === 'source')
        .map((shelf) => shelf.id)
    // With the recommendation sources too, their home isn't asked for Spotify's sections.
    const recommendations = fakeRecommendations({
      home: [
        {
          source: 'spotify',
          shelf: {
            id: 'generic',
            title: 'Generic',
            items: [{ type: 'track' as const, track: a1 }],
          },
        },
      ],
    })
    expect(await sections(homeServices('full', { recommendations, spotifyAccount }))).toEqual([
      'spotify:spotify:section:made-for-you',
    ])
    // Without recommendation sources (stage 3.2 not wired in), the sync's sections still show.
    expect(await sections(homeServices('full', { spotifyAccount }))).toEqual([
      'spotify:spotify:section:made-for-you',
    ])
    // Not connected, switched off or unreachable: not asked.
    asked.length = 0
    expect(
      await sections(
        homeServices('full', {
          spotifyAccount: { ...fakeSpotifyAccount(false), sections: spotifyAccount.sections },
        }),
      ),
    ).toEqual([])
    expect(await sections(homeServices('full', { spotifyAccount, spotifyEnabled: false }))).toEqual(
      [],
    )
    expect(await sections(homeServices('lite', { spotifyAccount }))).toEqual([])
    expect(asked).toEqual([])
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

  it('stops at once when cancelled, even while the sources have yet to answer', async () => {
    const controller = new AbortController()
    const silent: HomeRecommendations = {
      collect: () => new Promise(() => {}),
      home: async () => ({ shelves: [] }),
    }
    const spotifyAccount = { status: () => new Promise<never>(() => {}) }
    const building = build(homeServices('full', { recommendations: silent, spotifyAccount }), {
      signal: controller.signal,
      deadlineMs: 60_000,
    })
    await settle()
    controller.abort(new Error('Left Home'))
    await expect(building).rejects.toThrow('Left Home')
  })

  it('leaves out what the user skips, and offers nothing they played long ago as new', async () => {
    const repo = await library()
    const skipped = song('g1', 'Glass Song', 'Glass Choir')
    const old = song('o1', 'Old Song', 'Halcyon')
    await repo.recordPlays([...skips(skipped, 7, 8, 9), ...plays(old, 100)])
    const recommendations = fakeRecommendations({
      radio: { '*': [old, skipped, ...variedSongs('r', 40)] },
    })
    // A profile window too small for either: only the candidates' own affinity tells.
    const feed = await build(homeServices('lite', { recommendations }), {
      repo,
      profileLimits: { tracks: 8, artists: 120, tags: 60, recent: 5 },
    })
    const recommended = feed.shelves.filter((shelf) =>
      ['quick-picks', 'discover', 'because', 'daily-mixes'].includes(shelf.type),
    )
    expect(types(recommended)).toEqual(expect.arrayContaining(['quick-picks', 'discover']))
    for (const shelf of recommended) {
      for (const item of listed(shelf)) {
        const where = `${item.track.title} on ${shelf.id}`
        // Skipped at once, three times: the song and its artist stay out.
        expect(item.track.artists[0]?.name, where).not.toBe('Glass Choir')
        if (item.track.id !== old.id) continue
        expect(['discover', 'because', 'daily-mixes'], where).not.toContain(shelf.type)
        expect(item.familiar, where).toBe(true)
      }
    }
  })

  it('forgets the kept Discover and mixes with the history they came from', async () => {
    const repo = await library()
    const radio = (prefix: string) =>
      homeServices('lite', {
        recommendations: fakeRecommendations({ radio: { '*': variedSongs(prefix, 100) } }),
      })
    const first = await build(radio('r'), { repo })
    expect(types(first.shelves)).toEqual(expect.arrayContaining(['discover', 'daily-mixes']))
    expect(stored.size).toBe(1)
    await repo.clearHistory()
    const later = await build(radio('x'), { repo, now: NOW + HOUR })
    // Only the like is left, and what Home shows grows from it: nothing kept from the plays.
    expect(later.coldStart).toBe(true)
    const shown = later.shelves.flatMap(listed)
    expect(shown.length).toBeGreaterThan(0)
    expect(shown.filter((item) => /^ytm:track:r\d/u.test(item.track.id))).toEqual([])
    expect(shown.filter((item) => item.track.id === a1.id)).toEqual([])
  })

  it('keeps lists for their period only from a build that heard from every source', async () => {
    const repo = await library()
    const partial = await build(
      homeServices('lite', {
        recommendations: fakeRecommendations({
          radio: { '*': variedSongs('r', 100) },
          failing: ['Static Bloom'],
        }),
      }),
      { repo },
    )
    expect(partial.complete).toBe(false)
    expect(types(partial.shelves)).toContain('discover')
    expect(stored.size).toBe(0)
    const whole = await build(
      homeServices('lite', {
        recommendations: fakeRecommendations({ radio: { '*': variedSongs('r', 100) } }),
      }),
      { repo },
    )
    expect(whole.complete).toBe(true)
    expect(stored.size).toBe(1)
  })

  it("keeps no lists from a build where YouTube Music's radio skipped a seed", async () => {
    const repo = await library()
    const cache = createCollectionCache()
    let skipping = true
    const fake = fakeRecommendations({ radio: { '*': variedSongs('r', 100) } })
    const recommendations: HomeRecommendations = {
      async collect(seed, ctx, options) {
        const name = isTrackSeed(seed) ? seed.title : seed.name
        // As for a track of another source whose match isn't surely its own song.
        if (skipping && name === 'Static Bloom') {
          return { candidates: [], outcomes: [{ source: 'ytm', part: 'radio', status: 'skipped' }] }
        }
        const { candidates } = await fake.collect(seed, ctx, options)
        const outcomes = [
          { source: 'ytm', part: 'radio', status: 'ok' },
          // Other sources' skips don't count: Spotify has no radio for a song it lacks.
          { source: 'spotify', part: 'radio', status: 'skipped' },
        ]
        return { candidates, outcomes }
      },
      home: fake.home,
    }
    const services = homeServices('lite', { recommendations })
    const skipped = await build(services, { repo, cache })
    // Home shows what the other seeds brought, as a whole build...
    expect(skipped.complete).toBe(true)
    expect(types(skipped.shelves)).toContain('discover')
    // ...but doesn't keep it for the week, nor while the collection comes from the cache.
    expect(stored.size).toBe(0)
    await build(services, { repo, cache, now: NOW + 10 * 60_000 })
    expect(stored.size).toBe(0)
    // Once every seed has its radio, the lists are kept.
    skipping = false
    await build(services, { repo, cache, now: NOW + 31 * 60_000 })
    expect(stored.size).toBe(1)
  })

  it("builds from what arrived when a source doesn't answer in time, and caches the rest", async () => {
    const repo = await library()
    let answer = () => {}
    const late = new Promise<void>((resolve) => {
      answer = resolve
    })
    const fake = fakeRecommendations({ radio: { '*': variedSongs('r', 60) } })
    const asked: string[] = []
    const recommendations: HomeRecommendations = {
      async collect(seed, ctx, options) {
        const name = isTrackSeed(seed) ? seed.title : seed.name
        asked.push(name)
        if (name === 'Static Bloom') await late
        return fake.collect(seed, ctx, options)
      },
      home: fake.home,
    }
    const cache = createCollectionCache()
    const services = homeServices('lite', { recommendations })
    const feed = await build(services, { repo, cache, deadlineMs: 50 })
    expect(feed.complete).toBe(false)
    expect(types(feed.shelves)).toEqual(expect.arrayContaining(['quick-picks', 'on-repeat']))
    expect(stored.size).toBe(0)
    // The slow collection comes in after all, and serves the next build.
    answer()
    await settle()
    const next = await build(services, { repo, cache, deadlineMs: 50 })
    expect(next.complete).toBe(true)
    expect(asked.filter((name) => name === 'Static Bloom')).toHaveLength(1)
    expect(stored.size).toBe(1)
  })

  it("hands over the user's own shelves first, while the sources are asked", async () => {
    const locals: HomeFeedResult[] = []
    const onLocal = (feed: HomeFeedResult) => void locals.push(feed)
    const feed = await build(
      homeServices('lite', {
        recommendations: fakeRecommendations({ radio: { '*': variedSongs('r', 40) } }),
      }),
      { onLocal },
    )
    expect(locals.map((local) => [local.phase, types(local.shelves)])).toEqual([
      ['local', ['on-repeat', 'rediscover']],
    ])
    expect(feed.phase).toBe('full')
    expect(types(feed.shelves)).toContain('quick-picks')
    for (const type of ['on-repeat', 'rediscover'] as const) {
      expect(titles(feed.shelves.find((shelf) => shelf.type === type))).toEqual(
        titles(locals[0]?.shelves.find((shelf) => shelf.type === type)),
      )
    }
    // With nothing to ask, there is one pass only.
    await build(homeServices('free'), { onLocal })
    expect(locals).toHaveLength(1)
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
