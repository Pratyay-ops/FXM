/**
 * The bounded, credential-free DTO FXM Connect returns for a YouTube Music library read.
 * This deliberately contains metadata only: no cookies, tokens, request headers or InnerTube
 * continuation tokens cross the extension/page boundary.
 *
 * @module
 */

export interface YouTubeMusicArtwork {
  readonly url: string
  readonly width?: number
  readonly height?: number
}

export interface YouTubeMusicArtistRef {
  readonly name: string
  readonly channelId?: string
}

export interface YouTubeMusicTrack {
  readonly videoId: string
  readonly title: string
  readonly artists: readonly YouTubeMusicArtistRef[]
  readonly artwork: readonly YouTubeMusicArtwork[]
  readonly durationSeconds?: number
  readonly album?: { readonly id?: string; readonly name: string }
}

export interface YouTubeMusicPlaylist {
  readonly playlistId: string
  readonly title: string
  readonly description?: string
  readonly owner?: string
  readonly artwork: readonly YouTubeMusicArtwork[]
  readonly tracks: readonly YouTubeMusicTrack[]
}

export interface YouTubeMusicAlbum {
  readonly browseId: string
  readonly title: string
  readonly artists: readonly YouTubeMusicArtistRef[]
  readonly artwork: readonly YouTubeMusicArtwork[]
  readonly year?: string
}

export interface YouTubeMusicArtist {
  readonly channelId: string
  readonly name: string
  readonly artwork: readonly YouTubeMusicArtwork[]
}

export interface YouTubeMusicLibrarySnapshot {
  readonly accountId: string
  readonly displayName?: string
  /** The YouTube Music Liked Music playlist (LM), not ordinary YouTube video likes. */
  readonly likedSongs: readonly YouTubeMusicTrack[]
  /** Songs explicitly present in the account's YouTube Music library. */
  readonly songs: readonly YouTubeMusicTrack[]
  readonly playlists: readonly YouTubeMusicPlaylist[]
  readonly albums: readonly YouTubeMusicAlbum[]
  readonly artists: readonly YouTubeMusicArtist[]
  readonly truncated: {
    readonly likedSongs: boolean
    readonly songs: boolean
    readonly playlists: boolean
    readonly albums: boolean
    readonly artists: boolean
    /** Number of playlists whose track listing reached its cap. */
    readonly playlistTracks: number
  }
}

type RecordLike = Record<string, unknown>

function record(value: unknown): RecordLike | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as RecordLike)
    : undefined
}

function shortText(value: unknown, max = 500): string | undefined {
  return typeof value === 'string' && value.trim() !== '' && value.length <= max
    ? value.trim()
    : undefined
}

function nonNegative(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined
}

function artwork(value: unknown): YouTubeMusicArtwork[] | undefined {
  if (!Array.isArray(value) || value.length > 8) return undefined
  const result: YouTubeMusicArtwork[] = []
  for (const entry of value) {
    const node = record(entry)
    const url = shortText(node?.url, 2048)
    if (url === undefined || !url.startsWith('https://')) return undefined
    const width = nonNegative(node?.width)
    const height = nonNegative(node?.height)
    result.push({
      url,
      ...(width === undefined ? {} : { width }),
      ...(height === undefined ? {} : { height }),
    })
  }
  return result
}

function artistRefs(value: unknown): YouTubeMusicArtistRef[] | undefined {
  if (!Array.isArray(value) || value.length > 8) return undefined
  const result: YouTubeMusicArtistRef[] = []
  for (const entry of value) {
    const node = record(entry)
    const name = shortText(node?.name)
    const channelId = shortText(node?.channelId, 256)
    if (name === undefined) return undefined
    result.push({ name, ...(channelId === undefined ? {} : { channelId }) })
  }
  return result
}

function track(value: unknown): YouTubeMusicTrack | undefined {
  const node = record(value)
  const videoId = shortText(node?.videoId, 256)
  const title = shortText(node?.title)
  const artists = artistRefs(node?.artists)
  const images = artwork(node?.artwork)
  const duration = node?.durationSeconds
  const durationSeconds =
    duration === undefined ? undefined : nonNegative(duration)
  const albumNode = node?.album === undefined ? undefined : record(node.album)
  const albumName = albumNode === undefined ? undefined : shortText(albumNode.name)
  const albumId = albumNode === undefined ? undefined : shortText(albumNode.id, 256)

  if (
    videoId === undefined ||
    title === undefined ||
    artists === undefined ||
    images === undefined ||
    (duration !== undefined && durationSeconds === undefined) ||
    (node?.album !== undefined && (albumNode === undefined || albumName === undefined)) ||
    (albumId !== undefined && albumId.length === 0)
  ) {
    return undefined
  }
  return {
    videoId,
    title,
    artists,
    artwork: images,
    ...(durationSeconds === undefined ? {} : { durationSeconds }),
    ...(albumName === undefined
      ? {}
      : { album: { name: albumName, ...(albumId === undefined ? {} : { id: albumId }) } }),
  }
}

