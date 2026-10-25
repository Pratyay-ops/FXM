import { isFxmError } from '@fxm/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  fakeFetch,
  jsonResponse,
  paramsOf,
  testContext,
  textResponse,
} from '../shared/fake-network'
import {
  createListenBrainzClient,
  DEFAULT_LISTENBRAINZ_ALGORITHM,
  LISTENBRAINZ_LABS_ORIGIN,
  type ListenBrainzOptions,
  parseListenBrainzRecordingLookup,
  parseListenBrainzSimilarArtists,
} from './api'
import acrLookup from './fixtures/acr-lookup-radiohead-creep.json'
import similarArtists from './fixtures/similar-artists-radiohead.json'

const RADIOHEAD = 'a74b1b7f-71a5-4011-9441-d0b5e4122711'

afterEach(() => {
  vi.useRealTimers()
})

/** A client in front of a fake labs API, and the requests it made. */
function setup(
  route: (url: URL) => Response | Promise<Response>,
  options: ListenBrainzOptions = {},
) {
  const { fetch, calls } = fakeFetch(route)
  const client = createListenBrainzClient({ minIntervalMs: 0, ...options })
  return { client, ctx: testContext({ fetch, tier: 'free' }), calls }
}

/** Answers the two labs endpoints from the recorded fixtures. */
function labs(url: URL): Response {
  if (url.pathname === '/acr-lookup/json') return jsonResponse(acrLookup)
  if (url.pathname === '/similar-artists/json') return jsonResponse(similarArtists)
  return textResponse('Not found', { status: 404 })
}

/** The error a promise rejects with. */
function failure(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => new Error('expected a rejection'),
    (error: unknown) => error,
  )
}

describe('parseListenBrainzRecordingLookup', () => {
  it('reads the recorded lookup', () => {
    expect(parseListenBrainzRecordingLookup(acrLookup)).toEqual({
      recordingMbid: '70595637-9310-45f2-a266-58f8de4874a7',
      recordingName: 'Creep',
      artistCredit: 'Radiohead',
      artistMbids: [RADIOHEAD],
      releaseMbid: '07aab296-9a40-42a9-8d1f-6b06aa032e8a',
      releaseName: 'Pablo Honey',
    })
  })

  it('skips rows it cannot use, and finds nothing in an empty answer', () => {
    expect(parseListenBrainzRecordingLookup([])).toBeNull()
    expect(
      parseListenBrainzRecordingLookup([
        { recording_mbid: 'nope', recording_name: 'A', artist_credit_name: 'B' },
        {
          recording_mbid: '70595637-9310-45f2-a266-58f8de4874a7',
          recording_name: 'Creep',
          artist_credit_name: 'Radiohead',
          artist_mbids: [RADIOHEAD.toUpperCase(), 'bad'],
          release_mbid: null,
        },
      ]),
    ).toEqual({
      recordingMbid: '70595637-9310-45f2-a266-58f8de4874a7',
      recordingName: 'Creep',
      artistCredit: 'Radiohead',
      artistMbids: [RADIOHEAD],
    })
  })

  it('rejects an answer that is not a list', () => {
    expect(() => parseListenBrainzRecordingLookup({ error: 'x' })).toThrowError(
      expect.objectContaining({ code: 'Parse' }),
    )
  })
})

