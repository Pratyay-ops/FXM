/**
 * Read-only YouTube Music library snapshot for the FXM Connect background.
 *
 * Auth cookies are supplied by the browser's cookies API and are used only to initialize this
 * in-memory youtubei.js session. They are never returned, persisted or logged. The page receives
 * only the normalized DTOs declared below.
 */
import { Innertube } from 'youtubei.js'

const LIKED_MUSIC_PLAYLIST_ID = 'LM'
const MAX_LIBRARY_ITEMS = 500
const MAX_PLAYLIST_TRACKS = 2000
const MAX_PLAYLISTS = 150
const MAX_PAGES = 40

export interface YouTubeMusicArtwork {
  url: string
  width?: number
  height?: number
}

export interface YouTubeMusicTrack {
  videoId: string
  title: string
  artists: { name: string; channelId?: string }[]
  artwork: YouTubeMusicArtwork[]
  durationSeconds?: number
  album?: { id?: string; name: string }
}

export interface YouTubeMusicPlaylist {
  playlistId: string
  title: string
  description?: string
  owner?: string
  artwork: YouTubeMusicArtwork[]
  tracks: YouTubeMusicTrack[]
}

export interface YouTubeMusicAlbum {
  browseId: string
  title: string
  artists: { name: string; channelId?: string }[]
  artwork: YouTubeMusicArtwork[]
  year?: string
}

export interface YouTubeMusicArtist {
  channelId: string
  name: string
  artwork: YouTubeMusicArtwork[]
}

export interface YouTubeMusicLibrarySnapshot {
  displayName?: string
  likedSongs: YouTubeMusicTrack[]
  songs: YouTubeMusicTrack[]
  playlists: YouTubeMusicPlaylist[]
  albums: YouTubeMusicAlbum[]
  artists: YouTubeMusicArtist[]
  truncated: {
    likedSongs: boolean
    songs: boolean
    playlists: boolean
    albums: boolean
    artists: boolean
    playlistTracks: number
  }
}

type RecordLike = Record<string, unknown>

function record(value: unknown): RecordLike | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as RecordLike)
    : undefined
}

function text(value: unknown, max = 500): string | undefined {
  return typeof value === 'string' && value.trim() !== '' && value.length <= max
    ? value.trim()
    : undefined
}

function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : undefined
}

function items(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  if (
    typeof value === 'object' &&
    value !== null &&
    Symbol.iterator in value &&
    typeof (value as { [Symbol.iterator]?: unknown })[Symbol.iterator] === 'function'
  ) {
    try {
      return Array.from(value as Iterable<unknown>)
    } catch {
      return []
    }
  }
  return []
}

function artworkOf(value: unknown): YouTubeMusicArtwork[] {
  const node = record(value)
  const source = items(node?.thumbnails)
  return source.flatMap((entry) => {
    const image = record(entry)
    const url = text(image?.url, 2048)
    if (url === undefined || !url.startsWith('https://')) return []
    const width = number(image?.width)
    const height = number(image?.height)
    return [{
      url,
      ...(width === undefined ? {} : { width }),
      ...(height === undefined ? {} : { height }),
    }]
  }).slice(0, 8)
}

function artistsOf(value: unknown): YouTubeMusicTrack['artists'] {
  const source = items(value)
  return source.flatMap((entry) => {
    const artist = record(entry)
    const name = text(artist?.name)
    if (name === undefined) return []
    const channelId =
      text(artist?.channel_id, 256) ??
      text(record(artist?.endpoint)?.payload && record(record(artist?.endpoint)?.payload)?.browseId, 256)
    return [{ name, ...(channelId === undefined ? {} : { channelId }) }]
  }).slice(0, 8)
}

