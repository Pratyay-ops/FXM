/**
 * Maps Spotify's GraphQL and spclient JSON to FXM's core types. Pure functions over untrusted
 * data: they read only the field paths recorded from Spotify's own web player (see the README),
 * skip items they cannot read instead of throwing, and never set an optional field to
 * `undefined`.
 *
 * Every Spotify track is a catalog song (`kind: 'song'`) with its base62 ID in
 * `externalIds.spotify`; episodes, audiobooks and local files are left out.
 *
 * @module
 */

import type {
  Album,
  AlbumRef,
  AlbumType,
  Artist,
  ArtistRef,
  Artwork,
  Page,
  Playlist,
  PlaylistOwner,
  Shelf,
  ShelfItem,
  Track,
} from '@fxm/core'
import { normalizeIsrc } from '@fxm/core'
import { parseSpotifyUri, spotifyEntityIdFromUri } from './ids'

type JsonRecord = Record<string, unknown>

/**
 * Facts about a track that only spclient's `metadata/4` has. The ISRC belongs to the recording;
 * the label, release date and album type belong to the release (the album) Spotify lists the
 * track on.
 */
export interface SpotifyTrackDetails {
  /** The ISRC, canonical (see `normalizeIsrc`). */
  isrc?: string
  /** The album's record label. */
  label?: string
  /** The album's release date as ISO 8601, possibly partial. */
  releaseDate?: string
  /** What kind of release the album is: album, single, EP or compilation. */
  albumType?: AlbumType
  /** Popularity from 0 to 100. */
  popularity?: number
}

/** A liked song from the user's library, with when it was liked. */
export interface SpotifyLikedTrack {
  /** The song. */
  track: Track
  /** When the user liked it, as ISO 8601, when Spotify says. */
  addedAt?: string
}

/** A playlist in the user's library, with what a sync needs to tell whether it changed. */
export interface SpotifyLibraryPlaylist {
  /** The playlist: name, owner, description, artwork and track count. */
  playlist: Playlist
  /**
   * Spotify's revision of the playlist, an opaque string that changes whenever its tracks, their
   * order or its details change. Absent when Spotify sends none.
   */
  revisionId?: string
}

/** One page of a playlist's tracks, read with the user's account. */
export interface SpotifyPlaylistPage {
  /** The page of tracks. */
  tracks: Page<Track>
  /** The playlist's revision when this page was read (see {@link SpotifyLibraryPlaylist}). */
  revisionId?: string
}

/** Who is logged in, as `profileAttributes` says. */
export interface SpotifyAccountProfile {
  /** The account's user name: it never changes, unlike the display name. */
  username?: string
  /** The display name, when the account has one. */
  displayName?: string
}

// --- Safe accessors ---------------------------------------------------------------------

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The value at `path` below `value`, or `undefined`. */
function at(value: unknown, ...path: string[]): unknown {
  let current = value
  for (const key of path) {
    if (!isRecord(current)) return undefined
    current = current[key]
  }
  return current
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

/** The optional keys of `T`. */
type OptionalKeys<T> = { [K in keyof T]-?: object extends Pick<T, K> ? K : never }[keyof T]

/** `T`, except that its optional fields may also be given as `undefined`. */
type Loose<T> = Omit<T, OptionalKeys<T>> & { [K in OptionalKeys<T>]?: T[K] | undefined }

/**
 * A copy of `fields` without the entries whose value is `undefined`, so optional fields that
 * are unknown are left out rather than set to `undefined`.
 */
function defined<T extends object>(fields: Loose<T>): T {
  return Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)) as T
}

// --- Shared pieces ----------------------------------------------------------------------

/** Images from Spotify's `sources` lists, largest first. */
export function mapArtwork(sources: unknown): Artwork[] {
  const images: Artwork[] = []
  const seen = new Set<string>()
  for (const source of list(sources)) {
    const url = text(at(source, 'url'))
    if (!url?.startsWith('https://') || seen.has(url)) continue
    seen.add(url)
    const width = count(at(source, 'width'))
    const height = count(at(source, 'height'))
    images.push(defined({ url, width, height }))
  }
  return images.sort((a, b) => (b.width ?? -1) - (a.width ?? -1))
}

