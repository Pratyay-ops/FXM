import { formatId } from '@fxm/core'
import { describe, expect, it } from 'vitest'
import albumsTracks from './fixtures/albums-tracks.json'
import artistsTracks from './fixtures/artists-tracks.json'
import tracksDocsSample from './fixtures/tracks-docs-sample.json'
import tracksFlac from './fixtures/tracks-flac.json'
import {
  jamendoAlbumUrl,
  jamendoArtistUrl,
  jamendoId,
  jamendoTrackUrl,
  streamOptions,
  toAlbum,
  toArtist,
  toTrackRecord,
  trackOf,
} from './map'

const [manana, queensland] = tracksFlac.results

describe('toTrackRecord', () => {
  it('reads the fields FXM uses', () => {
    expect(toTrackRecord(manana)).toEqual({
      id: '1848357',
      name: 'mañana será tarde',
      durationMs: 272_000,
      artistId: '421168',
      artistName: 'fankel',
      albumId: '368084',
      albumName: 'mañana será tarde',
      position: 1,
      releaseDate: '2021-04-11',
      image: 'https://usercontent.jamendo.com?type=album&id=368084&width=300&trackid=1848357',
      audio: 'https://prod-1.storage.jamendo.com/?trackid=1848357&format=flac&from=app-devsite',
      downloadAllowed: true,
      licenseUrl: 'http://creativecommons.org/licenses/by-nc-nd/3.0/',
    })
    expect(toTrackRecord(queensland)?.downloadAllowed).toBe(false)
  })

  it('reads downloads as allowed in an answer without the flag only when a download URL is there', () => {
    const { audiodownload_allowed: _flag, ...legacy } = manana ?? {}
    expect(toTrackRecord(legacy)?.downloadAllowed).toBe(true)
    expect(toTrackRecord({ ...legacy, audiodownload: '' })?.downloadAllowed).toBe(false)
  })

  it('takes what the album or artist of a nested track says, and only https URLs', () => {
    const record = toTrackRecord(
      { id: 5, name: 'Nested', duration: '61.5', audio: 'http://insecure.test/a', position: 3 },
      {
        artistId: '9',
        artistName: 'Parent',
        albumId: '7',
        albumName: 'Album',
        image: 'https://img.test/a',
      },
    )
    expect(record).toEqual({
      id: '5',
      name: 'Nested',
      durationMs: 61_500,
      artistId: '9',
      artistName: 'Parent',
      albumId: '7',
      albumName: 'Album',
      position: 3,
      image: 'https://img.test/a',
      downloadAllowed: false,
    })
  })

  it('refuses entries without an ID or a name', () => {
    for (const value of [
      null,
      {},
      { id: '1' },
      { name: 'x' },
      { id: 'abc', name: 'x' },
      { id: '0', name: 'x' },
    ]) {
      expect(toTrackRecord(value)).toBeNull()
    }
  })
})

describe('jamendoId', () => {
  it('spells IDs in decimal without leading zeros', () => {
    expect(jamendoId('1848357')).toBe('1848357')
    expect(jamendoId(1848357)).toBe('1848357')
    expect(jamendoId('007')).toBe('7')
    for (const value of ['', ' ', '-1', '1.5', '1e3', 'x1', 0, Number.MAX_SAFE_INTEGER + 2, null]) {
      expect(jamendoId(value)).toBeUndefined()
    }
  })
})

describe('trackOf', () => {
  it('makes a song with source-qualified IDs and square artwork', () => {
    const record = toTrackRecord(manana)
    expect(record && trackOf(record)).toEqual({
      id: formatId('jamendo', 'track', '1848357'),
      source: 'jamendo',
      title: 'mañana será tarde',
      artists: [{ id: formatId('jamendo', 'artist', '421168'), name: 'fankel' }],
      album: { id: formatId('jamendo', 'album', '368084'), name: 'mañana será tarde' },
      durationMs: 272_000,
      artwork: [
        {
          url: 'https://usercontent.jamendo.com?type=album&id=368084&width=300&trackid=1848357',
          width: 300,
          height: 300,
        },
      ],
      trackNumber: 1,
      releaseDate: '2021-04-11',
      kind: 'song',
    })
  })

  it('leaves out what a single lacks', () => {
    const record = toTrackRecord({ id: '1', name: 'Single', album_id: '', album_name: '' })
    expect(record && trackOf(record)).toEqual({
      id: formatId('jamendo', 'track', '1'),
      source: 'jamendo',
      title: 'Single',
      artists: [],
      artwork: [],
      kind: 'song',
    })
  })
})

