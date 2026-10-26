/**
 * The library repository: the only code that reads and writes the library database. Pages read
 * through the hooks in `hooks.ts`, which run these reads as live queries; everything else,
 * backups included (`backup.ts` validates the file, then calls `restore`), calls the methods
 * directly. The database itself is not part of the repository's API.
 *
 * Every write runs in one IndexedDB transaction, so a change either lands whole or not at all,
 * and every order change is a single write of one record (see `ordering.ts`).
 *
 * @module
 */

import {
  type Album,
  type Artist,
  type Artwork,
  type AudioCandidate,
  type CatalogMode,
  type EntityId,
  entityKey,
  fisherYatesShuffle,
  formatId,
  type Playlist,
  parseId,
  type QueueContext,
  type RandomSource,
  type Track,
} from '@fxm/core'
import { Dexie } from 'dexie'
import { ensureSystemRecords, type FxmDatabase, openDatabase, TABLE_NAMES } from './database'
import {
  isConfirmedMatch,
  isExpiredMatch,
  type MatchDecision,
  matchKey,
  pinnedRecord,
  recordFromDecision,
} from './match-cache'
import { mergePlaylist, playKey, prefersIncomingMatch, unionOrder } from './merge'
import { type MoveTarget, moveKeys, reconcileOrder, sameOrder } from './ordering'
import {
  DB_NAME,
  DOWNLOADS_PLAYLIST_ID,
  type FollowKind,
  type FollowRecord,
  type HistoryRecord,
  type ImportProgressRecord,
  isLocalPlaylistId,
  LIKED_PLAYLIST_ID,
  type LibraryTables,
  type LikeRecord,
  MATCH_TTL_MS,
  MAX_DESCRIPTION_LENGTH,
  MAX_NAME_LENGTH,
  type MatchCacheRecord,
  type OrderUndo,
  PLAYLISTS_ORDER_ID,
  type PlaylistRecord,
  type RestoreMode,
  type StreamInfo,
  type SystemPlaylist,
} from './types'
import { MAX_PLAYLIST_TRACKS } from './validate'

/** Why the library refused a change. */
export type LibraryErrorCode =
  /** The playlist, follow or import does not exist. */
  | 'not-found'
  /** A built-in playlist can't be renamed or deleted, and only the download manager fills Downloads. */
  | 'protected'
  /** The input can't be stored, e.g. an empty name. */
  | 'invalid'

/** A change the library refused, with a machine-readable {@link LibraryErrorCode}. */
export class LibraryError extends Error {
  override readonly name = 'LibraryError'
  readonly code: LibraryErrorCode

  constructor(code: LibraryErrorCode, message: string) {
    super(message)
    this.code = code
  }
}

/** What the repository takes from its surroundings, so tests can fix it. */
export interface RepoDeps {
  /** The clock, as epoch milliseconds. */
  now: () => number
  /** Random numbers in `[0, 1)` for Shuffle order. */
  random: RandomSource
  /** A new random ID (a UUID) for playlists and imports. */
  uuid: () => string
}

