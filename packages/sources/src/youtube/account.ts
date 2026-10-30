/**
 * Read-only YouTube Music account library reader for FXM Connect.
 *
 * This module is called only by the extension background. Its caller supplies the browser's
 * current YouTube Music cookie header; the reader never persists it or returns it. The result is
 * plain, normalized metadata suitable for the local FXM library.
 *
 * YouTube Music's InnerTube API is unofficial and may change. Keep limits conservative and fail
 * closed when a response is incomplete so an API change is never interpreted as an empty library.
 */

import type { Album, Artist, Artwork, ArtistRef, Track, Playlist } from '@fxm/core'
import { Innertube } from 'youtubei.js'
import { isYouTubeId, playlistIdOf, youTubeEntityId } from './ids'

export interface YouTubeMusicPlaylist {
  playlist: Playlist
  tracks: Track[]
}

export interface YouTubeMusicAccountSnapshot {
  likedTracks: Track[]
  savedTracks: Track[]
  playlists: YouTubeMusicPlaylist[]
  savedAlbums: Album[]
  followedArtists: Artist[]
}

export interface YouTubeMusicReaderOptions {
  /** Test seam; production uses youtubei.js with the supplied cookie. */
  createClient?: (cookie: string) => Promise<MusicAccountClient>
  maxTracks?: number
  maxPlaylists?: number
  maxAlbums?: number
  maxArtists?: number
}

interface MusicAccountClient {
  music: {
    getLibrary(): Promise<MusicLibraryPage>
    getPlaylist(id: string): Promise<MusicPlaylistPage>
  }
}

interface MusicLibraryPage {
  filters?: string[]
  contents?: readonly unknown[]
  has_continuation: boolean
  applyFilter(filter: string): Promise<MusicLibraryPage>
  getContinuation(): Promise<MusicLibraryContinuation>
}

interface MusicLibraryContinuation {
  contents?: { contents?: readonly unknown[] }
  has_continuation: boolean
  getContinuation(): Promise<MusicLibraryContinuation>
}

interface MusicPlaylistPage {
  header?: unknown
  items: readonly unknown[]
  has_continuation: boolean
  getContinuation(): Promise<MusicPlaylistPage>
}

interface MusicItem {
  item_type?: string
  id?: string
  title?: unknown
  name?: unknown
  artists?: readonly { name?: string; channel_id?: string }[]
  authors?: readonly { name?: string; channel_id?: string }[]
  author?: { name?: string; channel_id?: string }
  album?: { id?: string; name?: string }
  duration?: { seconds?: number }
  thumbnail?: { contents?: readonly unknown[] } | readonly unknown[]
  artwork?: readonly unknown[]
  item_count?: string | null
  year?: string
}

const DEFAULT_LIMITS = {
  tracks: 10_000,
  playlists: 250,
  albums: 500,
  artists: 500,
} as const

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined
}

function text(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() || undefined
  if (value && typeof value === 'object' && 'toString' in value) {
    const result = String(value).trim()
    return result && result !== '[object Object]' ? result : undefined
  }
  return undefined
}

function artworkOf(item: MusicItem): Artwork[] {
  const raw = item.thumbnail
  const thumbnails = Array.isArray(raw)
    ? raw
    : Array.isArray(record(raw)?.contents)
      ? record(raw)?.contents as readonly unknown[]
      : Array.isArray(item.artwork)
        ? item.artwork
        : []
  return thumbnails.flatMap((value) => {
    const image = record(value)
    const url = typeof image?.url === 'string' ? image.url : undefined
    if (!url || !url.startsWith('https://')) return []
    const artwork: Artwork = { url }
    if (typeof image.width === 'number' && Number.isFinite(image.width)) artwork.width = image.width
    if (typeof image.height === 'number' && Number.isFinite(image.height)) artwork.height = image.height
    return [artwork]
  })
}

