import { type CatalogMode, FxmError, formatId, type ProviderContext, type Track } from '@fxm/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LastfmStationTrack } from '../lastfm/station'
import { sleep } from '../shared/gate'
import { UNLIMITED_CLASSIFICATION_BUDGET } from './adapters'
import { namesSameSong, rankScore, type StationOptions, stationCandidates } from './stations'
import {
  fakeBudget,
  fakeSongForVideo,
  fakeYouTubeLookup,
  testContext,
  verdictOf,
  ytmTrack,
} from './testing'
import type { RecommendationCandidate, SeedRef, TrackCandidate } from './types'

const SEED: SeedRef = { type: 'artist', name: 'Radiohead' }

afterEach(() => {
  vi.useRealTimers()
})

/** A station item. */
function item(youtubeId: string | undefined, title: string, artist: string): LastfmStationTrack {
  const track: LastfmStationTrack = {
    title,
    artists: [artist],
    url: `https://www.last.fm/music/${artist}/_/${title}`,
  }
  if (youtubeId !== undefined) track.youtubeId = youtubeId
  return track
}

const ITEMS = [
  item('song0000001', 'Creep', 'Radiohead'),
  item('omvLinked01', 'Karma Police', 'Radiohead'),
  item('omvNoLink01', 'No Surprises', 'Radiohead'),
  item('ugcVideo001', 'Fake Plastic Trees', 'Radiohead'),
  item(undefined, 'Let Down', 'Radiohead'),
]

/** Every video of {@link ITEMS}, as YouTube Music classifies it. */
const VIDEOS: Record<string, Track> = {
  song0000001: ytmTrack('song0000001', 'Creep', 'Radiohead'),
  omvLinked01: ytmTrack('omvLinked01', 'Karma Police', 'Radiohead', 'music-video', {
    songId: formatId('ytm', 'track', 'atvKarma001'),
  }),
  atvKarma001: ytmTrack('atvKarma001', 'Karma Police', 'Radiohead'),
  omvNoLink01: ytmTrack('omvNoLink01', 'No Surprises', 'Radiohead', 'music-video'),
  ugcVideo001: ytmTrack('ugcVideo001', 'Fake Plastic Trees (live)', 'fan', 'video'),
}

/** Options with a lookup over every video of {@link ITEMS}. */
function options(overrides: Partial<StationOptions> = {}): StationOptions {
  return {
    lookup: fakeYouTubeLookup(VIDEOS),
    budget: UNLIMITED_CLASSIFICATION_BUDGET,
    maxClassifications: 10,
    ...overrides,
  }
}

/** A short summary of each candidate: its type and what it names. */
function summary(candidates: readonly RecommendationCandidate[]) {
  return candidates.map((candidate) => {
    if (candidate.type === 'track') return `track ${candidate.track.id}`
    if (candidate.type === 'artist') return `artist ${candidate.artist.name}`
    return `search ${candidate.title}${candidate.youtubeId === undefined ? '' : ' +video'}`
  })
}

/** The lookups a fake made. */
function lookups(opts: StationOptions): string[] {
  return (opts.lookup as ReturnType<typeof fakeYouTubeLookup>).calls
}

describe('namesSameSong', () => {
  const creep = item('song0000001', 'Creep', 'Radiohead')

  it('accepts the song the item names, whatever the presentation', () => {
    expect(namesSameSong(ytmTrack('a', 'Creep', 'Radiohead'), creep)).toBe(true)
    expect(
      namesSameSong(ytmTrack('a', 'Creep - Remastered 2009', 'Radiohead - Topic'), creep),
    ).toBe(true)
    const song2 = item('b', 'Song 2 - 2012 Remaster', 'Blur')
    expect(namesSameSong(ytmTrack('b', 'Song 2', 'Blur'), song2)).toBe(true)
    const duet = ytmTrack('c', 'Creep', 'Someone', 'song', {
      artists: [{ name: 'Someone' }, { name: 'Radiohead' }],
    })
    expect(namesSameSong(duet, creep)).toBe(true)
  })

  it('refuses another artist, another song or another version', () => {
    expect(namesSameSong(ytmTrack('a', 'Creep', 'TLC'), creep)).toBe(false)
    expect(namesSameSong(ytmTrack('a', 'Karma Police', 'Radiohead'), creep)).toBe(false)
    expect(namesSameSong(ytmTrack('a', 'Creep (Acoustic)', 'Radiohead'), creep)).toBe(false)
  })

  it('refuses tribute and karaoke acts named after the artist', () => {
    for (const artist of ['Radiohead Tribute', 'Radiohead Karaoke', 'Radiohead Experience']) {
      expect(namesSameSong(ytmTrack('a', 'Creep', artist), creep)).toBe(false)
    }
  })
})

