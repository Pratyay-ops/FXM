import { describe, expect, expectTypeOf, it } from 'vitest'
import { formatId } from './ids'
import type {
  Album,
  Artist,
  Page,
  Playlist,
  SearchResults,
  Shelf,
  ShelfItem,
  Track,
  TrackKind,
} from './model'

/** A track with only its required fields. */
const minimal: Track = {
  id: formatId('ytm', 'track', 'dQw4w9WgXcQ'),
  source: 'ytm',
  title: 'Never Gonna Give You Up',
  artists: [{ name: 'Rick Astley' }],
  artwork: [],
  kind: 'song',
}

describe('Track', () => {
  it('needs only its required fields', () => {
    expect(Object.keys(minimal)).toEqual(['id', 'source', 'title', 'artists', 'artwork', 'kind'])
  })

  it('takes every optional field', () => {
    const full: Track = {
      ...minimal,
      artists: [{ id: formatId('ytm', 'artist', 'UCuAXFkgsw1L7xaCfnd5JJOw'), name: 'Rick Astley' }],
      album: { id: formatId('ytm', 'album', 'MPREb_abc'), name: 'Whenever You Need Somebody' },
      durationMs: 213_000,
      artwork: [{ url: 'https://example.test/cover.jpg', width: 544, height: 544 }],
      explicit: false,
      isrc: 'GBARL9300135',
      trackNumber: 1,
      discNumber: 1,
      releaseDate: '1987-07-27',
      popularity: 80,
      externalIds: { spotify: '4uLU6hMCjMI75M1A2tKUQC' },
    }
    expect(full.externalIds?.spotify).toBe('4uLU6hMCjMI75M1A2tKUQC')
  })

  it('rejects explicit undefined in optional fields (exactOptionalPropertyTypes)', () => {
    // @ts-expect-error leave unknown optional fields out instead of setting undefined
    const withUndefined: Track = { ...minimal, durationMs: undefined }
    expect(withUndefined.durationMs).toBeUndefined()
  })

  it('has the four kinds', () => {
    expectTypeOf<TrackKind>().toEqualTypeOf<'song' | 'music-video' | 'video' | 'episode'>()
  })
})

describe('collections', () => {
  it('builds albums, artists and playlists with and without their contents', () => {
    const album: Album = {
      id: formatId('spotify', 'album', '4aawyAB9vmqN3uQ7FjRGTy'),
      source: 'spotify',
      name: 'Global Warming',
      artists: [{ name: 'Pitbull' }],
      artwork: [],
      type: 'album',
      tracks: [minimal],
    }
    const artist: Artist = {
      id: formatId('ytm', 'artist', 'UC123'),
      source: 'ytm',
      name: 'Rick Astley',
      artwork: [],
      topTracks: [minimal],
      albums: [album],
      related: [],
    }
    const page: Page<Track> = { items: [minimal], nextCursor: 'next', total: 120 }
    const playlist: Playlist = {
      id: formatId('yt', 'playlist', 'PL123'),
      source: 'yt',
      name: 'Mix',
      owner: { name: 'Someone' },
      artwork: [],
      tracks: page,
    }
    const results: SearchResults = { tracks: { items: [minimal] }, artists: { items: [artist] } }
    expect(playlist.tracks?.items).toHaveLength(1)
    expect(results.albums).toBeUndefined()
  })

  it('tags shelf items so the UI can switch on their type', () => {
    const items: ShelfItem[] = [{ type: 'track', track: minimal }]
    const shelf: Shelf = { id: 'quick-picks', title: 'Quick picks', items }
    const titles = shelf.items.map((item) => (item.type === 'track' ? item.track.title : ''))
    expect(titles).toEqual(['Never Gonna Give You Up'])
  })
})