/**
 * An ISO 8601 date, possibly partial, from Spotify's date shapes: `{ isoString, precision }`,
 * `{ year, month, day }` or `{ year }`.
 */
export function mapDate(date: unknown): string | undefined {
  if (!isRecord(date)) return undefined
  const iso = text(date.isoString)
  const match = iso ? /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?/u.exec(iso) : null
  const precision = text(date.precision)?.toUpperCase()
  if (match) {
    const [, year, month, day] = match
    if (precision === 'YEAR' || !month) return year
    if (precision === 'MONTH' || !day) return `${year}-${month}`
    return `${year}-${month}-${day}`
  }
  const year = count(date.year)
  if (year === undefined || year < 1000 || year > 9999) return undefined
  const month = count(date.month)
  const day = count(date.day)
  const pad = (n: number) => String(n).padStart(2, '0')
  if (precision === 'YEAR' || month === undefined || month < 1 || month > 12) return String(year)
  if (precision === 'MONTH' || day === undefined || day < 1 || day > 31) {
    return `${year}-${pad(month)}`
  }
  return `${year}-${pad(month)}-${pad(day)}`
}

/** Plain text from Spotify's HTML-ish descriptions: tags removed, entities decoded. */
export function plainText(html: unknown): string | undefined {
  const raw = text(html)
  if (!raw) return undefined
  const decoded = raw
    .replace(/<br\s*\/?>/giu, '\n')
    .replace(/<[^>]*>/gu, '')
    .replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|#39);/giu, (_, entity: string) => {
      const lower = entity.toLowerCase()
      if (lower.startsWith('#x')) return codePoint(Number.parseInt(lower.slice(2), 16))
      if (lower.startsWith('#')) return codePoint(Number.parseInt(lower.slice(1), 10))
      return ENTITIES[lower] ?? `&${entity};`
    })
    .replace(/\r\n?/gu, '\n')
    .replace(/[ \t]+\n/gu, '\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim()
  return decoded === '' ? undefined : decoded
}

const ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
}

function codePoint(value: number): string {
  return Number.isInteger(value) && value > 0 && value <= 0x10ffff
    ? String.fromCodePoint(value)
    : ''
}

/** Artist references from `{ items: [{ uri, profile: { name } }] }` lists. */
function mapArtistRefs(...lists: unknown[]): ArtistRef[] {
  const refs: ArtistRef[] = []
  for (const items of lists) {
    for (const item of list(at(items, 'items'))) {
      const name = text(at(item, 'profile', 'name')) ?? text(at(item, 'name'))
      if (!name) continue
      const id = spotifyEntityIdFromUri('artist', at(item, 'uri'))
      refs.push(id ? { id, name } : { name })
    }
  }
  return refs
}

const ALBUM_TYPES: Readonly<Record<string, AlbumType>> = {
  ALBUM: 'album',
  SINGLE: 'single',
  EP: 'ep',
  COMPILATION: 'compilation',
}

/** The album type Spotify spells `ALBUM`, `SINGLE`, `EP` or `COMPILATION` (any case). */
function albumTypeOf(value: unknown): AlbumType | undefined {
  const key = text(value)?.toUpperCase()
  return key !== undefined && Object.hasOwn(ALBUM_TYPES, key) ? ALBUM_TYPES[key] : undefined
}

function explicitOf(track: JsonRecord): boolean | undefined {
  const labels = list(at(track, 'contentRatingV2', 'labels'))
  if (labels.includes('EXPLICIT')) return true
  const label = text(at(track, 'contentRating', 'label'))
  if (label === undefined) return labels.length > 0 ? false : undefined
  return label === 'EXPLICIT'
}

// --- Entities ---------------------------------------------------------------------------

