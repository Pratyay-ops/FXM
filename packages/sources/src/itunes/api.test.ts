import { isFxmError } from '@fxm/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fakeFetch, jsonResponse, paramsOf, testContext, textResponse } from '../recommend/testing'
import {
  createItunesClient,
  ITUNES_SEARCH_URL,
  type ItunesOptions,
  itunesArtwork,
  parseAlbums,
  parseSongs,
} from './api'
import ramAlbums from './fixtures/search-album-daft-punk-ram.json'
import getLucky from './fixtures/search-song-daft-punk-get-lucky.json'
import creep from './fixtures/search-song-radiohead-creep.json'

const ART =
  'https://is1-ssl.mzstatic.com/image/thumb/Music126/v4/28/7a/7c/287a7ca9-ed95-1a21-e3bb-4559a1a0ac0e/191404134351.png/100x100bb.jpg'

afterEach(() => {
  vi.useRealTimers()
})

/** A client in front of a fake iTunes Search, and the requests it made. */
function setup(route: (url: URL) => Response | Promise<Response>, options: ItunesOptions = {}) {
  const { fetch, calls } = fakeFetch(route)
  return { client: createItunesClient(options), ctx: testContext({ fetch, tier: 'free' }), calls }
}

/** The error a promise rejects with. */
function failure(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => new Error('expected a rejection'),
    (error: unknown) => error,
  )
}

describe('itunesArtwork', () => {
  it('offers the cover in three sizes, smallest first', () => {
    expect(itunesArtwork(ART)).toEqual(
      [100, 300, 600].map((size) => ({
        url: ART.replace('100x100bb.jpg', `${size}x${size}bb.jpg`),
        width: size,
        height: size,
      })),
    )
  })

  it('keeps a URL without a size part as it is, and refuses other hosts', () => {
    const plain = 'https://is2-ssl.mzstatic.com/image/thumb/x/cover.jpg'
    expect(itunesArtwork(plain)).toEqual([{ url: plain }])
    for (const url of [
      'https://evil.example/100x100bb.jpg',
      'http://is1-ssl.mzstatic.com/x/100x100bb.jpg',
      'https://mzstatic.com.evil.example/x/100x100bb.jpg',
      'https://user@is1-ssl.mzstatic.com/x/100x100bb.jpg',
      'not a url',
    ]) {
      expect(itunesArtwork(url)).toEqual([])
    }
  })
})

describe('parseSongs and parseAlbums', () => {
  it('read the recorded searches', () => {
    const songs = parseSongs(getLucky)
    expect(songs).toHaveLength(10)
    expect(songs[0]).toEqual({
      trackId: getLucky.results[0]?.trackId,
      title: 'Get Lucky',
      artist: 'Daft Punk, Pharrell Williams & Nile Rodgers',
      album: 'Random Access Memories',
      durationMs: 369_629,
      artworkUrl: getLucky.results[0]?.artworkUrl100,
    })
    const albums = parseAlbums(ramAlbums)
    expect(albums.map((album) => album.name)).toContain('Random Access Memories')
    expect(albums[0]).toMatchObject({
      artist: 'Daft Punk',
      artworkUrl: ramAlbums.results[0]?.artworkUrl100,
    })
  })

  it('skip results of other kinds and results without names, and leave out bad artwork', () => {
    expect(
      parseSongs({
        results: [
          { kind: 'music-video', trackId: 1, trackName: 'A', artistName: 'B' },
          { kind: 'song', trackId: 2, trackName: ' ', artistName: 'B' },
          {
            kind: 'song',
            trackId: 3,
            trackName: 'C',
            artistName: 'D',
            artworkUrl100: 'https://evil.example/x.jpg',
          },
        ],
      }),
    ).toEqual([{ trackId: 3, title: 'C', artist: 'D' }])
    expect(
      parseAlbums({
        results: [{ wrapperType: 'track', collectionId: 1, collectionName: 'A', artistName: 'B' }],
      }),
    ).toEqual([])
  })

  it('reject an answer without results', () => {
    expect(() => parseSongs({ resultCount: 0 })).toThrowError(
      expect.objectContaining({ code: 'Parse' }),
    )
  })
})

