import {
  type CatalogMode,
  FxmError,
  formatId,
  type ProviderContext,
  type RadioSeed,
  type Shelf,
  type Track,
} from '@fxm/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import stationSimilar from '../lastfm/fixtures/station-similar-radiohead.json'
import { createLastfmStations, LastfmStationPacing } from '../lastfm/station'
import { createListenBrainzClient } from '../listenbrainz/api'
import acrLookup from '../listenbrainz/fixtures/acr-lookup-radiohead-creep.json'
import similarArtists from '../listenbrainz/fixtures/similar-artists-radiohead.json'
import { sleep } from '../shared/gate'
import { SpotifyError } from '../spotify/errors'
import {
  createRecommendationCollector,
  DEFAULT_PARTS,
  type RecommendationCollectorOptions,
  tracksForMode,
} from './collector'
import {
  fakeArtistMbid,
  fakeBudget,
  fakeFetch,
  fakeLastfmApi,
  fakeLastfmStations,
  fakeListenBrainz,
  fakeRadio,
  fakeSongForVideo,
  fakeSpotifyMetadata,
  fakeYouTubeLookup,
  fakeYouTubeSeed,
  jsonResponse,
  spotifyArtist,
  spotifyTrack,
  testContext,
  textResponse,
  ytmTrack,
} from './testing'
import type { RecommendationCandidate, SourceOutcome, SourceResult } from './types'

const RADIOHEAD_MBID = 'a74b1b7f-71a5-4011-9441-d0b5e4122711'
const CREEP = ytmTrack('XFkzRNyygfk', 'Creep', 'Radiohead', 'song', {
  album: { name: 'Pablo Honey' },
})

/** YouTube Music radio for Creep: two songs, an official video and an upload. */
const YTM_RADIO = [
  ytmTrack('song0000001', 'Karma Police', 'Radiohead'),
  ytmTrack('omv00000001', 'No Surprises', 'Radiohead', 'music-video'),
  ytmTrack('song0000002', 'Bitter Sweet Symphony', 'The Verve'),
  ytmTrack('ugc00000001', 'Creep (cover)', 'someone', 'video'),
]

const SPOTIFY_RADIO = [
  spotifyTrack('0000000000000000000001', 'High and Dry', 'Radiohead'),
  spotifyTrack('0000000000000000000002', 'Song 2', 'Blur'),
]

afterEach(() => {
  vi.useRealTimers()
})

/** Every source, faked, as the Full tier would have them. */
function everything(
  overrides: RecommendationCollectorOptions = {},
): RecommendationCollectorOptions {
  return {
    youtube: fakeRadio('ytm', YTM_RADIO),
    youtubeLookup: fakeYouTubeLookup({ m1aaaaaaaaa: ytmTrack('m1aaaaaaaaa', 'Uprising', 'Muse') }),
    spotify: fakeRadio('spotify', SPOTIFY_RADIO),
    spotifyMetadata: fakeSpotifyMetadata(
      {
        '4Z8W4fKeB5YxbusRsdQVPb': [
          spotifyArtist('0000000000000000000011', 'Thom Yorke'),
          spotifyArtist('4Z8W4fKeB5YxbusRsdQVPb', 'Radiohead'),
          spotifyArtist('0000000000000000000012', 'Muse'),
        ],
      },
      [spotifyArtist('4Z8W4fKeB5YxbusRsdQVPb', 'Radiohead')],
    ),
    lastfmStations: fakeLastfmStations({
      'similar:Radiohead': [
        {
          title: 'Uprising',
          artists: ['Muse'],
          youtubeId: 'm1aaaaaaaaa',
          url: 'https://www.last.fm/music/Muse/_/Uprising',
        },
        { title: 'Song 2', artists: ['Blur'], url: 'https://www.last.fm/music/Blur/_/Song+2' },
      ],
    }),
    lastfmApi: fakeLastfmApi({
      Radiohead: [
        { name: 'Radiohead', match: 1, url: 'https://www.last.fm/music/Radiohead' },
        { name: 'Thom Yorke', match: 0.9, url: 'https://www.last.fm/music/Thom+Yorke' },
        {
          name: 'Muse',
          mbid: '9c9f1380-2516-4fc9-a3e6-f9f61941d090',
          match: 0.5,
          url: 'https://www.last.fm/music/Muse',
        },
      ],
    }),
    listenbrainz: fakeListenBrainz(
      {
        'Radiohead|Creep': {
          recordingMbid: '70595637-9310-45f2-a266-58f8de4874a7',
          recordingName: 'Creep',
          artistCredit: 'Radiohead',
          artistMbids: [RADIOHEAD_MBID],
        },
      },
      {
        [RADIOHEAD_MBID]: [
          {
            mbid: '5b11f4ce-a62d-471e-81fc-a69a8278c7da',
            name: 'Nirvana',
            score: 100,
            similarity: 1,
          },
          {
            mbid: '9c9f1380-2516-4fc9-a3e6-f9f61941d090',
            name: 'Muse',
            score: 50,
            similarity: 0.5,
          },
        ],
      },
    ),
    ...overrides,
  }
}

