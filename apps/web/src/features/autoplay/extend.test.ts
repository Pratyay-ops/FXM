import {
  createQueue,
  type ProviderContext,
  type QueueState,
  type RadioSeed,
  setQueue,
  type Track,
  trackKeys,
} from '@fxm/core'
import { describe, expect, it } from 'vitest'
import { getLibrary } from '../../db/repo'
import { createCollectionCache, FEED_LIMITS } from '../home/feed'
import type { HomeRecommendations, HomeServices } from '../home/services'
import { useTasteStore } from '../home/taste-store'
import { fakeRecommendations, homeServices, song } from '../home/testing'
import {
  EXTENSION_DEADLINE_MS,
  type ExtensionRequest,
  planAppExtension,
  planExtension,
} from './extend'

const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE

/** `count` songs by `artist`, ids `<prefix>1`…, titled `<artist> <n>`. */
const songs = (artist: string, prefix: string, count: number) =>
  Array.from({ length: count }, (_, index) =>
    song(`${prefix}${index + 1}`, `${artist} ${index + 1}`, artist),
  )

const titles = (tracks: readonly { track: Track }[]) => tracks.map((pick) => pick.track.title)

// The session: Night Swim plays now; Low Tide and Static Bloom played before it.
const nightSwim = song('ns1', 'Night Swim', 'Juniper Coast')
const lowTide = song('lt1', 'Low Tide', 'Dune Theory')
const bloom = song('sb1', 'Static Bloom', 'Basalt')

const radios = {
  'Night Swim': songs('Kestrel', 'k', 3),
  'Low Tide': [...songs('Iris Vale', 'i', 2), ...songs('Lark Avenue', 'l', 2)],
  'Static Bloom': [...songs('Mirror Lake', 'm', 2), ...songs('Northern Fern', 'n', 2)],
}

/** Records a play of `track` that started `ago` ago: heard through, or skipped at once. */
async function played(track: Track, ago: number, skipped = false) {
  await getLibrary().recordPlay({
    track,
    playedAt: Date.now() - ago,
    playedMs: skipped ? 3_000 : 200_000,
    durationMs: 200_000,
    completed: !skipped,
    skipped,
  })
}

async function history() {
  await played(lowTide, 4 * MINUTE)
  await played(bloom, 8 * MINUTE)
}

/** A queue playing `current`, with `upcoming` after it. */
function queueOf(current: Track, upcoming: readonly Track[] = []): QueueState {
  return setQueue(createQueue(), [current, ...upcoming], { startIndex: 0 })
}

/** Full-tier services whose `context` calls are recorded. */
function recordingServices(recommendations: HomeRecommendations) {
  const services = homeServices('full', { recommendations })
  const contexts: Parameters<HomeServices['sources']['context']>[0][] = []
  const { sources } = services
  return {
    contexts,
    services: {
      ...services,
      sources: {
        ...sources,
        context(options: Parameters<typeof sources.context>[0]): ProviderContext {
          contexts.push(options)
          return sources.context(options)
        },
      },
    } satisfies HomeServices,
  }
}

function request(
  services: HomeServices,
  overrides: Partial<ExtensionRequest> = {},
): ExtensionRequest {
  return {
    queue: queueOf(nightSwim),
    count: 4,
    services,
    repo: getLibrary(),
    now: Date.now(),
    cache: createCollectionCache(),
    ...overrides,
  }
}

const seedName = (seed: RadioSeed) => ('title' in seed ? seed.title : seed.name)

