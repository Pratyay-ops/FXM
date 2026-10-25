import { FxmError, formatId } from '@fxm/core'
import { describe, expect, it } from 'vitest'
import type { LastfmStationTrack } from '../lastfm/station'
import { UNLIMITED_CLASSIFICATION_BUDGET } from './adapters'
import { namesSameSong, rankScore, type StationOptions, stationCandidates } from './stations'
import { fakeBudget, fakeSongForVideo, fakeYouTubeLookup, testContext, ytmTrack } from './testing'
import type { SeedRef, SongSearchCandidate, TrackCandidate } from './types'

const SEED: SeedRef = { type: 'artist', name: 'Radiohead' }

/** A station item. */
function item(youtubeId: string | undefined, title: string, artist: string): LastfmStationTrack {
  const track: LastfmStationTrack = {
    title,
    artists: [artist],
    durationMs: 200_000,
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

/** Options with a lookup over every video of {@link ITEMS}. */
function options(overrides: Partial<StationOptions> = {}): StationOptions {
  return {
    lookup: fakeYouTubeLookup({
      song0000001: ytmTrack('song0000001', 'Creep', 'Radiohead'),
      omvLinked01: ytmTrack('omvLinked01', 'Karma Police', 'Radiohead', 'music-video', {
        songId: formatId('ytm', 'track', 'atvKarma001'),
      }),
      atvKarma001: ytmTrack('atvKarma001', 'Karma Police', 'Radiohead'),
      omvNoLink01: ytmTrack('omvNoLink01', 'No Surprises', 'Radiohead', 'music-video'),
      ugcVideo001: ytmTrack('ugcVideo001', 'Fake Plastic Trees (live)', 'fan', 'video'),
    }),
    budget: UNLIMITED_CLASSIFICATION_BUDGET,
    maxClassifications: 10,
    ...overrides,
  }
}

/** A short summary of each candidate: its type and what it names. */
function summary(candidates: readonly (TrackCandidate | SongSearchCandidate | { type: string })[]) {
  return candidates.map((candidate) =>
    candidate.type === 'track'
      ? `track ${(candidate as TrackCandidate).track.id}`
      : `search ${(candidate as SongSearchCandidate).title}${
          (candidate as SongSearchCandidate).youtubeId === undefined ? '' : ' +video'
        }`,
  )
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
})

describe('rankScore', () => {
  it('scores the first item 1 and the last 1/n', () => {
    expect(rankScore(0, 4)).toBe(1)
    expect(rankScore(3, 4)).toBe(0.25)
    expect(rankScore(0, 0)).toBe(0)
  })
})

describe('stationCandidates', () => {
  it('plays YouTube videos as they are in Music + Video mode', async () => {
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
        durationMs: 200_000,
        artwork: [],
        kind: 'video',
      },
    })
    expect(candidates[4]).toMatchObject({ type: 'song-search', rank: 4, score: 0.2 })
  })

  it('classifies each video in Music mode: songs as they are, official videos as their songs', async () => {
    const opts = options({ songForVideo: fakeSongForVideo({}) })
    const candidates = await stationCandidates(ITEMS, SEED, testContext(), opts)
    expect(summary(candidates)).toEqual([
      'track ytm:track:song0000001',
      'track ytm:track:atvKarma001',
      'search No Surprises',
      'search Fake Plastic Trees',
      'search Let Down',
    ])
    const lookup = opts.lookup as ReturnType<typeof fakeYouTubeLookup>
    expect(lookup.calls).toEqual([
      'song0000001',
      'omvLinked01',
      'atvKarma001',
      'omvNoLink01',
      'ugcVideo001',
    ])
  })

  it('uses the video-to-song rule for an official video without a link', async () => {
    const song = ytmTrack('atvNoSurp01', 'No Surprises', 'Radiohead')
    const rule = fakeSongForVideo({ omvNoLink01: song })
    const candidates = await stationCandidates(
      [ITEMS[2] as LastfmStationTrack],
      SEED,
      testContext(),
      options({ songForVideo: rule }),
    )
    expect(summary(candidates)).toEqual(['track ytm:track:atvNoSurp01'])
    expect(candidates[0]).toMatchObject({
      key: 'radiohead|no surprises',
      attributionUrl: 'https://www.last.fm/music/Radiohead/_/No Surprises',
    })
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
      options({
        budget: fakeBudget(0),
      }),
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