function idOf(value: RecordLike): string | undefined {
  const direct =
    text(value.id, 256) ??
    text(value.video_id, 256) ??
    text(value.videoId, 256) ??
    text(value.browse_id, 256)
  if (direct !== undefined) return direct
  const endpoint = record(value.endpoint) ?? record(value.navigation_endpoint)
  const payload = record(endpoint?.payload)
  return (
    text(payload?.videoId, 256) ??
    text(payload?.browseId, 256) ??
    text(payload?.playlistId, 256)
  )
}

function trackOf(value: unknown): YouTubeMusicTrack | undefined {
  const row = record(value)
  if (row === undefined) return undefined
  const videoId = idOf(row)
  const title = text(row.title) ?? text(row.name)
  if (videoId === undefined || title === undefined) return undefined
  const duration = record(row.duration)
  const seconds = number(duration?.seconds)
  const album = record(row.album)
  const albumName = text(album?.name) ?? text(album?.title)
  const albumId = album === undefined ? undefined : idOf(album)
  return {
    videoId,
    title,
    artists: artistsOf(row.artists ?? row.authors),
    artwork: artworkOf(row.thumbnail ?? row),
    ...(seconds === undefined ? {} : { durationSeconds: seconds }),
    ...(albumName === undefined ? {} : {
      album: { name: albumName, ...(albumId === undefined ? {} : { id: albumId }) },
    }),
  }
}

function sectionItems(page: unknown): unknown[] {
  const pageRecord = record(page)
  return items(pageRecord?.contents).flatMap((section) => {
    const node = record(section)
    return items(node?.contents)
  })
}

async function collectPages(
  first: unknown,
  readItems: (page: unknown) => unknown[],
  limit: number,
): Promise<{ rows: unknown[]; truncated: boolean }> {
  const rows: unknown[] = []
  let page = first
  for (let index = 0; index < MAX_PAGES; index++) {
    rows.push(...readItems(page))
    if (rows.length >= limit) return { rows: rows.slice(0, limit), truncated: true }
    const current = record(page)
    if (current?.has_continuation !== true || typeof current.getContinuation !== 'function') {
      return { rows, truncated: false }
    }
    page = await (current.getContinuation as () => Promise<unknown>)()
  }
  return { rows: rows.slice(0, limit), truncated: true }
}

function libraryRows(page: unknown): unknown[] {
  const root = record(page)
  const contents = items(root?.contents)
  return contents.flatMap((section) => {
    const node = record(section)
    return items(node?.contents)
  })
}

function playlistRows(page: unknown): unknown[] {
  const node = record(page)
  return items(node?.items).length > 0 ? items(node?.items) : items(node?.contents)
}

function playlistId(value: unknown): string | undefined {
  const id = typeof value === 'string' ? text(value, 256) : idOf(record(value) ?? {})
  if (id === undefined) return undefined
  return id.startsWith('VL') ? id.slice(2) : id
}

function filterFor(filters: readonly string[], kind: string): string | undefined {
  return filters.find((filter) => filter.toLocaleLowerCase('en').includes(kind))
}

function normalizePlaylist(value: unknown, tracks: YouTubeMusicTrack[]): YouTubeMusicPlaylist | undefined {
  const row = record(value)
  if (row === undefined) return undefined
  const playlistIdValue = playlistId(row.id ?? row.playlist_id ?? row)
  const title = text(row.title) ?? text(row.name)
  if (playlistIdValue === undefined || title === undefined) return undefined
  const info = record(row.info)
  const owner = record(row.author) ?? record(info?.author)
  const description = text(row.description) ?? text(info?.description, 4000)
  return {
    playlistId: playlistIdValue,
    title,
    artwork: artworkOf(row.thumbnail ?? row),
    tracks,
    ...(description === undefined ? {} : { description }),
    ...(text(owner?.name) === undefined ? {} : { owner: text(owner?.name) }),
  }
}

/**
 * Gets the signed-in user's YouTube Music library. The supplied cookie header is used only for
 * this in-memory session. This reads the account and never mutates it.
 */
