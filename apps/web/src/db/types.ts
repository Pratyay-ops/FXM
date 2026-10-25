/**
 * What the library database stores (see `database.ts`): one record type per table, the IDs of
 * the built-in playlists and the vocabulary of the match cache and import progress.
 *
 * Everything here is plain data that survives structured cloning and `JSON.stringify`, so the
 * same records go into IndexedDB and into backup files. Optional fields follow
 * `exactOptionalPropertyTypes`: leave them out, never set them to `undefined`.
 *
 * @module
 */

import {
  type AffinityEntry,
  type ArtistRef,
  type Artwork,
  type AudioCandidate,
  type CatalogMode,
  type EntityId,
  formatId,
  type JsonValue,
  type MatchSignals,
  type PlayContext,
  type PlayStream,
  parseId,
  type Track,
} from '@fxm/core'

/** The IndexedDB database every FXM app uses for the library. */
export const DB_NAME = 'fxm'

/** The built-in playlists: every library has them, and they can't be renamed or deleted. */
export type SystemPlaylist = 'liked' | 'downloads'

/**
 * Liked songs. Which songs are liked lives in the `likes` table, with the time of each like;
 * this playlist record holds their custom order.
 */
export const LIKED_PLAYLIST_ID = formatId('local', 'playlist', 'liked')

/**
 * Downloads. The download manager (stage 4.1) adds a track when its download completes and
 * removes it when the download is deleted. It is empty until then.
 */
export const DOWNLOADS_PLAYLIST_ID = formatId('local', 'playlist', 'downloads')

/** The ID of each built-in playlist. */
export const SYSTEM_PLAYLIST_IDS: Readonly<Record<SystemPlaylist, EntityId<'playlist'>>> = {
  liked: LIKED_PLAYLIST_ID,
  downloads: DOWNLOADS_PLAYLIST_ID,
}

/** Display names of the built-in playlists. */
export const SYSTEM_PLAYLIST_NAMES: Readonly<Record<SystemPlaylist, string>> = {
  liked: 'Liked songs',
  downloads: 'Downloads',
}

/** Whether `id` names a playlist that lives in this library (`local:playlist:…`). */
export function isLocalPlaylistId(id: unknown): id is EntityId<'playlist'> {
  const parts = parseId(id)
  return parts !== null && parts.source === 'local' && parts.kind === 'playlist'
}

/** The built-in playlist `id` names, if any. */
export function systemPlaylistOf(id: string): SystemPlaylist | undefined {
  if (id === LIKED_PLAYLIST_ID) return 'liked'
  if (id === DOWNLOADS_PLAYLIST_ID) return 'downloads'
  return undefined
}

/** A cached track: the metadata every list of the library shows. */
export interface TrackRecord {
  /** The track's ID, exactly as its source spells it. */
  id: EntityId<'track'>
  /** The track as the source described it last. */
  track: Track
  /** When the metadata was last saved, as epoch milliseconds. */
  updatedAt: number
}

/** A liked track. */
export interface LikeRecord {
  /**
   * `entityKey(trackId)`, so a song liked as `ytm:track:x` also counts as liked when it shows up
   * as `yt:track:x`.
   */
  key: string
  /** The track that was liked, with the ID it had then. */
  trackId: EntityId<'track'>
  /** When it was liked, as epoch milliseconds. */
  likedAt: number
}

/**
 * The order before the last shuffle, or before a sort was saved as the custom order. It stays
 * until the next change of that order, so Undo can bring it back.
 */
export interface OrderUndo {
  /** What replaced the order. */
  action: 'shuffle' | 'sort'
  /** The order before it. */
  order: string[]
}

