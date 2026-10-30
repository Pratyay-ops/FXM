import { describe, expect, it } from 'vitest'
import { formatId, type Album, type Artist, type Track } from '@fxm/core'
import {
  parseYouTubeMusicSnapshot,
  runYouTubeMusicSync,
  type YouTubeMusicSyncLibrary,
} from './sync'
import type { YouTubeMusicAccountSnapshot } from '@fxm/sources/youtube/account'

const account = '0123456789abcdef01234567'
const artistId = formatId('ytm', 'artist', 'UC' + 'A'.repeat(22))
const track = (id: string, title = id): Track => ({
  id: formatId('ytm', 'track', id.padEnd(11, 'x').slice(0, 11)),
  source: 'ytm',
  title,
  artists: [{ id: artistId, name: 'Artist' }],
  artwork: [],
  kind: 'song',
})
const album: Album = {
  id: formatId('ytm', 'album', 'MPREb_album'),
  source: 'ytm',
  name: 'Album',
  artists: [{ id: artistId, name: 'Artist' }],
  artwork: [],
}
const artist: Artist = {
  id: artistId,
  source: 'ytm',
  name: 'Artist',
  artwork: [],
}
const playlistId = formatId('ytm', 'playlist', 'PLabc123')
const snapshot = (
  liked: Track[] = [track('liked-00001')],
  saved: Track[] = [],
  playlistTracks: Track[] = [track('playlist001')],
): YouTubeMusicAccountSnapshot & { account: string } => ({
  account,
  likedTracks: liked,
  savedTracks: saved,
  playlists: [{
    playlist: { id: playlistId, source: 'ytm', name: 'Road trip', artwork: [] },
    tracks: playlistTracks,
  }],
  savedAlbums: [album],
  followedArtists: [artist],
})

function fakeLibrary(): YouTubeMusicSyncLibrary & {
  playlists: Map<string, { name: string; tracks: Track[] }>
  follows: Set<string>
  settings: Map<string, unknown>
} {
  const playlists = new Map<string, { name: string; tracks: Track[] }>()
  const follows = new Set<string>()
  const settings = new Map<string, unknown>()
  return {
    playlists,
    follows,
    settings,
    async getPlaylistList() {
      return { items: [...playlists].map(([id, value]) => ({
        id, origin: 'local' as const, name: value.name, artwork: [], addedAt: 0, updatedAt: 0,
      })) }
    },
    async createPlaylist(input) {
      const id = String(input.id)
      if (playlists.has(id)) throw new Error('duplicate playlist')
      playlists.set(id, { name: input.name, tracks: [...(input.tracks ?? [])] })
      return input.id as never
    },
    async addTracks(id, tracks) {
      const list = playlists.get(String(id))
      if (!list) throw new Error('playlist missing')
      let added = 0
      for (const item of tracks) {
        if (list.tracks.some((known) => known.id === item.id)) continue
        list.tracks.push(item)
        added += 1
      }
      return { added, skipped: tracks.length - added }
    },
    async isFollowing(id) {
      return follows.has(String(id))
    },
    async follow(entity: Album | Artist) {
      follows.add(entity.id)
    },
    async getSetting(key) {
      return settings.get(key) as never
    },
    async putSettings(values) {
      for (const [key, value] of Object.entries(values)) {
        if (value === undefined) settings.delete(key)
        else settings.set(key, value)
      }
    },
    // Only the sync path uses getPlaylistList/createPlaylist/addTracks and settings/follows.
    async getPlaylistView(id) {
      const list = playlists.get(String(id))
      if (!list) return undefined
      return { playlist: { id, trackIds: list.tracks.map((item) => item.id) } as never, rows: [] }
    },
  }
}

describe('runYouTubeMusicSync', () => {
  it('creates separate liked, saved-song and user playlist copies and follows albums/artists', async () => {
    const library = fakeLibrary()
    const result = await runYouTubeMusicSync(library, snapshot())
    expect(result.createdPlaylists).toBe(2)
    expect(result.addedTracks).toBe(2)
    expect(result.addedFollows).toBe(2)
    expect([...library.playlists.values()].map((list) => list.name)).toEqual([
      'Liked songs on YouTube Music',
      'Road trip',
    ])
    expect(library.follows).toEqual(new Set([album.id, artist.id]))
  })

  it('is idempotent and only appends newly saved tracks', async () => {
    const library = fakeLibrary()
    await runYouTubeMusicSync(library, snapshot())
    const before = [...library.playlists.values()].map((list) => list.tracks.length)
    const next = snapshot(
      [track('liked-00001'), track('liked-00002')],
      [],
      [track('playlist001'), track('playlist002')],
    )
    const result = await runYouTubeMusicSync(library, next)
    expect(result.createdPlaylists).toBe(0)
    expect(result.addedTracks).toBe(2)
    expect([...library.playlists.values()].map((list) => list.tracks.length)).toEqual(
      before.map((length) => length + 1),
    )
    await runYouTubeMusicSync(library, next)
    expect([...library.playlists.values()].map((list) => list.tracks.length)).toEqual([2, 2])
  })

  it('does not re-add a remote track that the user removed from its local copy', async () => {
    const library = fakeLibrary()
    await runYouTubeMusicSync(library, snapshot())
    const liked = [...library.playlists.entries()].find(([, value]) => value.name === 'Liked songs on YouTube Music')
    expect(liked).toBeDefined()
    liked?.[1].tracks.splice(0, 1)
    await runYouTubeMusicSync(library, snapshot())
    expect(liked?.[1].tracks).toHaveLength(0)
  })

  it('does not recreate a local playlist after the user deleted it', async () => {
    const library = fakeLibrary()
    await runYouTubeMusicSync(library, snapshot())
    const playlist = [...library.playlists.entries()].find(([, value]) => value.name === 'Road trip')
    expect(playlist).toBeDefined()
    library.playlists.delete(playlist?.[0] ?? '')
    await runYouTubeMusicSync(library, snapshot())
    expect([...library.playlists.values()].some((value) => value.name === 'Road trip')).toBe(false)
  })

  it('rejects a malformed account fingerprint before writing', async () => {
    const library = fakeLibrary()
    await expect(runYouTubeMusicSync(library, { ...snapshot(), account: 'bad' }))
      .rejects.toThrow('valid account fingerprint')
    expect(library.playlists.size).toBe(0)
  })
})


describe('parseYouTubeMusicSnapshot', () => {
  it('accepts the supported, normalized library shape', () => {
    expect(parseYouTubeMusicSnapshot(snapshot())).toMatchObject({
      account,
      likedTracks: [{ title: 'liked-00001' }],
      playlists: [{ playlist: { name: 'Road trip' } }],
      savedAlbums: [{ name: 'Album' }],
      followedArtists: [{ name: 'Artist' }],
    })
  })

  it('rejects malformed playlist and entity entries before any local write', () => {
    const valid = snapshot()
    expect(parseYouTubeMusicSnapshot({
      ...valid,
      playlists: [{ playlist: { id: 'ytm:playlist:PLabc123' }, tracks: 'not-a-list' }],
    })).toBeUndefined()
    expect(parseYouTubeMusicSnapshot({
      ...valid,
      savedAlbums: [{ id: 'ytm:track:bad', name: 'Not an album' }],
    })).toBeUndefined()
    expect(parseYouTubeMusicSnapshot({
      ...valid,
      followedArtists: [{ id: 'ytm:artist:abc', source: 'ytm', name: 'Artist' }],
    })).toBeUndefined()
  })
})