describe('parseListenBrainzSimilarArtists', () => {
  it('reads the recorded answer, best first, scored against the best', () => {
    const artists = parseListenBrainzSimilarArtists(similarArtists, RADIOHEAD)
    expect(artists).toHaveLength(25)
    expect(artists[0]).toEqual({
      mbid: '5b11f4ce-a62d-471e-81fc-a69a8278c7da',
      name: 'Nirvana',
      score: 11156,
      similarity: 1,
      comment: '1980s–1990s US grunge band',
    })
    expect(artists[1]?.similarity).toBeCloseTo(10587 / 11156)
    expect(artists[1]).not.toHaveProperty('comment')
  })

  it('keeps each artist once, never the seed, and only rows about the seed', () => {
    const row = (mbid: string, name: string, score: number, reference = RADIOHEAD) => ({
      artist_mbid: mbid,
      name,
      score,
      reference_mbid: reference,
    })
    const other = '5b11f4ce-a62d-471e-81fc-a69a8278c7da'
    const artists = parseListenBrainzSimilarArtists(
      [
        row(RADIOHEAD, 'Radiohead', 100),
        row(other, 'Nirvana', 10),
        row(other, 'Nirvana again', 50),
        row('9c9f1380-2516-4fc9-a3e6-f9f61941d090', 'Muse', 20),
        row('cc197bad-dc9c-440d-a5b5-d52ba2e14234', 'Coldplay', 30, other),
        row('ba0d6274-db14-4ef5-b28d-657ebde1a396', 'Zero', 0),
      ],
      RADIOHEAD,
    )
    expect(artists.map((artist) => [artist.name, artist.similarity])).toEqual([
      ['Muse', 1],
      ['Nirvana', 0.5],
    ])
  })
})

