import { describe, expect, expectTypeOf, it } from 'vitest'
import { type EntityId, type EntityKind, formatId } from './ids'
import {
  type Album,
  type Artist,
  type ArtistRef,
  isTrackSeed,
  type Page,
  type Playlist,
  type SearchResults,
  type SearchType,
  type Shelf,
  type ShelfItem,
  type Track,
  type TrackKind,
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

  it('links an official music video to its song', () => {
    const video: Track = {
      ...minimal,
      id: formatId('ytm', 'track', 'omv1'),
      title: 'Never Gonna Give You Up (Official Video)',
      kind: 'music-video',
      songId: minimal.id,
    }
    expect(video.songId).toBe('ytm:track:dQw4w9WgXcQ')
    expectTypeOf<Track['songId']>().toEqualTypeOf<EntityId<'track'> | undefined>()
    // @ts-expect-error the link names a track, never an album
    const toAlbum: Track = { ...video, songId: formatId('ytm', 'album', 'MPREb_abc') }
    expect(toAlbum.songId).toBe('ytm:album:MPREb_abc')
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

  it('pages songs and videos separately in search results', () => {
    const officialVideo: Track = { ...minimal, kind: 'music-video' }
    const results: SearchResults = {
      tracks: { items: [minimal], nextCursor: 'songs-2' },
      videos: { items: [officialVideo], nextCursor: 'videos-2' },
    }
    expect([results.tracks?.nextCursor, results.videos?.nextCursor]).toEqual([
      'songs-2',
      'videos-2',
    ])
    expectTypeOf<SearchType>().toEqualTypeOf<EntityKind | 'video'>()
  })

  it('tags shelf items so the UI can switch on their type', () => {
    const items: ShelfItem[] = [{ type: 'track', track: minimal }]
    const shelf: Shelf = { id: 'quick-picks', title: 'Quick picks', items }
    const titles = shelf.items.map((item) => (item.type === 'track' ? item.track.title : ''))
    expect(titles).toEqual(['Never Gonna Give You Up'])
  })
})

describe('isTrackSeed', () => {
  it('tells a track seed from an artist seed', () => {
    expect(isTrackSeed(minimal)).toBe(true)
    expect(isTrackSeed({ name: 'Rick Astley' })).toBe(false)
    expect(isTrackSeed({ id: formatId('ytm', 'artist', 'UC123'), name: 'Rick Astley' })).toBe(false)
    const seed = minimal as Track | ArtistRef
    if (isTrackSeed(seed)) expectTypeOf(seed).toEqualTypeOf<Track>()
    else expectTypeOf(seed).toEqualTypeOf<ArtistRef>()
  })
})