/** A playlist of this library: one the user made, or a built-in one. */
export interface PlaylistRecord {
  /** `local:playlist:<uuid>` for the user's playlists, or a built-in playlist's ID. */
  id: EntityId<'playlist'>
  /** Set on the built-in playlists, which can't be renamed or deleted. */
  system?: SystemPlaylist
  /** Name, at most {@link MAX_NAME_LENGTH} characters. */
  name: string
  /** Description, at most {@link MAX_DESCRIPTION_LENGTH} characters. */
  description?: string
  /** Cover art, e.g. the cover of an imported playlist. Lists show the first track's otherwise. */
  artwork?: Artwork[]
  /** When it was created, as epoch milliseconds. */
  createdAt: number
  /** When its name, description, tracks or order last changed. */
  updatedAt: number
  /**
   * The saved custom order: every track of the playlist, each once (no two share an
   * `entityKey`). For Liked songs, the order of the liked tracks.
   */
  trackIds: EntityId<'track'>[]
  /**
   * When each track was added, by track ID. Liked songs leaves it empty: its dates are the
   * `likedAt` of the `likes` table.
   */
  addedAt: Record<string, number>
  /** The order before the last shuffle or saved sort, until the next change. */
  undo?: OrderUndo
}

/** The ID of the order of the playlists list, in the `orders` table. */
export const PLAYLISTS_ORDER_ID = 'playlists'

/** The custom order of the list of playlists (the sidebar and the Library's Playlists tab). */
export interface OrderRecord {
  /** Always {@link PLAYLISTS_ORDER_ID}. */
  id: typeof PLAYLISTS_ORDER_ID
  /** The library's playlists and followed playlists, in the order the user chose. */
  order: EntityId<'playlist'>[]
  /** The order before the last shuffle or saved sort, until the next change. */
  undo?: OrderUndo
  /** When the order last changed. */
  updatedAt: number
}

/** What can be followed: an artist, an album (saved album) or another source's playlist. */
export type FollowKind = 'artist' | 'album' | 'playlist'

/** Every {@link FollowKind}. */
export const FOLLOW_KINDS: readonly FollowKind[] = ['artist', 'album', 'playlist']

/** A followed artist, a saved album or a followed playlist from a source. */
export interface FollowRecord {
  /** `entityKey(id)`. */
  key: string
  /** The entity's ID. */
  id: EntityId<FollowKind>
  /** What it is. */
  kind: FollowKind
  /** Its name, saved so the library can list it offline. */
  name: string
  /** Its artwork, saved for the same reason. May be empty. */
  artwork: Artwork[]
  /** An album's artists. */
  artists?: ArtistRef[]
  /** A playlist's owner, by name. */
  owner?: string
  /** When it was followed, as epoch milliseconds. */
  followedAt: number
}

/**
 * Where a play started, like the player's queue context: an album, a playlist, an artist, a
 * radio or a search. The type stays an open string so that newer contexts in a backup survive.
 * The listening signals (stage 3.1) define it in `@fxm/core`.
 */
export type { PlayContext }

/** What actually played: `PlayStream` from `@fxm/core`, which the listening signals share. */
export type StreamInfo = PlayStream

/**
 * One play of a track: a play signal (stage 3.1, see `ListeningSignal` in `@fxm/core`). The
 * history feeds Recently played and the listening affinity.
 */
export interface HistoryRecord {
  /** Auto-incremented by the database. */
  id: number
  /** The track that played. */
  trackId: EntityId<'track'>
  /** When playback started, as epoch milliseconds. */
  playedAt: number
  /** How long it played, in milliseconds: listening time, without pauses and skipped parts. */
  playedMs: number
  /** The track's length when it played, in milliseconds, when known. */
  durationMs?: number
  /** Whether it played to the end. */
  completed: boolean
  /** Whether the user skipped it. */
  skipped: boolean
  /** Where the play started. */
  context?: PlayContext
  /** What actually played. */
  stream?: StreamInfo
  /** The import that brought it in (an `importProgress` ID), for plays from another service. */
  importId?: string
}

/**
 * The listening affinity of one track, artist or tag (stage 3.1): a core `AffinityEntry`, kept
 * up to date by the repository with every play, like and playlist change. It is derived from
 * the history, the likes and the playlists, so backups leave it out and rebuild it.
 */
export interface AffinityRecord extends AffinityEntry {
  /** `<kind>|<key>`, e.g. `artist|radiohead`: see `affinityId`. */
  id: string
  /** `affinityRank(entry)`, indexed with the kind, so the top entries read straight off it. */
  rank: number
}

