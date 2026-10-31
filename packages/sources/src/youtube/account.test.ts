import { describe, expect, it } from 'vitest'
import {
  type MusicLibraryContinuation,
  type MusicLibraryPage,
  type MusicPlaylistPage,
  readYouTubeMusicAccount,
} from './account'

function libraryContinuation(): MusicLibraryContinuation {
  return {
    contents: { contents: [] },
    has_continuation: false,
    async getContinuation() {
      return libraryContinuation()
    },
  }
}

function libraryPage(items: unknown[] = []): MusicLibraryPage {
  return {
    filters: ['Songs', 'Playlists', 'Albums', 'Artists'],
    contents: [{ contents: items }],
    has_continuation: false,
    async applyFilter(filter: string) {
      return pages[filter] ?? libraryPage()
    },
    async getContinuation() {
      return libraryContinuation()
    },
  }
}

function emptyLibraryPage(): MusicLibraryPage {
  return {
    filters: [],
    contents: [],
    has_continuation: false,
    async applyFilter() {
      return libraryPage()
    },
    async getContinuation() {
      return libraryContinuation()
    },
  }
}

const artistId = `UC${'A'.repeat(22)}`
const track = {
  item_type: 'song',
  id: 'dQw4w9WgXcQ',
  title: 'Creep',
  artists: [{ name: 'Radiohead', channel_id: artistId }],
  album: { id: 'MPREb_album', name: 'Pablo Honey' },
  duration: { seconds: 238 },
  thumbnail: { contents: [{ url: 'https://example.com/cover.jpg', width: 500, height: 500 }] },
}
const pages: Record<string, MusicLibraryPage> = {
  Songs: libraryPage([track]),
  Playlists: libraryPage([
    {
      item_type: 'playlist',
      id: 'VLPLabc123',
      title: 'Road trip',
      item_count: '12 songs',
    },
  ]),
  Albums: libraryPage([
    {
      item_type: 'album',
      id: 'FEmusic_library_privately_owned_release_private-album',
      title: 'Pablo Honey',
      artists: [{ name: 'Radiohead', channel_id: artistId }],
    },
  ]),
  Artists: libraryPage([
    {
      item_type: 'library_artist',
      endpoint: { payload: { browseId: 'FEmusic_library_privately_owned_artist_private-artist' } },
      title: 'Radiohead',
    },
  ]),
}

describe('readYouTubeMusicAccount', () => {
  it('normalizes liked music, playlists, albums and followed artists', async () => {
    const snapshot = await readYouTubeMusicAccount('cookie=value-that-is-long-enough', {
      createClient: async () => ({
        music: {
          getLibrary: async () => libraryPage(),
          getPlaylist: async (id: string) => {
            expect(id).toBe('LM')
            return {
              items: [track],
              has_continuation: false,
              async getContinuation() {
                return this
              },
            }
          },
        },
      }),
    })

    expect(snapshot.likedTracks).toHaveLength(1)
    expect(snapshot.likedTracks[0]).toMatchObject({
      id: 'ytm:track:dQw4w9WgXcQ',
      source: 'ytm',
      title: 'Creep',
      kind: 'song',
      durationMs: 238_000,
      album: { id: 'ytm:album:MPREb_album', name: 'Pablo Honey' },
      artists: [{ id: `ytm:artist:${artistId}`, name: 'Radiohead' }],
    })
    expect(snapshot.playlists[0]?.playlist.id).toBe('ytm:playlist:PLabc123')
    expect(snapshot.savedAlbums[0]).toMatchObject({
      id: 'ytm:album:FEmusic_library_privately_owned_release_private-album',
      name: 'Pablo Honey',
    })
    expect(snapshot.followedArtists[0]).toMatchObject({
      id: 'ytm:artist:FEmusic_library_privately_owned_artist_private-artist',
      name: 'Radiohead',
    })
  })

  it('refuses an absent cookie rather than returning an empty library', async () => {
    await expect(readYouTubeMusicAccount('')).rejects.toThrow('login is unavailable')
  })

  it('fails closed when the library response has no readable account shape', async () => {
    await expect(
      readYouTubeMusicAccount('cookie=value-that-is-long-enough', {
        createClient: async () => ({
          music: {
            getLibrary: async () => emptyLibraryPage(),
            getPlaylist: async () => ({
              items: [],
              has_continuation: false,
              async getContinuation(): Promise<MusicPlaylistPage> {
                return this
              },
            }),
          },
        }),
      }),
    ).rejects.toThrow('did not return a readable account library')
  })
})
