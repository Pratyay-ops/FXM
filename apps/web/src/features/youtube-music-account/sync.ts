/**
 * Read-only, additive synchronization of a YouTube Music library into FXM's local library.
 *
 * Every remote list gets a stable local copy. New upstream tracks are added, but upstream
 * removals never delete local tracks, local names/order/edits are never overwritten, and a
 * playlist the user deleted in FXM is never recreated. FXM's own Liked songs stays separate.
 *
 * @module
 */

import {
  type Album,
  type Artist,
  type Artwork,
  type EntityId,
  formatId,
  type JsonValue,
  type Track,
} from '@fxm/core'
import type { LibraryRepo } from '../../db/repo'
import {
  accountKeyOf,
  likedCopyId,
  playlistCopyId,
  songsCopyId,
  stateKey,
} from './ids'
import type {
  YouTubeMusicAlbum,
  YouTubeMusicArtist,
  YouTubeMusicLibrarySnapshot,
  YouTubeMusicPlaylist,
  YouTubeMusicTrack,
} from './types'

const MAX_KNOWN_TRACKS = 20_000
const MAX_FOLLOWED_ENTITIES = 2_000

interface CopyState {
  readonly localId: string
  /** Union of remote tracks observed by a successful sync. */
  readonly knownTrackIds: readonly string[]
  readonly dismissed?: true
}

interface YouTubeMusicSyncState {
  readonly version: 1
  readonly accountKey: string
  readonly liked?: CopyState
  readonly songs?: CopyState
  readonly playlists: Readonly<Record<string, CopyState>>
  readonly albums: readonly string[]
  readonly artists: readonly string[]
  readonly lastSyncedAt?: number
}

export interface YouTubeMusicSyncResult {
  readonly accountKey: string
  readonly displayName?: string
  readonly likedAdded: number
  readonly songsAdded: number
  readonly playlistsCreated: number
  readonly playlistTracksAdded: number
  readonly albumsFollowed: number
  readonly artistsFollowed: number
  readonly truncated: boolean
  readonly lastSyncedAt: number
}

type SyncLibrary = Pick<
  LibraryRepo,
  | 'getPlaylistView'
  | 'createPlaylist'
  | 'addTracks'
  | 'follow'
  | 'isFollowing'
  | 'getSetting'
  | 'putSettings'
>

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function cleanStrings(value: unknown): string[] | undefined {
  if (
    !Array.isArray(value) ||
    value.length > MAX_KNOWN_TRACKS ||
    !value.every((entry) => typeof entry === 'string' && entry.length > 0 && entry.length <= 256)
  ) {
    return undefined
  }
  return [...new Set(value as string[])]
}

function copyState(value: unknown): CopyState | undefined {
  const node = record(value)
  if (node === undefined || typeof node.localId !== 'string') return undefined
  const knownTrackIds = cleanStrings(node.knownTrackIds)
  if (knownTrackIds === undefined) return undefined
  return {
    localId: node.localId,
    knownTrackIds,
    ...(node.dismissed === true ? { dismissed: true } : {}),
  }
}

function readSyncState(value: unknown, accountKey: string): YouTubeMusicSyncState {
  const node = record(value)
  if (node?.version !== 1 || node.accountKey !== accountKey) {
    return { version: 1, accountKey, playlists: {}, albums: [], artists: [] }
  }
  const playlistsNode = record(node.playlists) ?? {}
  const playlists: Record<string, CopyState> = {}
  for (const [id, item] of Object.entries(playlistsNode)) {
    if (id.length <= 256) {
      const parsed = copyState(item)
      if (parsed !== undefined) playlists[id] = parsed
    }
  }
  const albums = cleanStrings(node.albums) ?? []
  const artists = cleanStrings(node.artists) ?? []
  const liked = copyState(node.liked)
  const songs = copyState(node.songs)
  const lastSyncedAt =
    typeof node.lastSyncedAt === 'number' &&
    Number.isSafeInteger(node.lastSyncedAt) &&
    node.lastSyncedAt >= 0
      ? node.lastSyncedAt
      : undefined
  return {
    version: 1,
    accountKey,
    playlists,
    albums,
    artists,
    ...(liked === undefined ? {} : { liked }),
    ...(songs === undefined ? {} : { songs }),
    ...(lastSyncedAt === undefined ? {} : { lastSyncedAt }),
  }
}