/** What a track inherits from the page it was listed on, e.g. an album's tracks. */
export interface TrackContext {
  /** The album, for an album's own tracks. */
  album?: AlbumRef
  /** The album's cover, for an album's own tracks. */
  artwork?: Artwork[]
  /** The album's release date. */
  releaseDate?: string
}

/**
 * A track from any of Spotify's track shapes: search results, `getTrack`'s `trackUnion`, album
 * and playlist items, top tracks, home items and library items. `undefined` when it is not a
 * readable track (an episode, a local file, a removed item).
 */
export function mapTrack(value: unknown, context: TrackContext = {}): Track | undefined {
  if (!isRecord(value)) return undefined
  const typename = text(value.__typename)
  if (typename !== undefined && typename !== 'Track') return undefined
  const id = spotifyEntityIdFromUri('track', value.uri)
  const title = text(value.name)
  if (!id || !title) return undefined
  const nativeId = id.slice('spotify:track:'.length)
  const albumData = isRecord(value.albumOfTrack) ? value.albumOfTrack : undefined
  const albumId = spotifyEntityIdFromUri('album', albumData?.uri)
  const albumName = text(albumData?.name)
  const album: AlbumRef | undefined = albumName
    ? albumId
      ? { id: albumId, name: albumName }
      : { name: albumName }
    : context.album
  const artwork = albumData ? mapArtwork(at(albumData, 'coverArt', 'sources')) : []
  const durationMs =
    count(at(value, 'duration', 'totalMilliseconds')) ??
    count(at(value, 'trackDuration', 'totalMilliseconds'))
  return defined<Track>({
    id,
    source: 'spotify',
    title,
    artists: mapArtistRefs(value.artists, value.firstArtist, value.otherArtists),
    album,
    durationMs,
    artwork: artwork.length > 0 ? artwork : (context.artwork ?? []),
    explicit: explicitOf(value),
    kind: 'song',
    trackNumber: positive(value.trackNumber),
    discNumber: positive(value.discNumber),
    releaseDate: mapDate(albumData?.date) ?? context.releaseDate,
    externalIds: { spotify: nativeId },
  })
}

function positive(value: unknown): number | undefined {
  const n = count(value)
  return n !== undefined && n > 0 ? n : undefined
}

/**
 * An album from `getAlbum`'s `albumUnion`, a search result, a discography release or a home
 * item. Its `tracks` come from `tracksV2`, present only on the album page itself.
 */
export function mapAlbum(value: unknown): Album | undefined {
  if (!isRecord(value)) return undefined
  const typename = text(value.__typename)
  if (typename !== undefined && typename !== 'Album') return undefined
  const id = spotifyEntityIdFromUri('album', value.uri)
  const name = text(value.name)
  if (!id || !name) return undefined
  const artwork = mapArtwork(at(value, 'coverArt', 'sources'))
  const releaseDate = mapDate(value.date)
  const type = albumTypeOf(value.type) ?? albumTypeOf(value.albumType)
  const trackPage = value.tracksV2 ?? value.tracks
  let tracks: Track[] | undefined
  if (isRecord(value.tracksV2)) {
    const context: TrackContext = defined({ album: { id, name }, artwork, releaseDate })
    tracks = list(value.tracksV2.items)
      .map((item) => mapTrack(at(item, 'track'), context))
      .filter((track): track is Track => track !== undefined)
  }
  return defined<Album>({
    id,
    source: 'spotify',
    name,
    artists: mapArtistRefs(value.artists),
    artwork,
    type,
    releaseDate,
    trackCount: count(at(trackPage, 'totalCount')),
    explicit: tracks && tracks.length > 0 ? tracks.some((t) => t.explicit === true) : undefined,
    tracks,
  })
}

/**
 * An artist from a search result, a related artist, a home item or `queryArtistOverview`'s
 * `artistUnion`, with its top tracks, releases and related artists when the page has them.
 */