/** Reserved for settings that outgrow `localStorage`. Nothing uses it yet. */
export interface SettingRecord {
  /** Setting name. */
  key: string
  /** Its value. */
  value: JsonValue
  /** When it last changed. */
  updatedAt: number
}

/**
 * How sure the matching engine is about a source track's audio (ARCHITECTURE §12):
 *
 * - `auto`: plays without asking
 * - `suggest`: plays only after the user acts ("Not the right version?")
 * - `none`: no candidate is good enough; alternatives and a manual search are offered
 */
export type MatchBand = 'auto' | 'suggest' | 'none'

/** Every {@link MatchBand}. */
export const MATCH_BANDS: readonly MatchBand[] = ['auto', 'suggest', 'none']

/** How long an engine decision stays in the match cache. Pins never expire. */
export const MATCH_TTL_MS = 30 * 24 * 60 * 60 * 1000

/**
 * The cached decision about one source track's audio in one catalog mode, e.g. which YouTube
 * Music song plays for a Spotify track. Written by the matching engine and by the user's
 * "Not the right version?" choice.
 *
 * A decision counts as confirmed only when it is pinned or in the `auto` band (see
 * `isConfirmedMatch`): a `suggest` guess is never stored as confirmed.
 */
export interface MatchCacheRecord {
  /** `<sourceKey>|<mode>`: see `matchKey`. */
  key: string
  /** `entityKey(sourceTrackId)`. */
  sourceKey: string
  /** The track that needed audio, e.g. `spotify:track:…`. */
  sourceTrackId: EntityId<'track'>
  /** The catalog mode the decision was made in. */
  mode: CatalogMode
  /** The source track's ISRC, when known, for lookups by ISRC. */
  isrc?: string
  /** How sure the engine is, or the band of the candidate the user pinned. */
  band: MatchBand
  /** The engine's best candidate, or the one the user pinned. Absent when there is none. */
  candidate?: AudioCandidate
  /** The other candidates, best first, for the version switcher. */
  alternatives: AudioCandidate[]
  /** The facts the decision rested on (ISRC, release, album), when the engine computed them. */
  signals?: MatchSignals
  /** Why the decision came out this way, for people, e.g. `isrc`, `title 0.97`. */
  evidence: string[]
  /**
   * Whether the user chose `candidate`. A pin always wins: the engine never overwrites it, and
   * it is never deleted automatically.
   */
  userPinned: boolean
  /** When the decision was made, as epoch milliseconds. */
  decidedAt: number
}

/** Where an import stands. */
export type ImportStatus = 'pending' | 'running' | 'paused' | 'done' | 'failed' | 'cancelled'

/** Every {@link ImportStatus}. */
export const IMPORT_STATUSES: readonly ImportStatus[] = [
  'pending',
  'running',
  'paused',
  'done',
  'failed',
  'cancelled',
]

/** The progress of one import (stage 3.6), saved as it goes so that it can resume. */
export interface ImportProgressRecord {
  /** A random ID. */
  id: string
  /** What is imported, e.g. `spotify-data-export`, `csv`, `m3u` or `youtube-playlist`. */
  kind: string
  /** What the user sees, e.g. the file or playlist name. */
  label: string
  /** Where it stands. */
  status: ImportStatus
  /** The playlist the import fills, once created. */
  playlistId?: EntityId<'playlist'>
  /** Rows in the input. */
  total: number
  /** Rows processed so far: the import resumes after them. */
  done: number
  /** Rows matched to audio. */
  matched: number
  /** Rows waiting for the user's review (Suggest band or no match). */
  needsReview: number
  /** Rows that failed. */
  failed: number
  /** The importer's own resume data, defined by stage 3.6. */
  state?: JsonValue
  /** Why the import failed, for people. */
  error?: string
  /** When it started, as epoch milliseconds. */
  createdAt: number
  /** When it last saved progress. */
  updatedAt: number
}

/** Longest playlist name the library stores. */
export const MAX_NAME_LENGTH = 100

/** Longest playlist description the library stores. */
export const MAX_DESCRIPTION_LENGTH = 300