/** What a candidate names. */
function nameOf(candidate: RecommendationCandidate): string {
  if (candidate.type === 'track') return candidate.track.title
  if (candidate.type === 'artist') return candidate.artist.name
  return `search ${candidate.title}`
}

/** What each candidate names, by source and part. */
function names(collection: { candidates: RecommendationCandidate[] }): string[] {
  return collection.candidates.map(
    (candidate) => `${candidate.source}/${candidate.part}: ${nameOf(candidate)}`,
  )
}

/** One outcome as a short string. */
function line(outcome: SourceOutcome): string {
  const detail =
    outcome.status === 'ok'
      ? outcome.count
      : outcome.status === 'skipped'
        ? outcome.reason
        : outcome.status === 'failed'
          ? outcome.code
          : outcome.afterMs
  return `${outcome.source}/${outcome.part}: ${outcome.status} ${detail}`
}

/** The outcomes as short strings. */
function outcomes(collection: { outcomes: SourceOutcome[] }): string[] {
  return collection.outcomes.map(line)
}

/** A radio that never answers: it ignores its signal. */
function hangingRadio(id: 'ytm' | 'spotify') {
  return {
    id,
    radio: () => new Promise<Track[]>(() => undefined),
  }
}

describe('tracksForMode', () => {
  it('keeps songs in Music mode, all but episodes in Music + Video, each once', () => {
    const tracks = [...YTM_RADIO, ytmTrack('ep000000001', 'A podcast', 'Someone', 'episode')]
    const duplicate = { ...(YTM_RADIO[0] as Track), id: formatId('yt', 'track', 'song0000001') }
    expect(tracksForMode([...tracks, duplicate], 'music').map((track) => track.title)).toEqual([
      'Karma Police',
      'Bitter Sweet Symphony',
    ])
    expect(tracksForMode(tracks, 'all').map((track) => track.kind)).toEqual([
      'song',
      'music-video',
      'song',
      'video',
    ])
  })

  it('gives an unknown mode Music mode’s rules', () => {
    expect(tracksForMode(YTM_RADIO, 'video' as CatalogMode).map((track) => track.kind)).toEqual([
      'song',
      'song',
    ])
  })
})