function trackFromYouTubeMusic(source: YouTubeMusicTrack): Track {
  const album = source.album
  const artists = source.artists.map((artist) => ({
    name: artist.name,
    ...(artist.channelId === undefined
      ? {}
      : { id: formatId('ytm', 'artist', artist.channelId) }),
  }))
  const artwork: Artwork[] = source.artwork.map((image) => ({
    url: image.url,
    ...(image.width === undefined ? {} : { width: image.width }),
    ...(image.height === undefined ? {} : { height: image.height }),
  }))
  return {
    id: formatId('ytm', 'track', source.videoId),
    source: 'ytm',
    title: source.title,
    artists,
    artwork,
    kind: 'song',
    ...(source.durationSeconds === undefined
      ? {}
      : { durationMs: Math.round(source.durationSeconds * 1000) }),
    ...(album === undefined
      ? {}
      : {
          album: {
            name: album.name,
            ...(album.id === undefined ? {} : { id: formatId('ytm', 'album', album.id) }),
          },
        }),
  }
}

function albumFromYouTubeMusic(source: YouTubeMusicAlbum): Album {
  return {
    id: formatId('ytm', 'album', source.browseId),
    source: 'ytm',
    name: source.title,
    artists: source.artists.map((artist) => ({
      name: artist.name,
      ...(artist.channelId === undefined
        ? {}
        : { id: formatId('ytm', 'artist', artist.channelId) }),
    })),
    artwork: source.artwork.map((image) => ({
      url: image.url,
      ...(image.width === undefined ? {} : { width: image.width }),
      ...(image.height === undefined ? {} : { height: image.height }),
    })),
    ...(source.year === undefined ? {} : { releaseDate: source.year }),
  }
}

function artistFromYouTubeMusic(source: YouTubeMusicArtist): Artist {
  return {
    id: formatId('ytm', 'artist', source.channelId),
    source: 'ytm',
    name: source.name,
    artwork: source.artwork.map((image) => ({
      url: image.url,
      ...(image.width === undefined ? {} : { width: image.width }),
      ...(image.height === undefined ? {} : { height: image.height }),
    })),
  }
}

function uniqueTracks(items: readonly YouTubeMusicTrack[]): YouTubeMusicTrack[] {
  const seen = new Set<string>()
  return items.filter((item) => {
    if (seen.has(item.videoId)) return false
    seen.add(item.videoId)
    return true
  })
}

function unionStrings(before: readonly string[], current: readonly string[]): string[] {
  return [...new Set([...before, ...current])].slice(0, MAX_KNOWN_TRACKS)
}

function currentTrackIds(tracks: readonly YouTubeMusicTrack[]): string[] {
  return uniqueTracks(tracks).map((item) => item.videoId)
}

function localTrackIds(view: Awaited<ReturnType<SyncLibrary['getPlaylistView']>>): Set<string> {
  return new Set((view?.rows ?? []).map((row) => row.id))
}

function isTruncated(snapshot: YouTubeMusicLibrarySnapshot): boolean {
  return (
    snapshot.truncated.likedSongs ||
    snapshot.truncated.songs ||
    snapshot.truncated.playlists ||
    snapshot.truncated.albums ||
    snapshot.truncated.artists ||
    snapshot.truncated.playlistTracks > 0
  )
}

async function syncCopy(options: {
  library: SyncLibrary
  previous: CopyState | undefined
  localId: EntityId<'playlist'>
  name: string
  description?: string
  artwork: readonly Artwork[]
  remoteTracks: readonly YouTubeMusicTrack[]
}): Promise<{ state: CopyState; created: boolean; added: number; dismissed: boolean }> {
  const {
    library,
    previous,
    localId,
    name,
    description,
    artwork,
    remoteTracks,
  } = options
  const view = await library.getPlaylistView(localId)
  if (view === undefined && previous !== undefined) {
    // The copy existed before but the user removed it. Remember that choice forever.
    return {
      state: { ...previous, dismissed: true },
      created: false,
      added: 0,
      dismissed: true,
    }
  }
  if (previous?.dismissed === true && view === undefined) {
    return { state: previous, created: false, added: 0, dismissed: true }
  }

  const unique = uniqueTracks(remoteTracks)
  const remoteIds = currentTrackIds(unique)
  if (view === undefined) {
    await library.createPlaylist({
      id: localId,
      name,
      ...(description === undefined ? {} : { description }),
      artwork,
      tracks: unique.map(trackFromYouTubeMusic),
      position: 'bottom',
    })
    return {
      state: { localId, knownTrackIds: remoteIds },
      created: true,
      added: unique.length,
      dismissed: false,
    }
  }

  const localIds = localTrackIds(view)
  const previousKnown = previous === undefined
    ? new Set(remoteIds.filter((id) => localIds.has(formatId('ytm', 'track', id))))
    : new Set(previous.knownTrackIds)
  const toAdd = unique.filter(
    (track) =>
      !previousKnown.has(track.videoId) &&
      !localIds.has(formatId('ytm', 'track', track.videoId)),
  )
  const result =
    toAdd.length === 0
      ? { added: 0, skipped: 0 }
      : await library.addTracks(localId, toAdd.map(trackFromYouTubeMusic))
  return {
    state: {
      localId,
      knownTrackIds: unionStrings([...previousKnown], remoteIds),
    },
    created: false,
    added: result.added,
    dismissed: false,
  }
}

