import {
  type AudioCandidate,
  DEFAULT_QUALITY_PREFS,
  formatId,
  isFxmError,
  type Track,
} from '@fxm/core'
import { describe, expect, it } from 'vitest'
import { contextFor, fakeService, json } from '../shared/fake-fetch'
import albumsSearch from './fixtures/albums-search.json'
import albumsTracks from './fixtures/albums-tracks.json'
import artistsSearch from './fixtures/artists-search.json'
import artistsTracks from './fixtures/artists-tracks.json'
import invalidClientId from './fixtures/error-invalid-client-id.json'
import rateLimit from './fixtures/error-rate-limit.json'
import tracksFlac from './fixtures/tracks-flac.json'
import { createJamendoSource, type JamendoSourceOptions } from './provider'
import { JamendoQuota } from './quota'

const PUBLIC_ID = 'pub12345'
const USER_ID = 'usr67890'
const MANANA = formatId('jamendo', 'track', '1848357')

/** An answer with no results. */
const empty = {
  headers: { status: 'success', code: 0, error_message: '', warnings: '', results_count: 0 },
  results: [],
}

/** A fake Jamendo answering from the fixtures; `answer` may replace any answer. */
function jamendo(answer: (url: URL) => Response | undefined = () => undefined) {
  return fakeService((url) => {
    const replaced = answer(url)
    if (replaced !== undefined) return replaced
    const id = url.searchParams.get('id')
    switch (url.pathname) {
      case '/v3.0/tracks/':
        if (id === null || id === '1848357') {
          return json(
            id === null ? tracksFlac : { ...tracksFlac, results: tracksFlac.results.slice(0, 1) },
          )
        }
        return json(empty)
      case '/v3.0/albums/':
        return json(albumsSearch)
      case '/v3.0/artists/':
        return json(artistsSearch)
      case '/v3.0/albums/tracks/':
        return json(id === '368084' ? albumsTracks : empty)
      case '/v3.0/artists/tracks/':
        return json(id === '421168' ? artistsTracks : empty)
      default:
        return json({}, { status: 404 })
    }
  })
}

/** A Jamendo source with the public client_id and a clock the test moves. */
function source(options: JamendoSourceOptions = {}) {
  const clock = { now: 1_000_000 }
  const jamendoSource = createJamendoSource({
    publicClientId: PUBLIC_ID,
    now: () => clock.now,
    ...options,
  })
  return { jamendoSource, clock }
}

/** A Spotify track as Spotify would describe the first sample track. */
function spotifyManana(overrides: Partial<Track> = {}): Track {
  return {
    id: formatId('spotify', 'track', '0123456789abcdefghijkl'),
    source: 'spotify',
    title: 'mañana será tarde',
    artists: [{ name: 'fankel' }],
    album: { name: 'mañana será tarde' },
    durationMs: 271_500,
    artwork: [],
    kind: 'song',
    ...overrides,
  }
}

function candidate(ref: string, overrides: Partial<AudioCandidate> = {}): AudioCandidate {
  return {
    source: 'jamendo',
    ref,
    kind: 'song',
    title: 'x',
    artists: [],
    confidence: 1,
    evidence: [],
    ...overrides,
  }
}