describe('createRecommendationCollector', () => {
  it('collects every source in the Full tier, in Music mode', async () => {
    const options = everything()
    const collection = await createRecommendationCollector(options).collect(CREEP, testContext())
    expect(names(collection)).toEqual([
      'ytm/radio: Karma Police',
      'ytm/radio: Bitter Sweet Symphony',
      'spotify/radio: High and Dry',
      'spotify/radio: Song 2',
      'spotify/similar-artists: Thom Yorke',
      'spotify/similar-artists: Muse',
      'lastfm/station: Uprising',
      'lastfm/station: search Song 2',
      'lastfm/similar-artists: Thom Yorke',
      'lastfm/similar-artists: Muse',
      'listenbrainz/similar-artists: Nirvana',
      'listenbrainz/similar-artists: Muse',
    ])
    expect(outcomes(collection)).toEqual([
      'ytm/radio: ok 2',
      'spotify/radio: ok 2',
      'spotify/similar-artists: ok 2',
      'lastfm/station: ok 2',
      'lastfm/similar-artists: ok 2',
      'listenbrainz/similar-artists: ok 2',
    ])
    const seed = { type: 'track', id: CREEP.id, name: 'Creep', artists: ['Radiohead'] }
    expect(collection.candidates.every((candidate) => candidate.seed.id === seed.id)).toBe(true)
    expect(collection.candidates[0]).toEqual({
      type: 'track',
      source: 'ytm',
      part: 'radio',
      seed,
      rank: 0,
      score: 1,
      key: 'radiohead|karma police',
      track: YTM_RADIO[0],
    })
    expect(collection.candidates.find((c) => c.source === 'listenbrainz')).toMatchObject({
      type: 'artist',
      rank: 0,
      score: 1,
      key: 'nirvana',
      artist: { name: 'Nirvana', mbid: '5b11f4ce-a62d-471e-81fc-a69a8278c7da', artwork: [] },
    })
    expect(collection.candidates.find((c) => c.source === 'lastfm' && c.type === 'artist')).toEqual(
      expect.objectContaining({
        score: 0.9,
        attributionUrl: 'https://www.last.fm/music/Thom+Yorke',
      }),
    )
    // The seed itself went to every radio; Spotify's artist was found by name.
    expect((options.youtube as ReturnType<typeof fakeRadio>).seeds).toEqual([CREEP])
    expect((options.spotify as ReturnType<typeof fakeRadio>).seeds).toEqual([CREEP])
    expect((options.spotifyMetadata as ReturnType<typeof fakeSpotifyMetadata>).searches).toEqual([
      'Radiohead',
    ])
  })

  it('keeps videos in Music + Video mode', async () => {
    const collector = createRecommendationCollector(everything())
    const collection = await collector.collect(CREEP, testContext({ mode: 'all' }), {
      parts: ['radio', 'station'],
    })
    expect(names(collection)).toEqual([
      'ytm/radio: Karma Police',
      'ytm/radio: No Surprises',
      'ytm/radio: Bitter Sweet Symphony',
      'ytm/radio: Creep (cover)',
      'spotify/radio: High and Dry',
      'spotify/radio: Song 2',
      'lastfm/station: Uprising',
      'lastfm/station: search Song 2',
    ])
    const uprising = collection.candidates.find((c) => c.source === 'lastfm' && c.type === 'track')
    expect(uprising).toMatchObject({ track: { id: 'yt:track:m1aaaaaaaaa', kind: 'video' } })
  })

  it('treats an unknown mode as Music mode', async () => {
    const collector = createRecommendationCollector(everything())
    const collection = await collector.collect(
      CREEP,
      testContext({ mode: 'video' as CatalogMode }),
      {
        parts: ['radio', 'station'],
      },
    )
    expect(names(collection).filter((name) => name.startsWith('ytm'))).toEqual([
      'ytm/radio: Karma Police',
      'ytm/radio: Bitter Sweet Symphony',
    ])
    const uprising = collection.candidates.find((c) => c.source === 'lastfm' && c.type === 'track')
    expect(uprising).toMatchObject({ track: { id: 'ytm:track:m1aaaaaaaaa', kind: 'song' } })
  })

  it('runs what the Lite tier reaches: YouTube Music and the open services', async () => {
    const collection = await createRecommendationCollector(everything()).collect(
      CREEP,
      testContext({ tier: 'lite' }),
    )
    expect(outcomes(collection)).toEqual([
      'ytm/radio: ok 2',
      'spotify/radio: skipped unreachable',
      'spotify/similar-artists: skipped unreachable',
      'lastfm/station: skipped needs-full-tier',
      'lastfm/similar-artists: ok 2',
      'listenbrainz/similar-artists: ok 2',
    ])
  })

  it('runs only the open services without YouTube', async () => {
    const collection = await createRecommendationCollector(everything()).collect(
      CREEP,
      testContext({ tier: 'free' }),
    )
    expect(outcomes(collection)).toEqual([
      'ytm/radio: skipped unreachable',
      'spotify/radio: skipped unreachable',
      'spotify/similar-artists: skipped unreachable',
      'lastfm/station: skipped needs-full-tier',
      'lastfm/similar-artists: ok 2',
      'listenbrainz/similar-artists: ok 2',
    ])
  })

  it('asks the station reader’s own reachability check, and only that', async () => {
    const station = { 'similar:Radiohead': [] }
    const open = createRecommendationCollector({
      lastfmStations: fakeLastfmStations(station, () => true),
    })
    const lite = await open.collect(CREEP, testContext({ tier: 'lite' }), { parts: ['station'] })
    expect(outcomes(lite)).toEqual(['lastfm/station: ok 0'])
    const closed = createRecommendationCollector({
      lastfmStations: fakeLastfmStations(station, () => false),
    })
    const full = await closed.collect(CREEP, testContext(), { parts: ['station'] })
    expect(outcomes(full)).toEqual(['lastfm/station: skipped needs-full-tier'])
  })

  it('leaves Spotify out when the user switched it off', async () => {
    const options = everything({ spotifyEnabled: () => false })
    const collection = await createRecommendationCollector(options).collect(CREEP, testContext())
    expect(outcomes(collection).filter((entry) => entry.startsWith('spotify'))).toEqual([
      'spotify/radio: skipped switched-off',
      'spotify/similar-artists: skipped switched-off',
    ])
    expect((options.spotify as ReturnType<typeof fakeRadio>).seeds).toEqual([])
  })

  it('follows the Spotify provider’s own switch unless the app gives one', async () => {
    const seen: ProviderContext[] = []
    const spotify = fakeRadio('spotify', SPOTIFY_RADIO, undefined, () => false)
    const off = await createRecommendationCollector({ spotify }).collect(CREEP, testContext(), {
      parts: ['radio'],
    })
    expect(outcomes(off)).toContain('spotify/radio: skipped switched-off')
    const app = createRecommendationCollector({
      spotify,
      spotifyEnabled: (ctx) => {
        seen.push(ctx)
        return true
      },
    })
    const on = await app.collect(CREEP, testContext(), { parts: ['radio'] })
    expect(outcomes(on)).toContain('spotify/radio: ok 2')
    expect(seen[0]?.mode).toBe('music')
  })

  it('reports sources the app did not register', async () => {
    const collection = await createRecommendationCollector().collect(CREEP, testContext())
    expect(collection.candidates).toEqual([])
    expect(collection.outcomes.every((outcome) => outcome.status === 'skipped')).toBe(true)
    expect(outcomes(collection)).toContain('lastfm/similar-artists: skipped not-configured')
  })

  it('seeds YouTube Music with the song of an official video in Music mode', async () => {
    const video = ytmTrack('omvOMVomvOM', 'Creep', 'Radiohead', 'music-video')
    const song = ytmTrack('atvATVatvAT', 'Creep', 'Radiohead')
    const youtube = fakeRadio('ytm', YTM_RADIO)
    const withRule = createRecommendationCollector({
      youtube,
      songForVideo: fakeSongForVideo({ omvOMVomvOM: song }, 'suggest'),
    })
    await withRule.collect(video, testContext(), { parts: ['radio'] })
    expect(youtube.seeds).toEqual([song])
    const withoutRule = createRecommendationCollector({ youtube })
    const collection = await withoutRule.collect(video, testContext(), { parts: ['radio'] })
    expect(outcomes(collection)).toEqual([
      'ytm/radio: skipped unsupported-seed',
      'spotify/radio: skipped not-configured',
    ])
    expect(youtube.seeds).toHaveLength(1)
  })

  it('finds a YouTube seed for a seed from another source through the adapter', async () => {
    const seed = spotifyTrack('70LcF31zb1H0PyJoS1Sx1r', 'Creep', 'Radiohead')
    const youtube = fakeRadio('ytm', YTM_RADIO)
    const without = await createRecommendationCollector({ youtube }).collect(seed, testContext(), {
      parts: ['radio'],
    })
    expect(outcomes(without)[0]).toBe('ytm/radio: skipped unsupported-seed')
    const finder = fakeYouTubeSeed(() => CREEP)
    const found = await createRecommendationCollector({ youtube, youtubeSeed: finder }).collect(
      seed,
      testContext(),
      { parts: ['radio'] },
    )
    expect(outcomes(found)[0]).toBe('ytm/radio: ok 2')
    expect(youtube.seeds).toEqual([CREEP])
    expect(finder.seeds).toEqual([seed])
  })

  it('uses the seed’s own Spotify artist, and skips a seed it cannot place', async () => {
    const metadata = fakeSpotifyMetadata({
      '4Z8W4fKeB5YxbusRsdQVPb': [spotifyArtist('0000000000000000000011', 'Thom Yorke')],
    })
    const collector = createRecommendationCollector({ spotifyMetadata: metadata })
    const ctx = testContext()
    const seed = spotifyTrack(
      '70LcF31zb1H0PyJoS1Sx1r',
      'Creep',
      'Radiohead',
      '4Z8W4fKeB5YxbusRsdQVPb',
    )
    const own = await collector.collect(seed, ctx, { parts: ['similar-artists'] })
    expect(names(own)).toEqual(['spotify/similar-artists: Thom Yorke'])
    expect(metadata.searches).toEqual([])
    const unknown = await collector.collect({ name: 'Nobody' }, ctx, { parts: ['similar-artists'] })
    expect(outcomes(unknown)[0]).toBe('spotify/similar-artists: skipped unsupported-seed')
    const nameless = await collector.collect({ ...CREEP, artists: [] }, ctx, {
      parts: ['similar-artists', 'station'],
    })
    expect(outcomes(nameless)[0]).toBe('spotify/similar-artists: skipped unsupported-seed')
  })

  it('finds ListenBrainz’s artist through the seed’s MBID, else the MBID adapter', async () => {
    const listenbrainz = fakeListenBrainz({}, { [RADIOHEAD_MBID]: [] })
    const adapter = vi.fn(fakeArtistMbid({ Radiohead: RADIOHEAD_MBID }))
    const collector = createRecommendationCollector({ listenbrainz, artistMbid: adapter })
    const ctx = testContext()
    const parts = ['similar-artists'] as const
    const found = await collector.collect({ name: 'Radiohead' }, ctx, { parts })
    expect(outcomes(found)).toContain('listenbrainz/similar-artists: ok 0')
    const missing = await collector.collect({ name: 'Nobody' }, ctx, { parts })
    expect(outcomes(missing)).toContain('listenbrainz/similar-artists: skipped unsupported-seed')
    const withoutAdapter = createRecommendationCollector({ listenbrainz })
    const skipped = await withoutAdapter.collect({ name: 'Radiohead' }, ctx, { parts })
    expect(outcomes(skipped)).toContain('listenbrainz/similar-artists: skipped unsupported-seed')
    // An artist candidate's own MBID needs neither the adapter nor a lookup.
    adapter.mockClear()
    const known = await collector.collect(
      { name: 'Radiohead', mbid: RADIOHEAD_MBID.toUpperCase() },
      ctx,
      { parts },
    )
    expect(outcomes(known)).toContain('listenbrainz/similar-artists: ok 0')
    expect(adapter).not.toHaveBeenCalled()
    expect(listenbrainz.lookups).toEqual([])
    expect(listenbrainz.similarCalls.at(-1)).toBe(RADIOHEAD_MBID)
  })

  it('keeps similar artists whose names are symbols only', async () => {
    const collector = createRecommendationCollector({
      lastfmApi: fakeLastfmApi({
        Radiohead: [
          { name: '!!!', match: 0.8, url: 'https://www.last.fm/music/%21%21%21' },
          { name: '✝✝✝', match: 0.7, url: 'https://www.last.fm/music/x' },
          { name: '   ', match: 0.6, url: 'https://www.last.fm/music/y' },
        ],
      }),
    })
    const collection = await collector.collect(CREEP, testContext(), { parts: ['similar-artists'] })
    expect(names(collection)).toEqual([
      'lastfm/similar-artists: !!!',
      'lastfm/similar-artists: ✝✝✝',
    ])
    expect(collection.candidates.map((candidate) => candidate.key)).toEqual(['!!!', '✝✝✝'])
  })

  it('reports failures, Unsupported ones included, with their errors', async () => {
    const clientRejected = new SpotifyError('client-rejected', '403 Client/request not allowed')
    const routeClosed = Object.assign(new FxmError('Unsupported', 'FXM Connect lacks lastfm'), {
      reason: 'route-closed',
      route: 'lastfm-web',
      needs: ['connect'],
    })
    const collector = createRecommendationCollector(
      everything({
        youtube: fakeRadio('ytm', new FxmError('Network', 'offline')),
        spotify: fakeRadio('spotify', clientRejected),
        lastfmStations: fakeLastfmStations({ 'similar:Radiohead': routeClosed }),
        lastfmApi: fakeLastfmApi({ Radiohead: new TypeError('bug') }),
      }),
    )
    const collection = await collector.collect(CREEP, testContext())
    expect(outcomes(collection)).toEqual([
      'ytm/radio: failed Network',
      'spotify/radio: failed Unsupported',
      'spotify/similar-artists: ok 2',
      'lastfm/station: failed Unsupported',
      'lastfm/similar-artists: failed Unknown',
      'listenbrainz/similar-artists: ok 2',
    ])
    expect(collection.outcomes[0]).toMatchObject({ message: 'offline' })
    expect(collection.outcomes[1]).toMatchObject({ error: clientRejected })
    expect(collection.outcomes[3]).toMatchObject({ error: routeClosed })
    expect(collection.outcomes[4]).toMatchObject({ message: 'bug' })
  })

  it('skips only the seed refusals a provider makes explicitly', async () => {
    const refusals = [
      [new SpotifyError('unsupported-seed', 'no such track'), 'skipped unsupported-seed'],
      [new SpotifyError('disabled', 'off'), 'skipped switched-off'],
      [new SpotifyError('unreachable', 'no route'), 'skipped unreachable'],
      [new SpotifyError('operation-unsupported', 'no hash'), 'failed Unsupported'],
      [new FxmError('Unsupported', 'a bare refusal'), 'failed Unsupported'],
    ] as const
    for (const [error, expected] of refusals) {
      const collector = createRecommendationCollector({ spotify: fakeRadio('spotify', error) })
      const collection = await collector.collect(CREEP, testContext(), { parts: ['radio'] })
      expect(outcomes(collection)).toContain(`spotify/radio: ${expected}`)
    }
  })

  it('runs only the parts asked for, at most `limit` from each, read defensively', async () => {
    const collector = createRecommendationCollector(everything())
    const one = await collector.collect(CREEP, testContext(), { parts: ['radio'], limit: 1 })
    expect(names(one)).toEqual(['ytm/radio: Karma Police', 'spotify/radio: High and Dry'])
    expect(DEFAULT_PARTS).toEqual(['radio', 'station', 'similar-artists'])
    const rounded = await collector.collect(CREEP, testContext(), { parts: ['radio'], limit: 1.9 })
    expect(names(rounded)).toHaveLength(2)
    const notANumber = await collector.collect(CREEP, testContext(), {
      parts: ['radio'],
      limit: Number.NaN,
    })
    expect(names(notANumber)).toHaveLength(4)
    const options = everything()
    const none = await createRecommendationCollector(options).collect(CREEP, testContext(), {
      limit: -1,
    })
    expect(none.candidates).toEqual([])
    expect(none.outcomes.every((outcome) => outcome.status === 'ok')).toBe(true)
    expect((options.youtube as ReturnType<typeof fakeRadio>).seeds).toEqual([])
  })

  it('classifies station items within the budget', async () => {
    const options = everything({ classificationBudget: fakeBudget(0) })
    const collection = await createRecommendationCollector(options).collect(CREEP, testContext(), {
      parts: ['station'],
    })
    expect(names(collection)).toEqual([
      'lastfm/station: search Uprising',
      'lastfm/station: search Song 2',
    ])
    expect((options.youtubeLookup as ReturnType<typeof fakeYouTubeLookup>).calls).toEqual([])
  })

  it('keeps the classification cap when it is given something that is not one', async () => {
    const items = Array.from({ length: 12 }, () => ({
      title: 'Uprising',
      artists: ['Muse'],
      youtubeId: 'm1aaaaaaaaa',
      url: 'https://www.last.fm/music/Muse/_/Uprising',
    }))
    for (const maxClassifications of [Number.NaN, -1, 2.5]) {
      const lookup = fakeYouTubeLookup({ m1aaaaaaaaa: ytmTrack('m1aaaaaaaaa', 'Uprising', 'Muse') })
      const collector = createRecommendationCollector({
        lastfmStations: fakeLastfmStations({ 'similar:Radiohead': items }),
        youtubeLookup: lookup,
        maxClassifications,
      })
      await collector.collect(CREEP, testContext(), { parts: ['station'] })
      expect(lookup.calls).toHaveLength(8)
    }
  })

  it('rejects with the reason when the call is cancelled', async () => {
    const controller = new AbortController()
    const reason = new Error('stop')
    const youtube = fakeRadio('ytm', () => {
      controller.abort(reason)
      return reason
    })
    const collector = createRecommendationCollector({ youtube })
    await expect(collector.collect(CREEP, testContext({ signal: controller.signal }))).rejects.toBe(
      reason,
    )
    await expect(
      collector.collect(CREEP, testContext({ signal: AbortSignal.abort(reason) })),
    ).rejects.toBe(reason)
  })

  it('rejects at once when cancelled, even with a source that ignores its signal', async () => {
    const controller = new AbortController()
    const collector = createRecommendationCollector({ youtube: hangingRadio('ytm') })
    const pending = collector.collect(CREEP, testContext({ signal: controller.signal }))
    const reason = new Error('stop')
    controller.abort(reason)
    await expect(pending).rejects.toBe(reason)
  })

  it('returns what is ready at the deadline, and cancels the rest', async () => {
    vi.useFakeTimers({ now: Date.parse('2026-10-26T00:00:00Z') })
    let cancelled: unknown
    const slowSpotify = {
      id: 'spotify',
      async radio(_seed: RadioSeed, ctx: ProviderContext) {
        await sleep(10_000, ctx.signal).catch((error: unknown) => {
          cancelled = error
          throw error
        })
        return SPOTIFY_RADIO
      },
    }
    const collector = createRecommendationCollector({
      youtube: fakeRadio('ytm', YTM_RADIO),
      spotify: slowSpotify,
    })
    const pending = collector.collect(CREEP, testContext(), { parts: ['radio'], deadlineMs: 2_000 })
    await vi.advanceTimersByTimeAsync(2_000)
    const collection = await pending
    expect(outcomes(collection)).toEqual(['ytm/radio: ok 2', 'spotify/radio: timed-out 2000'])
    expect(names(collection)).toEqual([
      'ytm/radio: Karma Police',
      'ytm/radio: Bitter Sweet Symphony',
    ])
    expect(cancelled).toBeInstanceOf(DOMException)
  })

  it('delivers each source’s result as soon as it has one', async () => {
    vi.useFakeTimers({ now: Date.parse('2026-10-26T00:00:00Z') })
    const delivered: string[] = []
    const late = {
      id: 'spotify',
      async radio(_seed: RadioSeed, ctx: ProviderContext) {
        await sleep(1_000, ctx.signal)
        return SPOTIFY_RADIO
      },
    }
    const collector = createRecommendationCollector({
      youtube: fakeRadio('ytm', YTM_RADIO),
      spotify: late,
    })
    const pending = collector.collect(CREEP, testContext(), {
      parts: ['radio'],
      onResult: (result: SourceResult) =>
        delivered.push(`${line(result.outcome)} (${result.candidates.length})`),
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(delivered).toEqual(['ytm/radio: ok 2 (2)'])
    await vi.advanceTimersByTimeAsync(1_000)
    await pending
    expect(delivered).toEqual(['ytm/radio: ok 2 (2)', 'spotify/radio: ok 2 (2)'])
  })

  it('works with the real Last.fm and ListenBrainz clients', async () => {
    const { fetch, calls } = fakeFetch((url) => {
      if (url.hostname === 'www.last.fm') return jsonResponse(stationSimilar)
      if (url.pathname === '/acr-lookup/json') return jsonResponse(acrLookup)
      if (url.pathname === '/similar-artists/json') return jsonResponse(similarArtists)
      return textResponse('Not found', { status: 404 })
    })
    const collector = createRecommendationCollector({
      lastfmStations: createLastfmStations({
        pacing: new LastfmStationPacing({ minIntervalMs: 0 }),
      }),
      listenbrainz: createListenBrainzClient({ minIntervalMs: 0 }),
    })
    const seed: RadioSeed = CREEP
    const collection = await collector.collect(seed, testContext({ fetch, mode: 'all' }), {
      limit: 10,
    })
    expect(outcomes(collection)).toEqual([
      'ytm/radio: skipped not-configured',
      'spotify/radio: skipped not-configured',
      'spotify/similar-artists: skipped not-configured',
      'lastfm/station: ok 10',
      'lastfm/similar-artists: skipped not-configured',
      'listenbrainz/similar-artists: ok 10',
    ])
    expect(calls.map((call) => call.url.hostname)).toEqual([
      'www.last.fm',
      'labs.api.listenbrainz.org',
      'labs.api.listenbrainz.org',
    ])
  })
})

describe('home', () => {
  const shelf = (id: string, tracks: Track[]): Shelf => ({
    id,
    title: id,
    items: tracks.map((track) => ({ type: 'track', track })),
  })

  it('collects the home feeds, filtered to the mode', async () => {
    const album = {
      id: formatId('spotify', 'album', '0000000000000000000021'),
      source: 'spotify' as const,
      name: 'OK Computer',
      artists: [],
      artwork: [],
    }
    const youtube = fakeRadio(
      'ytm',
      [],
      [
        shelf('quick-picks', YTM_RADIO),
        shelf('videos', [YTM_RADIO[1] as Track, YTM_RADIO[3] as Track]),
      ],
    )
    const spotify = fakeRadio(
      'spotify',
      [],
      [{ id: 'albums', title: 'Albums', items: [{ type: 'album', album }] }],
    )
    const collector = createRecommendationCollector({ youtube, spotify })
    const home = await collector.home(testContext())
    expect(
      home.shelves.map(({ source, shelf: { id, items } }) => [source, id, items.length]),
    ).toEqual([
      ['ytm', 'quick-picks', 2],
      ['spotify', 'albums', 1],
    ])
    expect(outcomes(home)).toEqual(['ytm/home: ok 1', 'spotify/home: ok 1'])
    const all = await collector.home(testContext({ mode: 'all' }))
    expect(all.shelves.map(({ shelf: { items } }) => items.length)).toEqual([4, 2, 1])
    const stale = await collector.home(testContext({ mode: 'video' as CatalogMode }))
    expect(stale.shelves.map(({ shelf: { items } }) => items.length)).toEqual([2, 1])
  })

  it('skips feeds that cannot run, and reports failures', async () => {
    const spotify = fakeRadio('spotify', [], new FxmError('AuthRequired', 'log in'))
    const free = await createRecommendationCollector({
      youtube: fakeRadio('ytm', [], []),
      spotify,
    }).home(testContext({ tier: 'free' }))
    expect(outcomes(free)).toEqual([
      'ytm/home: skipped unreachable',
      'spotify/home: skipped unreachable',
    ])
    const failing = await createRecommendationCollector({ spotify }).home(testContext())
    expect(outcomes(failing)).toEqual([
      'ytm/home: skipped not-configured',
      'spotify/home: failed AuthRequired',
    ])
    const off = await createRecommendationCollector({ spotify, spotifyEnabled: () => false }).home(
      testContext(),
    )
    expect(outcomes(off)).toContain('spotify/home: skipped switched-off')
    const noHome = await createRecommendationCollector({ youtube: fakeRadio('ytm', []) }).home(
      testContext(),
    )
    expect(outcomes(noHome)[0]).toBe('ytm/home: skipped not-configured')
  })

  it('reports every Unsupported refusal of a home feed as a failure, having no seed', async () => {
    for (const error of [
      new FxmError('Unsupported', 'no hash for home'),
      new SpotifyError('operation-unsupported', 'no hash for home'),
      new SpotifyError('client-rejected', '403 Client/request not allowed'),
      new SpotifyError('unsupported-seed', 'not a seed'),
    ]) {
      const home = await createRecommendationCollector({
        spotify: fakeRadio('spotify', [], error),
      }).home(testContext())
      expect(outcomes(home)).toContain('spotify/home: failed Unsupported')
      expect(home.outcomes[1]).toMatchObject({ error })
    }
    const disabled = await createRecommendationCollector({
      spotify: fakeRadio('spotify', [], new SpotifyError('disabled', 'off')),
    }).home(testContext())
    expect(outcomes(disabled)).toContain('spotify/home: skipped switched-off')
  })

  it('returns what is ready at the deadline, and delivers each feed as it comes', async () => {
    vi.useFakeTimers({ now: Date.parse('2026-10-26T00:00:00Z') })
    const delivered: string[] = []
    const slow = {
      id: 'spotify',
      radio: async () => [],
      home: () => new Promise<Shelf[]>(() => undefined),
    }
    const collector = createRecommendationCollector({
      youtube: fakeRadio('ytm', [], [shelf('quick-picks', YTM_RADIO)]),
      spotify: slow,
    })
    const pending = collector.home(testContext(), {
      deadlineMs: 500,
      onResult: (result) => delivered.push(line(result.outcome)),
    })
    await vi.advanceTimersByTimeAsync(500)
    const home = await pending
    expect(outcomes(home)).toEqual(['ytm/home: ok 1', 'spotify/home: timed-out 500'])
    expect(delivered).toEqual(['ytm/home: ok 1', 'spotify/home: timed-out 500'])
  })
})