describe('createItunesClient', () => {
  it('searches the music of the context’s store', async () => {
    const { client, ctx, calls } = setup(() => jsonResponse(getLucky))
    const songs = await client.searchSongs(' Daft Punk  Get Lucky ', { ...ctx, region: 'in' })
    expect(songs).toHaveLength(10)
    expect(`${calls[0]?.url.origin}${calls[0]?.url.pathname}`).toBe(ITUNES_SEARCH_URL)
    expect(paramsOf(calls[0])).toEqual({
      term: 'Daft Punk Get Lucky',
      country: 'IN',
      media: 'music',
      entity: 'song',
      limit: '10',
    })
    expect(calls[0]?.init?.credentials).toBe('omit')
    expect(calls[0]?.init?.headers).toBeUndefined()
  })

  it('uses the US store without a usable region, and an explicit country first', async () => {
    const { client, ctx, calls } = setup(() => jsonResponse(ramAlbums))
    await client.searchAlbums('Daft Punk Random Access Memories', { ...ctx, region: 'India' })
    await client.searchAlbums('Daft Punk Random Access Memories', ctx, {
      country: 'gb',
      limit: 500,
    })
    expect(paramsOf(calls[0])).toMatchObject({ country: 'US', entity: 'album', limit: '10' })
    expect(paramsOf(calls[1])).toMatchObject({ country: 'GB', limit: '200' })
  })

  it('caches answers for as long as Apple says', async () => {
    vi.useFakeTimers({ now: Date.parse('2026-10-26T00:00:00Z') })
    const { client, ctx, calls } = setup(() =>
      jsonResponse(creep, { headers: { 'cache-control': 'max-age=7200' } }),
    )
    await client.searchSongs('Radiohead Creep', ctx)
    await client.searchSongs('Radiohead Creep', ctx)
    expect(calls).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(7_200_000)
    await client.searchSongs('Radiohead Creep', ctx)
    expect(calls).toHaveLength(2)
  })

  it('asks nothing for an empty term', async () => {
    const { client, ctx, calls } = setup(() => jsonResponse(creep))
    expect(await client.searchSongs('  ', ctx)).toEqual([])
    expect(await client.searchAlbums('', ctx)).toEqual([])
    expect(calls).toHaveLength(0)
  })

  it('keeps to the per-minute limit', async () => {
    vi.useFakeTimers({ now: Date.parse('2026-10-26T00:00:00Z') })
    const { client, ctx, calls } = setup(() => jsonResponse(creep), { maxPerMinute: 2 })
    const searches = ['a', 'b', 'c'].map((term) => client.searchSongs(term, ctx))
    await vi.advanceTimersByTimeAsync(60_000)
    await Promise.all(searches)
    const t0 = calls[0]?.at ?? 0
    expect(calls.map((call) => call.at - t0)).toEqual([0, 0, 60_000])
  })

  it('fails at once rather than wait longer than allowed', async () => {
    const { client, ctx } = setup(() => jsonResponse(creep), { maxPerMinute: 1, maxWaitMs: 1_000 })
    await client.searchSongs('a', ctx)
    expect(isFxmError(await failure(client.searchSongs('b', ctx)), 'RateLimited')).toBe(true)
  })

  it('backs off when Apple refuses with 403 or 429', async () => {
    vi.useFakeTimers({ now: Date.parse('2026-10-26T00:00:00Z') })
    for (const status of [403, 429]) {
      const { client, ctx, calls } = setup(() => textResponse('Forbidden', { status }))
      expect(isFxmError(await failure(client.searchSongs('a', ctx)), 'RateLimited')).toBe(true)
      expect(isFxmError(await failure(client.searchAlbums('b', ctx)), 'RateLimited')).toBe(true)
      expect(calls).toHaveLength(1)
    }
  })

  it('reports other errors as Unavailable and odd answers as Parse', async () => {
    const server = setup(() => textResponse('oops', { status: 500 }))
    expect(
      isFxmError(await failure(server.client.searchSongs('a', server.ctx)), 'Unavailable'),
    ).toBe(true)
    const odd = setup(() => jsonResponse({ errorMessage: 'Invalid value(s) for key(s)' }))
    expect(isFxmError(await failure(odd.client.searchSongs('a', odd.ctx)), 'Parse')).toBe(true)
  })
})
