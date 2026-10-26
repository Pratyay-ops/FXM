import { describe, expect, it } from 'vitest'
import { localAlbumId, localArtistId, localTrackId } from './ids'
import { fileRecord as record } from './testing'
import {
  albumArtistOf,
  type LocalTrack,
  searchLocalTracks,
  sortLocalTracks,
  toLocalTracks,
  toTrack,
  VARIOUS_ARTISTS,
} from './tracks'

const titles = (tracks: readonly LocalTrack[]) => tracks.map(({ track }) => track.title)

describe('toTrack', () => {
  it('makes a local song with the tags and the cover', () => {
    const file = record({
      title: 'Night Drive',
      artists: ['Aria Vale', 'Theo Marsh'],
      album: 'Neon Rivers',
      trackNumber: 3,
      discNumber: 1,
      releaseDate: '2021',
      isrc: 'USXYZ2100001',
      durationMs: 201_000,
    })
    const track = toTrack(file, {
      key: 'k',
      url: 'data:image/webp;base64,AA',
      width: 128,
      height: 128,
    })
    expect(track).toEqual({
      id: localTrackId(file.id),
      source: 'local',
      title: 'Night Drive',
      artists: [
        { id: localArtistId('Aria Vale'), name: 'Aria Vale' },
        { id: localArtistId('Theo Marsh'), name: 'Theo Marsh' },
      ],
      album: { id: localAlbumId('Aria Vale', 'Neon Rivers'), name: 'Neon Rivers' },
      durationMs: 201_000,
      artwork: [{ url: 'data:image/webp;base64,AA', width: 128, height: 128 }],
      kind: 'song',
      isrc: 'USXYZ2100001',
      trackNumber: 3,
      discNumber: 1,
      releaseDate: '2021',
    })
  })

  it('leaves out what the file doesn’t say', () => {
    expect(toTrack(record({ title: 'Bare' }))).toEqual({
      id: expect.any(String),
      source: 'local',
      title: 'Bare',
      artists: [],
      artwork: [],
      kind: 'song',
    })
  })

  it('files an album under its album artist, compilations under Various artists', () => {
    expect(albumArtistOf({ title: 'x', artists: ['A'], albumArtist: 'B' })).toBe('B')
    expect(albumArtistOf({ title: 'x', artists: ['A'] })).toBe('A')
    expect(albumArtistOf({ title: 'x', artists: ['A'], compilation: true })).toBe(VARIOUS_ARTISTS)
    const one = toTrack(record({ title: '1', artists: ['A'], album: 'Mix', compilation: true }))
    const two = toTrack(record({ title: '2', artists: ['B'], album: 'Mix', compilation: true }))
    expect(one.album?.id).toBe(two.album?.id)
  })

  it('joins files with their pictures', () => {
    const tracks = toLocalTracks(
      [
        record({ title: 'A' }, { pictureKey: 'p' }),
        record({ title: 'B' }, { pictureKey: 'missing' }),
      ],
      new Map([['p', { key: 'p', url: 'data:x', width: 1, height: 1 }]]),
    )
    expect(tracks.map(({ track }) => track.artwork.length)).toEqual([1, 0])
  })
})

describe('sortLocalTracks', () => {
  const library = toLocalTracks(
    [
      record(
        { title: 'Zebra', artists: ['Beta'], album: 'Second', trackNumber: 1 },
        { addedAt: 10 },
      ),
      record(
        { title: 'Apple', artists: ['Alpha'], album: 'First', trackNumber: 2 },
        { addedAt: 30 },
      ),
      record(
        { title: 'Mango', artists: ['Alpha'], album: 'First', trackNumber: 1 },
        { addedAt: 20 },
      ),
      record(
        { title: 'Kiwi', artists: ['Alpha'], album: 'First', discNumber: 2, trackNumber: 1 },
        { addedAt: 5 },
      ),
      record({ title: 'Loose' }, { addedAt: 0 }),
    ],
    new Map(),
  )

  it('sorts by artist, then album, disc and track, untagged last', () => {
    expect(titles(sortLocalTracks(library, 'artist'))).toEqual([
      'Mango',
      'Apple',
      'Kiwi',
      'Zebra',
      'Loose',
    ])
  })

  it('sorts by album', () => {
    expect(titles(sortLocalTracks(library, 'album'))).toEqual([
      'Mango',
      'Apple',
      'Kiwi',
      'Zebra',
      'Loose',
    ])
  })

  it('sorts by title', () => {
    expect(titles(sortLocalTracks(library, 'title'))).toEqual([
      'Apple',
      'Kiwi',
      'Loose',
      'Mango',
      'Zebra',
    ])
  })

  it('sorts the newest first', () => {
    expect(titles(sortLocalTracks(library, 'added')).slice(0, 3)).toEqual([
      'Apple',
      'Mango',
      'Zebra',
    ])
  })

  it('sorts track numbers as numbers', () => {
    const numbered = toLocalTracks(
      [10, 9, 1].map((trackNumber) =>
        record({ title: `T${trackNumber}`, artists: ['A'], album: 'X', trackNumber }),
      ),
      new Map(),
    )
    expect(titles(sortLocalTracks(numbered, 'artist'))).toEqual(['T1', 'T9', 'T10'])
  })
})

describe('searchLocalTracks', () => {
  const library = toLocalTracks(
    [
      record({ title: 'Night Drive', artists: ['Aria Vale'], album: 'Neon Rivers' }),
      record({ title: 'Drive Home', artists: ['Low Orbit'], album: 'Night Shift' }),
      record({ title: 'Café del Mar', artists: ['Energy 52'] }),
      record({ title: 'Untitled' }, { path: 'Field/Recording 7.wav' }),
    ],
    new Map(),
  )

  it('needs every word somewhere, and ranks titles first', () => {
    expect(titles(searchLocalTracks(library, 'night drive'))).toEqual(['Night Drive', 'Drive Home'])
    expect(titles(searchLocalTracks(library, 'drive'))).toEqual(['Drive Home', 'Night Drive'])
    expect(titles(searchLocalTracks(library, 'aria'))).toEqual(['Night Drive'])
    expect(titles(searchLocalTracks(library, 'neon'))).toEqual(['Night Drive'])
  })

  it('ignores case and accents', () => {
    expect(titles(searchLocalTracks(library, 'CAFE'))).toEqual(['Café del Mar'])
  })

  it('finds a file by its name', () => {
    expect(titles(searchLocalTracks(library, 'recording 7'))).toEqual(['Untitled'])
  })

  it('finds nothing for an empty query', () => {
    expect(searchLocalTracks(library, '   ')).toEqual([])
    expect(searchLocalTracks(library, 'nothing like this')).toEqual([])
  })
})