function artistRefs(item: MusicItem): ArtistRef[] {
  return (item.artists ?? [])
    .flatMap((artist) => {
      const name = text(artist.name)
      if (!name) return []
      const id = artist.channel_id && youTubeEntityId('ytm', 'artist', artist.channel_id)
      return [id ? { id, name } : { name }]
    })
}

function trackOf(value: unknown): Track | undefined {
  const item = value as MusicItem
  if (item.item_type !== 'song' || typeof item.id !== 'string') return undefined
  const id = youTubeEntityId('ytm', 'track', item.id)
  const title = text(item.title)
  if (!id || !title) return undefined
  const track: Track = {
    id,
    source: 'ytm',
    title,
    artists: artistRefs(item),
    artwork: artworkOf(item),
    kind: 'song',
  }
  if (typeof item.duration?.seconds === 'number' && Number.isFinite(item.duration.seconds)) {
    track.durationMs = Math.max(0, Math.round(item.duration.seconds * 1000))
  }
  if (item.album?.id && item.album.name) {
    const albumId = youTubeEntityId('ytm', 'album', item.album.id)
    if (albumId) track.album = { id: albumId, name: item.album.name }
  }
  return track
}

function albumOf(value: unknown): Album | undefined {
  const item = value as MusicItem
  if (item.item_type !== 'album' || typeof item.id !== 'string') return undefined
  const id = youTubeEntityId('ytm', 'album', item.id)
  const name = text(item.title) ?? text(item.name)
  if (!id || !name) return undefined
  const album: Album = {
    id,
    source: 'ytm',
    name,
    artists: artistRefs(item),
    artwork: artworkOf(item),
  }
  if (typeof item.year === 'string' && /^\d{4}$/.test(item.year)) album.releaseDate = item.year
  const count = item.item_count?.match(/\d[\d,]*/)
  if (count?.[0]) album.trackCount = Number(count[0].replace(/,/g, ''))
  return album
}

function artistOf(value: unknown): Artist | undefined {
  const item = value as MusicItem
  if (!['artist', 'library_artist'].includes(item.item_type ?? '')) return undefined
  const nativeId =
    item.id ??
    item.author?.channel_id ??
    record(record(item.endpoint)?.payload)?.browseId
  const id = typeof nativeId === 'string' ? youTubeEntityId('ytm', 'artist', nativeId) : undefined
  const name = text(item.title) ?? text(item.name)
  if (!id || !name) return undefined
  return { id, source: 'ytm', name, artwork: artworkOf(item) }
}

function playlistOf(value: unknown): Playlist | undefined {
  const item = value as MusicItem
  if (item.item_type !== 'playlist' || typeof item.id !== 'string') return undefined
  const nativeId = playlistIdOf(item.id)
  const id = youTubeEntityId('ytm', 'playlist', nativeId)
  const name = text(item.title) ?? text(item.name)
  if (!id || !name) return undefined
  const playlist: Playlist = { id, source: 'ytm', name, artwork: artworkOf(item) }
  const owner = item.author ?? item.artists?.[0]
  if (owner?.name) {
    playlist.owner = {
      name: owner.name,
      ...(owner.channel_id ? { id: owner.channel_id } : {}),
    }
  }
  const count = item.item_count?.match(/\d[\d,]*/)
  if (count?.[0]) playlist.trackCount = Number(count[0].replace(/,/g, ''))
  return playlist
}

function sectionItems(section: unknown): readonly unknown[] {
  const value = record(section)
  if (Array.isArray(value?.contents)) return value.contents
  if (Array.isArray(value?.items)) return value.items
  return []
}