export function mapArtist(value: unknown): Artist | undefined {
  if (!isRecord(value)) return undefined
  const typename = text(value.__typename)
  if (typename !== undefined && typename !== 'Artist') return undefined
  const id = spotifyEntityIdFromUri('artist', value.uri)
  const name = text(at(value, 'profile', 'name'))
  if (!id || !name) return undefined
  const discography = at(value, 'discography')
  const topTracks = isRecord(at(discography, 'topTracks'))
    ? list(at(discography, 'topTracks', 'items'))
        .map((item) => mapTrack(at(item, 'track')))
        .filter((track): track is Track => track !== undefined)
    : undefined
  const related = isRecord(at(value, 'relatedContent', 'relatedArtists'))
    ? mapArtists(at(value, 'relatedContent', 'relatedArtists', 'items'))
    : undefined
  return defined<Artist>({
    id,
    source: 'spotify',
    name,
    artwork: mapArtwork(at(value, 'visuals', 'avatarImage', 'sources')),
    description: plainText(at(value, 'profile', 'biography', 'text')),
    topTracks,
    albums: isRecord(discography) ? mapDiscography(discography, { id, name }) : undefined,
    related,
  })
}

/**
 * Releases from an artist page: albums, singles and EPs, then compilations, without repeats.
 * Spotify lists no artists on them, so they get the page's artist.
 */
function mapDiscography(discography: JsonRecord, artist: ArtistRef): Album[] {
  const albums: Album[] = []
  const seen = new Set<string>()
  const add = (value: unknown) => {
    const album = mapAlbum(value)
    if (album && !seen.has(album.id)) {
      seen.add(album.id)
      albums.push(album.artists.length > 0 ? album : { ...album, artists: [artist] })
    }
  }
  for (const group of ['albums', 'singles', 'compilations']) {
    for (const item of list(at(discography, group, 'items'))) {
      add(list(at(item, 'releases', 'items'))[0])
    }
  }
  if (albums.length === 0) {
    for (const item of list(at(discography, 'popularReleasesAlbums', 'items'))) add(item)
  }
  return albums
}

/** Artists from a list of artist objects. */
export function mapArtists(items: unknown): Artist[] {
  return list(items)
    .map((item) => mapArtist(item))
    .filter((artist): artist is Artist => artist !== undefined)
}

/** The related artists in `queryArtistRelated`'s `artistUnion`. */
export function mapRelatedArtists(artistUnion: unknown): Artist[] {
  return mapArtists(at(artistUnion, 'relatedContent', 'relatedArtists', 'items'))
}

/** How many raw items a page of album tracks (`albumUnion.tracksV2`) holds, readable or not. */
export function albumTracksOnPage(albumUnion: unknown): number {
  return list(at(albumUnion, 'tracksV2', 'items')).length
}

/** The page of tracks of a playlist's `content`, starting at `offset`, `limit` long. */
export function mapPlaylistItems(content: unknown, offset: number, limit: number): Page<Track> {
  const items = list(at(content, 'items'))
    .map((item) => mapTrack(at(item, 'itemV2', 'data')))
    .filter((track): track is Track => track !== undefined)
  return pageOf(items, offset, limit, count(at(content, 'totalCount')))
}

/**
 * The page of tracks in a `fetchPlaylist` answer's `playlistV2`, starting at `offset`, `limit`
 * long, or `undefined` when its `content` holds no list of items. Unlike {@link mapPlaylist},
 * which reads a missing list as an empty page, it never lets an answer it can't read pass for a
 * playlist that Spotify emptied: a sync would take the songs out of its copy.
 */
export function mapPlaylistContent(
  playlistV2: unknown,
  offset: number,
  limit: number,
): Page<Track> | undefined {
  const content = at(playlistV2, 'content')
  return Array.isArray(at(content, 'items')) ? mapPlaylistItems(content, offset, limit) : undefined
}

/**
 * A playlist from `fetchPlaylist`'s `playlistV2`, a search result, a home item or a library
 * item. With `page`, `tracks` holds that page of its `content`.
 */
