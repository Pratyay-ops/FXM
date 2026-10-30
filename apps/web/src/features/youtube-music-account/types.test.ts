import { describe, expect, it } from 'vitest'
import { parseYouTubeMusicSnapshot } from './types'

const empty = {
  accountId: 'UC-test',
  likedSongs: [],
  songs: [],
  playlists: [],
  albums: [],
  artists: [],
  truncated: {
    likedSongs: false,
    songs: false,
    playlists: false,
    albums: false,
    artists: false,
    playlistTracks: 0,
  },
}

describe('parseYouTubeMusicSnapshot', () => {
  it('accepts a complete empty music library', () => {
    expect(parseYouTubeMusicSnapshot(empty)).toMatchObject({
      accountId: 'UC-test',
      likedSongs: [],
      songs: [],
      playlists: [],
    })
  })

  it('validates tracks and account identity before the sync can write anything', () => {
    expect(() => parseYouTubeMusicSnapshot({ ...empty, accountId: '' })).toThrow(/incomplete/)
    expect(() =>
      parseYouTubeMusicSnapshot({
        ...empty,
        likedSongs: [{ videoId: 'x', title: 'Song', artists: [], artwork: [] }],
      }),
    ).not.toThrow()
    expect(() =>
      parseYouTubeMusicSnapshot({
        ...empty,
        likedSongs: [{ videoId: 'x', title: '', artists: [], artwork: [] }],
      }),
    ).toThrow(/incomplete/)
  })

  it('rejects unbounded or malformed playlists rather than importing an incomplete copy', () => {
    expect(() =>
      parseYouTubeMusicSnapshot({
        ...empty,
        playlists: [
          {
            playlistId: 'PL1',
            title: 'Playlist',
            artwork: [],
            tracks: [{ videoId: '', title: '', artists: [], artwork: [] }],
          },
        ],
      }),
    ).toThrow(/incomplete/)
  })
})