describe('streamOptions', () => {
  it('offers FLAC, VBR MP3, Ogg Vorbis and 96 kbps MP3 from the one stream URL', () => {
    const record = toTrackRecord(manana)
    const options = record ? streamOptions(record) : []
    expect(
      options.map((option) => [
        new URL(option.url).searchParams.get('format'),
        option.codec,
        option.container,
        option.tier,
        option.bitrateKbps,
      ]),
    ).toEqual([
      ['flac', 'flac', 'flac', 'lossless', undefined],
      ['mp32', 'mp3', 'mp3', 'normal', undefined],
      ['ogg', 'vorbis', 'ogg', 'normal', undefined],
      ['mp31', 'mp3', 'mp3', 'low', 96],
    ])
    for (const option of options) {
      const url = new URL(option.url)
      expect(url.searchParams.get('trackid')).toBe('1848357')
      expect(url.searchParams.get('from')).toBe('app-devsite')
      expect(option).toMatchObject({
        media: 'audio',
        protocol: 'progressive',
        ipBound: false,
        fullLength: 'unverified',
      })
      expect(option).not.toHaveProperty('downloadAllowed')
    }
  })

  it('marks every option when the artist turned downloads off', () => {
    const record = toTrackRecord(queensland)
    const options = record ? streamOptions(record) : []
    expect(options).toHaveLength(4)
    expect(options.every((option) => option.downloadAllowed === false)).toBe(true)
  })

  it('offers only the URL as given when it names no format, and nothing without one', () => {
    const record = toTrackRecord({
      id: '1',
      name: 'x',
      audio: 'https://prod-1.storage.jamendo.com/track/1',
    })
    expect(record && streamOptions(record).map((option) => [option.url, option.codec])).toEqual([
      ['https://prod-1.storage.jamendo.com/track/1', 'flac'],
    ])
    const silent = toTrackRecord({ id: '2', name: 'y' })
    expect(silent && streamOptions(silent)).toEqual([])
  })

  it('reads the documented default answer (MP3 96 kbps) as that format', () => {
    const record = toTrackRecord(tracksDocsSample.results[0])
    expect(record?.audio).toContain('format=mp31')
    expect(record && streamOptions(record)[0]?.url).toContain('format=flac')
  })
})

describe('toAlbum', () => {
  it('reads an album with its tracks, which inherit its artist, cover and date', () => {
    const parsed = toAlbum(albumsTracks.results[0])
    expect(parsed?.album).toMatchObject({
      id: formatId('jamendo', 'album', '368084'),
      source: 'jamendo',
      name: 'mañana será tarde',
      artists: [{ id: formatId('jamendo', 'artist', '421168'), name: 'fankel' }],
      releaseDate: '2021-04-11',
      trackCount: 1,
    })
    expect(parsed?.album.tracks?.[0]).toMatchObject({
      id: formatId('jamendo', 'track', '1848357'),
      artists: [{ name: 'fankel' }],
      album: { id: formatId('jamendo', 'album', '368084') },
      artwork: [{ width: 300 }],
      releaseDate: '2021-04-11',
      trackNumber: 1,
    })
    expect(parsed?.records[0]?.audio).toContain('format=flac')
  })

  it('reads a search result without tracks, and refuses one without an ID', () => {
    const parsed = toAlbum({ id: '42', name: 'Listed', artist_name: 'Someone' })
    expect(parsed?.album).not.toHaveProperty('tracks')
    expect(parsed?.records).toEqual([])
    expect(toAlbum({ name: 'No ID' })).toBeNull()
  })
})

describe('toArtist', () => {
  it('reads an artist with its tracks, which name the artist', () => {
    const parsed = toArtist(artistsTracks.results[0])
    expect(parsed?.artist).toMatchObject({
      id: formatId('jamendo', 'artist', '421168'),
      source: 'jamendo',
      name: 'fankel',
      artwork: [{ url: 'https://usercontent.jamendo.com?type=artist&id=421168&width=300' }],
    })
    expect(parsed?.artist.topTracks?.[0]).toMatchObject({
      id: formatId('jamendo', 'track', '1848357'),
      artists: [{ id: formatId('jamendo', 'artist', '421168'), name: 'fankel' }],
      album: { name: 'mañana será tarde' },
    })
    expect(toArtist({ id: '1' })).toBeNull()
  })
})

describe('page URLs', () => {
  it('link to Jamendo’s pages, the backlinks its terms ask for', () => {
    expect(jamendoTrackUrl('1848357')).toBe('https://www.jamendo.com/track/1848357')
    expect(jamendoAlbumUrl('368084')).toBe('https://www.jamendo.com/album/368084')
    expect(jamendoArtistUrl('421168')).toBe('https://www.jamendo.com/artist/421168')
  })
})