export function mapPlaylist(
  value: unknown,
  page?: { offset: number; limit: number },
): Playlist | undefined {
  if (!isRecord(value)) return undefined
  const typename = text(value.__typename)
  if (typename !== undefined && typename !== 'Playlist') return undefined
  const id = spotifyEntityIdFromUri('playlist', value.uri)
  const name = text(value.name)
  if (!id || !name) return undefined
  const ownerData = at(value, 'ownerV2', 'data')
  const ownerName = text(at(ownerData, 'name'))
  const ownerId = text(at(ownerData, 'username')) ?? parseSpotifyUri(at(ownerData, 'uri'))?.id
  const owner: PlaylistOwner | undefined = ownerName
    ? defined({ name: ownerName, id: ownerId })
    : undefined
  const content = value.content
  return defined<Playlist>({
    id,
    source: 'spotify',
    name,
    owner,
    description: plainText(value.description),
    artwork: mapArtwork(at(list(at(value, 'images', 'items'))[0], 'sources')),
    trackCount: count(at(content, 'totalCount')),
    tracks:
      page && isRecord(content) ? mapPlaylistItems(content, page.offset, page.limit) : undefined,
  })
}

/** One page: `nextCursor` is the next offset while the total says more items remain. */
export function pageOf<T>(items: T[], offset: number, limit: number, total?: number): Page<T> {
  const next = offset + Math.max(limit, items.length)
  const more = total !== undefined ? next < total : items.length >= limit && items.length > 0
  return defined<Page<T>>({
    items,
    nextCursor: more ? String(next) : undefined,
    total,
  })
}

// --- Search -----------------------------------------------------------------------------

/** The four kinds of results Spotify search returns that FXM shows. */
export interface SpotifySearchPages {
  tracks?: Page<Track>
  albums?: Page<Album>
  artists?: Page<Artist>
  playlists?: Page<Playlist>
}

function wrapped(item: unknown): unknown {
  // Track results are wrapped twice ({ item: { data } }), the others once ({ data }).
  return at(item, 'item', 'data') ?? at(item, 'data')
}

function searchPage<T>(
  section: unknown,
  map: (value: unknown) => T | undefined,
  offset: number,
  limit: number,
): Page<T> | undefined {
  if (!isRecord(section)) return undefined
  const items = list(section.items)
    .map((item) => map(wrapped(item)))
    .filter((value): value is T => value !== undefined)
  const total = count(section.totalCount)
  const nextOffset = at(section, 'pagingInfo', 'nextOffset')
  if (nextOffset === null) return defined<Page<T>>({ items, total })
  const next = count(nextOffset)
  if (next !== undefined && next > offset) {
    return defined<Page<T>>({
      items,
      nextCursor: total === undefined || next < total ? String(next) : undefined,
      total,
    })
  }
  return pageOf(items, offset, limit, total)
}

/** The result pages of `searchDesktop` or a typed search's `searchV2`. */
export function mapSearch(searchV2: unknown, offset: number, limit: number): SpotifySearchPages {
  return defined<SpotifySearchPages>({
    tracks: searchPage(at(searchV2, 'tracksV2'), (v) => mapTrack(v), offset, limit),
    albums: searchPage(at(searchV2, 'albumsV2'), mapAlbum, offset, limit),
    artists: searchPage(at(searchV2, 'artists'), mapArtist, offset, limit),
    playlists: searchPage(at(searchV2, 'playlists'), (v) => mapPlaylist(v), offset, limit),
  })
}

// --- Home -------------------------------------------------------------------------------

/** A home-feed item, from `{ content: { __typename: '…ResponseWrapper', data } }`. */
export function mapShelfItem(item: unknown): ShelfItem | undefined {
  const data = at(item, 'content', 'data')
  switch (text(at(data, '__typename'))) {
    case 'Track': {
      const track = mapTrack(data)
      return track && { type: 'track', track }
    }
    case 'Album': {
      const album = mapAlbum(data)
      return album && { type: 'album', album }
    }
    case 'Artist': {
      const artist = mapArtist(data)
      return artist && { type: 'artist', artist }
    }
    case 'Playlist': {
      const playlist = mapPlaylist(data)
      return playlist && { type: 'playlist', playlist }
    }
    default:
      return undefined
  }
}

