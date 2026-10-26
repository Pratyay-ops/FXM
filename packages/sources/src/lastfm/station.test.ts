import { isFxmError } from '@fxm/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  type FetchCall,
  fakeFetch,
  jsonResponse,
  testContext,
  textResponse,
} from '../shared/fake-network'
import { fixtures } from './fixtures/testing'
import {
  createLastfmStations,
  LASTFM_STATION_PREFIX,
  LASTFM_WEB_ORIGIN,
  LastfmStationPacing,
  type LastfmStationPacingOptions,
  type LastfmStationsOptions,
  lastfmPathSegment,
  lastfmStationPacing,
  lastfmStationsReachable,
  lastfmStationUrl,
  parseLastfmStation,
} from './station'

afterEach(() => {
  vi.useRealTimers()
})

/** A station reader with its own pacing in front of a fake Last.fm, and the requests it made. */
function setup(
  route: (url: URL) => Response | Promise<Response>,
  pacingOptions: LastfmStationPacingOptions = {},
  options: LastfmStationsOptions = {},
) {
  const { fetch, calls } = fakeFetch(route)
  const pacing = new LastfmStationPacing({ minIntervalMs: 0, ...pacingOptions })
  const stations = createLastfmStations({ pacing, ...options })
  return { stations, pacing, ctx: testContext({ fetch }), calls }
}

/** The error a promise rejects with. */
function failure(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => new Error('expected a rejection'),
    (error: unknown) => error,
  )
}

describe('lastfmPathSegment', () => {
  it.each([
    ['Radiohead', 'Radiohead'],
    ['my bloody valentine', 'my+bloody+valentine'],
    ["Don't Look Back in Anger", 'Don%27t+Look+Back+in+Anger'],
    ['Where Is My Mind?', 'Where+Is+My+Mind%3F'],
    ['Björk', 'Bj%C3%B6rk'],
    ['AC/DC', 'AC%2FDC'],
    ['R.E.M.', 'R.E.M.'],
    ['Exit Music (for a Film)', 'Exit+Music+(for+a+Film)'],
    ['  Sigur Rós  ', 'Sigur+R%C3%B3s'],
  ])('writes %j as %j, as Last.fm does', (name, segment) => {
    expect(lastfmPathSegment(name)).toBe(segment)
  })

  it('encodes a name of dots only, which a URL would resolve away', () => {
    expect(lastfmPathSegment('..')).toBe('%2E%2E')
    expect(lastfmStationUrl({ type: 'similar', artist: '..' })).toBe(
      'https://www.last.fm/player/station/music/%2E%2E/+similar',
    )
    expect(lastfmPathSegment('...And You Will Know Us')).toBe('...And+You+Will+Know+Us')
  })

  it('survives a lone surrogate, which encodeURIComponent refuses', () => {
    expect(lastfmPathSegment('a\uD800b')).toBe('a%EF%BF%BDb')
  })
})

describe('lastfmStationUrl', () => {
  it('builds the URLs on Last.fm’s play buttons', () => {
    expect(lastfmStationUrl({ type: 'similar', artist: 'Radiohead' })).toBe(
      'https://www.last.fm/player/station/music/Radiohead/+similar',
    )
    expect(lastfmStationUrl({ type: 'artist', artist: 'Sigur Rós' })).toBe(
      'https://www.last.fm/player/station/music/Sigur+R%C3%B3s',
    )
    expect(
      lastfmStationUrl({ type: 'artist', artist: 'A' }).startsWith(LASTFM_STATION_PREFIX),
    ).toBe(true)
  })
})

describe('lastfmStationsReachable', () => {
  it('is true only in the Full tier', () => {
    expect(lastfmStationsReachable(testContext({ tier: 'full' }).capabilities)).toBe(true)
    expect(lastfmStationsReachable(testContext({ tier: 'lite' }).capabilities)).toBe(false)
    expect(lastfmStationsReachable(testContext({ tier: 'free' }).capabilities)).toBe(false)
  })
})

