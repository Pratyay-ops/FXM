import { type EntityId, FxmError, isFxmError } from '@fxm/core'
import { describe, expect, it } from 'vitest'
import { isImportInputError } from './errors'
import type { ImportSpotify } from './load'
import { loadLinkImport, loadSpotifyImport, loadYouTubeImport, rowFromTrack } from './load'
import { fakeSpotify, fakeYouTube, song, spotifyTrack, testContext } from './testing'

const noWait = async () => {}

describe('loadSpotifyImport', () => {
  it('reads a playlist page by page, a second apart, with every track’s metadata', async () => {
    const tracks = Array.from({ length: 120 }, (_, index) =>
      spotifyTrack(index + 1, `Song ${index + 1}`, 'Band', { seconds: 200 }),
    )
    const spotify = fakeSpotify({
      playlists: {
        'spotify:playlist:37i9dQZF1DXcBWIGoYBM5M': { name: 'Big one', description: 'Lots', tracks },
      },
    })
    const waits: number[] = []
    const progress: number[] = []
    const parsed = await loadSpotifyImport(
      spotify,
      'spotify:playlist:37i9dQZF1DXcBWIGoYBM5M' as EntityId<'playlist'>,
      testContext(),
      {
        sleep: async (ms) => {
          waits.push(ms)
        },
        onProgress: (rows) => progress.push(rows),
      },
    )
    expect(spotify.calls).toEqual([
      'playlist spotify:playlist:37i9dQZF1DXcBWIGoYBM5M',
      'playlist spotify:playlist:37i9dQZF1DXcBWIGoYBM5M 50',
    ])
    expect(waits).toEqual([1000])
    expect(progress).toEqual([50, 120])
    expect(parsed.kind).toBe('spotify')
    expect(parsed.label).toBe('Big one')
    expect(parsed.collections[0]).toMatchObject({ name: 'Big one', description: 'Lots' })
    expect(parsed.collections[0]?.rows).toHaveLength(120)
    expect(parsed.collections[0]?.rows[0]).toEqual(rowFromTrack(tracks[0] as never))
    expect(parsed.collections[0]?.rows[0]?.track?.artwork).toHaveLength(1)
  })

  it('reads an album with all its tracks, and a track as a playlist of one', async () => {
    const tracks = [spotifyTrack(1, 'One', 'Band'), spotifyTrack(2, 'Two', 'Band')]
    const spotify = {
      ...fakeSpotify({ tracks }),
      getAlbum: async () => ({
        id: 'spotify:album:4aawyAB9vmqN3uQ7FjRGTy',
        source: 'spotify',
        name: 'The Album',
        artists: [{ name: 'Band' }],
        artwork: [],
        tracks,
      }),
    } as unknown as ImportSpotify
    const album = await loadSpotifyImport(
      spotify,
      'spotify:album:4aawyAB9vmqN3uQ7FjRGTy' as EntityId<'album'>,
      testContext(),
    )
    expect(album.collections[0]).toMatchObject({ name: 'The Album', description: 'Album by Band' })
    expect(album.collections[0]?.rows.map((row) => row.title)).toEqual(['One', 'Two'])
    const track = await loadSpotifyImport(
      spotify,
      tracks[0]?.id as EntityId<'track'>,
      testContext(),
    )
    expect(track.collections[0]?.name).toBe('One')
    expect(track.collections[0]?.rows).toHaveLength(1)
  })

  it('goes on after a page the mode filtered empty, until the cursors end', async () => {
    const songs = Array.from({ length: 70 }, (_, index) =>
      spotifyTrack(index + 1, `Song ${index + 1}`, 'Band', { seconds: 200 }),
    )
    const episodes = Array.from({ length: 100 }, (_, index) => ({
      ...spotifyTrack(500 + index, `Episode ${index + 1}`, 'Show'),
      kind: 'episode' as const,
    }))
    // 50 songs, 100 podcast episodes, 20 songs: the provider drops the episodes from its pages.
    const all = [...songs.slice(0, 50), ...episodes, ...songs.slice(50)]
    const fake = fakeSpotify({
      playlists: { 'spotify:playlist:37i9dQZF1DXcBWIGoYBM5M': { name: 'Mixed', tracks: all } },
    })
    const spotify = {
      ...fake,
      getPlaylistTracks: async (...args: Parameters<ImportSpotify['getPlaylistTracks']>) => {
        const page = await fake.getPlaylistTracks(...args)
        return { ...page, items: page.items.filter((track) => track.kind !== 'episode') }
      },
    } as unknown as ImportSpotify
    const parsed = await loadSpotifyImport(
      spotify,
      'spotify:playlist:37i9dQZF1DXcBWIGoYBM5M' as EntityId<'playlist'>,
      testContext(),
      { sleep: noWait },
    )
    expect(parsed.collections[0]?.rows).toHaveLength(70)
    expect(fake.calls.at(-1)).toBe('playlist spotify:playlist:37i9dQZF1DXcBWIGoYBM5M 150')
  })

  it('passes the provider’s errors on, and refuses an empty playlist', async () => {
    const spotify = fakeSpotify({
      failWith: new FxmError('Unsupported', 'unreachable'),
    })
    await expect(
      loadSpotifyImport(
        spotify,
        'spotify:playlist:37i9dQZF1DXcBWIGoYBM5M' as EntityId<'playlist'>,
        testContext(),
      ),
    ).rejects.toSatisfy((error) => isFxmError(error, 'Unsupported'))
    const empty = fakeSpotify({
      playlists: { 'spotify:playlist:37i9dQZF1DXcBWIGoYBM5M': { name: 'E', tracks: [] } },
    })
    await expect(
      loadSpotifyImport(
        empty,
        'spotify:playlist:37i9dQZF1DXcBWIGoYBM5M' as EntityId<'playlist'>,
        testContext(),
      ),
    ).rejects.toSatisfy((error) => isImportInputError(error, 'no-tracks'))
  })
})

