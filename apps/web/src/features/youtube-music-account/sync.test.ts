import { formatId } from '@fxm/core'
import { describe, expect, it } from 'vitest'
import { testRepo, track } from '../../test/library-fixtures'
import {
  accountKeyOf,
  likedCopyId,
  playlistCopyId,
  songsCopyId,
} from './ids'
import { runYouTubeMusicSync } from './sync'
import type {
  YouTubeMusicAlbum,
  YouTubeMusicArtist,
  YouTubeMusicLibrarySnapshot,
  YouTubeMusicPlaylist,
  YouTubeMusicTrack,
} from './types'

function remoteTrack(n: number): YouTubeMusicTrack {
  return {
    videoId: `video${String(n).padStart(4, '0')}`,
    title: `Song ${n}`,
    artists: [{ name: `Artist ${n}`, channelId: `UC-artist-${n}` }],
    artwork: [],
    durationSeconds: 180,
  }
}

function snapshot(
  accountId = 'UC-test-account',
  overrides: Partial<YouTubeMusicLibrarySnapshot> = {},
): YouTubeMusicLibrarySnapshot {
  const albums: YouTubeMusicAlbum[] = [
    {
      browseId: 'MPREb_album_1',
      title: 'Album 1',
      artists: [{ name: 'Artist 1', channelId: 'UC-artist-1' }],
      artwork: [],
      year: '2024',
    },
  ]
  const artists: YouTubeMusicArtist[] = [
    { channelId: 'UC-artist-1', name: 'Artist 1', artwork: [] },
  ]
  const playlists: YouTubeMusicPlaylist[] = [
    {
      playlistId: 'PL-user-1',
      title: 'Remote playlist',
      description: 'Made in YouTube Music',
      owner: 'Test user',
      artwork: [],
      tracks: [remoteTrack(2), remoteTrack(3)],
    },
  ]
  return {
    accountId,
    displayName: 'Test user',
    likedSongs: [remoteTrack(1), remoteTrack(2)],
    songs: [remoteTrack(1), remoteTrack(2)],
    playlists,
    albums,
    artists,
    truncated: {
      likedSongs: false,
      songs: false,
      playlists: false,
      albums: false,
      artists: false,
      playlistTracks: 0,
    },
    ...overrides,
  }
}

async function titles(
  repo: ReturnType<typeof testRepo>,
  id: Awaited<ReturnType<typeof playlistCopyId>> | ReturnType<typeof likedCopyId>,
): Promise<string[]> {
  const view = await repo.getPlaylistView(id)
  return view?.rows.map((row) => row.track?.title ?? row.id) ?? []
}

describe('YouTube Music library sync', () => {
  it('copies Music likes, library songs, playlists, saved albums and artists locally', async () => {
    const repo = testRepo()
    const result = await runYouTubeMusicSync(snapshot(), repo)
    const key = await accountKeyOf('UC-test-account')
    const liked = likedCopyId(key)
    const songs = songsCopyId(key)
    const remotePlaylist = await playlistCopyId(key, 'PL-user-1')

    expect(result).toMatchObject({
      displayName: 'Test user',
      likedAdded: 2,
      songsAdded: 2,
      playlistsCreated: 1,
      playlistTracksAdded: 2,
      albumsFollowed: 1,
      artistsFollowed: 1,
      truncated: false,
    })
    expect(await titles(repo, liked)).toEqual(['Song 1', 'Song 2'])
    expect(await titles(repo, songs)).toEqual(['Song 1', 'Song 2'])
    const view = await repo.getPlaylistView(remotePlaylist)
    expect(view?.playlist).toMatchObject({
      name: 'Remote playlist',
      description: 'Made in YouTube Music',
      artwork: [],
    })
    expect(await titles(repo, remotePlaylist)).toEqual(['Song 2', 'Song 3'])
    expect(await repo.isFollowing(formatId('ytm', 'album', 'MPREb_album_1'))).toBe(true)
    expect(await repo.isFollowing(formatId('ytm', 'artist', 'UC-artist-1'))).toBe(true)
    // YouTube Music likes are not copied into FXM's own Liked songs.
    expect((await repo.getPlaylistView(formatId('local', 'playlist', 'liked')))?.rows).toEqual([])
  })

  it('is idempotent when the same account is synced again', async () => {
    const repo = testRepo()
    const first = await runYouTubeMusicSync(snapshot(), repo)
    const second = await runYouTubeMusicSync(snapshot(), repo)
    expect(second).toMatchObject({
      accountKey: first.accountKey,
      likedAdded: 0,
      songsAdded: 0,
      playlistsCreated: 0,
      playlistTracksAdded: 0,
      albumsFollowed: 0,
      artistsFollowed: 0,
    })
  })

  it('adds new upstream tracks but preserves local removals, names and custom tracks', async () => {
    const repo = testRepo()
    await runYouTubeMusicSync(snapshot(), repo)
    const key = await accountKeyOf('UC-test-account')
    const remotePlaylist = await playlistCopyId(key, 'PL-user-1')
    await repo.removeTracks(remotePlaylist, [formatId('ytm', 'track', 'video0002')])
    await repo.updatePlaylist(remotePlaylist, { name: 'My renamed copy' })
    await repo.addTracks(remotePlaylist, [track(99)])

    const updated = snapshot('UC-test-account', {
      playlists: [
        {
          playlistId: 'PL-user-1',
          title: 'Upstream renamed playlist',
          artwork: [],
          tracks: [remoteTrack(2), remoteTrack(3), remoteTrack(4)],
        },
      ],
    })
    const result = await runYouTubeMusicSync(updated, repo)
    const view = await repo.getPlaylistView(remotePlaylist)
    expect(result.playlistTracksAdded).toBe(1)
    expect(view?.playlist.name).toBe('My renamed copy')
    expect(await titles(repo, remotePlaylist)).toEqual(['Song 3', 'Song 99', 'Song 4'])
  })

  it('does not recreate a local playlist the user deleted', async () => {
    const repo = testRepo()
    await runYouTubeMusicSync(snapshot(), repo)
    const key = await accountKeyOf('UC-test-account')
    const remotePlaylist = await playlistCopyId(key, 'PL-user-1')
    await repo.deletePlaylist(remotePlaylist)
    await runYouTubeMusicSync(snapshot(), repo)
    expect(await repo.getPlaylistView(remotePlaylist)).toBeUndefined()
  })

  it('keeps two Google accounts in separate local copies', async () => {
    const repo = testRepo()
    await runYouTubeMusicSync(snapshot('UC-first'), repo)
    await runYouTubeMusicSync(snapshot('UC-second'), repo)
    const firstKey = await accountKeyOf('UC-first')
    const secondKey = await accountKeyOf('UC-second')
    expect(likedCopyId(firstKey)).not.toBe(likedCopyId(secondKey))
    expect(await repo.getPlaylistView(likedCopyId(firstKey))).toBeDefined()
    expect(await repo.getPlaylistView(likedCopyId(secondKey))).toBeDefined()
  })

  it('reports truncation without treating a partial list as empty', async () => {
    const repo = testRepo()
    const result = await runYouTubeMusicSync(
      snapshot('UC-truncated', {
        truncated: {
          likedSongs: true,
          songs: false,
          playlists: false,
          albums: false,
          artists: false,
          playlistTracks: 1,
        },
      }),
      repo,
    )
    expect(result.truncated).toBe(true)
    expect(await titles(repo, likedCopyId(await accountKeyOf('UC-truncated')))).toEqual([
      'Song 1',
      'Song 2',
    ])
  })
})