describe('createJamendoSource', () => {
  it('is the jamendo source', () => {
    expect(source().jamendoSource.id).toBe('jamendo')
  })

  describe('client_id', () => {
    it('is off, without a request, until a client_id is set', async () => {
      const service = jamendo()
      const jamendoSource = createJamendoSource()
      expect(jamendoSource.access()).toEqual({ status: 'not-configured' })
      const error = await jamendoSource
        .search('rock', { types: ['track'] }, contextFor(service.fetch))
        .catch((caught: unknown) => caught)
      expect(isFxmError(error, 'Unsupported')).toBe(true)
      expect(service.calls).toHaveLength(0)
    })

    it('sends the public client_id, or the user’s own when set', async () => {
      const service = jamendo()
      const { jamendoSource } = source()
      const ctx = contextFor(service.fetch)
      expect(jamendoSource.access()).toEqual({ status: 'ready', client: 'public' })
      await jamendoSource.search('rock', { types: ['track'] }, ctx)
      jamendoSource.setUserClientId(` ${USER_ID} `)
      expect(jamendoSource.access()).toEqual({ status: 'ready', client: 'user' })
      await jamendoSource.search('jazz', { types: ['track'] }, ctx)
      jamendoSource.setUserClientId('')
      await jamendoSource.search('blues', { types: ['track'] }, ctx)
      expect(service.calls.map((call) => call.url.searchParams.get('client_id'))).toEqual([
        PUBLIC_ID,
        USER_ID,
        PUBLIC_ID,
      ])
    })

    it('refuses a value that is no client_id at all, without a request', async () => {
      const service = jamendo()
      const { jamendoSource } = source({ userClientId: 'not a client id!' })
      expect(jamendoSource.access()).toEqual({ status: 'invalid-client-id', client: 'user' })
      const error = await jamendoSource
        .search('rock', { types: ['track'] }, contextFor(service.fetch))
        .catch((caught: unknown) => caught)
      expect(isFxmError(error, 'AuthRequired')).toBe(true)
      expect(service.calls).toHaveLength(0)
    })

    it('stops sending a client_id Jamendo does not know, until the user adds their own', async () => {
      let refuse = true
      const service = jamendo(() => (refuse ? json(invalidClientId) : undefined))
      const { jamendoSource } = source()
      const ctx = contextFor(service.fetch)
      for (const query of ['rock', 'jazz']) {
        const error = await jamendoSource
          .search(query, { types: ['track'] }, ctx)
          .catch((caught: unknown) => caught)
        expect(isFxmError(error, 'AuthRequired')).toBe(true)
      }
      expect(service.calls).toHaveLength(1)
      expect(jamendoSource.access()).toEqual({ status: 'invalid-client-id', client: 'public' })
      refuse = false
      jamendoSource.setUserClientId(USER_ID)
      await expect(jamendoSource.search('jazz', { types: ['track'] }, ctx)).resolves.toBeDefined()
      expect(service.calls.at(-1)?.url.searchParams.get('client_id')).toBe(USER_ID)
    })

    it('reports a suspended application', async () => {
      const suspended = {
        headers: { status: 'failed', code: 11, error_message: 'suspended', warnings: '' },
        results: [],
      }
      const service = jamendo(() => json(suspended))
      const { jamendoSource } = source()
      const error = await jamendoSource
        .search('rock', { types: ['track'] }, contextFor(service.fetch))
        .catch((caught: unknown) => caught)
      expect(isFxmError(error, 'AuthRequired')).toBe(true)
      expect(jamendoSource.access()).toEqual({ status: 'suspended', client: 'public' })
    })
  })

  describe('quota', () => {
    it('stops asking once the quota is used up, and tries once again after the wait', async () => {
      let refuse = true
      const service = jamendo(() => (refuse ? json(rateLimit) : undefined))
      const { jamendoSource, clock } = source()
      const ctx = contextFor(service.fetch)
      const search = (query: string) =>
        jamendoSource.search(query, { types: ['track'] }, ctx).catch((caught: unknown) => caught)

      const first = await search('rock')
      expect(isFxmError(first, 'RateLimited')).toBe(true)
      expect(first).toMatchObject({ retryAfterMs: 15 * 60_000 })
      expect(String((first as Error).message)).toMatch(/add your own client_id/u)
      expect(jamendoSource.access()).toEqual({
        status: 'quota-exceeded',
        client: 'public',
        retryAt: 1_000_000 + 15 * 60_000,
      })

      clock.now += 10 * 60_000
      const blocked = await search('jazz')
      expect(blocked).toMatchObject({ code: 'RateLimited', retryAfterMs: 5 * 60_000 })
      expect(service.calls).toHaveLength(1)

      clock.now += 5 * 60_000
      refuse = false
      await expect(search('jazz')).resolves.toMatchObject({ tracks: { items: expect.any(Array) } })
      expect(service.calls).toHaveLength(2)
      expect(jamendoSource.access()).toEqual({ status: 'ready', client: 'public' })
    })

    it('treats HTTP 429 like Jamendo’s own rate-limit code', async () => {
      const service = jamendo(() => json({}, { status: 429 }))
      const { jamendoSource } = source()
      const error = await jamendoSource
        .search('rock', { types: ['track'] }, contextFor(service.fetch))
        .catch((caught: unknown) => caught)
      expect(isFxmError(error, 'RateLimited')).toBe(true)
      expect(jamendoSource.access()).toMatchObject({ status: 'quota-exceeded' })
    })

    it('gives the user’s own client_id a clean record', async () => {
      const service = jamendo((url) =>
        url.searchParams.get('client_id') === PUBLIC_ID ? json(rateLimit) : undefined,
      )
      const { jamendoSource } = source()
      const ctx = contextFor(service.fetch)
      await jamendoSource.search('rock', { types: ['track'] }, ctx).catch(() => undefined)
      jamendoSource.setUserClientId(USER_ID)
      expect(jamendoSource.access()).toEqual({ status: 'ready', client: 'user' })
      await expect(jamendoSource.search('rock', { types: ['track'] }, ctx)).resolves.toBeDefined()
    })

    it('remembers a used-up quota across restarts through a saved snapshot', async () => {
      const service = jamendo(() => json(rateLimit))
      const first = source()
      await first.jamendoSource
        .search('rock', { types: ['track'] }, contextFor(service.fetch))
        .catch(() => undefined)
      const saved = first.jamendoSource.quota.snapshot()
      const restarted = source({ quota: new JamendoQuota({ saved, now: () => 1_000_000 }) })
      expect(restarted.jamendoSource.access()).toMatchObject({ status: 'quota-exceeded' })
      await restarted.jamendoSource
        .search('jazz', { types: ['track'] }, contextFor(service.fetch))
        .catch(() => undefined)
      expect(service.calls).toHaveLength(1)
    })
  })

  describe('search', () => {
    it('asks for songs and singles with FLAC streams, and pages by offset', async () => {
      const service = jamendo()
      const { jamendoSource } = source()
      const results = await jamendoSource.search(
        'funk',
        { types: ['track'], limit: 2 },
        contextFor(service.fetch),
      )
      expect(results.tracks?.items.map((track) => track.id)).toEqual([
        MANANA,
        formatId('jamendo', 'track', '1880336'),
      ])
      expect(results.tracks?.nextCursor).toBe('2')
      const url = service.calls[0]?.url
      expect(url?.origin).toBe('https://api.jamendo.com')
      expect(url?.pathname).toBe('/v3.0/tracks/')
      expect(Object.fromEntries(url?.searchParams ?? [])).toEqual({
        client_id: PUBLIC_ID,
        format: 'json',
        audiodlformat: 'flac',
        audioformat: 'flac',
        imagesize: '300',
        limit: '2',
        offset: '0',
        search: 'funk',
        type: 'single albumtrack',
      })
      expect([...(service.calls[0]?.headers.keys() ?? [])]).toEqual([])
      expect(service.calls[0]?.init?.credentials).toBe('omit')
    })

    it('asks for the offset a cursor names, ends at a short page, and refuses foreign cursors', async () => {
      const service = jamendo()
      const { jamendoSource } = source()
      const ctx = contextFor(service.fetch)
      const results = await jamendoSource.search('funk', { types: ['track'], cursor: '20' }, ctx)
      expect(service.calls[0]?.url.searchParams.get('offset')).toBe('20')
      expect(results.tracks).not.toHaveProperty('nextCursor')
      for (const cursor of ['0', 'abc', '-20', '05']) {
        await expect(
          jamendoSource.search('funk', { types: ['track'], cursor }, ctx),
        ).rejects.toThrow(RangeError)
      }
    })

    it('searches albums and artists by name, one request per type', async () => {
      const service = jamendo()
      const { jamendoSource } = source()
      const results = await jamendoSource.search(
        'fankel',
        { types: ['album', 'artist', 'playlist', 'video'] },
        contextFor(service.fetch),
      )
      expect(results.albums?.items.map((album) => album.name)).toEqual([
        'mañana será tarde',
        'Queensland [High Energy Funk Instrumental]',
      ])
      expect(results.artists?.items.map((artist) => artist.id)).toEqual([
        formatId('jamendo', 'artist', '421168'),
      ])
      expect(results).toMatchObject({ playlists: { items: [] }, videos: { items: [] } })
      expect(
        service.calls.map((call) => [call.url.pathname, call.url.searchParams.get('namesearch')]),
      ).toEqual([
        ['/v3.0/albums/', 'fankel'],
        ['/v3.0/artists/', 'fankel'],
      ])
    })

    it('makes no request for a blank query', async () => {
      const service = jamendo()
      const { jamendoSource } = source()
      const results = await jamendoSource.search(
        '   ',
        { types: ['track', 'album', 'artist'] },
        contextFor(service.fetch),
      )
      expect(results).toEqual({
        tracks: { items: [] },
        albums: { items: [] },
        artists: { items: [] },
      })
      expect(service.calls).toHaveLength(0)
    })

    it('keeps answers for an hour, whatever the client_id', async () => {
      const service = jamendo()
      const { jamendoSource, clock } = source()
      const ctx = contextFor(service.fetch)
      await jamendoSource.search('funk', { types: ['track'] }, ctx)
      jamendoSource.setUserClientId(USER_ID)
      await jamendoSource.search('funk', { types: ['track'] }, ctx)
      expect(service.calls).toHaveLength(1)
      clock.now += 3_600_000
      await jamendoSource.search('funk', { types: ['track'] }, ctx)
      expect(service.calls).toHaveLength(2)
    })

    it('maps other failures to typed errors', async () => {
      const cases: Array<[Response, string]> = [
        [
          json({ headers: { status: 'failed', code: 3, error_message: 'bad type' }, results: [] }),
          'Unavailable',
        ],
        [json({ results: [] }), 'Parse'],
        [json({ headers: { status: 'success', code: 0 }, results: {} }), 'Parse'],
        [json({}, { status: 500 }), 'Unavailable'],
      ]
      for (const [response, code] of cases) {
        const service = jamendo(() => response)
        const error = await source()
          .jamendoSource.search('rock', { types: ['track'] }, contextFor(service.fetch))
          .catch((caught: unknown) => caught)
        expect(isFxmError(error, code as 'Parse')).toBe(true)
      }
    })
  })

  describe('pages', () => {
    it('loads a track once, and reuses tracks that answers already returned', async () => {
      const service = jamendo()
      const { jamendoSource } = source()
      const ctx = contextFor(service.fetch)
      const track = await jamendoSource.getTrack(MANANA, ctx)
      expect(track).toMatchObject({ id: MANANA, title: 'mañana será tarde', kind: 'song' })
      expect(service.calls[0]?.url.searchParams.get('id')).toBe('1848357')
      await jamendoSource.getTrack(MANANA, ctx)
      await jamendoSource.search('funk', { types: ['track'] }, ctx)
      await jamendoSource.getTrack(formatId('jamendo', 'track', '1880336'), ctx)
      expect(service.calls).toHaveLength(2)
    })

    it('rejects tracks it cannot find with NotFound, foreign ones without a request', async () => {
      const service = jamendo()
      const { jamendoSource } = source()
      const ctx = contextFor(service.fetch)
      for (const id of [
        formatId('jamendo', 'track', '999'),
        formatId('jamendo', 'track', 'abc'),
        formatId('ytm', 'track', 'dQw4w9WgXcQ'),
      ]) {
        const error = await jamendoSource.getTrack(id, ctx).catch((caught: unknown) => caught)
        expect(isFxmError(error, 'NotFound')).toBe(true)
      }
      expect(service.calls).toHaveLength(1)
    })

    it('loads an album with its tracks, whose streams then need no request', async () => {
      const service = jamendo()
      const { jamendoSource } = source()
      const ctx = contextFor(service.fetch)
      const album = await jamendoSource.getAlbum(formatId('jamendo', 'album', '0368084'), ctx)
      expect(album).toMatchObject({ id: formatId('jamendo', 'album', '368084'), trackCount: 1 })
      expect(album.tracks?.map((track) => track.id)).toEqual([MANANA])
      expect(service.calls[0]?.url.pathname).toBe('/v3.0/albums/tracks/')
      await jamendoSource.resolve(candidate('1848357'), ctx, DEFAULT_QUALITY_PREFS)
      expect(service.calls).toHaveLength(1)
      const error = await jamendoSource
        .getAlbum(formatId('jamendo', 'album', '1'), ctx)
        .catch((caught: unknown) => caught)
      expect(isFxmError(error, 'NotFound')).toBe(true)
    })

    it('loads an artist with tracks', async () => {
      const service = jamendo()
      const { jamendoSource } = source()
      const ctx = contextFor(service.fetch)
      const artist = await jamendoSource.getArtist(formatId('jamendo', 'artist', '421168'), ctx)
      expect(artist).toMatchObject({ name: 'fankel', topTracks: [{ id: MANANA }] })
      const error = await jamendoSource
        .getArtist(formatId('jamendo', 'artist', '1'), ctx)
        .catch((caught: unknown) => caught)
      expect(isFxmError(error, 'NotFound')).toBe(true)
    })

    it('has no playlists', async () => {
      const service = jamendo()
      const error = await source()
        .jamendoSource.getPlaylist(formatId('jamendo', 'playlist', '1'), contextFor(service.fetch))
        .catch((caught: unknown) => caught)
      expect(isFxmError(error, 'Unsupported')).toBe(true)
      expect(service.calls).toHaveLength(0)
    })
  })

  describe('match', () => {
    it('answers a Jamendo track with its own audio, without a request', async () => {
      const service = jamendo()
      const { jamendoSource } = source()
      const own: Track = {
        id: MANANA,
        source: 'jamendo',
        title: 'mañana será tarde',
        artists: [{ name: 'fankel' }],
        album: { id: formatId('jamendo', 'album', '368084'), name: 'mañana será tarde' },
        durationMs: 272_000,
        artwork: [],
        kind: 'song',
      }
      expect(await jamendoSource.match(own, contextFor(service.fetch))).toEqual([
        {
          source: 'jamendo',
          ref: '1848357',
          kind: 'song',
          title: 'mañana será tarde',
          artists: ['fankel'],
          durationMs: 272_000,
          confidence: 1,
          evidence: ['same track'],
          signals: { isrcVerified: false, releaseId: '368084', sourceAlbumMatch: true },
        },
      ])
      const linked = spotifyManana({ externalIds: { jamendo: '1848357' } })
      const [found] = await jamendoSource.match(linked, contextFor(service.fetch))
      expect(found).toMatchObject({ ref: '1848357', evidence: ['linked track'] })
      expect(service.calls).toHaveLength(0)
    })

    it('never asks Jamendo for another source’s track while "prefer lossless" is off', async () => {
      const service = jamendo()
      const { jamendoSource } = source()
      await expect(
        jamendoSource.match(spotifyManana(), contextFor(service.fetch)),
      ).resolves.toEqual([])
      const off = source({ preferLossless: () => false }).jamendoSource
      await expect(off.match(spotifyManana(), contextFor(service.fetch))).resolves.toEqual([])
      expect(service.calls).toHaveLength(0)
    })

    it('searches for another source’s track while "prefer lossless" is on', async () => {
      let preferLossless = true
      const service = jamendo()
      const { jamendoSource } = source({ preferLossless: () => preferLossless })
      const ctx = contextFor(service.fetch)
      const candidates = await jamendoSource.match(spotifyManana(), ctx)
      expect(candidates).toEqual([
        {
          source: 'jamendo',
          ref: '1848357',
          kind: 'song',
          title: 'mañana será tarde',
          artists: ['fankel'],
          durationMs: 272_000,
          confidence: 0.79,
          evidence: ['title 1.00', 'artist 1.00', 'duration +0.5s'],
          signals: {
            isrcVerified: false,
            releaseId: '368084',
            releaseYear: 2021,
            sourceAlbumMatch: true,
          },
        },
      ])
      const params = service.calls[0]?.url.searchParams
      expect([params?.get('search'), params?.get('limit'), params?.get('audioformat')]).toEqual([
        'fankel mañana será tarde',
        '10',
        'flac',
      ])
      preferLossless = false
      await expect(jamendoSource.match(spotifyManana({ title: 'Other' }), ctx)).resolves.toEqual([])
      expect(service.calls).toHaveLength(1)
    })

    it('finds nothing when no result fits', async () => {
      const service = jamendo()
      const { jamendoSource } = source({ preferLossless: () => true })
      const ctx = contextFor(service.fetch)
      await expect(
        jamendoSource.match(
          spotifyManana({ title: 'Karma Police', artists: [{ name: 'Radiohead' }] }),
          ctx,
        ),
      ).resolves.toEqual([])
      await expect(jamendoSource.match(spotifyManana({ artists: [] }), ctx)).resolves.toEqual([])
      expect(service.calls).toHaveLength(1)
    })
  })

  describe('resolve', () => {
    it('offers FLAC first, then the lossy versions', async () => {
      const service = jamendo()
      const { jamendoSource } = source()
      const options = await jamendoSource.resolve(
        candidate('1848357'),
        contextFor(service.fetch),
        DEFAULT_QUALITY_PREFS,
      )
      expect(options.map((option) => [option.codec, option.tier])).toEqual([
        ['flac', 'lossless'],
        ['mp3', 'normal'],
        ['vorbis', 'normal'],
        ['mp3', 'low'],
      ])
      expect(options[0]?.url).toBe(
        'https://prod-1.storage.jamendo.com/?trackid=1848357&format=flac&from=app-devsite',
      )
      expect(options.every((option) => option.downloadAllowed === undefined)).toBe(true)
    })

    it('honours an artist’s choice to allow streaming but not downloads', async () => {
      const service = jamendo()
      const { jamendoSource } = source()
      const ctx = contextFor(service.fetch)
      await jamendoSource.search('funk', { types: ['track'] }, ctx)
      const options = await jamendoSource.resolve(candidate('1880336'), ctx, DEFAULT_QUALITY_PREFS)
      expect(options[0]).toMatchObject({ codec: 'flac', downloadAllowed: false })
      expect(options.every((option) => option.downloadAllowed === false)).toBe(true)
      expect(options.filter((option) => option.downloadAllowed !== false)).toEqual([])
    })

    it('refuses foreign candidates, unknown tracks and tracks without a stream', async () => {
      const silent = { ...tracksFlac, results: [{ ...tracksFlac.results[0], id: '5', audio: '' }] }
      const service = jamendo((url) =>
        url.searchParams.get('id') === '5' ? json(silent) : undefined,
      )
      const { jamendoSource } = source()
      const ctx = contextFor(service.fetch)
      const cases: Array<[AudioCandidate, string]> = [
        [candidate('1848357', { source: 'archive' }), 'Unsupported'],
        [candidate('not-a-number'), 'NotFound'],
        [candidate('999'), 'NotFound'],
        [candidate('5'), 'Unavailable'],
      ]
      for (const [input, code] of cases) {
        const error = await jamendoSource
          .resolve(input, ctx, DEFAULT_QUALITY_PREFS)
          .catch((caught: unknown) => caught)
        expect(isFxmError(error, code as 'NotFound')).toBe(true)
      }
    })
  })
})