describe('parseLastfmStation', () => {
  it('reads every song of a recorded station', () => {
    const tracks = parseLastfmStation(fixtures.stationSimilar)
    expect(tracks).toHaveLength(24)
    expect(tracks[0]).toEqual({
      title: 'Stockholm Syndrome',
      artists: ['Muse'],
      youtubeId: 'gXN9acC9edU',
      url: 'https://www.last.fm/music/Muse/_/Stockholm+Syndrome',
    })
    expect(tracks.every((track) => track.youtubeId !== undefined)).toBe(true)
    expect(new Set(tracks.map((track) => track.artists[0])).size).toBeGreaterThan(15)
  })

  it('reads the artist station, and never the station’s durations, which mislead', () => {
    const tracks = parseLastfmStation(fixtures.stationArtist)
    expect(tracks).toHaveLength(30)
    expect(tracks.every((track) => track.artists[0] === 'Radiohead')).toBe(true)
    // The station says 279 s for Creep, whose album version is 3:56.
    expect(fixtures.stationArtist.playlist[0]).toMatchObject({ name: 'Creep', duration: 279 })
    expect(tracks.some((track) => 'durationMs' in track)).toBe(false)
  })

  it('falls back to the underscored fields, and skips what it cannot use', () => {
    const tracks = parseLastfmStation(
      {
        playlist: [
          {
            _name: 'Only underscored',
            artists: [{ _name: 'Someone' }],
            _playlinks: [{ affiliate: 'youtube', id: 'abcdefghijk' }],
            url: '//evil.example/x',
            duration: 0,
          },
          { name: 'No artist', artists: [] },
          { name: '   ', artists: [{ name: 'Someone' }] },
          {
            name: 'Bad links',
            artists: [{ name: 'Someone' }, { name: 42 }, { name: 'Guest' }],
            playlinks: [
              { affiliate: 'spotify', id: 'abcdefghijk' },
              { affiliate: 'youtube', id: 'too-short' },
              { affiliate: 'youtube', id: 'lmnopqrstuv' },
            ],
          },
          { name: 'Only underscored', artists: [{ name: 'someone' }] },
          'not an object',
        ],
      },
      'https://lastfm.test',
    )
    expect(tracks).toEqual([
      {
        title: 'Only underscored',
        artists: ['Someone'],
        youtubeId: 'abcdefghijk',
        url: 'https://lastfm.test/music/Someone/_/Only+underscored',
      },
      {
        title: 'Bad links',
        artists: ['Someone', 'Guest'],
        youtubeId: 'lmnopqrstuv',
        url: 'https://lastfm.test/music/Someone/_/Bad+links',
      },
    ])
  })

  it('caps very long names', () => {
    const [track] = parseLastfmStation({
      playlist: [{ name: 'x'.repeat(1_000), artists: [{ name: 'A' }] }],
    })
    expect(track?.title).toHaveLength(300)
  })

  it('rejects an answer without a playlist', () => {
    expect(() => parseLastfmStation({ tracks: [] })).toThrowError(
      expect.objectContaining({ code: 'Parse' }),
    )
    expect(() => parseLastfmStation(null)).toThrowError(expect.objectContaining({ code: 'Parse' }))
  })
})

