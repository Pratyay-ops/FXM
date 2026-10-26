import { describe, expect, it } from 'vitest'
import { isPluginError } from './errors'
import {
  type ResultContext,
  toAlbum,
  toArtist,
  toCandidates,
  toPlaylist,
  toSearchResults,
  toStreams,
  toSuggestions,
  toTrack,
  toTrackPage,
  toTracks,
} from './results'

const rc: ResultContext = {
  source: 'plugin.example',
  hosts: ['api.example.org', 'cdn.example.org'],
  name: 'Example',
  mode: 'all',
}
const music: ResultContext = { ...rc, mode: 'music' }

function bad(work: () => unknown): boolean {
  try {
    work()
  } catch (error) {
    return isPluginError(error, 'bad-result')
  }
  return false
}

describe('plugin results', () => {
  it('turn a track into a core track with IDs FXM builds itself', () => {
    expect(
      toTrack(rc, {
        id: 'abc:1',
        title: ' Lantern\nWeather ',
        artists: [{ id: 'a1', name: 'The Paper Moths' }, 'Guest', { name: '' }, 42],
        album: 'Night Ferries',
        durationMs: 201_499.6,
        artwork: [
          'https://cdn.example.org/c.jpg',
          { url: 'https://cdn.example.org/big.jpg', width: 1200, height: 1200.5 },
          'https://tracker.example.net/pixel.gif',
          'http://cdn.example.org/plain.jpg',
        ],
        explicit: false,
        isrc: 'zz-tst-26-00001',
        trackNumber: 3,
        discNumber: 0,
        releaseDate: '2026-10',
        popularity: 101,
        tags: ['Dream pop', 'Dream pop', 'x'.repeat(80)],
        id2: 'ignored',
      }),
    ).toEqual({
      id: 'plugin.example:track:abc:1',
      source: 'plugin.example',
      title: 'Lantern Weather',
      artists: [{ id: 'plugin.example:artist:a1', name: 'The Paper Moths' }, { name: 'Guest' }],
      album: { name: 'Night Ferries' },
      durationMs: 201_500,
      artwork: [
        { url: 'https://cdn.example.org/c.jpg' },
        { url: 'https://cdn.example.org/big.jpg', width: 1200 },
      ],
      explicit: false,
      isrc: 'ZZTST2600001',
      kind: 'song',
      trackNumber: 3,
      releaseDate: '2026-10',
      tags: ['Dream pop', `${'x'.repeat(49)}…`],
    })
  })

  it('refuse a track without an ID or a title, or of an unknown kind', () => {
    expect(bad(() => toTrack(rc, { title: 'No id' }))).toBe(true)
    expect(bad(() => toTrack(rc, { id: 'x', title: '  ' }))).toBe(true)
    expect(bad(() => toTrack(rc, { id: 'x', title: 'T', kind: 'podcast' }))).toBe(true)
    expect(bad(() => toTrack(rc, { id: 'a\u0000b', title: 'T' }))).toBe(true)
    expect(bad(() => toTrack(rc, 'x'))).toBe(true)
    expect(toTrack(rc, { id: 7, name: 'Seven' })).toMatchObject({ id: 'plugin.example:track:7' })
  })

  it('link a music video to its song, but never to itself', () => {
    expect(
      toTrack(rc, { id: 'v1', title: 'Video', kind: 'music-video', songId: 's1' }),
    ).toMatchObject({ kind: 'music-video', songId: 'plugin.example:track:s1' })
    expect(
      toTrack(rc, { id: 'v1', title: 'Video', kind: 'music-video', songId: 'v1' }),
    ).not.toHaveProperty('songId')
    expect(toTrack(rc, { id: 's2', title: 'Song', songId: 's1' })).not.toHaveProperty('songId')
  })

  it('split search results into songs and videos, keep requested types only, drop bad items', () => {
    const value = {
      tracks: {
        items: [
          { id: 's1', title: 'Song' },
          { id: 'v1', title: 'Video', kind: 'video' },
          { title: 'broken' },
        ],
        nextCursor: 'next',
        total: 9,
      },
      albums: [
        { id: 'al1', title: 'Album', artists: ['Band'], tracks: [{ id: 's1', title: 'x' }] },
      ],
      artists: [{ id: 'a1', name: 'Band', topTracks: [{ id: 's1', title: 'x' }] }],
      playlists: { items: [{ id: 'p1', name: 'List', owner: 'Someone' }] },
    }
    const all = toSearchResults(rc, value, ['track', 'video', 'album', 'artist', 'playlist'])
    expect(all.tracks).toEqual({
      items: [expect.objectContaining({ id: 'plugin.example:track:s1' })],
      nextCursor: 'next',
      total: 9,
    })
    expect(all.videos?.items.map((track) => track.id)).toEqual(['plugin.example:track:v1'])
    // Lists leave out what a list of results doesn't carry.
    expect(all.albums?.items[0]).not.toHaveProperty('tracks')
    expect(all.artists?.items[0]).not.toHaveProperty('topTracks')
    expect(all.playlists?.items[0]).toMatchObject({ owner: { name: 'Someone' } })
    const songsOnly = toSearchResults(music, value, ['track', 'video'])
    expect(Object.keys(songsOnly)).toEqual(['tracks', 'videos'])
    expect(songsOnly.videos).toEqual({ items: [] })
    expect(toSearchResults(rc, {}, ['album'])).toEqual({ albums: { items: [] } })
    expect(bad(() => toSearchResults(rc, [], ['track']))).toBe(true)
    expect(bad(() => toSearchResults(rc, { tracks: 'x' }, ['track']))).toBe(true)
  })

  it('filter lists for the catalog mode', () => {
    const value = [
      { id: 's1', title: 'Song' },
      { id: 'mv', title: 'Official video', kind: 'music-video' },
      { id: 'v1', title: 'A video', kind: 'video' },
      { id: 'e1', title: 'An episode', kind: 'episode' },
    ]
    expect(toTracks(music, value).map((track) => track.kind)).toEqual(['song', 'music-video'])
    expect(toTracks(rc, value).map((track) => track.kind)).toEqual(['song', 'music-video', 'video'])
    expect(bad(() => toTracks(rc, { items: [] }))).toBe(true)
  })

  it('cut lists to 200 items', () => {
    const many = Array.from({ length: 250 }, (_, index) => ({ id: `t${index}`, title: 'T' }))
    expect(toTracks(rc, many)).toHaveLength(200)
  })

  it('turn albums, artists and playlists into core entities with their contents', () => {
    expect(
      toAlbum(rc, {
        id: 'al1',
        name: 'Night Ferries',
        artists: [{ id: 'a1', name: 'Band' }],
        type: 'ep',
        releaseDate: '2026-02-30T00:00',
        trackCount: 3,
        tracks: [{ id: 't1', title: 'One' }],
      }),
    ).toEqual({
      id: 'plugin.example:album:al1',
      source: 'plugin.example',
      name: 'Night Ferries',
      artists: [{ id: 'plugin.example:artist:a1', name: 'Band' }],
      artwork: [],
      type: 'ep',
      trackCount: 3,
      tracks: [expect.objectContaining({ id: 'plugin.example:track:t1' })],
    })
    expect(
      toArtist(rc, {
        id: 'a1',
        name: 'Band',
        description: 'From\nsomewhere',
        topTracks: [{ id: 't1', title: 'One' }],
        albums: [{ id: 'al1', title: 'A' }],
        related: [{ id: 'a2', name: 'Other' }],
      }),
    ).toMatchObject({
      id: 'plugin.example:artist:a1',
      description: 'From somewhere',
      topTracks: [{ id: 'plugin.example:track:t1' }],
      albums: [{ id: 'plugin.example:album:al1' }],
      related: [{ id: 'plugin.example:artist:a2' }],
    })
    expect(
      toPlaylist(rc, {
        id: 'p1',
        title: 'List',
        owner: { name: 'Someone', id: 'u1' },
        tracks: { items: [{ id: 't1', title: 'One' }], nextCursor: 'c2' },
      }),
    ).toMatchObject({
      id: 'plugin.example:playlist:p1',
      owner: { name: 'Someone', id: 'u1' },
      tracks: { items: [{ id: 'plugin.example:track:t1' }], nextCursor: 'c2' },
    })
    expect(bad(() => toAlbum(rc, { id: 'x' }))).toBe(true)
    expect(bad(() => toArtist(rc, { name: 'x' }))).toBe(true)
    expect(bad(() => toPlaylist(rc, null))).toBe(true)
  })

  it('read a page of playlist tracks from a page or from a playlist', () => {
    expect(toTrackPage(rc, { items: [{ id: 't2', title: 'Two' }] }).items).toHaveLength(1)
    expect(
      toTrackPage(rc, { id: 'p1', name: 'List', tracks: { items: [{ id: 't3', title: 'x' }] } }),
    ).toMatchObject({ items: [{ id: 'plugin.example:track:t3' }] })
    expect(toTrackPage(rc, [{ id: 't4', title: 'x' }]).items).toHaveLength(1)
  })

  it('clean suggestions', () => {
    expect(toSuggestions(rc, ['moths', ' moths ', '', 3, 'paper\nmoths'])).toEqual([
      'moths',
      'paper moths',
    ])
    expect(
      toSuggestions(
        rc,
        Array.from({ length: 30 }, (_, i) => `s${i}`),
      ),
    ).toHaveLength(20)
    expect(bad(() => toSuggestions(rc, 'moths'))).toBe(true)
  })

  it('turn candidates into audio candidates of the plugin, playable in the mode', () => {
    const candidates = toCandidates(music, [
      { id: 'c1', title: 'Song', artists: ['Band'], durationMs: 200_000, confidence: 1.4 },
      { id: 'c2', title: 'Video', artists: ['Band'], kind: 'music-video', confidence: 0.9 },
      { id: 'c3', title: 'Other', confidence: -1, evidence: ['title 0.4', 7] },
      { title: 'no id' },
    ])
    expect(candidates).toEqual([
      {
        source: 'plugin.example',
        ref: 'c1',
        kind: 'song',
        title: 'Song',
        artists: ['Band'],
        durationMs: 200_000,
        confidence: 1,
        evidence: ['plugin example'],
      },
      {
        source: 'plugin.example',
        ref: 'c3',
        kind: 'song',
        title: 'Other',
        artists: [],
        confidence: 0,
        evidence: ['plugin example', 'title 0.4'],
      },
    ])
    expect(bad(() => toCandidates(rc, {}))).toBe(true)
  })

  it('turn streams into unverified progressive options on declared hosts, best first', () => {
    const streams = toStreams(rc, [
      { url: 'https://cdn.example.org/a.mp3', codec: 'mp3', container: 'mp3', bitrateKbps: 128 },
      {
        url: 'https://cdn.example.org/a.flac',
        codec: 'flac',
        container: 'flac',
        sampleRateHz: 44_100,
        bitDepth: 16,
        expiresAt: 1_800_000_000_000,
        ipBound: true,
        downloadAllowed: false,
      },
      { url: 'https://elsewhere.example.net/a.mp3', codec: 'mp3', container: 'mp3' },
      { url: 'https://cdn.example.org/a.m3u8', codec: 'aac', container: 'mp4', protocol: 'hls' },
      { url: 'https://cdn.example.org/a.wma', codec: 'wma', container: 'asf' },
      { url: 'https://cdn.example.org/capped.mp3', codec: 'mp3', container: 'mp3', capped: true },
    ])
    expect(streams).toEqual([
      {
        url: 'https://cdn.example.org/a.flac',
        codec: 'flac',
        container: 'flac',
        media: 'audio',
        sampleRateHz: 44_100,
        bitDepth: 16,
        tier: 'lossless',
        protocol: 'progressive',
        expiresAt: 1_800_000_000_000,
        ipBound: true,
        fullLength: 'unverified',
        downloadAllowed: false,
      },
      {
        url: 'https://cdn.example.org/a.mp3',
        codec: 'mp3',
        container: 'mp3',
        media: 'audio',
        bitrateKbps: 128,
        tier: 'normal',
        protocol: 'progressive',
        ipBound: false,
        fullLength: 'unverified',
      },
      expect.objectContaining({ url: 'https://cdn.example.org/capped.mp3', fullLength: 'capped' }),
    ])
    expect(streams.every((stream) => stream.requestHeaders === undefined)).toBe(true)
    expect(bad(() => toStreams(rc, 'x'))).toBe(true)
  })
})
