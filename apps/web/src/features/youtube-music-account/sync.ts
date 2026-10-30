/**
 * Manual, additive synchronization of a YouTube Music library into FXM.
 *
 * The account request is performed by FXM Connect. This module receives normalized metadata and
 * writes local copies; it never holds account credentials or sends writes to YouTube Music.
 * Import bookkeeping is stored under a device-local setting (not the sync. prefix).
 */
import {
  type Album,
  type Artist,
  type EntityId,
  formatId,
  type JsonValue,
  parseId,
  type Track,
} from '@fxm/core'
import type {
  YouTubeMusicAccountSnapshot,
  YouTubeMusicPlaylist,
} from '@fxm/sources/youtube/account'
import type { LibraryRepo } from '../../db/repo'

const STATE_PREFIX = 'youtube-music-account.'
const ACTIVE_ACCOUNT_KEY = 'youtube-music-account.active'
const MAX_TRACKS_PER_PLAYLIST = 10_000

interface ImportedListState {
  readonly localId: EntityId<'playlist'>
  readonly seenTrackIds: readonly string[]
  readonly dismissed?: true
}
interface YouTubeMusicSyncState {
  readonly schema: 1
  readonly account: string
  readonly liked?: ImportedListState
  readonly playlists: Readonly<Record<string, ImportedListState>>
  readonly albums: readonly string[]
  readonly artists: readonly string[]
}
export interface YouTubeMusicSyncLibrary {
  getPlaylistList(): ReturnType<LibraryRepo['getPlaylistList']>
  createPlaylist(
    input: Parameters<LibraryRepo['createPlaylist']>[0],
  ): ReturnType<LibraryRepo['createPlaylist']>
  addTracks(
    id: EntityId<'playlist'>,
    tracks: readonly Track[],
  ): ReturnType<LibraryRepo['addTracks']>
  isFollowing(id: EntityId<'album' | 'artist'>): ReturnType<LibraryRepo['isFollowing']>
  follow(entity: Album | Artist): ReturnType<LibraryRepo['follow']>
  getSetting(key: string): Promise<JsonValue | undefined>
  putSettings(values: Readonly<Record<string, JsonValue | undefined>>): Promise<void>
}
export interface YouTubeMusicSyncResult {
  readonly account: string
  readonly likedSongs: number
  readonly savedSongs: number
  readonly playlists: number
  readonly savedAlbums: number
  readonly followedArtists: number
  readonly addedTracks: number
  readonly createdPlaylists: number
  readonly addedFollows: number
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function string(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}
function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter(string) : []
}
function parseListState(value: unknown): ImportedListState | undefined {
  if (!isRecord(value) || !string(value.localId)) return undefined
  const id = parseId(value.localId)
  if (id?.source !== 'local' || id.kind !== 'playlist') return undefined
  return {
    localId: value.localId as EntityId<'playlist'>,
    seenTrackIds: stringList(value.seenTrackIds),
    ...(value.dismissed === true ? { dismissed: true } : {}),
  }
}
function readState(value: unknown, account: string): YouTubeMusicSyncState {
  if (!isRecord(value) || value.schema !== 1 || value.account !== account) {
    return { schema: 1, account, playlists: {}, albums: [], artists: [] }
  }
  const playlists: Record<string, ImportedListState> = {}
  if (isRecord(value.playlists)) {
    for (const [key, entry] of Object.entries(value.playlists)) {
      const parsed = parseListState(entry)
      if (parsed !== undefined && /^[A-Za-z0-9_-]{1,128}$/u.test(key)) playlists[key] = parsed
    }
  }
  return {
    schema: 1,
    account,
    ...(parseListState(value.liked) === undefined ? {} : { liked: parseListState(value.liked) }),
    playlists,
    albums: stringList(value.albums),
    artists: stringList(value.artists),
  }
}
function uniqueTracks(tracks: readonly Track[]): Track[] {
  const seen = new Set<string>()
  return tracks.filter((track) => {
    if (!string(track.id) || seen.has(track.id)) return false
    seen.add(track.id)
    return true
  })
}
function accountSettingKey(account: string): string {
  return STATE_PREFIX + account
}
function localListId(account: string, remoteKey: string): EntityId<'playlist'> {
  return formatId('local', 'playlist', `youtube-music-${account}-${remoteKey}`)
}
function mergeIds(before: readonly string[], incoming: readonly string[]): string[] {
  return [...new Set([...before, ...incoming])]
}
async function copyList(
  library: YouTubeMusicSyncLibrary,
  account: string,
  current: ImportedListState | undefined,
  remoteKey: string,
  name: string,
  tracks: readonly Track[],
  artwork: readonly { url: string; width?: number; height?: number }[],
  localLists: ReadonlySet<string>,
): Promise<{ state: ImportedListState; added: number; created: number }> {
  const unique = uniqueTracks(tracks).slice(0, MAX_TRACKS_PER_PLAYLIST)
  const localId = current?.localId ?? localListId(account, remoteKey)
  if (current?.dismissed) return { state: current, added: 0, created: 0 }
  const known = new Set(current?.seenTrackIds ?? [])
  const newTracks = unique.filter((track) => !known.has(track.id))
  let created = 0
  let added = 0
  if (!localLists.has(localId)) {
    if (current !== undefined) {
      // A previously imported copy disappeared: preserve the user's deletion.
      return { state: { ...current, dismissed: true }, added: 0, created: 0 }
    }
    await library.createPlaylist({ id: localId, name, tracks: unique, artwork })
    created = 1
    added = unique.length
  } else if (newTracks.length > 0) {
    const result = await library.addTracks(localId, newTracks)
    added = result.added
  }
  return {
    state: {
      localId,
      seenTrackIds: mergeIds(
        [...known],
        unique.map((track) => track.id),
      ),
    },
    added,
    created,
  }
}