describe('loadYouTubeImport', () => {
  it('reads every item whatever the mode, and leaves podcast episodes out', async () => {
    const items = [
      song('songsongson', 'A Song', 'Band'),
      song('videovideov', 'A Video', 'Band', { kind: 'video', source: 'yt' }),
      song('episodexxxx', 'An Episode', 'Show', { kind: 'episode' }),
      song('songsongson', 'A Song', 'Band'),
    ]
    const youtube = fakeYouTube({
      playlists: { 'ytm:playlist:PLabcdefgh': { name: 'Mixed', tracks: items } },
      pageSize: 2,
    })
    const parsed = await loadYouTubeImport(
      youtube,
      'ytm:playlist:PLabcdefgh' as EntityId<'playlist'>,
      testContext('music'),
      { sleep: noWait },
    )
    expect(youtube.requests).toEqual([
      'playlist ytm:playlist:PLabcdefgh',
      'playlist ytm:playlist:PLabcdefgh 2',
    ])
    expect(parsed.collections[0]?.rows.map((row) => [row.title, row.kind])).toEqual([
      ['A Song', 'song'],
      ['A Video', 'video'],
    ])
    expect(parsed.skipped).toMatchObject({ episodes: 1, duplicates: 1 })
  })
})

describe('loadLinkImport', () => {
  it('sends each link to its source, and refuses Spotify links while Spotify is off', async () => {
    const youtube = fakeYouTube({
      playlists: { 'yt:playlist:PLx1': { name: 'Y', tracks: [song('aaaaaaaaaaa', 'A', 'B')] } },
    })
    const parsed = await loadLinkImport(
      { source: 'youtube', id: 'yt:playlist:PLx1' as EntityId<'playlist'> },
      { youtube },
      testContext(),
    )
    expect(parsed.kind).toBe('youtube')
    await expect(
      loadLinkImport(
        { source: 'spotify', id: 'spotify:track:70LcF31zb1H0PyJoS1Sx1r' as EntityId<'track'> },
        { youtube },
        testContext(),
      ),
    ).rejects.toSatisfy((error) => isFxmError(error, 'Unsupported'))
  })
})