/**
 * Imports a validated YouTube Music snapshot. This only writes local FXM data. It never sends
 * likes, follows, playlist edits or deletes back to YouTube Music.
 */
export async function runYouTubeMusicSync(
  snapshot: YouTubeMusicLibrarySnapshot,
  library: SyncLibrary,
  options: { now?: () => number } = {},
): Promise<YouTubeMusicSyncResult> {
  const now = options.now ?? Date.now
  const accountKey = await accountKeyOf(snapshot.accountId)
  const key = stateKey(accountKey)
  let state = readSyncState(await library.getSetting(key), accountKey)
  let likedAdded = 0
  let songsAdded = 0
  let playlistsCreated = 0
  let playlistTracksAdded = 0
  let albumsFollowed = 0
  let artistsFollowed = 0
  const likedId = likedCopyId(accountKey)
  const songsId = songsCopyId(accountKey)
  const nextPlaylists: Record<string, CopyState> = { ...state.playlists }

  const persist = async (next: YouTubeMusicSyncState) => {
    await library.putSettings({ [key]: next as unknown as JsonValue })
  }

  const liked = await syncCopy({
    library,
    previous: state.liked,
    localId: likedId,
    name: 'Liked songs on YouTube Music',
    artwork: [],
    remoteTracks: snapshot.likedSongs,
  })
  likedAdded = liked.added
  state = { ...state, liked: liked.state }
  await persist(state)

  const songs = await syncCopy({
    library,
    previous: state.songs,
    localId: songsId,
    name: 'Songs on YouTube Music',
    artwork: [],
    remoteTracks: snapshot.songs,
  })
  songsAdded = songs.added
  state = { ...state, songs: songs.state }
  await persist(state)

  for (const remote of snapshot.playlists) {
    const previous = state.playlists[remote.playlistId]
    const localId = await playlistCopyId(accountKey, remote.playlistId)
    const copied = await syncCopy({
      library,
      previous,
      localId,
      name: remote.title,
      ...(remote.description === undefined ? {} : { description: remote.description }),
      artwork: remote.artwork,
      remoteTracks: remote.tracks,
    })
    if (copied.created) playlistsCreated += 1
    playlistTracksAdded += copied.added
    nextPlaylists[remote.playlistId] = copied.state
    // Save each completed playlist, so closing the tab never loses earlier completed copies.
    state = { ...state, playlists: { ...nextPlaylists } }
    await persist(state)
  }

  let knownAlbums = new Set(state.albums)
  for (const remote of snapshot.albums) {
    const album = albumFromYouTubeMusic(remote)
    const nativeId = remote.browseId
    if (!knownAlbums.has(nativeId)) {
      if (!(await library.isFollowing(album.id))) {
        await library.follow(album)
        albumsFollowed += 1
      }
      knownAlbums.add(nativeId)
    }
  }
  state = { ...state, albums: [...knownAlbums].slice(0, MAX_FOLLOWED_ENTITIES) }
  await persist(state)

  let knownArtists = new Set(state.artists)
  for (const remote of snapshot.artists) {
    const artist = artistFromYouTubeMusic(remote)
    const nativeId = remote.channelId
    if (!knownArtists.has(nativeId)) {
      if (!(await library.isFollowing(artist.id))) {
        await library.follow(artist)
        artistsFollowed += 1
      }
      knownArtists.add(nativeId)
    }
  }
  const lastSyncedAt = now()
  state = {
    ...state,
    artists: [...knownArtists].slice(0, MAX_FOLLOWED_ENTITIES),
    lastSyncedAt,
  }
  await persist(state)

  return {
    accountKey,
    ...(snapshot.displayName === undefined ? {} : { displayName: snapshot.displayName }),
    likedAdded,
    songsAdded,
    playlistsCreated,
    playlistTracksAdded,
    albumsFollowed,
    artistsFollowed,
    truncated: isTruncated(snapshot),
    lastSyncedAt,
  }
}