/**
 * Imports a validated snapshot. Repeated runs add only newly seen remote tracks and never update
 * local playlist names, order, removals, or user-edited metadata. A deleted copy is marked
 * dismissed so subsequent syncs will not recreate it.
 */
export async function runYouTubeMusicSync(
  library: YouTubeMusicSyncLibrary,
  snapshot: YouTubeMusicAccountSnapshot & { account: string },
): Promise<YouTubeMusicSyncResult> {
  if (!/^[a-f0-9]{24}$/u.test(snapshot.account)) {
    throw new Error('YouTube Music did not provide a valid account fingerprint')
  }
  if (
    !Array.isArray(snapshot.likedTracks) ||
    !Array.isArray(snapshot.savedTracks) ||
    !Array.isArray(snapshot.playlists) ||
    !Array.isArray(snapshot.savedAlbums) ||
    !Array.isArray(snapshot.followedArtists)
  ) {
    throw new Error('YouTube Music returned an incomplete library snapshot')
  }
  const key = accountSettingKey(snapshot.account)
  const state = readState(await library.getSetting(key), snapshot.account)
  const present = await library.getPlaylistList()
  const localLists = new Set(
    present.items.filter((item) => item.origin === 'local').map((item) => item.id as string),
  )
  const likedTracks = uniqueTracks(snapshot.likedTracks)
  const likedCopy = await copyList(
    library,
    snapshot.account,
    state.liked,
    'liked',
    'Liked songs on YouTube Music',
    likedTracks,
    [],
    localLists,
  )
  const playlistStates: Record<string, ImportedListState> = { ...state.playlists }
  let addedTracks = likedCopy.added
  let createdPlaylists = likedCopy.created
  const seenRemotePlaylists = new Set<string>()
  for (const entry of snapshot.playlists) {
    const parts = parseId(entry.playlist.id)
    const remoteId = parts?.source === 'ytm' && parts.kind === 'playlist' ? parts.nativeId : undefined
    if (!remoteId || seenRemotePlaylists.has(remoteId)) continue
    seenRemotePlaylists.add(remoteId)
    const copied = await copyList(
      library,
      snapshot.account,
      playlistStates[remoteId],
      remoteId,
      entry.playlist.name,
      entry.tracks,
      entry.playlist.artwork,
      localLists,
    )
    playlistStates[remoteId] = copied.state
    addedTracks += copied.added
    createdPlaylists += copied.created
  }
  const seenAlbums = new Set(state.albums)
  let addedFollows = 0
  for (const album of snapshot.savedAlbums) {
    if (seenAlbums.has(album.id)) continue
    if (!(await library.isFollowing(album.id))) {
      await library.follow(album)
      addedFollows += 1
    }
    seenAlbums.add(album.id)
  }
  const seenArtists = new Set(state.artists)
  for (const artist of snapshot.followedArtists) {
    if (seenArtists.has(artist.id)) continue
    if (!(await library.isFollowing(artist.id))) {
      await library.follow(artist)
      addedFollows += 1
    }
    seenArtists.add(artist.id)
  }
  const next: YouTubeMusicSyncState = {
    schema: 1,
    account: snapshot.account,
    liked: likedCopy.state,
    playlists: playlistStates,
    albums: [...seenAlbums],
    artists: [...seenArtists],
  }
  await library.putSettings({
    [key]: next as unknown as JsonValue,
    [ACTIVE_ACCOUNT_KEY]: snapshot.account,
  })
  return {
    account: snapshot.account,
    likedSongs: likedTracks.length,
    savedSongs: 0,
    playlists: seenRemotePlaylists.size,
    savedAlbums: snapshot.savedAlbums.length,
    followedArtists: snapshot.followedArtists.length,
    addedTracks,
    createdPlaylists,
    addedFollows,
  }
}

