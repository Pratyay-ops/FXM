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
  createLastfmApiClient,
  LASTFM_API_URL,
  type LastfmApiOptions,
  parseLastfmSimilarArtists,
} from './api'
import { fixtures } from './fixtures/testing'

afterEach(() => {
  vi.useRealTimers()
})

/** An API client with a test key in front of a fake Last.fm API, and the requests it made. */
function setup(
  route: (url: URL) => Response | Promise<Response>,
  options: Partial<LastfmApiOptions> = {},
) {
  const { fetch, calls } = fakeFetch(route)
  const api = createLastfmApiClient({ apiKey: 'test-key', minIntervalMs: 0, ...options })
  return { api, ctx: testContext({ fetch, tier: 'free' }), calls }
}

/** The error a promise rejects with. */
function failure(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => new Error('expected a rejection'),
    (error: unknown) => error,
  )
}

describe('parseLastfmSimilarArtists', () => {
  it('reads the documented format', () => {
    const artists = parseLastfmSimilarArtists(fixtures.apiSimilarArtists)
    expect(artists).toHaveLength(10)
    expect(artists[0]).toEqual({
      name: 'Nirvana',
      mbid: '5b11f4ce-a62d-471e-81fc-a69a8278c7da',
      match: 1,
      url: 'https://www.last.fm/music/Nirvana',
    })
    // An empty mbid is left out.
    expect(artists[2]).toEqual({
      name: 'Muse',
      match: 0.874512,
      url: 'https://www.last.fm/music/Muse',
    })
  })

  it('takes a single artist sent as an object, and clamps odd values', () => {
    const artists = parseLastfmSimilarArtists({
      similarartists: {
        artist: { name: ' Thom  Yorke ', match: '1.5', url: 'javascript:alert(1)', mbid: 'nope' },
      },
    })
    expect(artists).toEqual([
      { name: 'Thom Yorke', match: 1, url: 'https://www.last.fm/music/Thom+Yorke' },
    ])
    expect(
      parseLastfmSimilarArtists({
        similarartists: { artist: [{ name: 'A', match: 'x' }, { match: 1 }] },
      }),
    ).toEqual([{ name: 'A', match: 0, url: 'https://www.last.fm/music/A' }])
    expect(parseLastfmSimilarArtists({ similarartists: {} })).toEqual([])
  })

  it('writes an MBID in its canonical form', () => {
    const [artist] = parseLastfmSimilarArtists({
      similarartists: {
        artist: [{ name: 'Nirvana', mbid: ' 5B11F4CE-A62D-471E-81FC-A69A8278C7DA ', match: 1 }],
      },
    })
    expect(artist?.mbid).toBe('5b11f4ce-a62d-471e-81fc-a69a8278c7da')
  })

  it('rejects an answer without similar artists', () => {
    expect(() => parseLastfmSimilarArtists({ artists: [] })).toThrowError(
      expect.objectContaining({ code: 'Parse' }),
    )
  })
})

