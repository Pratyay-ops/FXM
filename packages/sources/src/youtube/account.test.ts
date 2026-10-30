import { describe, expect, it } from 'vitest'
import { readYouTubeMusicAccount } from './account'

function libraryPage(items: unknown[] = []) {
  return {
    filters: ['Songs', 'Playlists', 'Albums', 'Artists'],
    contents: [{ contents: items }],
    has_continuation: false,
    async applyFilter(filter: string) {
      return pages[filter] ?? libraryPage()
    },
    async getContinuation() {
      return { contents: { contents: [] }, has_continuation: false, async getContinuation() { return this } }
    },
  }
}

const artistId = 'UC' + 'A'.repeat(22)
const track = {
  item_type: 'song',
  id: 'dQw4w9WgXcQ',
  title: 'Creep',
  artists: [{ name: 'Radiohead', channel_id: artistId }],
  album: { id: 'MPREb_album', name: 'Pablo Honey' },
  duration: { seconds: 238 },
  thumbnail: { contents: [{ url: 'https://example.com/cover.jpg', width: 500, height: 500 }] },
}
const pages: Record<string, ReturnType<typeof libraryPage>> = {
  Songs: libraryPage([track]),
  Playlists: libraryPage([{
    item_type: 'playlist',
    id: 'VLPLabc123',
    title: 'Road trip',
    item_count: '12 songs',
  }]),
  Albums: libraryPage([{
    item_type: 'album',
    id: 'MPREb_album',
    title: 'Pablo Honey',
    artists: [{ name: 'Radiohead', channel_id: artistId }],
  }]),
  Artists: libraryPage([{
    item_type: 'artist',
    id: artistId,
    title: 'Radiohead',
  }]),
}

describe('readYouTubeMusicAccount', () => {
  it('normalizes liked music, saved songs, playlists, albums and followed artists', async () => {
    const snapshot = await readYouTubeMusicAccount('cookie=value-that-is-long-enough', {
      createClient: async () => ({
        music: {
          getLibrary: async () => libraryPage(),
          getPlaylist: async (id: string) => {
            expect(id).toBe('LM')
            return {
              items: [track],
              has_continuation: false,
              async getContinuation() { return this },
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
      artists: [{ id: 'ytm:artist:' + artistId, name: 'Radiohead' }],
    })
    expect(snapshot.savedTracks).toHaveLength(1)
    expect(snapshot.playlists[0]?.playlist.id).toBe('ytm:playlist:PLabc123')
    expect(snapshot.savedAlbums[0]?.name).toBe('Pablo Honey')
    expect(snapshot.followedArtists[0]?.name).toBe('Radiohead')
  })

  it('refuses an absent cookie rather than returning an empty library', async () => {
    await expect(readYouTubeMusicAccount('')).rejects.toThrow('login is unavailable')
  })

  it('fails closed when the library response has no readable account shape', async () => {
    await expect(readYouTubeMusicAccount('cookie=value-that-is-long-enough', {
      createClient: async () => ({
        music: {
          getLibrary: async () => ({
            filters: [],
            contents: [],
            has_continuation: false,
            async applyFilter() { return this },
            async getContinuation() { return this },
          }),
          getPlaylist: async () => ({
            items: [],
            has_continuation: false,
            async getContinuation() { return this },
          }),
        },
      }),
    })).rejects.toThrow('did not return a readable account library')
  })
})