/** Checks the shape before an untrusted page-to-extension reply enters the local library. */
export function parseYouTubeMusicSnapshot(
  value: unknown,
): (YouTubeMusicAccountSnapshot & { account: string }) | undefined {
  if (!isRecord(value) || typeof value.account !== 'string' || !/^[a-f0-9]{24}$/u.test(value.account)) {
    return undefined
  }
  const arrays = ['likedTracks', 'savedTracks', 'playlists', 'savedAlbums', 'followedArtists'] as const
  if (!arrays.every((key) => Array.isArray(value[key]))) return undefined
  const tracksValid = (items: unknown[]) =>
    items.every((item) => {
      if (
        !isRecord(item) ||
        typeof item.id !== 'string' ||
        parseId(item.id)?.source !== 'ytm' ||
        parseId(item.id)?.kind !== 'track' ||
        typeof item.title !== 'string' ||
        item.source !== 'ytm' ||
        item.kind !== 'song' ||
        !Array.isArray(item.artists) ||
        !Array.isArray(item.artwork)
      ) return false
      return item.artists.every((artist) =>
        isRecord(artist) &&
        typeof artist.name === 'string' &&
        (artist.id === undefined ||
          (typeof artist.id === 'string' &&
            parseId(artist.id)?.source === 'ytm' &&
            parseId(artist.id)?.kind === 'artist')),
      )
    })
  const albumsValid = (items: unknown[]) =>
    items.every((item) =>
      isRecord(item) &&
      typeof item.id === 'string' &&
      parseId(item.id)?.source === 'ytm' &&
      parseId(item.id)?.kind === 'album' &&
      item.source === 'ytm' &&
      typeof item.name === 'string' &&
      Array.isArray(item.artists) &&
      Array.isArray(item.artwork),
    )
  const artistsValid = (items: unknown[]) =>
    items.every((item) =>
      isRecord(item) &&
      typeof item.id === 'string' &&
      parseId(item.id)?.source === 'ytm' &&
      parseId(item.id)?.kind === 'artist' &&
      item.source === 'ytm' &&
      typeof item.name === 'string' &&
      Array.isArray(item.artwork),
    )
  const playlistsValid = (items: unknown[]) =>
    items.every((entry) => {
      if (!isRecord(entry) || !isRecord(entry.playlist) || !Array.isArray(entry.tracks)) return false
      const playlist = entry.playlist
      return (
        typeof playlist.id === 'string' &&
        parseId(playlist.id)?.source === 'ytm' &&
        parseId(playlist.id)?.kind === 'playlist' &&
        playlist.source === 'ytm' &&
        typeof playlist.name === 'string' &&
        Array.isArray(playlist.artwork) &&
        tracksValid(entry.tracks)
      )
    })
  if (
    !tracksValid(value.likedTracks as unknown[]) ||
    !tracksValid(value.savedTracks as unknown[]) ||
    !playlistsValid(value.playlists as unknown[]) ||
    !albumsValid(value.savedAlbums as unknown[]) ||
    !artistsValid(value.followedArtists as unknown[])
  ) return undefined
  return {
    account: value.account,
    likedTracks: value.likedTracks as Track[],
    savedTracks: value.savedTracks as Track[],
    playlists: value.playlists as YouTubeMusicPlaylist[],
    savedAlbums: value.savedAlbums as Album[],
    followedArtists: value.followedArtists as Artist[],
  }
}


/**
 * Forgets only the current account's import bookkeeping. Imported playlists and follows are
 * ordinary local library data and are deliberately left untouched.
 *
 * @returns whether an active YouTube Music sync history existed.
 */
export async function forgetYouTubeMusicSyncHistory(
  library: YouTubeMusicSyncLibrary,
): Promise<boolean> {
  const active = await library.getSetting(ACTIVE_ACCOUNT_KEY)
  if (typeof active !== 'string' || !/^[a-f0-9]{24}$/u.test(active)) return false
  await library.putSettings({
    [accountSettingKey(active)]: undefined,
    [ACTIVE_ACCOUNT_KEY]: undefined,
  })
  return true
}