describe('createLastfmStations', () => {
  it('fetches the station Last.fm’s own button names, without cookies or headers', async () => {
    const { stations, ctx, calls } = setup(() => jsonResponse(fixtures.stationSimilar))
    const tracks = await stations.station({ type: 'similar', artist: 'Radiohead' }, ctx)
    expect(tracks).toHaveLength(24)
    expect(calls).toHaveLength(1)
    const [call] = calls as [FetchCall]
    expect(call.url.href).toBe(`${LASTFM_WEB_ORIGIN}/player/station/music/Radiohead/+similar`)
    expect(call.init?.credentials).toBe('omit')
    expect(call.init?.headers).toBeUndefined()
  })

  it('refuses outside the Full tier, without a request', async () => {
    const { stations, calls } = setup(() => jsonResponse(fixtures.stationSimilar))
    for (const tier of ['free', 'lite'] as const) {
      const ctx = testContext({ tier })
      expect(stations.isReachable(ctx)).toBe(false)
      const error = await failure(stations.station({ type: 'similar', artist: 'Radiohead' }, ctx))
      expect(isFxmError(error, 'Unsupported')).toBe(true)
    }
    expect(stations.isReachable(testContext({ tier: 'full' }))).toBe(true)
    expect(calls).toHaveLength(0)
  })

  it('asks the app’s own reachability check instead, when it has one', async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse(fixtures.stationSimilar))
    const pacing = new LastfmStationPacing({ minIntervalMs: 0 })
    const station = { type: 'similar', artist: 'Radiohead' } as const
    // E.g. the transport says FXM Connect lacks its Last.fm feature, in the Full tier.
    const closed = createLastfmStations({ pacing, reachable: () => false })
    const full = testContext({ fetch, tier: 'full' })
    expect(closed.isReachable(full)).toBe(false)
    expect(isFxmError(await failure(closed.station(station, full)), 'Unsupported')).toBe(true)
    const open = createLastfmStations({ pacing, reachable: () => true })
    const lite = testContext({ fetch, tier: 'lite' })
    expect(open.isReachable(lite)).toBe(true)
    expect(await open.station(station, lite)).toHaveLength(24)
    expect(calls).toHaveLength(1)
  })

  it('asks nothing for an artist without a name', async () => {
    const { stations, ctx, calls } = setup(() => jsonResponse(fixtures.stationSimilar))
    expect(await stations.station({ type: 'artist', artist: '  ' }, ctx)).toEqual([])
    expect(calls).toHaveLength(0)
  })

  it('treats the challenge page as a bot check, and then pauses', async () => {
    vi.useFakeTimers({ now: Date.parse('2026-10-26T00:00:00Z') })
    let challenge = true
    const { stations, ctx, calls } = setup(
      () => (challenge ? textResponse(fixtures.challenge) : jsonResponse(fixtures.stationArtist)),
      { challengeBackoffMs: 60_000 },
    )
    const station = { type: 'artist', artist: 'Radiohead' } as const
    const first = await failure(stations.station(station, ctx))
    expect(isFxmError(first, 'BotCheck')).toBe(true)
    expect((first as { retryAfterMs: number }).retryAfterMs).toBe(60_000)
    challenge = false
    await vi.advanceTimersByTimeAsync(20_000)
    const second = await failure(stations.station(station, ctx))
    expect(isFxmError(second, 'BotCheck')).toBe(true)
    expect((second as { retryAfterMs: number }).retryAfterMs).toBe(40_000)
    expect(calls).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(40_000)
    expect(await stations.station(station, ctx)).toHaveLength(30)
    expect(calls).toHaveLength(2)
  })

  it('sends no queued request after a challenge', async () => {
    const { stations, ctx, calls } = setup(() => textResponse(fixtures.challenge))
    const station = { type: 'similar', artist: 'Radiohead' } as const
    const errors = await Promise.all([1, 2, 3].map(() => failure(stations.station(station, ctx))))
    expect(errors.every((error) => isFxmError(error, 'BotCheck'))).toBe(true)
    expect(calls).toHaveLength(1)
  })

  it('shares the pause between readers that share the pacing', async () => {
    const { fetch, calls } = fakeFetch(() => textResponse(fixtures.challenge))
    const pacing = new LastfmStationPacing({ minIntervalMs: 0 })
    const ctx = testContext({ fetch })
    const station = { type: 'artist', artist: 'Radiohead' } as const
    const one = createLastfmStations({ pacing })
    const two = createLastfmStations({ pacing })
    expect(isFxmError(await failure(one.station(station, ctx)), 'BotCheck')).toBe(true)
    expect(isFxmError(await failure(two.station(station, ctx)), 'BotCheck')).toBe(true)
    expect(calls).toHaveLength(1)
    expect(pacing.challengeRemainingMs()).toBeGreaterThan(0)
    // Readers without pacing of their own share the app's.
    expect(lastfmStationPacing.challengeRemainingMs()).toBe(0)
  })

  it('also takes HTML without a content type, and a 403, as the challenge', async () => {
    const pages = [
      new Response('  <!doctype html><title>Client Challenge</title>', { status: 200 }),
      textResponse('Forbidden', { status: 403, contentType: 'text/plain' }),
    ]
    for (const page of pages) {
      const { stations, ctx } = setup(() => page)
      const error = await failure(stations.station({ type: 'artist', artist: 'Radiohead' }, ctx))
      expect(isFxmError(error, 'BotCheck')).toBe(true)
    }
  })

  it('gives no songs for an artist Last.fm does not know', async () => {
    const { stations, ctx } = setup(() => textResponse('Not found', { status: 404 }))
    expect(await stations.station({ type: 'artist', artist: 'Nobody' }, ctx)).toEqual([])
  })

  it('honours a 429 with Retry-After, and fails at once until then', async () => {
    vi.useFakeTimers({ now: Date.parse('2026-10-26T00:00:00Z') })
    const { stations, ctx, calls } = setup(() =>
      jsonResponse({}, { status: 429, headers: { 'retry-after': '20' } }),
    )
    const station = { type: 'artist', artist: 'Radiohead' } as const
    const first = await failure(stations.station(station, ctx))
    expect(isFxmError(first, 'RateLimited')).toBe(true)
    expect((first as { retryAfterMs: number }).retryAfterMs).toBeGreaterThanOrEqual(20_000)
    expect((first as { retryAfterMs: number }).retryAfterMs).toBeLessThanOrEqual(26_000)
    expect(isFxmError(await failure(stations.station(station, ctx)), 'RateLimited')).toBe(true)
    expect(calls).toHaveLength(1)
  })

  it('reports server errors as Unavailable and broken JSON as Parse', async () => {
    const server = setup(() => textResponse('oops', { status: 502, contentType: 'text/plain' }))
    const station = { type: 'artist', artist: 'Radiohead' } as const
    const unavailable = await failure(server.stations.station(station, server.ctx))
    expect(isFxmError(unavailable, 'Unavailable')).toBe(true)
    const broken = setup(() => textResponse('{"playlist": [', { contentType: 'application/json' }))
    const parse = await failure(broken.stations.station(station, broken.ctx))
    expect(isFxmError(parse, 'Parse')).toBe(true)
  })

  it('keeps a human pace between station requests', async () => {
    vi.useFakeTimers({ now: Date.parse('2026-10-26T00:00:00Z') })
    const { stations, ctx, calls } = setup(() => jsonResponse(fixtures.stationArtist), {
      minIntervalMs: 2_000,
    })
    const station = { type: 'artist', artist: 'Radiohead' } as const
    const both = Promise.all([stations.station(station, ctx), stations.station(station, ctx)])
    await vi.advanceTimersByTimeAsync(2_000)
    await both
    const [a, b] = calls
    expect((b?.at ?? 0) - (a?.at ?? 0)).toBe(2_000)
  })
})