export async function readYouTubeMusicLibrary(
  cookie: string,
  fetcher: typeof fetch = fetch,
): Promise<YouTubeMusicLibrarySnapshot> {
  if (cookie.trim() === '') throw new Error('YouTube Music is not signed in in this browser')
  const innertube = await Innertube.create({
    cookie,
    retrieve_player: false,
    fetch: (input, init) =>
      fetcher(input, {
        ...init,
        credentials: 'include',
        cache: 'no-store',
        redirect: 'error',
      }),
  })

  const account = await innertube.account.getInfo()
  const displayName = text(record(account)?.name) ?? text(record(account)?.title)

  const library = await innertube.music.getLibrary()
  const filters = items(record(library)?.filters).filter((value): value is string => typeof value === 'string')
  const readFiltered = async (kind: string) => {
    const filter = filterFor(filters, kind)
    if (filter === undefined) return { rows: [], truncated: false }
    const filtered = await library.applyFilter(filter)
    return collectPages(filtered, libraryRows, MAX_LIBRARY_ITEMS)
  }

  const likedFeed = await innertube.music.getPlaylist(LIKED_MUSIC_PLAYLIST_ID)
  const likedResult = await collectPages(likedFeed, playlistRows, MAX_LIBRARY_ITEMS)
  const likedSongs = likedResult.rows.flatMap((row) => {
    const track = trackOf(row)
    return track === undefined ? [] : [track]
  })

  const [songRows, playlistRowsResult, albumRows, artistRows] = await Promise.all([
    readFiltered('song'),
    readFiltered('playlist'),
    readFiltered('album'),
    readFiltered('artist'),
  ])

  const songs = songRows.rows.flatMap((row) => {
    const track = trackOf(row)
    return track === undefined ? [] : [track]
  })

  const albums = albumRows.rows.flatMap((value) => {
    const row = record(value)
    if (row === undefined || (row.item_type !== 'album' && row.item_type !== undefined)) return []
    const browseId = idOf(row)
    const title = text(row.title) ?? text(row.name)
    if (browseId === undefined || title === undefined) return []
    return [{
      browseId,
      title,
      artists: artistsOf(row.artists),
      artwork: artworkOf(row.thumbnail ?? row),
      ...(text(row.year, 32) === undefined ? {} : { year: text(row.year, 32) }),
    }]
  })

  const artists = artistRows.rows.flatMap((value) => {
    const row = record(value)
    if (row === undefined) return []
    const channelId = idOf(row)
    const name = text(row.title) ?? text(row.name)
    if (channelId === undefined || name === undefined) return []
    return [{ channelId, name, artwork: artworkOf(row.thumbnail ?? row) }]
  })

  let playlistTrackTruncated = 0
  const playlists: YouTubeMusicPlaylist[] = []
  for (const row of playlistRowsResult.rows.slice(0, MAX_PLAYLISTS)) {
    const id = playlistId(row)
    if (id === undefined) continue
    const feed = await innertube.music.getPlaylist(id)
    const result = await collectPages(feed, playlistRows, MAX_PLAYLIST_TRACKS)
    const tracks = result.rows.flatMap((entry) => {
      const track = trackOf(entry)
      return track === undefined ? [] : [track]
    })
    if (result.truncated) playlistTrackTruncated += 1
    const playlist = normalizePlaylist(row, tracks)
    if (playlist !== undefined) playlists.push(playlist)
  }

  return {
    ...(displayName === undefined ? {} : { displayName }),
    likedSongs,
    songs,
    playlists,
    albums,
    artists,
    truncated: {
      likedSongs: likedResult.truncated,
      songs: songRows.truncated,
      playlists: playlistRowsResult.truncated || playlistRowsResult.rows.length > MAX_PLAYLISTS,
      albums: albumRows.truncated,
      artists: artistRows.truncated,
      playlistTracks: playlistTrackTruncated,
    },
  }
}