describe('createListenBrainzClient', () => {
  it('looks a recording up by artist credit and name', async () => {
    const { client, ctx, calls } = setup(labs)
    const lookup = await client.lookupRecording(' Radiohead ', 'Creep', ctx)
    expect(lookup?.artistMbids).toEqual([RADIOHEAD])
    expect(calls[0]?.url.origin).toBe(LISTENBRAINZ_LABS_ORIGIN)
    expect(calls[0]?.url.pathname).toBe('/acr-lookup/json')
    expect(paramsOf(calls[0])).toEqual({ artist_credit_name: 'Radiohead', recording_name: 'Creep' })
    expect(calls[0]?.init?.credentials).toBe('omit')
    expect(calls[0]?.init?.headers).toBeUndefined()
  })

  it('asks for similar artists with the default data set', async () => {
    const { client, ctx, calls } = setup(labs)
    const artists = await client.similarArtists(RADIOHEAD, ctx, { limit: 5 })
    expect(artists.map((artist) => artist.name)).toEqual([
      'Nirvana',
      'Red Hot Chili Peppers',
      'Muse',
      'Coldplay',
      'The Smashing Pumpkins',
    ])
    expect(calls[0]?.url.pathname).toBe('/similar-artists/json')
    expect(paramsOf(calls[0])).toEqual({
      artist_mbids: RADIOHEAD,
      algorithm: DEFAULT_LISTENBRAINZ_ALGORITHM,
    })
  })

  it('caches lookups, misses and similar artists', async () => {
    const { client, ctx, calls } = setup((url) =>
      url.searchParams.get('recording_name') === 'Nothing' ? jsonResponse([]) : labs(url),
    )
    await client.lookupRecording('Radiohead', 'Creep', ctx)
    await client.lookupRecording('radiohead', 'CREEP', ctx)
    expect(await client.lookupRecording('Radiohead', 'Nothing', ctx)).toBeNull()
    expect(await client.lookupRecording('Radiohead', 'Nothing', ctx)).toBeNull()
    await client.similarArtists(RADIOHEAD, ctx, { limit: 3 })
    expect(await client.similarArtists(RADIOHEAD, ctx, { limit: 30 })).toHaveLength(25)
    expect(calls).toHaveLength(3)
  })

  it('shares an answer that arrived while a call waited its turn', async () => {
    const { client, ctx, calls } = setup(labs)
    const [first, second] = await Promise.all([
      client.similarArtists(RADIOHEAD, ctx),
      client.similarArtists(RADIOHEAD, ctx),
    ])
    expect(second).toEqual(first)
    const [one, two] = await Promise.all([
      client.lookupRecording('Radiohead', 'Creep', ctx),
      client.lookupRecording('Radiohead', 'Creep', ctx),
    ])
    expect(two).toEqual(one)
    expect(calls).toHaveLength(2)
  })

  it('asks nothing without the names, and refuses a value that is not an MBID', async () => {
    const { client, ctx, calls } = setup(labs)
    expect(await client.lookupRecording('', 'Creep', ctx)).toBeNull()
    expect(await client.lookupRecording('Radiohead', '  ', ctx)).toBeNull()
    await expect(client.similarArtists('radiohead', ctx)).rejects.toThrowError(RangeError)
    expect(calls).toHaveLength(0)
  })

  it('takes an MBID in any case, and reads the limit defensively', async () => {
    const { client, ctx, calls } = setup(labs)
    const upper = await client.similarArtists(` ${RADIOHEAD.toUpperCase()} `, ctx, { limit: 2.5 })
    expect(upper).toHaveLength(2)
    expect(paramsOf(calls[0]).artist_mbids).toBe(RADIOHEAD)
    expect(await client.similarArtists(RADIOHEAD, ctx, { limit: Number.NaN })).toHaveLength(25)
    expect(await client.similarArtists(RADIOHEAD, ctx, { limit: -1 })).toEqual([])
    expect(calls).toHaveLength(1)
  })

  it('keys lookups on what it sends: "&" is not "and" to the labs API', async () => {
    const { client, ctx, calls } = setup(() => jsonResponse([]))
    await client.lookupRecording('Simon & Garfunkel', 'The Boxer', ctx)
    await client.lookupRecording('Simon and Garfunkel', 'The Boxer', ctx)
    await client.lookupRecording('!!!', 'Heart of Hearts', ctx)
    await client.lookupRecording('✝✝✝', 'Heart of Hearts', ctx)
    expect(calls).toHaveLength(4)
  })

  it('lets a call of a higher priority go before background lookups', async () => {
    const { client, ctx, calls } = setup(labs)
    const background = ['A', 'B', 'C'].map((name) =>
      client.lookupRecording('Radiohead', name, ctx, { priority: 'bulk' }),
    )
    const urgent = client.similarArtists(RADIOHEAD, ctx)
    await Promise.all([...background, urgent])
    expect(calls.map((call) => call.url.pathname)).toEqual([
      '/acr-lookup/json',
      '/similar-artists/json',
      '/acr-lookup/json',
      '/acr-lookup/json',
    ])
  })

  it('treats a 404 as nothing', async () => {
    const { client, ctx } = setup(() => textResponse('Not found', { status: 404 }))
    expect(await client.lookupRecording('A', 'B', ctx)).toBeNull()
    expect(await client.similarArtists(RADIOHEAD, ctx)).toEqual([])
  })

  it('honours a 429, reading the wait from X-RateLimit-Reset-In', async () => {
    vi.useFakeTimers({ now: Date.parse('2026-10-26T00:00:00Z') })
    const { client, ctx, calls } = setup(() =>
      jsonResponse({ code: 429 }, { status: 429, headers: { 'x-ratelimit-reset-in': '8' } }),
    )
    const error = await failure(client.similarArtists(RADIOHEAD, ctx))
    expect(isFxmError(error, 'RateLimited')).toBe(true)
    expect((error as { retryAfterMs: number }).retryAfterMs).toBeGreaterThanOrEqual(8_000)
    expect(isFxmError(await failure(client.lookupRecording('A', 'B', ctx)), 'RateLimited')).toBe(
      true,
    )
    expect(calls).toHaveLength(1)
  })

  it('reports other errors as Unavailable, and a non-list as Parse', async () => {
    const server = setup(() => textResponse('oops', { status: 500 }))
    expect(
      isFxmError(await failure(server.client.similarArtists(RADIOHEAD, server.ctx)), 'Unavailable'),
    ).toBe(true)
    const bad = setup(() => textResponse('bad algorithm', { status: 400 }))
    expect(
      isFxmError(await failure(bad.client.lookupRecording('A', 'B', bad.ctx)), 'Unavailable'),
    ).toBe(true)
    const odd = setup(() => jsonResponse({ results: [] }))
    expect(isFxmError(await failure(odd.client.similarArtists(RADIOHEAD, odd.ctx)), 'Parse')).toBe(
      true,
    )
  })
})