describe('rankScore', () => {
  it('scores the first item 1 and the last 1/n', () => {
    expect(rankScore(0, 4)).toBe(1)
    expect(rankScore(3, 4)).toBe(0.25)
    expect(rankScore(0, 0)).toBe(0)
  })
})

describe('stationCandidates', () => {
  it('plays YouTube videos as they are in Music + Video mode, with no duration', async () => {
    const lookup = fakeYouTubeLookup({})
    const ctx = testContext({ mode: 'all' })
    const candidates = await stationCandidates(ITEMS, SEED, ctx, options({ lookup }))
    expect(summary(candidates)).toEqual([
      'track yt:track:song0000001',
      'track yt:track:omvLinked01',
      'track yt:track:omvNoLink01',
      'track yt:track:ugcVideo001',
      'search Let Down',
    ])
    expect(lookup.calls).toEqual([])
    expect(candidates[0]).toEqual({
      type: 'track',
      source: 'lastfm',
      part: 'station',
      seed: SEED,
      rank: 0,
      score: 1,
      key: 'radiohead|creep',
      attributionUrl: 'https://www.last.fm/music/Radiohead/_/Creep',
      track: {
        id: formatId('yt', 'track', 'song0000001'),
        source: 'yt',
        title: 'Creep',
        artists: [{ name: 'Radiohead' }],
        artwork: [],
        kind: 'video',
      },
    })
    expect(candidates[4]).toMatchObject({ type: 'song-search', rank: 4, score: 0.2 })
  })

  it('classifies each video in Music mode: songs as they are, official videos as their songs', async () => {
    const opts = options({ songForVideo: fakeSongForVideo({}), autoMatch: () => true })
    const candidates = await stationCandidates(ITEMS, SEED, testContext(), opts)
    expect(summary(candidates)).toEqual([
      'track ytm:track:song0000001',
      'track ytm:track:atvKarma001',
      'search No Surprises',
      'search Fake Plastic Trees',
      'search Let Down',
    ])
    expect(lookups(opts)).toEqual([
      'song0000001',
      'omvLinked01',
      'atvKarma001',
      'omvNoLink01',
      'ugcVideo001',
    ])
    // A song needs no match; a linked song is no guess.
    expect(candidates[0]).not.toHaveProperty('match')
    expect((candidates[1] as TrackCandidate).match).toEqual({ via: 'link' })
  })

  it('treats an unknown mode as Music mode', async () => {
    const ctx = testContext({ mode: 'video' as CatalogMode })
    const candidates = await stationCandidates(ITEMS, SEED, ctx, options())
    expect(summary(candidates)).toEqual([
      'track ytm:track:song0000001',
      'track ytm:track:atvKarma001',
      'search No Surprises',
      'search Fake Plastic Trees',
      'search Let Down',
    ])
  })

  it('queues a matched song only when its verdict is auto with the Auto setting on', async () => {
    const song = ytmTrack('atvNoSurp01', 'No Surprises', 'Radiohead')
    const noSurprises = [ITEMS[2] as LastfmStationTrack]
    const auto = fakeSongForVideo({ omvNoLink01: song })
    const on = await stationCandidates(
      noSurprises,
      SEED,
      testContext(),
      options({ songForVideo: auto, autoMatch: () => true }),
    )
    expect(summary(on)).toEqual(['track ytm:track:atvNoSurp01'])
    expect(on[0]).toMatchObject({
      key: 'radiohead|no surprises',
      attributionUrl: 'https://www.last.fm/music/Radiohead/_/No Surprises',
      match: { via: 'match', verdict: verdictOf('auto') },
    })
    // A suggestion never plays unasked, and a verdict without one counts as a suggestion.
    const suggest = fakeSongForVideo({ omvNoLink01: song }, 'suggest')
    const unscored = fakeSongForVideo({ omvNoLink01: { song, via: 'match' } })
    for (const rule of [suggest, unscored]) {
      const found = await stationCandidates(
        noSurprises,
        SEED,
        testContext(),
        options({ songForVideo: rule, autoMatch: () => true }),
      )
      expect(summary(found)).toEqual(['search No Surprises'])
    }
    // With the Auto setting off, the rule is not even asked.
    const off = fakeSongForVideo({ omvNoLink01: song })
    const offCandidates = await stationCandidates(
      noSurprises,
      SEED,
      testContext(),
      options({ songForVideo: off }),
    )
    expect(summary(offCandidates)).toEqual(['search No Surprises'])
    expect(off.calls).toEqual([])
    // A verdict from another matcher version is a suggestion too.
    const stale = fakeSongForVideo({
      omvNoLink01: { song, via: 'match', verdict: { ...verdictOf('auto'), matcherVersion: 0 } },
    })
    const staleCandidates = await stationCandidates(
      noSurprises,
      SEED,
      testContext(),
      options({ songForVideo: stale, autoMatch: () => true }),
    )
    expect(summary(staleCandidates)).toEqual(['search No Surprises'])
  })

  it('keeps items as song searches, with their videos, when it cannot classify', async () => {
    const withoutLookup = await stationCandidates(ITEMS.slice(0, 2), SEED, testContext(), {
      budget: UNLIMITED_CLASSIFICATION_BUDGET,
      maxClassifications: 10,
    })
    expect(summary(withoutLookup)).toEqual(['search Creep +video', 'search Karma Police +video'])
    const noBudget = await stationCandidates(
      ITEMS.slice(0, 2),
      SEED,
      testContext(),
      options({ budget: fakeBudget(0) }),
    )
    expect(summary(noBudget)).toEqual(['search Creep +video', 'search Karma Police +video'])
  })

  it('classifies no more than the budget and its own limit allow', async () => {
    const opts = options({ budget: fakeBudget(2) })
    const candidates = await stationCandidates(ITEMS, SEED, testContext(), opts)
    // Two lookups: the first song, and the official video, whose linked song needs a third.
    expect(summary(candidates)).toEqual([
      'track ytm:track:song0000001',
      'search Karma Police',
      'search No Surprises +video',
      'search Fake Plastic Trees +video',
      'search Let Down',
    ])
    const limited = options({ maxClassifications: 1 })
    expect(
      summary(await stationCandidates(ITEMS.slice(0, 2), SEED, testContext(), limited)),
    ).toEqual(['track ytm:track:song0000001', 'search Karma Police +video'])
  })

  it('counts the video-to-song rule against the allowance', async () => {
    const rule = fakeSongForVideo({
      omvNoLink01: ytmTrack('atvNoSurp01', 'No Surprises', 'Radiohead'),
    })
    const items = [ITEMS[2] as LastfmStationTrack, ITEMS[0] as LastfmStationTrack]
    const opts = options({ budget: fakeBudget(2), songForVideo: rule, autoMatch: () => true })
    const candidates = await stationCandidates(items, SEED, testContext(), opts)
    // The lookup and the rule used both calls, so Creep stays unclassified.
    expect(summary(candidates)).toEqual(['track ytm:track:atvNoSurp01', 'search Creep +video'])
    const short = options({ budget: fakeBudget(1), songForVideo: rule, autoMatch: () => true })
    const rule1 = rule.calls.length
    expect(summary(await stationCandidates(items, SEED, testContext(), short))).toEqual([
      'search No Surprises',
      'search Creep +video',
    ])
    expect(rule.calls).toHaveLength(rule1)
  })

  it('never lets a budget that is not a number turn the cap off', async () => {
    for (const allowance of [Number.NaN, -3]) {
      const opts = options({ budget: fakeBudget(allowance) })
      const candidates = await stationCandidates(ITEMS, SEED, testContext(), opts)
      expect(lookups(opts)).toEqual([])
      expect(candidates.every((candidate) => candidate.type === 'song-search')).toBe(true)
    }
    const items = Array.from({ length: 20 }, () => ITEMS[0] as LastfmStationTrack)
    const opts = options({ budget: fakeBudget(2.9), maxClassifications: Number.NaN })
    await stationCandidates(items, SEED, testContext(), opts)
    expect(lookups(opts)).toEqual([])
  })

  it('classifies with the budget’s context, keeping the caller’s mode and signal', async () => {
    const controller = new AbortController()
    const marked = (ctx: ProviderContext): ProviderContext => ({
      ...ctx,
      region: 'prefetch',
      mode: 'all',
      signal: AbortSignal.abort(),
    })
    const opts = options({ budget: fakeBudget(10, marked) })
    const ctx = testContext({ signal: controller.signal })
    await stationCandidates(ITEMS.slice(0, 1), SEED, ctx, opts)
    const [used] = (opts.lookup as ReturnType<typeof fakeYouTubeLookup>).contexts
    expect(used?.region).toBe('prefetch')
    expect(used?.mode).toBe('music')
    expect(used?.signal?.aborted).toBe(false)
  })

  it('stops classifying when its time is up, and cancels the lookup in flight', async () => {
    vi.useFakeTimers({ now: Date.parse('2026-10-26T00:00:00Z') })
    let cancelled = false
    const slow = {
      async getTrack(id: Track['id'], ctx: ProviderContext): Promise<Track> {
        ctx.signal?.addEventListener('abort', () => {
          cancelled = true
        })
        await sleep(id.endsWith('song0000001') ? 1_000 : 60_000, ctx.signal)
        return VIDEOS.song0000001 as Track
      },
    }
    const opts = options({ lookup: slow, maxClassificationMs: 5_000 })
    const pending = stationCandidates(ITEMS.slice(0, 3), SEED, testContext(), opts)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(summary(await pending)).toEqual([
      'track ytm:track:song0000001',
      'search Karma Police +video',
      'search No Surprises +video',
    ])
    expect(cancelled).toBe(true)
  })

  it('drops a video that is gone and goes on, but stops after a budget refusal', async () => {
    const gone = options({
      lookup: fakeYouTubeLookup({
        song0000001: new FxmError('Unavailable', 'removed'),
        omvLinked01: ytmTrack('omvLinked01', 'Karma Police', 'Radiohead'),
      }),
    })
    expect(summary(await stationCandidates(ITEMS.slice(0, 2), SEED, testContext(), gone))).toEqual([
      'search Creep',
      'track ytm:track:omvLinked01',
    ])
    const refused = options({
      lookup: fakeYouTubeLookup({
        song0000001: new FxmError('RateLimited', 'budget used up', { retryAfterMs: 60_000 }),
        omvLinked01: ytmTrack('omvLinked01', 'Karma Police', 'Radiohead'),
      }),
    })
    expect(
      summary(await stationCandidates(ITEMS.slice(0, 2), SEED, testContext(), refused)),
    ).toEqual(['search Creep +video', 'search Karma Police +video'])
  })

  it('stops classifying when the linked song or the rule fails for another reason', async () => {
    const opts = options({
      songForVideo: async () => {
        throw new FxmError('BotCheck', 'flagged')
      },
      autoMatch: () => true,
    })
    const items = [ITEMS[2] as LastfmStationTrack, ITEMS[0] as LastfmStationTrack]
    expect(summary(await stationCandidates(items, SEED, testContext(), opts))).toEqual([
      'search No Surprises',
      'search Creep +video',
    ])
  })

  it('keeps a song search when the linked video is another recording', async () => {
    const opts = options({
      lookup: fakeYouTubeLookup({
        song0000001: ytmTrack('song0000001', 'Creep', 'Some Cover Band'),
        omvLinked01: ytmTrack('omvLinked01', 'Karma Police (Live)', 'Radiohead'),
      }),
    })
    expect(summary(await stationCandidates(ITEMS.slice(0, 2), SEED, testContext(), opts))).toEqual([
      'search Creep',
      'search Karma Police',
    ])
  })

  it('rejects with the reason when the call is cancelled', async () => {
    const controller = new AbortController()
    const reason = new Error('stop')
    const opts = options({
      lookup: {
        async getTrack() {
          controller.abort(reason)
          throw reason
        },
      },
    })
    const ctx = testContext({ signal: controller.signal })
    await expect(stationCandidates(ITEMS, SEED, ctx, opts)).rejects.toBe(reason)
  })
})