function tracks(value: unknown): YouTubeMusicTrack[] | undefined {
  if (!Array.isArray(value) || value.length > 2000) return undefined
  const result: YouTubeMusicTrack[] = []
  for (const item of value) {
    const parsed = track(item)
    if (parsed === undefined) return undefined
    result.push(parsed)
  }
  return result
}

function playlist(value: unknown): YouTubeMusicPlaylist | undefined {
  const node = record(value)
  const playlistId = shortText(node?.playlistId, 256)
  const title = shortText(node?.title)
  const images = artwork(node?.artwork)
  const songs = tracks(node?.tracks)
  const description = shortText(node?.description, 4000)
  const owner = shortText(node?.owner)
  if (
    playlistId === undefined ||
    title === undefined ||
    images === undefined ||
    songs === undefined ||
    (node?.description !== undefined && description === undefined) ||
    (node?.owner !== undefined && owner === undefined)
  ) {
    return undefined
  }
  return {
    playlistId,
    title,
    artwork: images,
    tracks: songs,
    ...(description === undefined ? {} : { description }),
    ...(owner === undefined ? {} : { owner }),
  }
}

function album(value: unknown): YouTubeMusicAlbum | undefined {
  const node = record(value)
  const browseId = shortText(node?.browseId, 256)
  const title = shortText(node?.title)
  const artists = artistRefs(node?.artists)
  const images = artwork(node?.artwork)
  const year = shortText(node?.year, 32)
  if (
    browseId === undefined ||
    title === undefined ||
    artists === undefined ||
    images === undefined ||
    (node?.year !== undefined && year === undefined)
  ) {
    return undefined
  }
  return { browseId, title, artists, artwork: images, ...(year === undefined ? {} : { year }) }
}

function artist(value: unknown): YouTubeMusicArtist | undefined {
  const node = record(value)
  const channelId = shortText(node?.channelId, 256)
  const name = shortText(node?.name)
  const images = artwork(node?.artwork)
  if (channelId === undefined || name === undefined || images === undefined) return undefined
  return { channelId, name, artwork: images }
}

/** Validates a response before any local library writes are made. */
export function parseYouTubeMusicSnapshot(value: unknown): YouTubeMusicLibrarySnapshot {
  const node = record(value)
  if (node === undefined) throw new Error('FXM Connect returned an invalid YouTube Music response')

  const accountId = shortText(node.accountId, 256)
  const displayName = shortText(node.displayName)
  const likedSongs = tracks(node.likedSongs)
  const songs = tracks(node.songs)
  const playlistsRaw = Array.isArray(node.playlists) ? node.playlists : undefined
  const albumsRaw = Array.isArray(node.albums) ? node.albums : undefined
  const artistsRaw = Array.isArray(node.artists) ? node.artists : undefined
  const playlists = playlistsRaw?.map(playlist)
  const albums = albumsRaw?.map(album)
  const artists = artistsRaw?.map(artist)
  const truncated = record(node.truncated)

  if (
    accountId === undefined ||
    (node.displayName !== undefined && displayName === undefined) ||
    likedSongs === undefined ||
    songs === undefined ||
    playlists === undefined ||
    playlists.length > 30 ||
    playlists.some((item) => item === undefined) ||
    albums === undefined ||
    albums.length > 250 ||
    albums.some((item) => item === undefined) ||
    artists === undefined ||
    artists.length > 250 ||
    artists.some((item) => item === undefined) ||
    truncated === undefined ||
    typeof truncated.likedSongs !== 'boolean' ||
    typeof truncated.songs !== 'boolean' ||
    typeof truncated.playlists !== 'boolean' ||
    typeof truncated.albums !== 'boolean' ||
    typeof truncated.artists !== 'boolean' ||
    nonNegative(truncated.playlistTracks) === undefined
  ) {
    throw new Error(
      'FXM Connect returned an incomplete YouTube Music library response. No library changes were made.',
    )
  }

  return {
    accountId,
    ...(displayName === undefined ? {} : { displayName }),
    likedSongs,
    songs,
    playlists: playlists as YouTubeMusicPlaylist[],
    albums: albums as YouTubeMusicAlbum[],
    artists: artists as YouTubeMusicArtist[],
    truncated: {
      likedSongs: truncated.likedSongs,
      songs: truncated.songs,
      playlists: truncated.playlists,
      albums: truncated.albums,
      artists: truncated.artists,
      playlistTracks: nonNegative(truncated.playlistTracks) as number,
    },
  }
}
