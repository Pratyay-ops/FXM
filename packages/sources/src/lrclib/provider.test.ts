import { isFxmError, type Lyrics, lineAt } from '@fxm/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_LRCLIB_CLIENT, LRCLIB_ORIGIN, type LrclibRecord } from './api'
import {
  after,
  busy,
  contextFor,
  creep,
  fakeLrclib,
  fixtures,
  hangingFetch,
  json,
} from './fixtures/testing'
import * as entry from './index'
import { createLrclibProvider, LRCLIB_PROVIDER_ID, type LrclibOptions, lyricsOf } from './provider'

type Handler = (url: URL) => Response

/** A fake LRCLIB with a handler per endpoint; the others answer 404, and search nothing. */
function lrclib(handlers: { get?: Handler; search?: Handler; byId?: Handler }) {
  const notFound = () => json(fixtures.notFound, { status: 404 })
  return fakeLrclib((url) => {
    if (url.pathname === '/api/get') return (handlers.get ?? notFound)(url)
    if (url.pathname === '/api/search') return (handlers.search ?? (() => json([])))(url)
    return (handlers.byId ?? notFound)(url)
  })
}

/** A provider without request pacing, so tests need no timers. */
function provider(options: LrclibOptions = {}) {
  return createLrclibProvider({ minIntervalMs: 0, ...options })
}

/** The paths and queries a fake LRCLIB received, e.g. `/api/search?q=Radiohead+Creep`. */
function requests(calls: ReadonlyArray<{ url: URL }>): string[] {
  return calls.map((call) => `${call.url.pathname}${call.url.search}`)
}

/** Lyrics, or a failed test. */
function present(lyrics: Lyrics | null): Lyrics {
  if (lyrics === null) throw new Error('expected lyrics')
  return lyrics
}

const plainOnly = { ...fixtures.getCreep, syncedLyrics: null }
const GET_CREEP =
  '/api/get?track_name=Creep&artist_name=Radiohead&album_name=Pablo+Honey&duration=239'
