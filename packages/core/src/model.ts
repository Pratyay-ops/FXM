/**
 * The domain model shared by every provider and app: tracks, albums, artists, playlists, pages,
 * search results and home-feed shelves. Types, plus one type guard.
 *
 * Optional fields are declared as `field?: T`. Under `exactOptionalPropertyTypes` that means
 * "leave it out when unknown": never set an optional field to `undefined`.
 *
 * @module
 */

import type { EntityId, EntityKind, SourceId } from './ids'

/** One size of a cover image or photo. */
export interface Artwork {
  /** Image URL. */
  url: string
  /** Width in pixels, when the source says. */
  width?: number
  /** Height in pixels, when the source says. */
  height?: number
}

/** A pointer to an artist, as listed on a track or album. */
export interface ArtistRef {
  /** The artist's ID, when the source links one. */
  id?: EntityId<'artist'>
  /** Display name. */
  name: string
}

/** A pointer to an album, as listed on a track. */
export interface AlbumRef {
  /** The album's ID, when the source links one. */
  id?: EntityId<'album'>
  /** Display name. */
  name: string
}

/**
 * What a track is, which drives the catalog-mode policy (see `modePolicy`):
 *
 * - `song`: a catalog song, i.e. official album audio. YouTube Music songs (`musicVideoType`
 *   `ATV`) and every audio track from Spotify, Internet Archive, Jamendo or local files
 * - `music-video`: an official music video (`OMV` / `OFFICIAL_SOURCE_MUSIC`), which may link
 *   the song it is the video of (`Track.songId`)
 * - `video`: any other YouTube video (`UGC`, or no `musicVideoType`): covers, live sets, uploads
 * - `episode`: a podcast episode (hidden for now)
 */
export type TrackKind = 'song' | 'music-video' | 'video' | 'episode'

/** A playable recording: a song, a music video, a video or an episode. */
export interface Track {
  /** Source-qualified ID, e.g. `ytm:track:dQw4w9WgXcQ`. */
  id: EntityId<'track'>
  /** The source the metadata came from (the same as in `id`). */
  source: SourceId
  /** Title as the source shows it. */
  title: string
  /** Credited artists, main artist first. */
  artists: ArtistRef[]
  /** The album the track appears on. */
  album?: AlbumRef
  /** Duration in milliseconds. */
  durationMs?: number
  /** Cover art in the sizes the source offers. May be empty. */
  artwork: Artwork[]
  /** Whether the source marks the track as explicit. */
  explicit?: boolean
  /**
   * International Standard Recording Code in canonical form: 12 upper-case characters without
   * hyphens or spaces, e.g. `GBARL9300135`. Providers store it through `normalizeIsrc`, so ISRCs
   * from every source compare equal.
   */
  isrc?: string
  /** Song, music video, video or episode. */
  kind: TrackKind
  /**
   * For an official music video (`kind` `music-video`): the song it is the video of, when the
   * source links the two, e.g. `ytm:track:<videoId of the song>`. Never the video's own ID.
   * YouTube Music's album pages link official videos to their songs, so the YouTube provider sets
   * it from them; anonymous search and `next` results carry no such link, so it is often absent.
   * Music mode plays a linked video as this song (see `songForVideo` and `modePolicy`). Tracks
   * of other kinds leave it out.
   */
  songId?: EntityId<'track'>
  /** Position on its disc, starting at 1. */
  trackNumber?: number
  /** Disc number, starting at 1. */
  discNumber?: number
  /** Release date as ISO 8601, possibly partial: `2013`, `2013-05` or `2013-05-17`. */
  releaseDate?: string
  /**
   * Popularity from 0 to 100, higher is more popular. Spotify's value is used as is; other
   * sources scale their own signal to the same range.
   */
  popularity?: number
  /**
   * Native IDs (not full {@link EntityId}s) of the same recording in other sources, once known,
   * e.g. `{ spotify: '4uLU6hMCjMI75M1A2tKUQC' }`.
   */
  externalIds?: Partial<Record<SourceId, string>>
}

/**
 * Whether a radio seed (`RadioSeed`, a track or an artist reference) is a track. Tracks always
 * have a `kind`; artist references never do.
 */
export function isTrackSeed(seed: Track | ArtistRef): seed is Track {
  return 'kind' in seed
}

/** The release type of an album. */
export type AlbumType = 'album' | 'single' | 'ep' | 'compilation'