describe('createLastfmApiClient', () => {
  it('asks artist.getSimilar with the key, and corrects misspellings', async () => {
    const { api, ctx, calls } = setup(() => jsonResponse(fixtures.apiSimilarArtists))
    const artists = await api.similarArtists(' Radiohead ', ctx, { limit: 10 })
    expect(artists).toHaveLength(10)
    expect(`${calls[0]?.url.origin}${calls[0]?.url.pathname}`).toBe(LASTFM_API_URL)
    expect(paramsOf(calls[0])).toEqual({
      method: 'artist.getsimilar',
      artist: 'Radiohead',
      autocorrect: '1',
      limit: '10',
      api_key: 'test-key',
      format: 'json',
    })
    expect(calls[0]?.init?.credentials).toBe('omit')
  })

  it('refuses a blank API key at once', () => {
    for (const apiKey of ['', '   ']) {
      expect(() => createLastfmApiClient({ apiKey })).toThrowError(TypeError)
    }
  })

  it('reads the limit defensively', async () => {
    const { api, ctx, calls } = setup(() => jsonResponse(fixtures.apiSimilarArtists))
    for (const limit of [Number.NaN, -1, 2.5, 500])
      await api.similarArtists('Radiohead', ctx, { limit })
    expect(calls.map((call) => paramsOf(call).limit)).toEqual(['30', '1', '2', '100'])
  })

  it('caches answers, as Last.fm’s terms ask', async () => {
    vi.useFakeTimers({ now: Date.parse('2026-10-26T00:00:00Z') })
    const { api, ctx, calls } = setup(() =>
      jsonResponse(fixtures.apiSimilarArtists, { headers: { 'cache-control': 'max-age=1200' } }),
    )
    await api.similarArtists('Radiohead', ctx)
    await api.similarArtists(' Radiohead', ctx)
    expect(calls).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1_200_000)
    await api.similarArtists('Radiohead', ctx)
    expect(calls).toHaveLength(2)
  })

  it('keeps names that differ only in symbols apart', async () => {
    const { api, ctx, calls } = setup(() => jsonResponse(fixtures.apiSimilarArtists))
    await api.similarArtists('!!!', ctx)
    await api.similarArtists('✝✝✝', ctx)
    expect(calls.map((call) => paramsOf(call).artist)).toEqual(['!!!', '✝✝✝'])
  })

  it('asks nothing for an empty name', async () => {
    const { api, ctx, calls } = setup(() => jsonResponse(fixtures.apiSimilarArtists))
    expect(await api.similarArtists('  ', ctx)).toEqual([])
    expect(calls).toHaveLength(0)
  })

  it('gives no artists, and remembers it, when Last.fm cannot find the artist', async () => {
    for (const status of [200, 400]) {
      const { api, ctx, calls } = setup(() =>
        jsonResponse(fixtures.apiErrorUnknownArtist, { status }),
      )
      expect(await api.similarArtists('Nobody At All', ctx)).toEqual([])
      expect(await api.similarArtists('Nobody At All', ctx)).toEqual([])
      expect(calls).toHaveLength(1)
    }
  })

  it('reports a missing parameter, which is the key, as AuthRequired, without caching it', async () => {
    const { api, ctx, calls } = setup(() =>
      jsonResponse(fixtures.apiErrorMissingParameter, { status: 400 }),
    )
    for (let attempt = 0; attempt < 2; attempt++) {
      const error = await failure(api.similarArtists('Radiohead', ctx))
      expect(isFxmError(error, 'AuthRequired')).toBe(true)
    }
    expect(calls).toHaveLength(2)
  })

  it('reports a refused key as AuthRequired', async () => {
    for (const code of [10, 26]) {
      const { api, ctx } = setup(() =>
        jsonResponse({ error: code, message: 'no' }, { status: 403 }),
      )
      const error = await failure(api.similarArtists('Radiohead', ctx))
      expect(isFxmError(error, 'AuthRequired')).toBe(true)
      expect((error as Error).message).not.toContain('test-key')
    }
  })

  it('backs off on error 29 and on HTTP 429', async () => {
    vi.useFakeTimers({ now: Date.parse('2026-10-26T00:00:00Z') })
    const answers = [
      jsonResponse({ error: 29, message: 'Rate limit exceeded' }, { status: 429 }),
      textResponse('busy', { status: 429, headers: { 'retry-after': '5' } }),
    ]
    for (const answer of answers) {
      const { api, ctx, calls } = setup(() => answer)
      expect(isFxmError(await failure(api.similarArtists('A', ctx)), 'RateLimited')).toBe(true)
      expect(isFxmError(await failure(api.similarArtists('B', ctx)), 'RateLimited')).toBe(true)
      expect(calls).toHaveLength(1)
    }
  })

  it('reports other failures as Unavailable, and broken JSON as Parse', async () => {
    const offline = setup(() => jsonResponse({ error: 11, message: 'Service Offline' }))
    expect(
      isFxmError(await failure(offline.api.similarArtists('A', offline.ctx)), 'Unavailable'),
    ).toBe(true)
    const server = setup(() => textResponse('<html>oops</html>', { status: 500 }))
    expect(
      isFxmError(await failure(server.api.similarArtists('A', server.ctx)), 'Unavailable'),
    ).toBe(true)
    const broken = setup(() =>
      textResponse('{"similarartists":', { contentType: 'application/json' }),
    )
    expect(isFxmError(await failure(broken.api.similarArtists('A', broken.ctx)), 'Parse')).toBe(
      true,
    )
  })
})