/** A home section as a shelf: its URI as the ID, its title, and the items FXM can show. */
export function mapShelf(section: unknown): Shelf | undefined {
  const id = text(at(section, 'uri'))
  const titleData = at(section, 'data', 'title')
  const title = text(at(titleData, 'transformedLabel')) ?? text(at(titleData, 'translatedBaseText'))
  if (!id || !title) return undefined
  const subtitleData = at(section, 'data', 'subtitle')
  const subtitle =
    text(at(subtitleData, 'transformedLabel')) ?? text(at(subtitleData, 'translatedBaseText'))
  const items = list(at(section, 'sectionItems', 'items'))
    .map(mapShelfItem)
    .filter((item): item is ShelfItem => item !== undefined)
  return defined<Shelf>({ id, title, subtitle, items })
}

/** The shelves of `home`, leaving out empty ones. */
export function mapHome(home: unknown): Shelf[] {
  return list(at(home, 'sectionContainer', 'sections', 'items'))
    .map(mapShelf)
    .filter((shelf): shelf is Shelf => shelf !== undefined && shelf.items.length > 0)
}

/** One page of a home section, from `homeSection`'s `homeSections`. */
export interface SpotifyHomeSectionPage {
  /** The section as a shelf, holding this page's items. */
  shelf: Shelf
  /** The cursor of the next page; absent on the last one. */
  nextCursor?: string
  /** How many items the section has in all, when Spotify says. */
  total?: number
}

/** The page of the one section in a `homeSection` answer, or `undefined` when there is none. */
export function mapHomeSection(homeSections: unknown): SpotifyHomeSectionPage | undefined {
  const section = list(at(homeSections, 'sections'))[0]
  const shelf = mapShelf(section)
  if (!shelf) return undefined
  const next = count(at(section, 'sectionItems', 'pagingInfo', 'nextOffset'))
  return defined<SpotifyHomeSectionPage>({
    shelf,
    nextCursor: next !== undefined && next > 0 ? String(next) : undefined,
    total: count(at(section, 'sectionItems', 'totalCount')),
  })
}

// --- Library (logged in) ----------------------------------------------------------------

/**
 * A liked song from `fetchLibraryTracks`: `{ addedAt: { isoString }, track: { _uri, data } }`,
 * where the track's URI sits on the wrapper.
 */
export function mapLibraryTrack(item: unknown): SpotifyLikedTrack | undefined {
  const wrapper = at(item, 'track')
  const data = at(wrapper, 'data')
  const track = isRecord(data) ? mapTrack({ uri: at(wrapper, '_uri'), ...data }) : undefined
  if (!track) return undefined
  const added = at(item, 'addedAt')
  const addedAt = text(isRecord(added) ? added.isoString : added)
  return defined<SpotifyLikedTrack>({
    track,
    addedAt: addedAt !== undefined && !Number.isNaN(Date.parse(addedAt)) ? addedAt : undefined,
  })
}

/** A revision ID: a short opaque string, or `undefined`. */
export function revisionOf(value: unknown): string | undefined {
  const revision = text(value)
  return revision !== undefined && revision.length <= 256 ? revision : undefined
}

/**
 * A playlist from a `libraryV3` item: `{ item: { _uri, data: { __typename: 'Playlist',
 * revisionId, currentUserCapabilities } } }`. Like Spotify's own player, it leaves out a
 * playlist whose revision is `null` or that the user may not view: its tracks can't be read.
 * Folders, albums, artists and the user's episodes are not playlists, so they are left out too.
 */
export function mapLibraryPlaylist(item: unknown): SpotifyLibraryPlaylist | undefined {
  const wrapper = at(item, 'item')
  const data = at(wrapper, 'data')
  if (!isRecord(data) || data.revisionId === null) return undefined
  if (at(data, 'currentUserCapabilities', 'canView') === false) return undefined
  const playlist = mapPlaylist({ uri: at(wrapper, '_uri'), ...data })
  if (!playlist) return undefined
  return defined<SpotifyLibraryPlaylist>({ playlist, revisionId: revisionOf(data.revisionId) })
}