const SEARCH_CREEP = '/api/search?q=Radiohead+Creep'

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('the LRCLIB provider', () => {
  it('is the lrclib lyrics provider, exported from the entry point', () => {
    expect(provider().id).toBe('lrclib')
    expect(LRCLIB_PROVIDER_ID).toBe('lrclib')
    expect(entry).toMatchObject({ createLrclibProvider, LRCLIB_PROVIDER_ID, LRCLIB_ORIGIN })
    expect(entry.DEFAULT_LRCLIB_CLIENT).toBe(DEFAULT_LRCLIB_CLIENT)
  })

  it('returns synced lyrics from the exact lookup in one request', async () => {
    const { fetch, calls } = lrclib({ get: () => json(fixtures.getCreep) })
    const lyrics = present(await provider().getLyrics(creep(), contextFor(fetch)))
    expect(lyrics).toMatchObject({
      synced: true,
      source: 'lrclib',
      metadata: { title: 'Creep', artist: 'Radiohead', album: 'Pablo Honey', lengthMs: 239_000 },
    })
    expect(lyrics.lines).toHaveLength(7)
    expect(lyrics.lines[0]).toEqual({ timeMs: 19_160, text: 'Creep, line 1' })
    expect(lyrics.lines.at(-1)).toEqual({ timeMs: 230_780, text: '' })
    expect(lineAt(lyrics, 30_000)).toBe(2)
    expect(requests(calls)).toEqual([GET_CREEP])
  })

  it('returns null for an instrumental without searching', async () => {
    const instrumental = { ...plainOnly, instrumental: true, plainLyrics: null }
    const { fetch, calls } = lrclib({ get: () => json(instrumental) })
    expect(await provider().getLyrics(creep(), contextFor(fetch))).toBeNull()
    expect(calls).toHaveLength(1)
  })

  it('looks for synced lyrics when the exact record only has plain ones', async () => {
    const { fetch, calls } = lrclib({
      get: () => json(plainOnly),
      search: () => json(fixtures.searchRadioheadCreep),
    })
    const lyrics = present(await provider().getLyrics(creep(), contextFor(fetch)))
    expect(lyrics.synced).toBe(true)
    expect(lyrics.lines[0]).toEqual({ timeMs: 19_160, text: 'Record 6730469, line 1' })
    expect(lyrics.metadata).toMatchObject({ title: 'Radiohead - Creep', lengthMs: 239_000 })
    expect(requests(calls)).toEqual([GET_CREEP, SEARCH_CREEP])
  })

  it.each([
    ['no synced lyrics fit', () => json([fixtures.searchRadioheadCreep[1]])],
    ['the search fails', () => new Response('UnknownError', { status: 500 })],
  ])('keeps the plain lyrics of the exact record when %s', async (_case, search) => {
    const { fetch, calls } = lrclib({ get: () => json(plainOnly), search })
    const lyrics = present(await provider().getLyrics(creep(), contextFor(fetch)))
    expect(lyrics).toMatchObject({ synced: false, source: 'lrclib', metadata: { title: 'Creep' } })
    expect(lyrics.lines).toEqual([
      { text: 'Creep, line 1' },
      { text: 'Creep, line 2' },
      { text: '' },
      { text: 'Creep, line 3' },
      { text: 'Creep, line 4' },
      { text: 'Creep, line 5' },
      { text: 'Creep, line 6' },
    ])
    expect(calls).toHaveLength(2)
  })

  it('does not trust exact synced lyrics of another cut, and drops their timestamps', async () => {
    const otherCut = { ...fixtures.getCreep, duration: 250, plainLyrics: null }
    const { fetch } = lrclib({ get: () => json(otherCut) })
    const lyrics = present(await provider().getLyrics(creep(), contextFor(fetch)))
    expect(lyrics.synced).toBe(false)
    expect(lyrics.lines.map((line) => line.text)).toEqual([
      'Creep, line 1',
      'Creep, line 2',
      'Creep, line 3',
      'Creep, line 4',
      'Creep, line 5',
      'Creep, line 6',
    ])
    expect(lyrics.metadata?.lengthMs).toBe(250_000)
  })

  it('trusts the exact synced lyrics of a track whose duration is unknown', async () => {
    const { durationMs: _duration, ...noDuration } = creep()
    const { fetch, calls } = lrclib({ get: () => json(fixtures.getCreep) })
    const lyrics = present(await provider().getLyrics(noDuration, contextFor(fetch)))
    expect(lyrics.synced).toBe(true)
    expect(requests(calls)).toEqual([
      '/api/get?track_name=Creep&artist_name=Radiohead&album_name=Pablo+Honey',
    ])
  })

  it('reads "synced" lyrics without timestamps as plain, after looking for better', async () => {
    const untimed = { ...fixtures.getCreep, plainLyrics: null, syncedLyrics: 'One\nTwo' }
    const { fetch, calls } = lrclib({ get: () => json(untimed) })
    const lyrics = present(await provider().getLyrics(creep(), contextFor(fetch)))
    expect(lyrics).toMatchObject({ synced: false, lines: [{ text: 'One' }, { text: 'Two' }] })
    expect(requests(calls)).toEqual([GET_CREEP, SEARCH_CREEP])
  })

  it('searches when the exact lookup misses, and scores the results', async () => {
    const { fetch, calls } = lrclib({ search: () => json(fixtures.searchRadioheadCreep) })
    const lyrics = present(await provider().getLyrics(creep(), contextFor(fetch)))
    expect(lyrics.synced).toBe(true)
    expect(lyrics.lines[0]?.text).toBe('Record 6730469, line 1')
    expect(requests(calls)).toEqual([GET_CREEP, SEARCH_CREEP])
  })

  it("waits out the Retry-After of LRCLIB's 503 miss before searching", async () => {
    vi.useFakeTimers()
    const { fetch, calls } = lrclib({
      get: busy,
      search: () => json(fixtures.searchRadioheadCreep),
    })
    const pending = provider().getLyrics(creep(), contextFor(fetch))
    await vi.advanceTimersByTimeAsync(999)
    expect(calls).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(400)
    expect(present(await pending).synced).toBe(true)
    expect(requests(calls)).toEqual([GET_CREEP, SEARCH_CREEP])
  })

  it('loads a search result by ID when the search left its lyrics out', async () => {
    const bare = fixtures.searchRadioheadCreep.map(
      ({ plainLyrics: _plain, syncedLyrics: _synced, ...record }) => record,
    )
    const { fetch, calls } = lrclib({
      search: () => json(bare),
      byId: (url) =>
        json(fixtures.searchRadioheadCreep.find((r) => url.pathname.endsWith(`/${r.id}`))),
    })
    const lyrics = present(await provider().getLyrics(creep(), contextFor(fetch)))
    expect(lyrics.lines[0]?.text).toBe('Record 6730469, line 1')
    expect(requests(calls)).toEqual([GET_CREEP, SEARCH_CREEP, '/api/get/6730469'])
  })

  it('returns null when the record loaded by ID is gone', async () => {
    const bare = [{ ...fixtures.getCreep, plainLyrics: undefined, syncedLyrics: undefined }]
    const { fetch, calls } = lrclib({ search: () => json(bare) })
    expect(await provider().getLyrics(creep(), contextFor(fetch))).toBeNull()
    expect(calls).toHaveLength(3)
  })

  it('returns null when no search result fits, or the best is instrumental', async () => {
    const { fetch } = lrclib({ search: () => json(fixtures.searchRadioheadCreep) })
    const karmaPolice = creep({ title: 'Karma Police', durationMs: 264_000 })
    expect(await provider().getLyrics(karmaPolice, contextFor(fetch))).toBeNull()

    const zimmer = lrclib({ search: () => json(fixtures.searchHansZimmerTime) })
    const time = creep({
      title: 'Time',
      artists: [{ name: 'Hans Zimmer' }],
      album: { name: 'Inception (Music from the Motion Picture)' },
      durationMs: 275_000,
    })
    expect(await provider().getLyrics(time, contextFor(zimmer.fetch))).toBeNull()
    expect(requests(zimmer.calls)[1]).toBe('/api/search?q=Hans+Zimmer+Time')
  })

  it('gives a music video plain lyrics, because no synced lyrics keep time with it', async () => {
    const { album: _album, ...video } = creep({
      id: creep().id,
      title: 'Radiohead - Creep (Official Music Video)',
      artists: [{ name: 'RadioheadVEVO' }],
      durationMs: 256_000,
      kind: 'music-video',
    })
    const { fetch, calls } = lrclib({ search: () => json(fixtures.searchRadioheadCreep) })
    const lyrics = present(await provider().getLyrics(video, contextFor(fetch)))
    expect(lyrics).toMatchObject({ synced: false, metadata: { lengthMs: 259_000 } })
    expect(lyrics.lines).toEqual([
      { text: 'Record 36837546, line 1' },
      { text: 'Record 36837546, line 2' },
    ])
    expect(requests(calls)).toEqual([
      '/api/get?track_name=Creep&artist_name=Radiohead&duration=256',
      SEARCH_CREEP,
    ])
  })

  it('sends every artist of the track to the exact lookup', async () => {
    const { fetch, calls } = lrclib({})
    const oneKiss = creep({
      title: 'One Kiss (with Dua Lipa)',
      artists: [{ name: 'Calvin Harris' }, { name: 'Dua Lipa' }],
      album: { name: 'One Kiss' },
      durationMs: 214_847,
    })
    expect(await provider().getLyrics(oneKiss, contextFor(fetch))).toBeNull()
    expect(requests(calls)).toEqual([
      `/api/get?${[
        'track_name=One+Kiss+%28with+Dua+Lipa%29',
        'artist_name=Calvin+Harris%2C+Dua+Lipa',
        'album_name=One+Kiss',
        'duration=215',
      ].join('&')}`,
      '/api/search?q=Calvin+Harris+One+Kiss',
    ])
  })

  it('returns null without a request for a track without an artist or a title', async () => {
    const { fetch, calls } = lrclib({ get: () => json(fixtures.getCreep) })
    expect(await provider().getLyrics(creep({ artists: [] }), contextFor(fetch))).toBeNull()
    expect(await provider().getLyrics(creep({ title: ' ' }), contextFor(fetch))).toBeNull()
    expect(calls).toHaveLength(0)
  })

  it('rejects with RateLimited, then fails fast until the wait is over', async () => {
    const { fetch, calls } = lrclib({
      get: () => json(fixtures.rateLimited, { status: 429, headers: { 'retry-after': '20' } }),
    })
    const lyricsProvider = provider()
    const error = await lyricsProvider
      .getLyrics(creep(), contextFor(fetch))
      .catch((e: unknown) => e)
    expect(isFxmError(error, 'RateLimited')).toBe(true)
    // Retry-After: 20, plus up to 30 % jitter.
    const waitMs = (error as { retryAfterMs: number }).retryAfterMs
    expect(waitMs).toBeGreaterThanOrEqual(20_000)
    expect(waitMs).toBeLessThanOrEqual(26_000)
    const again = await lyricsProvider
      .getLyrics(creep(), contextFor(fetch))
      .catch((e: unknown) => e)
    expect(isFxmError(again, 'RateLimited')).toBe(true)
    expect(calls).toHaveLength(1)
  })

  it('sends one request at a time across concurrent lookups', async () => {
    vi.useFakeTimers()
    let inFlight = 0
    let most = 0
    // LRCLIB answers a miss with a 503 after about 1.5 s.
    const { fetch, calls } = fakeLrclib(async (url) => {
      inFlight++
      most = Math.max(most, inFlight)
      const response = url.pathname === '/api/get' ? await after(1_500, busy) : json([])
      inFlight--
      return response
    })
    const lyricsProvider = provider({ minIntervalMs: 250 })
    const lookups = Promise.all(
      [1, 2, 3].map(() => lyricsProvider.getLyrics(creep(), contextFor(fetch))),
    )
    await vi.advanceTimersByTimeAsync(30_000)
    expect(await lookups).toEqual([null, null, null])
    expect(most).toBe(1)
    expect(requests(calls)).toEqual([
      ...[GET_CREEP, GET_CREEP, GET_CREEP],
      ...[SEARCH_CREEP, SEARCH_CREEP, SEARCH_CREEP],
    ])
  })

  it('answers more than 20 concurrent lookups without failing any', async () => {
    vi.useFakeTimers()
    const { fetch, calls } = lrclib({ get: () => json(fixtures.getCreep) })
    const lyricsProvider = createLrclibProvider()
    const lookups = Promise.allSettled(
      Array.from({ length: 30 }, () => lyricsProvider.getLyrics(creep(), contextFor(fetch))),
    )
    await vi.advanceTimersByTimeAsync(30 * 250)
    const results = await lookups
    expect(results.filter((result) => result.status === 'rejected')).toEqual([])
    expect(calls).toHaveLength(30)
  })

  it('rejects with a Network error when LRCLIB cannot be reached', async () => {
    const offline: typeof fetch = async () => {
      throw new TypeError('fetch failed')
    }
    await expect(provider().getLyrics(creep(), contextFor(offline))).rejects.toMatchObject({
      code: 'Network',
    })
  })

  it('stops when the call is cancelled, also during the search for synced lyrics', async () => {
    const controller = new AbortController()
    const pending = provider().getLyrics(creep(), contextFor(hangingFetch, controller.signal))
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })

    const searching = new AbortController()
    const { fetch } = lrclib({
      get: () => json(plainOnly),
      search: () => {
        searching.abort()
        return new Response('[', { status: 200 })
      },
    })
    await expect(
      provider().getLyrics(creep(), contextFor(fetch, searching.signal)),
    ).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('uses only the injected fetch', async () => {
    vi.stubGlobal('fetch', () => {
      throw new Error('the global fetch was used')
    })
    const { fetch } = lrclib({ get: () => json(fixtures.getCreep) })
    expect((await provider().getLyrics(creep(), contextFor(fetch)))?.synced).toBe(true)
  })

  it('identifies itself and reaches the server it is given', async () => {
    const { fetch, calls } = lrclib({ get: () => json(fixtures.getCreep) })
    const custom = provider({
      client: 'FXM fork v1 (https://fork.example.test)',
      baseUrl: 'https://lyrics.example.test',
    })
    await custom.getLyrics(creep(), contextFor(fetch))
    expect(calls[0]?.url.origin).toBe('https://lyrics.example.test')
    expect(calls[0]?.headers.get('lrclib-client')).toBe('FXM fork v1 (https://fork.example.test)')
  })

  it('spaces its requests out by default', async () => {
    vi.useFakeTimers()
    const { fetch, calls } = lrclib({ search: () => json([]) })
    const pending = createLrclibProvider().getLyrics(creep(), contextFor(fetch))
    await vi.advanceTimersByTimeAsync(1_000)
    expect(await pending).toBeNull()
    expect((calls[1]?.at ?? 0) - (calls[0]?.at ?? 0)).toBeGreaterThanOrEqual(250)
  })
})

describe('lyricsOf', () => {
  const base: LrclibRecord = {
    id: 1,
    trackName: 'Song',
    artistName: '',
    instrumental: false,
    plainLyrics: null,
    syncedLyrics: null,
  }

  it('reads LRC that has no timestamps as plain lyrics', () => {
    expect(lyricsOf({ ...base, syncedLyrics: 'One\nTwo' }, true)).toEqual({
      synced: false,
      lines: [{ text: 'One' }, { text: 'Two' }],
      source: 'lrclib',
      metadata: { title: 'Song' },
    })
  })

  it('removes timestamps from plain lyrics', () => {
    expect(
      lyricsOf({ ...base, plainLyrics: '[00:01.00]One\n[00:02.00]\n[00:03.00]Two' }, false)?.lines,
    ).toEqual([{ text: 'One' }, { text: '' }, { text: 'Two' }])
  })

  it('returns null for records without text', () => {
    expect(lyricsOf(base, true)).toBeNull()
    expect(lyricsOf({ ...base, syncedLyrics: '[00:01.00]\n[00:02.00] ' }, true)).toBeNull()
    expect(lyricsOf({ ...base, plainLyrics: 'Words', instrumental: true }, false)).toBeNull()
  })
})