/** An album, single, EP or compilation. */
export interface Album {
  /** Source-qualified ID. */
  id: EntityId<'album'>
  /** The source the metadata came from. */
  source: SourceId
  /** Album name. */
  name: string
  /** Credited artists, main artist first. */
  artists: ArtistRef[]
  /** Cover art in the sizes the source offers. May be empty. */
  artwork: Artwork[]
  /** Release type, when the source says. */
  type?: AlbumType
  /** Release date as ISO 8601, possibly partial. */
  releaseDate?: string
  /** Number of tracks, when known without loading them. */
  trackCount?: number
  /** Whether the source marks the album as explicit. */
  explicit?: boolean
  /**
   * Every track in album order. Present when the album itself was loaded, absent in lists such
   * as search results or an artist's discography.
   */
  tracks?: Track[]
}

/** An artist or channel. */
export interface Artist {
  /** Source-qualified ID. */
  id: EntityId<'artist'>
  /** The source the metadata came from. */
  source: SourceId
  /** Display name. */
  name: string
  /** Photos in the sizes the source offers. May be empty. */
  artwork: Artwork[]
  /** Biography or channel description. */
  description?: string
  /** The artist's most popular tracks, when the artist page was loaded. */
  topTracks?: Track[]
  /** Albums, singles and EPs, when the artist page was loaded. */
  albums?: Album[]
  /** Similar artists, when the source lists them on the artist page. */
  related?: Artist[]
}

/** Who made a playlist. */
export interface PlaylistOwner {
  /** Display name. */
  name: string
  /** The owner's native ID in the playlist's source, when known. */
  id?: string
}

/** A playlist. Large playlists come one page of tracks at a time. */
export interface Playlist {
  /** Source-qualified ID. */
  id: EntityId<'playlist'>
  /** The source the metadata came from. */
  source: SourceId
  /** Playlist name. */
  name: string
  /** Who made it. */
  owner?: PlaylistOwner
  /** Description as written by the owner. */
  description?: string
  /** Cover art in the sizes the source offers. May be empty. */
  artwork: Artwork[]
  /** Total number of tracks, when known. */
  trackCount?: number
  /**
   * The first page of tracks. Present when the playlist itself was loaded, absent in lists such
   * as search results. Further pages come from `MetadataProvider.getPlaylistTracks`.
   */
  tracks?: Page<Track>
}

/** One page of a longer list. */
export interface Page<T> {
  /** The items on this page, in order. */
  items: T[]
  /** Opaque cursor for the next page. Absent on the last page. */
  nextCursor?: string
  /** Total number of items across all pages, when the source says. */
  total?: number
}

/**
 * The kinds of results a search can ask for: every {@link EntityKind}, plus `video`. Songs and
 * videos are separate types, so each has its own page and cursor:
 *
 * - `track`: songs (kind `song`), i.e. YouTube Music catalog songs and the tracks of non-YouTube
 *   sources, in both modes
 * - `video`: official music videos and other videos (kinds `music-video` and `video`). Only
 *   Music + Video mode shows them, so request this type only in `all` mode; in `music` mode a
 *   provider answers it with an empty page
 * - `album`, `artist` and `playlist`
 */
export type SearchType = EntityKind | 'video'

/**
 * The results of one search: one page per requested type. A type that was not requested is
 * absent; a requested type with no results is an empty page.
 */
export interface SearchResults {
  /** Songs (kind `song` only), for the `track` type. Never holds videos. */
  tracks?: Page<Track>
  /**
   * Official music videos and other videos (kinds `music-video` and `video`), for the `video`
   * type. Always an empty page in `music` mode.
   */
  videos?: Page<Track>
  /** Albums. */
  albums?: Page<Album>
  /** Artists. */
  artists?: Page<Artist>
  /** Playlists, without their tracks. */
  playlists?: Page<Playlist>
}

/** One item on a home-feed shelf, tagged with its type. */
export type ShelfItem =
  | { type: 'track'; track: Track }
  | { type: 'album'; album: Album }
  | { type: 'artist'; artist: Artist }
  | { type: 'playlist'; playlist: Playlist }

/** A titled row of a home feed, such as "Quick picks" or "Because you listened to X". */
export interface Shelf {
  /** Stable ID, unique within one feed. */
  id: string
  /** Title shown above the row. */
  title: string
  /** Smaller line under the title. */
  subtitle?: string
  /** The row's items, in order. */
  items: ShelfItem[]
}