/**
 * The liked songs in a `fetchLibraryTracks` answer (`me.library.tracks`, a
 * `UserLibraryTrackPage`), or `undefined` when the answer is not such a page or holds no list of
 * items: a sync must never take an answer it can't read for an empty library.
 */
export function mapLibraryTracks(
  data: unknown,
  offset: number,
  limit: number,
): Page<SpotifyLikedTrack> | undefined {
  const page = at(data, 'me', 'library', 'tracks')
  const raw = at(page, 'items')
  if (text(at(page, '__typename')) !== 'UserLibraryTrackPage' || !Array.isArray(raw)) {
    return undefined
  }
  const items = raw
    .map(mapLibraryTrack)
    .filter((liked): liked is SpotifyLikedTrack => liked !== undefined)
  return pageOf(items, offset, limit, count(at(page, 'totalCount')))
}

/**
 * The saved playlists in a `libraryV3` answer (`me.libraryV3`, a `LibraryPage`), or `undefined`
 * when the answer is not such a page or holds no list of items. Folders and other kinds of
 * items are left out.
 */
export function mapLibraryPlaylists(
  data: unknown,
  offset: number,
  limit: number,
): Page<SpotifyLibraryPlaylist> | undefined {
  const page = at(data, 'me', 'libraryV3')
  const raw = at(page, 'items')
  if (text(at(page, '__typename')) !== 'LibraryPage' || !Array.isArray(raw)) return undefined
  const items = raw
    .map(mapLibraryPlaylist)
    .filter((playlist): playlist is SpotifyLibraryPlaylist => playlist !== undefined)
  return pageOf(items, offset, limit, count(at(page, 'totalCount')))
}

/**
 * Who is logged in, from a `profileAttributes` answer (`me.profile`: `username`, `name`), or
 * `undefined` when the answer has no profile.
 */
export function mapProfile(data: unknown): SpotifyAccountProfile | undefined {
  const profile = at(data, 'me', 'profile')
  if (!isRecord(profile)) return undefined
  const username = text(profile.username)
  return defined<SpotifyAccountProfile>({
    username: username !== undefined && username.length <= 256 ? username : undefined,
    displayName: text(profile.name),
  })
}

/**
 * The entity in a GraphQL union field such as `trackUnion`, when its `__typename` is
 * `typename`; otherwise what Spotify put there instead: `NotFound` with its message, or another
 * typename such as `GenericError`.
 */
export function unionOf(
  value: unknown,
  typename: string,
): { found: true } | { found: false; typename: string; message?: string } {
  const actual = text(at(value, '__typename'))
  if (actual === typename) return { found: true }
  return defined<{ found: false; typename: string; message?: string }>({
    found: false,
    typename: actual ?? 'missing',
    message: text(at(value, 'message')),
  })
}

// --- spclient ---------------------------------------------------------------------------

/** The ISRC, label, release date, album type and popularity in a `metadata/4/track` answer. */
export function mapTrackDetails(value: unknown): SpotifyTrackDetails {
  const isrcEntry = list(at(value, 'external_id')).find(
    (entry) => text(at(entry, 'type'))?.toLowerCase() === 'isrc',
  )
  const popularity = count(at(value, 'popularity'))
  return defined<SpotifyTrackDetails>({
    isrc: normalizeIsrc(at(isrcEntry, 'id')) ?? undefined,
    label: text(at(value, 'album', 'label'))?.trim(),
    releaseDate: mapDate(at(value, 'album', 'date')),
    albumType: albumTypeOf(at(value, 'album', 'type')),
    popularity: popularity !== undefined && popularity <= 100 ? popularity : undefined,
  })
}

/** The playlist a `seed_to_playlist` answer points to, as its base62 ID. */
export function radioPlaylistId(value: unknown): string | undefined {
  for (const item of list(at(value, 'mediaItems'))) {
    const ref = parseSpotifyUri(at(item, 'uri'))
    if (ref?.type === 'playlist') return ref.id
  }
  return undefined
}