describe('planExtension', () => {
  it('fetches one radio per extension, at prefetch priority, and keeps it', async () => {
    await history()
    const recommendations = fakeRecommendations({ radio: radios })
    const { services, contexts } = recordingServices(recommendations)
    const cache = createCollectionCache()

    // Low Tide, heard through just before, weighs more than Night Swim, which is new.
    const first = await planExtension(request(services, { cache }))
    expect(recommendations.calls.map((call) => seedName(call.seed))).toEqual(['Low Tide'])
    expect(recommendations.calls[0]?.parts).toEqual(['radio'])
    expect(contexts).toEqual([
      expect.objectContaining({
        mode: 'music',
        priority: 'prefetch',
        signal: expect.any(AbortSignal),
      }),
    ])
    expect(first.fetched?.ref.name).toBe('Low Tide')
    expect(titles(first.picks)).toHaveLength(4)
    for (const title of titles(first.picks)) expect(title).toMatch(/^(Iris Vale|Lark Avenue)/)

    // The next extension fetches the next play's radio, and blends it with the one kept.
    const second = await planExtension(request(services, { cache }))
    expect(recommendations.calls.map((call) => seedName(call.seed))).toEqual([
      'Low Tide',
      'Static Bloom',
    ])
    expect(titles(second.picks).some((title) => /^(Mirror Lake|Northern Fern)/.test(title))).toBe(
      true,
    )
    expect(titles(second.picks).some((title) => /^(Iris Vale|Lark Avenue)/.test(title))).toBe(true)

    await planExtension(request(services, { cache }))
    // Every seed's radio is at hand: no fetch at all.
    const fourth = await planExtension(request(services, { cache }))
    expect(recommendations.calls).toHaveLength(3)
    expect(fourth.fetched).toBeUndefined()
    expect(fourth.picks).toHaveLength(4)
  })

  it('asks the collector for its parts and limit within the deadline', async () => {
    const asked: unknown[] = []
    const recommendations: HomeRecommendations = {
      async collect(_seed, _ctx, options) {
        asked.push(options)
        return { candidates: [] }
      },
      async home() {
        return { shelves: [] }
      },
    }
    await planExtension(request(homeServices('lite', { recommendations })))
    expect(asked).toEqual([
      { parts: ['radio'], limit: FEED_LIMITS.perSource, deadlineMs: EXTENSION_DEADLINE_MS },
    ])
  })

  it('shares the radios of Home’s cache for its recommendation sources', async () => {
    const recommendations = fakeRecommendations({ radio: radios })
    const services = homeServices('full', { recommendations })
    const { cache: _cache, ...shared } = request(services)
    await planExtension(shared)
    await planExtension(shared)
    // Night Swim's radio, kept by the first, serves the second.
    expect(recommendations.calls).toHaveLength(1)
  })

  it('never adds what the queue holds, nor a song the user removed', async () => {
    const recommendations = fakeRecommendations({ radio: { 'Night Swim': radios['Night Swim'] } })
    const services = homeServices('full', { recommendations })
    const [k1, k2, k3] = radios['Night Swim']
    const plan = await planExtension(
      request(services, {
        queue: queueOf(nightSwim, [k1 as Track]),
        exclude: trackKeys(k2 as Track),
      }),
    )
    expect(titles(plan.picks)).toEqual([k3?.title])
  })

  it('retunes with the skips the library recorded', async () => {
    await history()
    const radio = { 'Low Tide': [...songs('Iris Vale', 'i', 2), ...songs('Lark Avenue', 'l', 2)] }
    const services = homeServices('full', { recommendations: fakeRecommendations({ radio }) })
    const before = await planExtension(request(services))
    expect(titles(before.picks).some((title) => title.startsWith('Iris Vale'))).toBe(true)

    // The user skips two of Iris Vale's songs at once.
    await played(song('i8', 'Iris Vale 8', 'Iris Vale'), 3 * MINUTE, true)
    await played(song('i9', 'Iris Vale 9', 'Iris Vale'), 2 * MINUTE, true)
    const after = await planExtension(request(services))
    expect(titles(after.picks)).toEqual(['Lark Avenue 1', 'Lark Avenue 2'])
  })

  it('fetches no radio for a song the user skipped just now, however much they like it', async () => {
    // Low Tide is a favourite, heard through on the three days before…
    for (const day of [1, 2, 3]) await played(lowTide, day * DAY)
    // …but skipped at once a moment ago.
    await played(lowTide, 4 * MINUTE, true)
    await played(bloom, 8 * MINUTE)
    const recommendations = fakeRecommendations({ radio: radios })
    const services = homeServices('full', { recommendations })
    const cache = createCollectionCache()
    for (let extension = 0; extension < 3; extension++) {
      await planExtension(request(services, { cache }))
    }
    expect(recommendations.calls.map((call) => seedName(call.seed)).sort()).toEqual([
      'Night Swim',
      'Static Bloom',
    ])
  })

  it('grows from an official music video in Music mode', async () => {
    const video = song('mv1', 'Night Swim (Official Video)', 'Juniper Coast', {
      kind: 'music-video',
    })
    const recommendations = fakeRecommendations({ radio: { [video.title]: radios['Night Swim'] } })
    const plan = await planExtension(
      request(homeServices('full', { recommendations }), { queue: queueOf(video) }),
    )
    expect(plan.fetched?.ref.name).toBe(video.title)
    // Two, the most a batch holds of one artist.
    expect(titles(plan.picks)).toHaveLength(2)
    for (const title of titles(plan.picks)) expect(title).toMatch(/^Kestrel/)
  })

  it('doesn’t keep a radio a source failed in, and asks again next time', async () => {
    let calls = 0
    const recommendations: HomeRecommendations = {
      async collect() {
        calls++
        return {
          candidates: [],
          outcomes: [{ status: calls === 1 ? 'failed' : 'timed-out' }, { status: 'ok' }],
        }
      },
      async home() {
        return { shelves: [] }
      },
    }
    const services = homeServices('full', { recommendations })
    const cache = createCollectionCache()
    await planExtension(request(services, { cache }))
    await planExtension(request(services, { cache }))
    await planExtension(request(services, { cache }))
    expect(calls).toBe(3)
  })

  it('builds from what is at hand when the fetch fails or doesn’t answer in time', async () => {
    const failing = homeServices('full', {
      recommendations: fakeRecommendations({ failing: ['Night Swim'] }),
    })
    expect((await planExtension(request(failing))).picks).toEqual([])

    const silent: HomeRecommendations = {
      collect: () => new Promise(() => {}),
      async home() {
        return { shelves: [] }
      },
    }
    const started = Date.now()
    const late = await planExtension(
      request(homeServices('full', { recommendations: silent }), { deadlineMs: 20 }),
    )
    expect(late.picks).toEqual([])
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  it('rejects when cancelled', async () => {
    const abort = new AbortController()
    const recommendations: HomeRecommendations = {
      collect: () => {
        abort.abort(new DOMException('Not needed', 'AbortError'))
        return new Promise(() => {})
      },
      async home() {
        return { shelves: [] }
      },
    }
    await expect(
      planExtension(request(homeServices('full', { recommendations }), { signal: abort.signal })),
    ).rejects.toThrow('Not needed')
    const cancelled = new AbortController()
    cancelled.abort(new Error('Gone'))
    await expect(
      planExtension(
        request(homeServices('full', { recommendations: fakeRecommendations() }), {
          signal: cancelled.signal,
        }),
      ),
    ).rejects.toThrow('Gone')
  })

  it('plans nothing where the sources can’t run, or with nothing to grow from', async () => {
    const recommendations = fakeRecommendations({ radio: radios })
    const free = await planExtension(request(homeServices('free', { recommendations })))
    expect(free.picks).toEqual([])
    expect((await planExtension(request(homeServices('full')))).picks).toEqual([])
    expect(
      (await planExtension(request(homeServices('full', { recommendations }), { count: 0 }))).picks,
    ).toEqual([])
    // A video can't seed in Music mode, and nothing else played.
    const video = song('v1', 'A Video', 'Ember Fold', { kind: 'video' })
    const queue = setQueue(createQueue({ mode: 'all' }), [video], { startIndex: 0 })
    const music = { ...queue, mode: 'music' as const }
    expect(
      (await planExtension(request(homeServices('full', { recommendations }), { queue: music })))
        .picks,
    ).toEqual([])
    expect(recommendations.calls).toEqual([])
  })
})

describe('planAppExtension', () => {
  const kestrel = song('k1', 'Kestrel 1', 'Kestrel')
  const lark = song('l1', 'Lark Avenue 1', 'Lark Avenue')
  const plan = () =>
    planAppExtension({
      queue: queueOf(nightSwim),
      count: 1,
      services: homeServices('full', {
        recommendations: fakeRecommendations({ radio: { 'Night Swim': [lark, kestrel] } }),
      }),
      now: Date.now(),
      random: () => 0.5,
      cache: createCollectionCache(),
    })

  it('reads the app’s library', async () => {
    expect((await plan()).fetched?.ref.name).toBe('Night Swim')
    await history()
    // Low Tide, from the app's history, is the heaviest seed now.
    expect((await plan()).fetched?.ref.name).toBe('Low Tide')
  })

  it('reads the app’s onboarding picks: an artist the user picked rises', async () => {
    expect(titles((await plan()).picks)).toEqual(['Lark Avenue 1'])
    useTasteStore.getState().savePicks({ artists: [{ name: 'Kestrel' }], genres: [] }, Date.now())
    try {
      expect(titles((await plan()).picks)).toEqual(['Kestrel 1'])
    } finally {
      useTasteStore.setState(useTasteStore.getInitialState(), true)
    }
  })
})