/** A version 4 UUID, also where `crypto.randomUUID` is missing (an insecure context). */
export function randomUuid(): string {
  const crypto = globalThis.crypto
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

const DEFAULT_DEPS: RepoDeps = {
  now: () => Date.now(),
  // Called at use, so tests can spy on Math.random.
  random: () => Math.random(),
  uuid: randomUuid,
}

/** One playlist as lists of playlists show it. */
export interface PlaylistSummary {
  id: EntityId<'playlist'>
  /** `local`: a playlist of this library; `followed`: another source's playlist the user follows. */
  origin: 'local' | 'followed'
  /** Set on the built-in playlists. */
  system?: SystemPlaylist
  name: string
  description?: string
  /** Number of tracks; unknown for followed playlists. */
  trackCount?: number
  /** A followed playlist's owner. */
  owner?: string
  /** The playlist's artwork, else its first track's. May be empty. */
  artwork: Artwork[]
  /** When it joined the library: created or followed. */
  addedAt: number
  /** When it last changed (local playlists). */
  updatedAt: number
}

/** The list of playlists in its saved custom order. */
export interface PlaylistListView {
  items: PlaylistSummary[]
  /** The order before the last shuffle or saved sort, until the next change. */
  undo?: OrderUndo
}

/** One track of a list, as the list shows it. */
export interface TrackRow {
  /** The track ID as the list stores it. */
  id: EntityId<'track'>
  /** The cached metadata. Absent when the cache lacks it, e.g. after a partial import. */
  track?: Track
  /** When it joined the list: added, liked or downloaded. */
  addedAt?: number
  /** Whether the track is liked. */
  liked: boolean
}

/** A playlist with its tracks in the saved custom order. */
export interface PlaylistView {
  /** The record, with `trackIds` in the order shown. */
  playlist: PlaylistRecord
  rows: TrackRow[]
}

/** One distinct track of the listening history, most recent play first. */
export interface RecentRow extends TrackRow {
  /** When it last played. */
  playedAt: number
}

/** A play to record in the history. */
export interface NewPlay {
  track: Track
  /** When playback started; now when absent. */
  playedAt?: number
  playedMs: number
  completed: boolean
  skipped: boolean
  /** Where it started: the queue's context, e.g. an album, a radio or Liked songs. */
  context?: QueueContext
  stream?: StreamInfo
}

/** What a new import starts with. */
export interface NewImport {
  kind: string
  label: string
  total: number
  playlistId?: EntityId<'playlist'>
  state?: ImportProgressRecord['state']
}

/** The fields an import updates as it goes. */
export type ImportPatch = Partial<
  Pick<
    ImportProgressRecord,
    | 'status'
    | 'playlistId'
    | 'total'
    | 'done'
    | 'matched'
    | 'needsReview'
    | 'failed'
    | 'state'
    | 'error'
  >
>

/** Where new items land in a list. */
export type Position = 'top' | 'bottom'

/** A list whose order the repository saves: a local playlist, or the list of playlists. */
export type ListId = EntityId<'playlist'> | typeof PLAYLISTS_ORDER_ID

/** The order of one list inside a transaction, and how to save it. */
interface OrderedList {
  order: string[]
  undo?: OrderUndo
  save(order: string[], undo?: OrderUndo): Promise<void>
}

const keyOf = (id: string) => entityKey(id as EntityId)

/** The library repository over `db`. */
export function createLibraryRepo(db: FxmDatabase, deps: Partial<RepoDeps> = {}) {
  const { now, random, uuid } = { ...DEFAULT_DEPS, ...deps }

  /** `record` with a new track order, touched now, and with `undo` set or cleared. */
  function withOrder(
    record: PlaylistRecord,
    trackIds: EntityId<'track'>[],
    undo?: OrderUndo,
  ): PlaylistRecord {
    const { undo: _previous, ...rest } = record
    const next: PlaylistRecord = { ...rest, trackIds, updatedAt: now() }
    if (undo !== undefined) next.undo = undo
    return next
  }

  async function putTracks(tracks: readonly Track[]): Promise<void> {
    if (tracks.length === 0) return
    const updatedAt = now()
    await db.tracks.bulkPut(tracks.map((track) => ({ id: track.id, track, updatedAt })))
  }

  async function requirePlaylist(id: EntityId<'playlist'>): Promise<PlaylistRecord> {
    const record = await db.playlists.get(id)
    if (record === undefined) throw new LibraryError('not-found', `No playlist ${id}`)
    return record
  }

  /**
   * Liked songs in their saved order, with liked tracks the order lacks in front, newest
   * first. Pass the likes when they are already read.
   */
  async function likedOrder(
    record: PlaylistRecord,
    likes?: readonly LikeRecord[],
  ): Promise<EntityId<'track'>[]> {
    const all = likes ?? (await db.likes.toArray())
    const newestFirst = [...all].sort((a, b) => b.likedAt - a.likedAt)
    return reconcileOrder(
      record.trackIds,
      newestFirst.map((like) => like.trackId),
      { keyOf },
    )
  }

  /** Every playlist of the list of playlists, newest first: the ones its order may lack. */
  async function presentPlaylistIds(): Promise<EntityId<'playlist'>[]> {
    const [playlists, followed] = await Promise.all([
      db.playlists.toArray(),
      db.follows.where('kind').equals('playlist').toArray(),
    ])
    return [
      ...playlists.map((playlist) => ({ id: playlist.id, at: playlist.createdAt })),
      ...followed.map((follow) => ({
        id: follow.id as EntityId<'playlist'>,
        at: follow.followedAt,
      })),
    ]
      .sort((a, b) => b.at - a.at)
      .map((item) => item.id)
  }

  async function playlistOrder(): Promise<{ order: EntityId<'playlist'>[]; undo?: OrderUndo }> {
    const record = await db.orders.get(PLAYLISTS_ORDER_ID)
    const order = reconcileOrder(record?.order ?? [], await presentPlaylistIds())
    return record?.undo === undefined ? { order } : { order, undo: record.undo }
  }

  async function savePlaylistOrder(order: string[], undo?: OrderUndo): Promise<void> {
    await db.orders.put({
      id: PLAYLISTS_ORDER_ID,
      order: order as EntityId<'playlist'>[],
      updatedAt: now(),
      ...(undo === undefined ? {} : { undo }),
    })
  }

  async function openList(listId: ListId): Promise<OrderedList> {
    if (listId === PLAYLISTS_ORDER_ID) {
      const { order, undo } = await playlistOrder()
      return { order, ...(undo === undefined ? {} : { undo }), save: savePlaylistOrder }
    }
    const record = await requirePlaylist(listId)
    const order = record.system === 'liked' ? await likedOrder(record) : record.trackIds
    return {
      order,
      ...(record.undo === undefined ? {} : { undo: record.undo }),
      save: async (next, undo) => {
        await db.playlists.put(withOrder(record, next as EntityId<'track'>[], undo))
      },
    }
  }

  /** Runs `body` in a transaction over the tables that hold orders. */
  function orderTransaction<T>(body: () => Promise<T>, mode: 'r' | 'rw' = 'rw'): Promise<T> {
    return db.transaction(mode, [db.playlists, db.likes, db.orders, db.follows], body)
  }

  async function addToPlaylistOrder(
    id: EntityId<'playlist'>,
    position: Position | { after: EntityId<'playlist'> },
  ): Promise<void> {
    const { order } = await playlistOrder()
    const rest = order.filter((other) => other !== id)
    let next: EntityId<'playlist'>[]
    if (position === 'top') next = [id, ...rest]
    else if (position === 'bottom') next = [...rest, id]
    else {
      const at = rest.indexOf(position.after)
      next = at < 0 ? [id, ...rest] : [...rest.slice(0, at + 1), id, ...rest.slice(at + 1)]
    }
    await savePlaylistOrder(next)
  }

  async function removeFromPlaylistOrder(id: EntityId<'playlist'>): Promise<void> {
    const { order } = await playlistOrder()
    await savePlaylistOrder(order.filter((other) => other !== id))
  }

  function cleanName(name: string): string {
    const clean = name.trim().slice(0, MAX_NAME_LENGTH).trim()
    if (clean === '') throw new LibraryError('invalid', 'A playlist needs a name')
    return clean
  }

  function cleanDescription(description: string | undefined): string | undefined {
    const clean = description?.trim().slice(0, MAX_DESCRIPTION_LENGTH).trim()
    return clean === '' ? undefined : clean
  }

  async function rowsFor(
    order: readonly EntityId<'track'>[],
    addedAt: (id: EntityId<'track'>) => number | undefined,
    allLiked = false,
  ): Promise<TrackRow[]> {
    const [tracks, likes] = await Promise.all([
      db.tracks.bulkGet([...order]),
      allLiked ? Promise.resolve([]) : db.likes.bulkGet(order.map(keyOf)),
    ])
    return order.map((id, index) => {
      const row: TrackRow = { id, liked: allLiked || likes[index] !== undefined }
      const track = tracks[index]?.track
      if (track !== undefined) row.track = track
      const at = addedAt(id)
      if (at !== undefined) row.addedAt = at
      return row
    })
  }

  /**
   * Likes the tracks that aren't liked yet, all at `likedAt`: they go to the top of Liked
   * songs, in the given order. However many there are, the likes are read once, written in one
   * bulk write, and Liked songs is one write of its record. Returns how many were new. Call
   * inside a transaction.
   */
  async function likeAll(tracks: readonly Track[], likedAt: number): Promise<number> {
    const likes = await db.likes.toArray()
    const liked = new Set(likes.map((like) => like.key))
    const fresh = dedupeTracks(tracks).filter((track) => !liked.has(entityKey(track.id)))
    if (fresh.length === 0) return 0
    const record = await requirePlaylist(LIKED_PLAYLIST_ID)
    // The order before the new likes: they go in front of it, as given.
    const order = await likedOrder(record, likes)
    await db.likes.bulkPut(
      fresh.map((track) => ({ key: entityKey(track.id), trackId: track.id, likedAt })),
    )
    await db.playlists.put(withOrder(record, [...fresh.map((track) => track.id), ...order]))
    return fresh.length
  }

  /**
   * Removes the likes of `trackIds`: the likes are read once and deleted in one bulk delete,
   * and Liked songs is one write of its record. Returns how many there were. Call inside a
   * transaction.
   */
  async function unlikeAll(trackIds: readonly EntityId<'track'>[]): Promise<number> {
    const removing = new Set(trackIds.map(keyOf))
    const likes = await db.likes.toArray()
    const gone = likes.filter((like) => removing.has(like.key))
    if (gone.length === 0) return 0
    // Removing every like ("Select all", then Remove) is one request instead of one per like.
    if (gone.length === likes.length) await db.likes.clear()
    else await db.likes.bulkDelete(gone.map((like) => like.key))
    const record = await requirePlaylist(LIKED_PLAYLIST_ID)
    const kept = likes.filter((like) => !removing.has(like.key))
    await db.playlists.put(withOrder(record, await likedOrder(record, kept)))
    return gone.length
  }

  /** Writes a backup's rows over an emptied library. Call inside the restore transaction. */
  async function writeReplaced(tables: LibraryTables): Promise<void> {
    for (const name of TABLE_NAMES) await db.table(name).clear()
    await db.tracks.bulkPut(tables.tracks)
    await db.likes.bulkPut(tables.likes)
    await db.playlists.bulkPut(tables.playlists)
    await db.orders.bulkPut(tables.orders)
    await db.follows.bulkPut(tables.follows)
    // Rows without an ID get a new one.
    await db.history.bulkPut(tables.history as HistoryRecord[])
    await db.settings.bulkPut(tables.settings)
    await db.matchCache.bulkPut(tables.matchCache)
    await db.importProgress.bulkPut(tables.importProgress)
  }

  /**
   * Adds a backup's rows to the library, keeping everything here (rules in `merge.ts`). Call
   * inside the restore transaction.
   */
  async function writeMerged(tables: LibraryTables): Promise<void> {
    // Tracks: the most recently saved metadata wins.
    const tracksHere = await db.tracks.bulkGet(tables.tracks.map((row) => row.id))
    await db.tracks.bulkPut(
      tables.tracks.filter((row, index) => {
        const here = tracksHere[index]
        return here === undefined || row.updatedAt > here.updatedAt
      }),
    )
    // Likes, follows and reserved settings: what is here stays; the backup adds the rest.
    await db.likes.bulkAdd(await missingRows(db.likes, tables.likes, (row) => row.key))
    await db.follows.bulkAdd(await missingRows(db.follows, tables.follows, (row) => row.key))
    await db.settings.bulkAdd(await missingRows(db.settings, tables.settings, (row) => row.key))
    // Playlists: new ones are added; one that exists in both merges, the newer edit leading.
    for (const incoming of tables.playlists) {
      const here = await db.playlists.get(incoming.id)
      await db.playlists.put(here === undefined ? incoming : mergePlaylist(here, incoming))
    }
    // The list of playlists: this order first, then the backup's playlists it lacks.
    const order = await db.orders.get(PLAYLISTS_ORDER_ID)
    const incomingOrder = tables.orders.find((row) => row.id === PLAYLISTS_ORDER_ID)
    if (incomingOrder !== undefined) {
      await db.orders.put({
        id: PLAYLISTS_ORDER_ID,
        order: unionOrder(order?.order ?? [], incomingOrder.order),
        updatedAt: Math.max(order?.updatedAt ?? 0, incomingOrder.updatedAt),
      })
    }
    // History: a play that is here already is not added twice.
    const seen = new Set<string>()
    await db.history.each((entry) => {
      seen.add(playKey(entry))
    })
    const plays = tables.history
      .filter((entry) => {
        const key = playKey(entry)
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
      .map(({ id: _id, ...entry }) => entry)
    await db.history.bulkAdd(plays)
    // Match cache: a pin wins, then the newer decision.
    const matchesHere = await db.matchCache.bulkGet(tables.matchCache.map((row) => row.key))
    await db.matchCache.bulkPut(
      tables.matchCache.filter((row, index) => {
        const here = matchesHere[index]
        return here === undefined || prefersIncomingMatch(here, row)
      }),
    )
    // Imports: the more recent progress wins.
    const importsHere = await db.importProgress.bulkGet(tables.importProgress.map((row) => row.id))
    await db.importProgress.bulkPut(
      tables.importProgress.filter((row, index) => {
        const here = importsHere[index]
        return here === undefined || row.updatedAt > here.updatedAt
      }),
    )
  }

  return {
    // --- Tracks ------------------------------------------------------------------------

    /** Saves (or refreshes) the metadata of `tracks` in the track cache. */
    async saveTracks(tracks: readonly Track[]): Promise<void> {
      await db.transaction('rw', db.tracks, () => putTracks(tracks))
    },

    /** The cached metadata of one track. */
    async getTrack(id: EntityId<'track'>): Promise<Track | undefined> {
      return (await db.tracks.get(id))?.track
    },

    /**
     * Refreshes the cached metadata of the tracks the library already holds, e.g. after the
     * local-files feature (stage 4.4) read a file's tags again. Tracks it doesn't hold, and
     * tracks whose metadata didn't change, are left alone, so lists don't re-render for nothing.
     * Returns how many it updated.
     */
    async refreshTracks(tracks: readonly Track[]): Promise<number> {
      if (tracks.length === 0) return 0
      return db.transaction('rw', db.tracks, async () => {
        const cached = await db.tracks.bulkGet(tracks.map((track) => track.id))
        const changed = tracks.filter((track, index) => {
          const old = cached[index]
          return old !== undefined && JSON.stringify(old.track) !== JSON.stringify(track)
        })
        await putTracks(changed)
        return changed.length
      })
    },

    // --- Likes -------------------------------------------------------------------------

    /** Whether `trackId` (or the same entity under another YouTube prefix) is liked. */
    async isLiked(trackId: EntityId<'track'>): Promise<boolean> {
      return (await db.likes.get(entityKey(trackId))) !== undefined
    },

    /** Likes `track`: it goes to the top of Liked songs. Returns false if it already was. */
    async like(track: Track): Promise<boolean> {
      return db.transaction('rw', [db.tracks, db.likes, db.playlists], async () => {
        await putTracks([track])
        return (await likeAll([track], now())) > 0
      })
    },

    /** Removes a like. Returns false if the track wasn't liked. */
    async unlike(trackId: EntityId<'track'>): Promise<boolean> {
      return db.transaction('rw', [db.likes, db.playlists], async () => {
        if ((await db.likes.get(entityKey(trackId))) === undefined) return false
        return (await unlikeAll([trackId])) > 0
      })
    },

    /** Likes `track`, or removes its like. Returns whether it is liked now. */
    async toggleLike(track: Track): Promise<boolean> {
      return db.transaction('rw', [db.tracks, db.likes, db.playlists], async () => {
        if ((await db.likes.get(entityKey(track.id))) !== undefined) {
          await unlikeAll([track.id])
          return false
        }
        await putTracks([track])
        await likeAll([track], now())
        return true
      })
    },

    // --- Playlists ---------------------------------------------------------------------

    /** Every playlist of the library and every followed playlist, in the saved custom order. */
    async getPlaylistList(): Promise<PlaylistListView> {
      const { order, undo } = await playlistOrder()
      const [records, followed, likeCount] = await Promise.all([
        db.playlists.bulkGet(order),
        db.follows.bulkGet(order.map(keyOf)),
        db.likes.count(),
      ])
      // Lists show a playlist without artwork of its own with its first track's.
      const firstIds = records.flatMap((record) => record?.trackIds.slice(0, 1) ?? [])
      const firstTracks = new Map(
        (await db.tracks.bulkGet(firstIds)).flatMap((cached) =>
          cached === undefined ? [] : [[cached.id, cached.track] as const],
        ),
      )
      const items: PlaylistSummary[] = []
      order.forEach((id, index) => {
        const record = records[index]
        if (record !== undefined) {
          const summary: PlaylistSummary = {
            id,
            origin: 'local',
            name: record.name,
            trackCount: record.system === 'liked' ? likeCount : record.trackIds.length,
            artwork:
              record.artwork ??
              firstTracks.get(record.trackIds[0] ?? ('' as EntityId<'track'>))?.artwork ??
              [],
            addedAt: record.createdAt,
            updatedAt: record.updatedAt,
          }
          if (record.system !== undefined) summary.system = record.system
          if (record.description !== undefined) summary.description = record.description
          items.push(summary)
          return
        }
        const follow = followed[index]
        if (follow !== undefined) {
          const summary: PlaylistSummary = {
            id,
            origin: 'followed',
            name: follow.name,
            artwork: follow.artwork,
            addedAt: follow.followedAt,
            updatedAt: follow.followedAt,
          }
          if (follow.owner !== undefined) summary.owner = follow.owner
          items.push(summary)
        }
      })
      return undo === undefined ? { items } : { items, undo }
    },

    /** One playlist with its tracks in the saved custom order, or `undefined`. */
    async getPlaylistView(id: EntityId<'playlist'>): Promise<PlaylistView | undefined> {
      const record = await db.playlists.get(id)
      if (record === undefined) return undefined
      if (record.system === 'liked') {
        const likes = await db.likes.toArray()
        const likedAt = new Map(likes.map((like) => [like.key, like.likedAt]))
        const order = await likedOrder(record, likes)
        const rows = await rowsFor(order, (trackId) => likedAt.get(keyOf(trackId)), true)
        return { playlist: { ...record, trackIds: order }, rows }
      }
      const rows = await rowsFor(record.trackIds, (trackId) =>
        Object.hasOwn(record.addedAt, trackId) ? record.addedAt[trackId] : undefined,
      )
      return { playlist: record, rows }
    },

    /**
     * Creates a playlist, optionally with `tracks` in their given order, at the top of the
     * list of playlists. Returns its ID.
     */
    async createPlaylist(input: {
      name: string
      description?: string
      tracks?: readonly Track[]
    }): Promise<EntityId<'playlist'>> {
      const name = cleanName(input.name)
      const description = cleanDescription(input.description)
      const id = formatId('local', 'playlist', uuid())
      return db.transaction(
        'rw',
        [db.tracks, db.playlists, db.likes, db.orders, db.follows],
        async () => {
          const at = now()
          const tracks = dedupeTracks(input.tracks ?? []).slice(0, MAX_PLAYLIST_TRACKS)
          await putTracks(tracks)
          const record: PlaylistRecord = {
            id,
            name,
            createdAt: at,
            updatedAt: at,
            trackIds: tracks.map((track) => track.id),
            addedAt: Object.fromEntries(tracks.map((track) => [track.id, at])),
          }
          if (description !== undefined) record.description = description
          await db.playlists.add(record)
          await addToPlaylistOrder(id, 'top')
          return id
        },
      )
    },

    /** Renames a playlist and changes its description. Built-in playlists refuse. */
    async updatePlaylist(
      id: EntityId<'playlist'>,
      changes: { name?: string; description?: string },
    ): Promise<void> {
      await db.transaction('rw', db.playlists, async () => {
        const record = await requirePlaylist(id)
        if (record.system !== undefined) {
          throw new LibraryError('protected', `${record.name} can't be renamed`)
        }
        const { description: _old, ...rest } = record
        const next: PlaylistRecord = { ...rest, updatedAt: now() }
        if (changes.name !== undefined) next.name = cleanName(changes.name)
        const description =
          changes.description === undefined
            ? record.description
            : cleanDescription(changes.description)
        if (description !== undefined) next.description = description
        await db.playlists.put(next)
      })
    },

    /**
     * Copies a playlist, its order and dates included, right after the original in the list
     * of playlists. Built-in playlists can be copied too. Returns the copy's ID.
     */
    async duplicatePlaylist(id: EntityId<'playlist'>): Promise<EntityId<'playlist'>> {
      const copyId = formatId('local', 'playlist', uuid())
      return db.transaction('rw', [db.playlists, db.likes, db.orders, db.follows], async () => {
        const record = await requirePlaylist(id)
        const at = now()
        let trackIds = record.trackIds
        let addedAt = record.addedAt
        if (record.system === 'liked') {
          const likes = await db.likes.toArray()
          trackIds = await likedOrder(record, likes)
          addedAt = Object.fromEntries(likes.map((like) => [like.trackId, like.likedAt]))
        }
        const copy: PlaylistRecord = {
          id: copyId,
          name: `${record.name} (copy)`.slice(0, MAX_NAME_LENGTH),
          createdAt: at,
          updatedAt: at,
          trackIds: [...trackIds],
          addedAt: Object.fromEntries(
            trackIds.flatMap((trackId) =>
              Object.hasOwn(addedAt, trackId) ? [[trackId, addedAt[trackId] as number]] : [],
            ),
          ),
        }
        if (record.description !== undefined) copy.description = record.description
        if (record.artwork !== undefined) copy.artwork = record.artwork
        await db.playlists.add(copy)
        await addToPlaylistOrder(copyId, { after: id })
        return copyId
      })
    },

    /** Deletes a playlist. Built-in playlists refuse. Its tracks stay in the track cache. */
    async deletePlaylist(id: EntityId<'playlist'>): Promise<void> {
      await orderTransaction(async () => {
        const record = await requirePlaylist(id)
        if (record.system !== undefined) {
          throw new LibraryError('protected', `${record.name} can't be deleted`)
        }
        await db.playlists.delete(id)
        await removeFromPlaylistOrder(id)
      })
    },

    /**
     * Adds tracks to a playlist, at the end unless `position` says `top`. Tracks already in it
     * (by `entityKey`) are skipped. Adding to Liked songs likes them; Downloads refuses, because
     * only the download manager fills it.
     */
    async addTracks(
      playlistId: EntityId<'playlist'>,
      tracks: readonly Track[],
      { position = 'bottom' }: { position?: Position } = {},
    ): Promise<{ added: number; skipped: number }> {
      if (playlistId === DOWNLOADS_PLAYLIST_ID) {
        throw new LibraryError('protected', 'Only downloads can be added to Downloads')
      }
      return db.transaction('rw', [db.tracks, db.playlists, db.likes], async () => {
        const unique = dedupeTracks(tracks)
        await putTracks(unique)
        if (playlistId === LIKED_PLAYLIST_ID) {
          // New likes go to the top, the first track first.
          const added = await likeAll(unique, now())
          return { added, skipped: tracks.length - added }
        }
        const record = await requirePlaylist(playlistId)
        const present = new Set(record.trackIds.map(keyOf))
        const room = Math.max(0, MAX_PLAYLIST_TRACKS - record.trackIds.length)
        const fresh = unique.filter((track) => !present.has(entityKey(track.id))).slice(0, room)
        if (fresh.length === 0) return { added: 0, skipped: tracks.length }
        const at = now()
        const ids = fresh.map((track) => track.id)
        const next = withOrder(
          record,
          position === 'top' ? [...ids, ...record.trackIds] : [...record.trackIds, ...ids],
        )
        next.addedAt = { ...record.addedAt, ...Object.fromEntries(ids.map((id) => [id, at])) }
        await db.playlists.put(next)
        return { added: fresh.length, skipped: tracks.length - fresh.length }
      })
    },

    /**
     * Removes tracks from a playlist. Removing from Liked songs removes the likes; Downloads
     * refuses, because deleting the download removes it there.
     */
    async removeTracks(
      playlistId: EntityId<'playlist'>,
      trackIds: readonly EntityId<'track'>[],
    ): Promise<number> {
      if (playlistId === DOWNLOADS_PLAYLIST_ID) {
        throw new LibraryError('protected', 'Delete the download to remove it from Downloads')
      }
      return db.transaction('rw', [db.playlists, db.likes], async () => {
        if (playlistId === LIKED_PLAYLIST_ID) return unlikeAll(trackIds)
        const record = await requirePlaylist(playlistId)
        const removing = new Set(trackIds.map(keyOf))
        const kept = record.trackIds.filter((id) => !removing.has(keyOf(id)))
        if (kept.length === record.trackIds.length) return 0
        const next = withOrder(record, kept)
        next.addedAt = Object.fromEntries(
          Object.entries(record.addedAt).filter(([id]) => !removing.has(keyOf(id))),
        )
        await db.playlists.put(next)
        return record.trackIds.length - kept.length
      })
    },

    // --- Ordering: any local playlist, or the list of playlists (PLAYLISTS_ORDER_ID) -------

    /** The saved order of a list. */
    async getOrder(listId: ListId): Promise<string[]> {
      return (await orderTransaction(() => openList(listId), 'r')).order
    },

    /**
     * Moves `keys` of a list to `target` (see `MoveTarget`). Returns false when nothing moved.
     * Clears the list's undo, like every other change of its order.
     */
    async moveItems(listId: ListId, keys: Iterable<string>, target: MoveTarget): Promise<boolean> {
      const moving = [...keys]
      return orderTransaction(async () => {
        const list = await openList(listId)
        const next = moveKeys(list.order, moving, target)
        if (sameOrder(next, list.order)) return false
        await list.save(next)
        return true
      })
    },

    /**
     * Saves `order` as the list's custom order, e.g. a sort ("Save as custom order"). Items the
     * list no longer holds are dropped, and items `order` lacks keep their place at the end.
     * With an `action`, the previous order is kept for {@link undoOrder} until the next change.
     */
    async setOrder(
      listId: ListId,
      order: readonly string[],
      action?: OrderUndo['action'],
    ): Promise<boolean> {
      return orderTransaction(async () => {
        const list = await openList(listId)
        const next = reconcileOrder(order, list.order, { keyOf, missing: 'last' })
        if (sameOrder(next, list.order)) return false
        await list.save(next, action === undefined ? undefined : { action, order: list.order })
        return true
      })
    },

    /**
     * Shuffles a list's saved order for good (Fisher-Yates), keeping the previous order for
     * {@link undoOrder} until the next change. Returns false for a list too short to shuffle.
     */
    async shuffleOrder(listId: ListId): Promise<boolean> {
      return orderTransaction(async () => {
        const list = await openList(listId)
        if (list.order.length < 2) return false
        // A shuffle that lands on the same order would look like nothing happened.
        let next = fisherYatesShuffle(list.order, random)
        for (let attempt = 0; attempt < 5 && sameOrder(next, list.order); attempt++) {
          next = fisherYatesShuffle(list.order, random)
        }
        if (sameOrder(next, list.order)) return false
        await list.save(next, { action: 'shuffle', order: list.order })
        return true
      })
    },

    /**
     * Brings back the order from before the last shuffle or saved sort. Returns false when
     * there is nothing to undo: no such change, or another change came after it.
     */
    async undoOrder(listId: ListId): Promise<boolean> {
      return orderTransaction(async () => {
        const list = await openList(listId)
        if (list.undo === undefined) return false
        await list.save(reconcileOrder(list.undo.order, list.order, { keyOf, missing: 'last' }))
        return true
      })
    },

    // --- Downloads (stage 4.1 calls these) ------------------------------------------------

    /** Adds a completed download to the top of Downloads. */
    async addDownload(track: Track): Promise<void> {
      await db.transaction('rw', [db.tracks, db.playlists], async () => {
        await putTracks([track])
        const record = await requirePlaylist(DOWNLOADS_PLAYLIST_ID)
        const key = entityKey(track.id)
        if (record.trackIds.some((id) => keyOf(id) === key)) return
        const next = withOrder(record, [track.id, ...record.trackIds])
        next.addedAt = { ...record.addedAt, [track.id]: now() }
        await db.playlists.put(next)
      })
    },

    /** Removes a deleted download from Downloads. */
    async removeDownload(trackId: EntityId<'track'>): Promise<void> {
      await db.transaction('rw', db.playlists, async () => {
        const record = await requirePlaylist(DOWNLOADS_PLAYLIST_ID)
        const key = entityKey(trackId)
        const kept = record.trackIds.filter((id) => keyOf(id) !== key)
        if (kept.length === record.trackIds.length) return
        const next = withOrder(record, kept)
        next.addedAt = Object.fromEntries(
          Object.entries(record.addedAt).filter(([id]) => keyOf(id) !== key),
        )
        await db.playlists.put(next)
      })
    },

    /**
     * Removes deleted downloads from Downloads in one change, however many there are (stage
     * 4.1's "Remove all downloads" and batches). Returns how many left it.
     */
    async removeDownloads(trackIds: readonly EntityId<'track'>[]): Promise<number> {
      if (trackIds.length === 0) return 0
      return db.transaction('rw', db.playlists, async () => {
        const record = await requirePlaylist(DOWNLOADS_PLAYLIST_ID)
        const removing = new Set(trackIds.map(keyOf))
        const kept = record.trackIds.filter((id) => !removing.has(keyOf(id)))
        if (kept.length === record.trackIds.length) return 0
        const next = withOrder(record, kept)
        next.addedAt = Object.fromEntries(
          Object.entries(record.addedAt).filter(([id]) => !removing.has(keyOf(id))),
        )
        await db.playlists.put(next)
        return record.trackIds.length - kept.length
      })
    },

    // --- Follows -----------------------------------------------------------------------

    /**
     * Follows an artist, saves an album or follows another source's playlist. A followed
     * playlist joins the top of the list of playlists. Local playlists can't be followed.
     */
    async follow(entity: Artist | Album | Playlist): Promise<void> {
      const parts = parseId(entity.id)
      if (isLocalPlaylistId(entity.id)) {
        throw new LibraryError('invalid', 'Playlists of this library are already in it')
      }
      const kind: FollowKind = parts.kind
      await orderTransaction(async () => {
        const key = entityKey(entity.id)
        const existing = await db.follows.get(key)
        const record: FollowRecord = {
          key,
          id: entity.id as EntityId<FollowKind>,
          kind,
          name: entity.name,
          artwork: entity.artwork,
          followedAt: existing?.followedAt ?? now(),
        }
        if ('artists' in entity && kind === 'album') record.artists = entity.artists
        if ('owner' in entity && entity.owner !== undefined) record.owner = entity.owner.name
        await db.follows.put(record)
        if (kind === 'playlist' && existing === undefined) {
          await addToPlaylistOrder(entity.id as EntityId<'playlist'>, 'top')
        }
      })
    },

    /** Stops following. */
    async unfollow(id: EntityId<FollowKind>): Promise<void> {
      await orderTransaction(async () => {
        const record = await db.follows.get(entityKey(id))
        if (record === undefined) return
        await db.follows.delete(record.key)
        if (record.kind === 'playlist') {
          await removeFromPlaylistOrder(record.id as EntityId<'playlist'>)
        }
      })
    },

    /** Whether `id` is followed (or saved, for an album). */
    async isFollowing(id: EntityId<FollowKind>): Promise<boolean> {
      return (await db.follows.get(entityKey(id))) !== undefined
    },

    /** Followed artists, saved albums or followed playlists, most recent first. */
    async listFollows(kind: FollowKind): Promise<FollowRecord[]> {
      return db.follows
        .where('[kind+followedAt]')
        .between([kind, Dexie.minKey], [kind, Dexie.maxKey])
        .reverse()
        .toArray()
    },

    // --- History -----------------------------------------------------------------------

    /** Records one play and caches the track. Returns the history entry's ID. */
    async recordPlay(play: NewPlay): Promise<number> {
      return db.transaction('rw', [db.tracks, db.history], async () => {
        await putTracks([play.track])
        const entry: Omit<HistoryRecord, 'id'> = {
          trackId: play.track.id,
          playedAt: play.playedAt ?? now(),
          playedMs: Math.max(0, play.playedMs),
          completed: play.completed,
          skipped: play.skipped,
        }
        if (play.context !== undefined) entry.context = play.context
        if (play.stream !== undefined) entry.stream = play.stream
        return db.history.add(entry)
      })
    },

    /** The most recently played distinct tracks, most recent first. */
    async recentlyPlayed(limit = 50): Promise<RecentRow[]> {
      const seen = new Set<string>()
      const entries: HistoryRecord[] = []
      await db.history
        .orderBy('playedAt')
        .reverse()
        .until(() => entries.length >= limit)
        .each((entry) => {
          const key = keyOf(entry.trackId)
          if (seen.has(key)) return
          seen.add(key)
          entries.push(entry)
        })
      const order = entries.map((entry) => entry.trackId)
      const rows = await rowsFor(order, () => undefined)
      return rows.map((row, index) => ({ ...row, playedAt: entries[index]?.playedAt ?? 0 }))
    },

    /** Every history entry, oldest first (the listening signals of stage 3.1 read this). */
    async history(): Promise<HistoryRecord[]> {
      return db.history.orderBy('playedAt').toArray()
    },

    /** Deletes the whole listening history. */
    async clearHistory(): Promise<void> {
      await db.history.clear()
    },

    // --- Match cache (stages 1.7 and 2.3) ------------------------------------------------

    /**
     * The cached decision for a source track in `mode`, including a `suggest` guess for the
     * version switcher. Expired engine decisions read as missing; pins never expire.
     */
    async getMatch(
      sourceTrackId: EntityId<'track'>,
      mode: CatalogMode,
    ): Promise<MatchCacheRecord | undefined> {
      const record = await db.matchCache.get(matchKey(sourceTrackId, mode))
      return record === undefined || isExpiredMatch(record, now()) ? undefined : record
    },

    /**
     * The audio playback may use without asking: a pinned or `auto` candidate. Never a
     * `suggest` guess.
     */
    async getConfirmedMatch(
      sourceTrackId: EntityId<'track'>,
      mode: CatalogMode,
    ): Promise<AudioCandidate | undefined> {
      const record = await db.matchCache.get(matchKey(sourceTrackId, mode))
      if (record === undefined || isExpiredMatch(record, now())) return undefined
      return isConfirmedMatch(record) ? record.candidate : undefined
    },

    /**
     * Stores the matching engine's decision. A user's pin always wins: the decision is dropped
     * when the track is pinned in that mode. Returns whether it was stored.
     */
    async recordMatch(decision: MatchDecision): Promise<boolean> {
      return db.transaction('rw', db.matchCache, async () => {
        const key = matchKey(decision.sourceTrackId, decision.mode)
        const record = recordFromDecision(decision, now(), await db.matchCache.get(key))
        if (record === null) return false
        await db.matchCache.put(record)
        return true
      })
    },

    /** Pins the audio the user chose for a source track in `mode` ("Not the right version?"). */
    async pinMatch(
      sourceTrackId: EntityId<'track'>,
      mode: CatalogMode,
      candidate: AudioCandidate,
    ): Promise<void> {
      await db.transaction('rw', db.matchCache, async () => {
        const existing = await db.matchCache.get(matchKey(sourceTrackId, mode))
        await db.matchCache.put(pinnedRecord(sourceTrackId, mode, candidate, now(), existing))
      })
    },

    /** Removes the user's pin, so the engine decides again. */
    async unpinMatch(sourceTrackId: EntityId<'track'>, mode: CatalogMode): Promise<void> {
      await db.matchCache.delete(matchKey(sourceTrackId, mode))
    },

    /**
     * Forgets the engine's decision, e.g. when its video was removed (Smart Replace). A pin
     * stays: only the user removes one. Returns whether a decision was forgotten.
     */
    async forgetMatch(sourceTrackId: EntityId<'track'>, mode: CatalogMode): Promise<boolean> {
      return db.transaction('rw', db.matchCache, async () => {
        const key = matchKey(sourceTrackId, mode)
        const record = await db.matchCache.get(key)
        if (record === undefined || record.userPinned) return false
        await db.matchCache.delete(key)
        return true
      })
    },

    /** Deletes engine decisions older than about 30 days; never a pin. Returns how many. */
    async pruneMatchCache(): Promise<number> {
      const cutoff = now() - MATCH_TTL_MS
      return db.matchCache
        .where('decidedAt')
        .below(cutoff)
        .filter((record) => !record.userPinned)
        .delete()
    },

    // --- Import progress (stage 3.6) ---------------------------------------------------------

    /** Starts tracking a new import. */
    async startImport(input: NewImport): Promise<ImportProgressRecord> {
      const at = now()
      const record: ImportProgressRecord = {
        id: uuid(),
        kind: input.kind,
        label: input.label,
        status: 'running',
        total: Math.max(0, input.total),
        done: 0,
        matched: 0,
        needsReview: 0,
        failed: 0,
        createdAt: at,
        updatedAt: at,
      }
      if (input.playlistId !== undefined) record.playlistId = input.playlistId
      if (input.state !== undefined) record.state = input.state
      await db.importProgress.add(record)
      return record
    },

    /** Saves an import's progress. Returns the updated record. */
    async updateImport(id: string, patch: ImportPatch): Promise<ImportProgressRecord> {
      return db.transaction('rw', db.importProgress, async () => {
        const record = await db.importProgress.get(id)
        if (record === undefined) throw new LibraryError('not-found', `No import ${id}`)
        const next: ImportProgressRecord = { ...record, updatedAt: now() }
        for (const [field, value] of Object.entries(patch)) {
          if (value !== undefined) Object.assign(next, { [field]: value })
        }
        await db.importProgress.put(next)
        return next
      })
    },

    /** One import's progress. */
    async getImport(id: string): Promise<ImportProgressRecord | undefined> {
      return db.importProgress.get(id)
    },

    /** Every import, most recently updated first. */
    async listImports(): Promise<ImportProgressRecord[]> {
      return db.importProgress.orderBy('updatedAt').reverse().toArray()
    },

    /** Forgets an import. */
    async deleteImport(id: string): Promise<void> {
      await db.importProgress.delete(id)
    },

    // --- The whole library -------------------------------------------------------------------

    /**
     * Every row of every table, read in one transaction, so a backup is a consistent snapshot.
     * `backup.ts` wraps it into the backup file.
     */
    async snapshot(): Promise<LibraryTables> {
      return db.transaction(
        'r',
        TABLE_NAMES.map((name) => db.table(name)),
        async () => ({
          tracks: await db.tracks.toArray(),
          likes: await db.likes.toArray(),
          playlists: await db.playlists.toArray(),
          orders: await db.orders.toArray(),
          follows: await db.follows.toArray(),
          history: await db.history.toArray(),
          settings: await db.settings.toArray(),
          matchCache: await db.matchCache.toArray(),
          importProgress: await db.importProgress.toArray(),
        }),
      )
    },

    /**
     * Writes rows a backup brought, already validated by `backup.ts`, in one transaction, so a
     * failure leaves the library as it was. `replace` makes the library exactly `tables`,
     * custom orders, undo orders and play IDs included; `merge` keeps everything here and adds
     * the rest (the rules are in `merge.ts`). The built-in playlists exist afterwards either way.
     */
    async restore(tables: LibraryTables, mode: RestoreMode): Promise<void> {
      await db.transaction(
        'rw',
        TABLE_NAMES.map((name) => db.table(name)),
        async () => {
          if (mode === 'replace') await writeReplaced(tables)
          else await writeMerged(tables)
          await ensureSystemRecords(db, now())
        },
      )
    },

    /** Empties every table, then recreates the built-in playlists. */
    async clearLibrary(): Promise<void> {
      await db.transaction(
        'rw',
        TABLE_NAMES.map((name) => db.table(name)),
        async () => {
          for (const name of TABLE_NAMES) await db.table(name).clear()
        },
      )
      await ensureSystemRecords(db, now())
    },
  }
}

/** The library repository. */
export type LibraryRepo = ReturnType<typeof createLibraryRepo>

/** `tracks` without repeats of the same entity (by `entityKey`), first one kept. */
function dedupeTracks(tracks: readonly Track[]): Track[] {
  const seen = new Set<string>()
  return tracks.filter((track) => {
    const key = entityKey(track.id)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** The rows of `rows` whose key `table` doesn't have yet, each key once. */
async function missingRows<T>(
  table: { bulkGet(keys: string[]): PromiseLike<unknown[]> },
  rows: readonly T[],
  keyOf: (row: T) => string,
): Promise<T[]> {
  const unique = new Map(rows.map((row) => [keyOf(row), row]))
  const existing = await table.bulkGet([...unique.keys()])
  return [...unique.values()].filter((_, index) => existing[index] === undefined)
}

let current: { repo: LibraryRepo; db: FxmDatabase } | undefined

/**
 * The app's library, on the `fxm` database. Opened on first use, when engine decisions older
 * than about 30 days also leave the match cache (pins stay).
 */
export function getLibrary(): LibraryRepo {
  if (current === undefined) {
    const db = openDatabase()
    current = { repo: createLibraryRepo(db), db }
    // Housekeeping only: reads already ignore expired decisions.
    current.repo.pruneMatchCache().catch(() => {})
  }
  return current.repo
}

/**
 * Tests only: closes and deletes the app's database, and starts over with `deps` (a seeded
 * random source, a fixed clock). The next {@link getLibrary} gets a fresh, empty library.
 */
export async function resetLibrary(deps: Partial<RepoDeps> = {}): Promise<LibraryRepo> {
  current?.db.close()
  await Dexie.delete(DB_NAME)
  const db = openDatabase()
  current = { repo: createLibraryRepo(db, deps), db }
  return current.repo
}
