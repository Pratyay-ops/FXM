import {
  type AudioCandidate,
  DEFAULT_QUALITY_PREFS,
  formatId,
  isFxmError,
  type StreamOption,
  type Track,
} from '@fxm/core'
import { describe, expect, it } from 'vitest'
import { type Call, contextFor, fakeService, json } from '../shared/fake-fetch'
import missing from './fixtures/item-missing.json'
import ninGhosts from './fixtures/item-nin-ghosts.json'
import restricted from './fixtures/item-restricted.json'
import tuning77 from './fixtures/item-tuning-77.json'
import searchMatchNin from './fixtures/search-match-nin.json'
import searchNinGhosts from './fixtures/search-nin-ghosts.json'
import { type ArchiveSourceOptions, createArchiveSource, parseTrackRef } from './provider'

const NIN = 'nineinchnails_ghosts_I_IV'
const GHOSTS_1 = `${NIN}/01_Ghosts_I.flac`

/** The first 42 bytes of a real 24-bit FLAC file on the Archive. */
const FLAC_HEADER = Uint8Array.from(
  '664c61430000002210001000000012004b460ac443700ea41f88f521ab47258d5bc7282502c456665d5b'.match(
    /../gu,
  ) ?? [],
  (pair) => Number.parseInt(pair, 16),
)

/** A live concert item from the Live Music Archive, for the live-recording checks. */
const liveShow = {
  metadata: {
    identifier: 'band1999-01-01',
    title: 'Band at the Hall',
    mediatype: 'etree',
    creator: 'Band',
  },
  files: [{ name: 'song.flac', format: 'Flac', source: 'original', title: 'Song', length: '200' }],
}

/** A fake Archive: searches, item metadata and the start of FLAC files, from the fixtures. */
function archive(extra: Record<string, unknown> = {}) {
  const items: Record<string, unknown> = {
    [NIN]: ninGhosts,
    'gd1977-12-31_505': tuning77,
    'gd1977-06-09.28614.sbeok.flac16': restricted,
    ...extra,
  }
  return fakeService((url) => {
    if (url.pathname === '/advancedsearch.php') {
      const query = url.searchParams.get('q') ?? ''
      if (query.includes('band')) {
        return json({
          response: { numFound: 1, start: 0, docs: [{ identifier: 'band1999-01-01' }] },
        })
      }
      return json(query.includes(' OR (') ? searchMatchNin : searchNinGhosts)
    }
    if (url.pathname.startsWith('/metadata/')) {
      const identifier = decodeURIComponent(url.pathname.slice('/metadata/'.length))
      return json(Object.hasOwn(items, identifier) ? items[identifier] : missing)
    }
    if (url.pathname.startsWith('/download/') && url.pathname.endsWith('.flac')) {
      return new Response(FLAC_HEADER, { status: 206 })
    }
    return json({}, { status: 404 })
  })
}

/** The request paths, without hosts. */
function paths(calls: readonly Call[]): string[] {
  return calls.map((call) => decodeURIComponent(call.url.pathname))
}

function source(options: ArchiveSourceOptions = {}) {
  return createArchiveSource(options)
}

/** A Spotify track, as Spotify describes Nine Inch Nails' "1 Ghosts I". */
function spotifyGhosts(overrides: Partial<Track> = {}): Track {
  return {
    id: formatId('spotify', 'track', '2KcYOmnZ4oexHQRO8aYcfW'),
    source: 'spotify',
    title: '1 Ghosts I',
    artists: [{ name: 'Nine Inch Nails' }],
    album: { name: 'Ghosts I-IV' },
    durationMs: 168_000,
    artwork: [],
    kind: 'song',
    ...overrides,
  }
}

/** An Archive track without any request. */
function archiveTrack(ref = GHOSTS_1): Track {
  return {
    id: formatId('archive', 'track', ref),
    source: 'archive',
    title: '1 Ghosts I',
    artists: [{ name: 'Nine Inch Nails' }],
    durationMs: 168_830,
    artwork: [],
    kind: 'song',
  }
}