async function collectLibraryFilter<T>(
  library: MusicLibraryPage,
  filter: string,
  map: (item: unknown) => T | undefined,
  max: number,
): Promise<T[]> {
  let page = await library.applyFilter(filter)
  const result: T[] = []
  const add = (items: readonly unknown[]) => {
    for (const item of items) {
      const mapped = map(item)
      if (mapped !== undefined) result.push(mapped)
      if (result.length > max) throw new Error('YouTube Music library exceeds FXM import limits')
    }
  }
  for (const section of page.contents ?? []) add(sectionItems(section))
  let continuationPages = 0
  while (page.has_continuation) {
    if (++continuationPages > 200) throw new Error('YouTube Music returned too many library pages')
    const next = await page.getContinuation()
    add(next.contents?.contents ?? [])
    if (!next.has_continuation) break
    // LibraryContinuation uses the same continuation interface but has no public wrapper method
    // that returns a Library instance. Follow it directly for the remaining pages.
    let cursor = next
    while (cursor.has_continuation) {
      if (++continuationPages > 200) throw new Error('YouTube Music returned too many library pages')
      cursor = await cursor.getContinuation()
      add(cursor.contents?.contents ?? [])
    }
    break
  }
  return result
}

async function collectPlaylistTracks(
  client: MusicAccountClient,
  playlistId: string,
  max: number,
): Promise<Track[]> {
  let page = await client.music.getPlaylist(playlistId)
  const tracks: Track[] = []
  const seen = new Set<string>()
  let pages = 0
  for (;;) {
    for (const item of page.items) {
      const track = trackOf(item)
      if (!track || seen.has(track.id)) continue
      seen.add(track.id)
      tracks.push(track)
      if (tracks.length > max) throw new Error('YouTube Music playlist exceeds FXM import limits')
    }
    if (!page.has_continuation) break
    if (++pages > 200) throw new Error('YouTube Music returned too many playlist pages')
    page = await page.getContinuation()
  }
  return tracks
}

/**
 * Reads an authenticated YouTube Music account using the cookie the extension obtained from the
 * browser cookie store. The cookie is used only to create this in-memory client and is never
 * returned or persisted.
 */
export async function readYouTubeMusicAccount(
  cookie: string,
  options: YouTubeMusicReaderOptions = {},
): Promise<YouTubeMusicAccountSnapshot> {
  if (typeof cookie !== 'string' || cookie.length < 16 || cookie.length > 32_768) {
    throw new Error('YouTube Music login is unavailable in this browser')
  }
  const createClient = options.createClient ?? ((value: string) =>
    Innertube.create({ cookie: value, lang: 'en', retrieve_player: false, retrieve_innertube_config: false }))
  const limits = {
    tracks: options.maxTracks ?? DEFAULT_LIMITS.tracks,
    playlists: options.maxPlaylists ?? DEFAULT_LIMITS.playlists,
    albums: options.maxAlbums ?? DEFAULT_LIMITS.albums,
    artists: options.maxArtists ?? DEFAULT_LIMITS.artists,
  }
  const client = await createClient(cookie)
  const library = await client.music.getLibrary()
  const filters = new Map((library.filters ?? []).map((name) => [name.toLowerCase(), name]))
  if (filters.size === 0 && (library.contents?.length ?? 0) === 0) {
    throw new Error('YouTube Music did not return a readable account library')
  }

  const savedTracks = filters.has('songs')
    ? await collectLibraryFilter(library, filters.get('songs') as string, trackOf, limits.tracks)
    : []
  const playlists = filters.has('playlists')
    ? await collectLibraryFilter(library, filters.get('playlists') as string, playlistOf, limits.playlists)
    : []
  const savedAlbums = filters.has('albums')
    ? await collectLibraryFilter(library, filters.get('albums') as string, albumOf, limits.albums)
    : []
  const followedArtists = filters.has('artists')
    ? await collectLibraryFilter(library, filters.get('artists') as string, artistOf, limits.artists)
    : []

  const likedTracks = await collectPlaylistTracks(client, 'LM', limits.tracks)
  const playlistCopies: YouTubeMusicPlaylist[] = []
  for (const entry of playlists) {
    const nativeId = String(entry.id).slice('ytm:playlist:'.length)
    const tracks = await collectPlaylistTracks(client, nativeId, limits.tracks)
    playlistCopies.push({ playlist: entry, tracks })
  }

  return {
    likedTracks,
    savedTracks,
    playlists: playlistCopies,
    savedAlbums,
    followedArtists,
  }
}