function candidate(ref: string, overrides: Partial<AudioCandidate> = {}): AudioCandidate {
  return {
    source: 'archive',
    ref,
    kind: 'song',
    title: 'x',
    artists: [],
    confidence: 1,
    evidence: [],
    ...overrides,
  }
}

describe('parseTrackRef', () => {
  it('splits a track ID’s native part at the first slash', () => {
    expect(parseTrackRef('item_1/disc 1/a.flac')).toEqual({
      identifier: 'item_1',
      path: 'disc 1/a.flac',
    })
    for (const ref of ['', 'item', '/a.flac', 'item/', '-item/a.flac', 'it em/a.flac']) {
      expect(parseTrackRef(ref)).toBeNull()
    }
  })
})

describe('createArchiveSource', () => {
  it('is the archive source', () => {
    expect(source().id).toBe('archive')
  })

  describe('search', () => {
    it('lists items as albums, most downloaded first, in pages', async () => {
      const service = archive()
      const results = await source().search(
        'nine inch nails ghosts',
        { types: ['album'], limit: 5 },
        contextFor(service.fetch),
      )
      expect(results.albums?.items).toHaveLength(5)
      expect(results.albums?.items[0]).toEqual({
        id: formatId('archive', 'album', NIN),
        source: 'archive',
        name: 'Ghosts I - IV',
        artists: [{ name: 'Nine Inch Nails' }],
        artwork: [{ url: `https://archive.org/services/img/${NIN}` }],
        releaseDate: '2008-03-02',
      })
      expect(results.albums).toMatchObject({ total: 46, nextCursor: '2' })
      expect(results).not.toHaveProperty('tracks')
      expect(service.calls).toHaveLength(1)
      expect(service.calls[0]?.url.searchParams.get('rows')).toBe('5')
    })

    it('asks for the page a cursor names, and refuses a cursor it did not make', async () => {
      const service = archive()
      const ctx = contextFor(service.fetch)
      await source().search('ghosts', { types: ['album'], cursor: '3', limit: 10 }, ctx)
      expect(service.calls[0]?.url.searchParams.get('page')).toBe('3')
      for (const cursor of ['1', '02', 'abc', '-2', '2.5']) {
        await expect(source().search('ghosts', { types: ['album'], cursor }, ctx)).rejects.toThrow(
          RangeError,
        )
      }
    })

    it('lists songs from the first items that fit every word', async () => {
      const service = archive()
      const results = await source().search(
        'nine inch nails ghosts',
        { types: ['track'] },
        contextFor(service.fetch),
      )
      expect(results.tracks?.items.map((track) => track.id)).toEqual([
        formatId('archive', 'track', GHOSTS_1),
        formatId('archive', 'track', `${NIN}/02_Ghosts_I.flac`),
        formatId('archive', 'track', `${NIN}/03_Ghosts_I.flac`),
      ])
      expect(results.tracks?.nextCursor).toBe('2')
      // One search, then four items, three of which no longer exist.
      expect(service.calls[0]?.url.searchParams.get('rows')).toBe('4')
      expect(paths(service.calls).slice(1)).toEqual([
        `/metadata/${NIN}`,
        '/metadata/NineInchNailsGhostsI-Ivblu-ray24bit96khz',
        '/metadata/NIN_OAOA',
        '/metadata/NineInchNails37Ghosts38Ghosts',
      ])
    })

    it('keeps only the songs whose own fields hold the words the item does not', async () => {
      const service = archive()
      const results = await source().search(
        'the Ghosts 2',
        { types: ['track'] },
        contextFor(service.fetch),
      )
      expect(results.tracks?.items.map((track) => track.title)).toEqual(['2 Ghosts I'])
    })

    it('serves both types from one search', async () => {
      const service = archive()
      const results = await source({ trackSearchItems: 1 }).search(
        'nine inch nails ghosts',
        { types: ['album', 'track', 'artist', 'playlist', 'video'] },
        contextFor(service.fetch),
      )
      expect(results.albums?.items).toHaveLength(5)
      expect(results.tracks?.items).toHaveLength(3)
      expect(results).toMatchObject({
        artists: { items: [] },
        playlists: { items: [] },
        videos: { items: [] },
      })
      expect(paths(service.calls)).toEqual(['/advancedsearch.php', `/metadata/${NIN}`])
      expect(service.calls[0]?.url.searchParams.get('rows')).toBe('20')
    })

    it('makes no request for types it has nothing for', async () => {
      const service = archive()
      const results = await source().search(
        'ghosts',
        { types: ['artist', 'playlist'] },
        contextFor(service.fetch),
      )
      expect(results).toEqual({ artists: { items: [] }, playlists: { items: [] } })
      expect(service.calls).toHaveLength(0)
    })
  })

  describe('getTrack', () => {
    it('loads a track from its item', async () => {
      const service = archive()
      const track = await source().getTrack(
        formatId('archive', 'track', GHOSTS_1),
        contextFor(service.fetch),
      )
      expect(track).toEqual({
        id: formatId('archive', 'track', GHOSTS_1),
        source: 'archive',
        title: '1 Ghosts I',
        artists: [{ name: 'Nine Inch Nails' }],
        album: { id: formatId('archive', 'album', NIN), name: 'Ghosts I - IV' },
        durationMs: 168_830,
        artwork: [
          expect.objectContaining({ url: `https://archive.org/download/${NIN}/cover.jpg` }),
          { url: `https://archive.org/services/img/${NIN}` },
        ],
        trackNumber: 1,
        releaseDate: '2008-03-02',
        kind: 'song',
      })
    })

    it('answers with the canonical ID when asked by any file of the recording', async () => {
      const service = archive()
      const track = await source().getTrack(
        formatId('archive', 'track', `${NIN}/01_Ghosts_I_64kb.mp3`),
        contextFor(service.fetch),
      )
      expect(track.id).toBe(formatId('archive', 'track', GHOSTS_1))
    })

    it('rejects what it cannot find with NotFound', async () => {
      const service = archive()
      const ctx = contextFor(service.fetch)
      const ids = [
        formatId('archive', 'track', `${NIN}/missing.flac`),
        formatId('archive', 'track', 'no-such-item/a.flac'),
        formatId('archive', 'track', 'not a ref'),
        formatId('ytm', 'track', 'dQw4w9WgXcQ'),
      ]
      for (const id of ids) {
        const error = await source()
          .getTrack(id, ctx)
          .catch((caught: unknown) => caught)
        expect(isFxmError(error, 'NotFound')).toBe(true)
      }
    })

    it('refuses an item the Archive restricts', async () => {
      const service = archive()
      const error = await source()
        .getTrack(
          formatId('archive', 'track', 'gd1977-06-09.28614.sbeok.flac16/gd77-06-09d1t01.flac'),
          contextFor(service.fetch),
        )
        .catch((caught: unknown) => caught)
      expect(isFxmError(error, 'Unavailable')).toBe(true)
    })
  })

  describe('getAlbum', () => {
    it('loads an item with its tracks in album order', async () => {
      const service = archive()
      const album = await source().getAlbum(
        formatId('archive', 'album', 'gd1977-12-31_505'),
        contextFor(service.fetch),
      )
      expect(album).toMatchObject({
        id: formatId('archive', 'album', 'gd1977-12-31_505'),
        name: "Tuning '77",
        artists: [{ name: 'Michael David Murphy' }],
        trackCount: 2,
        artwork: [{ url: 'https://archive.org/services/img/gd1977-12-31_505' }],
      })
      expect(
        album.tracks?.map((track) => [track.title, track.artists[0]?.name, track.trackNumber]),
      ).toEqual([
        ["Tuning '77", 'Grateful Dead', 1],
        ["Tuning '77", 'Grateful Dead', 2],
      ])
    })

    it('rejects an album ID that is not an item identifier, without a request', async () => {
      const service = archive()
      const error = await source()
        .getAlbum(formatId('archive', 'album', 'a/b'), contextFor(service.fetch))
        .catch((caught: unknown) => caught)
      expect(isFxmError(error, 'NotFound')).toBe(true)
      expect(service.calls).toHaveLength(0)
    })
  })

  it('has no artist pages or playlists', async () => {
    const service = archive()
    const ctx = contextFor(service.fetch)
    const artist = await source()
      .getArtist(formatId('archive', 'artist', 'x'), ctx)
      .catch((caught: unknown) => caught)
    const playlist = await source()
      .getPlaylist(formatId('archive', 'playlist', 'x'), ctx)
      .catch((caught: unknown) => caught)
    expect(isFxmError(artist, 'Unsupported')).toBe(true)
    expect(isFxmError(playlist, 'Unsupported')).toBe(true)
  })

  describe('match', () => {
    it('answers an Archive track with its own file, without a request', async () => {
      const service = archive()
      const candidates = await source().match(archiveTrack(), contextFor(service.fetch))
      expect(candidates).toEqual([
        {
          source: 'archive',
          ref: GHOSTS_1,
          kind: 'song',
          title: '1 Ghosts I',
          artists: ['Nine Inch Nails'],
          durationMs: 168_830,
          confidence: 1,
          evidence: ['same file'],
          signals: { isrcVerified: false, releaseId: NIN, sourceAlbumMatch: true },
        },
      ])
      expect(service.calls).toHaveLength(0)
    })

    it('uses a known link to an Archive file, without a request', async () => {
      const service = archive()
      const linked = spotifyGhosts({ externalIds: { archive: GHOSTS_1 } })
      const [only] = await source().match(linked, contextFor(service.fetch))
      expect(only).toMatchObject({ ref: GHOSTS_1, confidence: 1, evidence: ['linked file'] })
      expect(only?.signals).toMatchObject({ isrcVerified: false, sourceAlbumMatch: false })
      expect(service.calls).toHaveLength(0)
    })

    it('searches for another source’s track by artist, and title or album', async () => {
      const service = archive()
      const candidates = await source().match(spotifyGhosts(), contextFor(service.fetch))
      expect(candidates).toEqual([
        {
          source: 'archive',
          ref: GHOSTS_1,
          kind: 'song',
          title: '1 Ghosts I',
          artists: ['Nine Inch Nails'],
          durationMs: 168_830,
          confidence: 0.79,
          evidence: ['title 1.00', 'artist 1.00', 'duration +0.8s'],
          signals: {
            isrcVerified: false,
            releaseId: NIN,
            releaseYear: 2008,
            sourceAlbumMatch: true,
          },
        },
      ])
      const query = service.calls[0]?.url.searchParams.get('q')
      expect(query).toBe(
        'mediatype:(audio) AND format:flac AND NOT access-restricted-item:true AND ' +
          '(nine inch nails) AND ((1 ghosts i) OR (ghosts i iv))',
      )
      expect(service.calls[0]?.url.searchParams.get('rows')).toBe('3')
    })

    it('never offers a concert recording for a studio track', async () => {
      const service = archive({ 'band1999-01-01': liveShow })
      const studio: Track = {
        ...spotifyGhosts(),
        title: 'Song',
        artists: [{ name: 'Band' }],
        durationMs: 200_000,
      }
      const ctx = contextFor(service.fetch)
      await expect(source().match(studio, ctx)).resolves.toEqual([])
      const live = await source().match({ ...studio, title: 'Song - Live' }, ctx)
      expect(live.map((found) => found.ref)).toEqual(['band1999-01-01/song.flac'])
      expect(
        service.calls
          .filter((call) => call.url.pathname === '/advancedsearch.php')
          .map((call) => call.url.searchParams.get('q')?.split(' AND ')[0]),
      ).toEqual(['mediatype:(audio)', 'mediatype:(audio OR etree)'])
    })

    it('makes no request for a track without a title or artist', async () => {
      const service = archive()
      const ctx = contextFor(service.fetch)
      await expect(source().match(spotifyGhosts({ artists: [] }), ctx)).resolves.toEqual([])
      await expect(source().match(spotifyGhosts({ title: '()' }), ctx)).resolves.toEqual([])
      expect(service.calls).toHaveLength(0)
    })
  })

  describe('resolve', () => {
    it('offers every playable file of the track, best first', async () => {
      const service = archive()
      const options = await source().resolve(
        candidate(GHOSTS_1),
        contextFor(service.fetch),
        DEFAULT_QUALITY_PREFS,
      )
      expect(
        options.map((option) => [
          option.url.split('/').at(-1),
          option.codec,
          option.tier,
          option.bitrateKbps,
        ]),
      ).toEqual([
        ['01_Ghosts_I.flac', 'flac', 'lossless', 612],
        ['01_Ghosts_I_320kb.mp3', 'mp3', 'high', 320],
        ['01_Ghosts_I_vbr.mp3', 'mp3', 'normal', 178],
        ['01_Ghosts_I.mp3', 'mp3', 'normal', 177],
        ['01_Ghosts_I.ogg', 'vorbis', 'normal', 100],
        ['01_Ghosts_I_64kb.mp3', 'mp3', 'low', 64],
      ])
      expect(options[0]).toEqual<StreamOption>({
        url: `https://archive.org/download/${NIN}/01_Ghosts_I.flac`,
        codec: 'flac',
        container: 'flac',
        media: 'audio',
        bitrateKbps: 612,
        tier: 'lossless',
        protocol: 'progressive',
        ipBound: false,
        fullLength: 'unverified',
      })
      expect(options.every((option) => option.downloadAllowed === undefined)).toBe(true)
      expect(options[4]).toMatchObject({ container: 'ogg', codec: 'vorbis' })
    })

    it('states the bit depth of a 24-bit FLAC from its format name', async () => {
      const service = archive()
      const [best] = await source().resolve(
        candidate('gd1977-12-31_505/gd_1977_Tuning_77.flac'),
        contextFor(service.fetch),
        DEFAULT_QUALITY_PREFS,
      )
      expect(best).toMatchObject({ codec: 'flac', tier: 'lossless', bitDepth: 24 })
      expect(best).not.toHaveProperty('sampleRateHz')
    })

    it('reads the sample rate and bit depth of each FLAC file when asked to probe', async () => {
      const service = archive()
      const probing = source({ probeFlac: true })
      const ctx = contextFor(service.fetch)
      const options = await probing.resolve(candidate(GHOSTS_1), ctx, DEFAULT_QUALITY_PREFS)
      expect(options[0]).toMatchObject({ sampleRateHz: 44100, bitDepth: 24 })
      expect(options.slice(1).every((option) => option.sampleRateHz === undefined)).toBe(true)
      const again = await probing.resolve(candidate(GHOSTS_1), ctx, DEFAULT_QUALITY_PREFS)
      expect(again[0]).toMatchObject({ sampleRateHz: 44100, bitDepth: 24 })
      const probes = service.calls.filter((call) => call.headers.has('range'))
      expect(paths(probes)).toEqual([`/download/${NIN}/01_Ghosts_I.flac`])
    })

    it('keeps the options as they are when a probe fails, and probes again next time', async () => {
      let broken = true
      const service = fakeService((url) => {
        if (url.pathname.startsWith('/download/')) {
          return broken
            ? new Response('nope', { status: 500 })
            : new Response(FLAC_HEADER, { status: 206 })
        }
        return json(ninGhosts)
      })
      const probing = source({ probeFlac: true })
      const ctx = contextFor(service.fetch)
      const [first] = await probing.resolve(candidate(GHOSTS_1), ctx, DEFAULT_QUALITY_PREFS)
      expect(first).not.toHaveProperty('sampleRateHz')
      broken = false
      const [second] = await probing.resolve(candidate(GHOSTS_1), ctx, DEFAULT_QUALITY_PREFS)
      expect(second).toMatchObject({ sampleRateHz: 44100 })
    })

    it('refuses candidates from other sources, missing files and restricted items', async () => {
      const service = archive()
      const ctx = contextFor(service.fetch)
      const cases: Array<[AudioCandidate, string]> = [
        [candidate('x', { source: 'ytm' }), 'Unsupported'],
        [candidate(`${NIN}/missing.flac`), 'NotFound'],
        [candidate('gd1977-06-09.28614.sbeok.flac16/gd77-06-09d1t01.flac'), 'Unavailable'],
      ]
      for (const [input, code] of cases) {
        const error = await source()
          .resolve(input, ctx, DEFAULT_QUALITY_PREFS)
          .catch((caught: unknown) => caught)
        expect(isFxmError(error, code as 'NotFound')).toBe(true)
      }
    })
  })
})
