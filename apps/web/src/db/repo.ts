/**
 * The library repository: the only code that reads and writes the library database. Pages read
 * through the hooks in `hooks.ts`, which run these reads as live queries; everything else
 * calls the methods directly.
 *
 * Every write runs in one IndexedDB transaction, so a change either lands whole or not at all,
 * and every order change is a single write of one record (see `ordering.ts`). Transaction
 * scopes are always `async` functions: Dexie keeps a transaction open across native `await`s
 * only inside one, and IndexedDB would commit it early otherwise.
 *
 * @module
 */

import {
  type AffinityEntry,
  type AffinityKind,
  type AffinityReader,
  type AffinityScore,
  type Album,
  type Artist,
  type Artwork,
  type AudioCandidate,
  affinityContributions,
  type CatalogMode,
  type EntityId,
  entityKey,
  fisherYatesShuffle,
  formatId,
  isEntityId,
  isSignalTime,
  type ListeningSignal,
  type ListeningSignalTrack,
  type Playlist,
  parseId,
  type RandomSource,
  type Track,
} from '@fxm/core'
import { Dexie } from 'dexie'
import {
  type AffinityTables,
  addedAtOf,
  affinityScores,
  affinityTableReader,
  applyEntries,
  cachedSpellings,
  effectiveRecord,
  effectiveTracks,
  maintainAffinity,
  readEffectiveTracks,
  reattribute,
  rebuildAffinity,
  spellingsOf,
  topAffinity,
  withEffectiveTrack,
} from './affinity'
import { ensureSystemRecords, type FxmDatabase, openDatabase, TABLE_NAMES } from './database'
import {
  isConfirmedMatch,
  isExpiredMatch,
  type MatchDecision,
  matchKey,
  pinnedRecord,
  recordFromDecision,
} from './match-cache'
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
  type LikeRecord,
  MATCH_TTL_MS,
  MAX_DESCRIPTION_LENGTH,
  MAX_NAME_LENGTH,
  type MatchCacheRecord,
  type OrderUndo,
  PLAYLISTS_ORDER_ID,
  type PlayContext,
  type PlaylistRecord,
  type StreamInfo,
  type SystemPlaylist,
  type TrackRecord,
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

/**
 * A play to record in the history: a play signal (stage 3.1). The player records one when a
 * play ends, and imports (stage 3.6) record the listening history of another service.
 */
export interface NewPlay {
  /** The track that played. Its metadata is cached, so the history can show it. */
  track: Track
  /**
   * When playback started, as epoch milliseconds; now when absent. Never after now: the
   * library refuses a play from the future (see {@link playRejection}).
   */
  playedAt?: number
  /** How long it played, in milliseconds: listening time, without pauses and skipped parts. */
  playedMs: number
  /** The track's length when it played, as the player knew it. Default: the track's own. */
  durationMs?: number
  /** Whether it played to the end. */
  completed: boolean
  /** Whether the user skipped the rest of it. */
  skipped: boolean
  /** Where it started from. */
  context?: PlayContext
  /** What actually played. */
  stream?: StreamInfo
  /** The import it comes from (an import-progress ID), for a play from another service. */
  importId?: string
}

/** Options for {@link LibraryRepo.recordPlays}. */
export interface RecordPlaysOptions {
  /**
   * Whether a track whose metadata is already cached keeps it, instead of taking the play's.
   * Imports want this: another service's history says less about a track (a title, one artist)
   * than the providers that cached it. A video cached only under its other YouTube prefix is
   * saved under the play's with the metadata already known. Default: false, as the player
   * wants, so the cache follows the latest metadata.
   */
  keepCachedTracks?: boolean
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

  /**
   * Saves `tracks` in the track cache, each under its own ID (a later one of the same ID wins),
   * and keeps the listening affinity on the metadata it now holds: when a save changes the
   * artists, tags or kind a track's signals credit, what the track holds moves to the new
   * credits (see `affinity.ts`). With `keep`, a track already cached keeps its metadata. Runs
   * inside the caller's transaction, which must include `tracks` and `affinity`.
   */
  async function putTracks(tracks: readonly Track[], { keep = false } = {}): Promise<void> {
    if (tracks.length === 0) return
    const updatedAt = now()
    const rows = await cachedSpellings(
      db.tracks,
      tracks.map((track) => track.id),
    )
    const before = effectiveTracks(rows)
    const writes = new Map<EntityId<'track'>, TrackRecord>()
    for (const track of tracks) {
      let saved = track
      if (keep) {
        if (rows.has(track.id)) continue
        // The same video under its other prefix: its metadata is this one's too.
        const known = effectiveRecord(
          spellingsOf(track.id).map((id) => writes.get(id) ?? rows.get(id)),
        )
        if (known !== undefined) {
          saved = { ...known.track, id: track.id, source: parseId(track.id).source }
        }
      }
      writes.set(track.id, { id: track.id, track: saved, updatedAt })
    }
    if (writes.size === 0) return
    await db.tracks.bulkPut([...writes.values()])
    for (const [id, record] of writes) rows.set(id, record)
    const after = effectiveTracks(rows)
    await reattribute(
      db.affinity,
      [...after].map(([key, track]) => ({ key, from: before.get(key), to: track })),
    )
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

  /** The tables a rebuild of the affinity reads and writes. */
  const affinityTables: AffinityTables = {
    affinity: db.affinity,
    history: db.history,
    likes: db.likes,
    playlists: db.playlists,
    settings: db.settings,
    tracks: db.tracks,
  }

  /**
   * Scores `signals` in the listening affinity (stage 3.1), each with its track's effective
   * metadata as the cache holds it now (see `affinity.ts`), whatever track the signal carries.
   * Runs inside the caller's transaction, which must include `tracks` and `affinity`, so a
   * change and its signal land together.
   */
  async function signal(
    signals: readonly ListeningSignal[],
    extra: readonly AffinityEntry[] = [],
  ): Promise<void> {
    if (signals.length === 0 && extra.length === 0) return
    const tracks = await readEffectiveTracks(
      db.tracks,
      signals.map((one) => one.track.id),
    )
    await applyEntries(db.affinity, [
      ...extra,
      ...signals.flatMap((one) => affinityContributions(withEffectiveTrack(one, tracks))),
    ])
  }

  /** Signals that the tracks `ids` of `playlist` left it now. */
  function removalSignals(
    playlist: PlaylistRecord,
    ids: readonly EntityId<'track'>[],
  ): ListeningSignal[] {
    const at = now()
    return ids.map((id) => ({
      type: 'playlist-remove',
      at,
      track: trackRef(id),
      playlistId: playlist.id,
      addedAt: addedAtOf(playlist, id),
    }))
  }

  /**
   * Records plays, in one transaction: a history entry for each, the tracks' metadata, and
   * their signals in the listening affinity. This is the event API for plays: the player
   * records each play as it ends, and imports (stage 3.6) record another service's listening
   * history here, in batches, each play with the time it started and its `importId`.
   *
   * A play of the same track (by `entityKey`) at the same start as one already recorded is the
   * same play: it keeps the ID recorded first, so a resumed or repeated import adds nothing
   * twice. When the new record says more (more time played, or a verdict where there was none,
   * as when the player saves a play it had kept a checkpoint of), it replaces the old one, and
   * the affinity with it. Returns the history IDs, in the order of `plays`.
   *
   * @throws LibraryError (`invalid`) for a play {@link playRejection} refuses; nothing of the
   * batch is recorded then. Imports check each play first.
   */
  async function recordPlays(
    plays: readonly NewPlay[],
    { keepCachedTracks = false }: RecordPlaysOptions = {},
  ): Promise<number[]> {
    if (plays.length === 0) return []
    const at = now()
    const entries = plays.map((play) => historyEntry(play, at))
    return db.transaction('rw', [db.tracks, db.history, db.affinity], async () => {
      const pairs = new Map<string, [EntityId<'track'>, number]>()
      for (const entry of entries) {
        for (const id of spellingsOf(entry.trackId)) {
          pairs.set(`${id}|${entry.playedAt}`, [id, entry.playedAt])
        }
      }
      const slots = new Map<string, PlaySlot>()
      await db.history
        .where('[trackId+playedAt]')
        .anyOf([...pairs.values()])
        .each((row) => {
          const key = playKey(row)
          const { id: _id, ...entry } = row
          if (!slots.has(key)) slots.set(key, { stored: row, entry, changed: false })
        })
      for (const entry of entries) {
        const slot = slots.get(playKey(entry))
        if (slot === undefined) slots.set(playKey(entry), { entry, changed: true })
        else if (saysMore(entry, slot.entry)) {
          slot.entry = { ...slot.entry, ...entry, trackId: slot.entry.trackId }
          slot.changed = true
        }
      }
      // Every played track is cached under its own ID, with the latest metadata given.
      const tracks = new Map(plays.map((play) => [play.track.id, play.track]))
      await putTracks([...tracks.values()], { keep: keepCachedTracks })
      const fresh = [...slots.values()].filter((slot) => slot.stored === undefined)
      const ids = await db.history.bulkAdd(
        fresh.map((slot) => slot.entry),
        { allKeys: true },
      )
      fresh.forEach((slot, index) => {
        slot.id = ids[index] as number
      })
      const replaced = [...slots.values()].filter(
        (slot) => slot.stored !== undefined && slot.changed,
      )
      await db.history.bulkPut(
        replaced.map((slot) => ({ ...slot.entry, id: (slot.stored as HistoryRecord).id })),
      )
      // A replaced play takes back what the old record added, under the same metadata.
      const effective = await readEffectiveTracks(
        db.tracks,
        replaced.map((slot) => slot.entry.trackId),
      )
      const takenBack = replaced.flatMap((slot) =>
        affinityContributions(
          withEffectiveTrack(playSignal(slot.stored as HistoryRecord), effective),
        ).map(negated),
      )
      await signal(
        [...fresh, ...replaced].map((slot) => playSignal(slot.entry)),
        takenBack,
      )
      return entries.map((entry) => {
        const slot = slots.get(playKey(entry)) as PlaySlot
        return slot.stored?.id ?? (slot.id as number)
      })
    })
  }

  /** Likes `track` unless it already is. Returns the like's signal, or nothing. */
  async function likeInTransaction(
    track: Track,
    likedAt: number,
  ): Promise<ListeningSignal | undefined> {
    const key = entityKey(track.id)
    if ((await db.likes.get(key)) !== undefined) return undefined
    await db.likes.put({ key, trackId: track.id, likedAt })
    const liked = await requirePlaylist(LIKED_PLAYLIST_ID)
    const rest = (await likedOrder(liked)).filter((id) => keyOf(id) !== key)
    await db.playlists.put(withOrder(liked, [track.id, ...rest]))
    return { type: 'like', at: likedAt, track }
  }

  /**
   * Removes the like of `trackId`, if there is one. Returns the unlike's signal, which takes
   * back what that like added.
   */
  async function unlikeInTransaction(
    trackId: EntityId<'track'>,
  ): Promise<ListeningSignal | undefined> {
    const key = entityKey(trackId)
    const like = await db.likes.get(key)
    if (like === undefined) return undefined
    await db.likes.delete(key)
    const liked = await requirePlaylist(LIKED_PLAYLIST_ID)
    const rest = (await likedOrder(liked)).filter((id) => keyOf(id) !== key)
    await db.playlists.put(withOrder(liked, rest))
    return { type: 'unlike', at: now(), likedAt: like.likedAt, track: trackRef(like.trackId) }
  }

  const affinity: AffinityReader = affinityTableReader(db.affinity, now)

  return {
    /** The database this repository works on. */
    db,

    /** The repository's clock, as epoch milliseconds: every time it stores comes from it. */
    now,

    // --- Tracks ------------------------------------------------------------------------

    /**
     * Saves (or refreshes) the metadata of `tracks` in the track cache. When their artists,
     * tags or kind change, their listening affinity moves to the new ones.
     */
    async saveTracks(tracks: readonly Track[]): Promise<void> {
      await db.transaction('rw', [db.tracks, db.affinity], async () => putTracks(tracks))
    },

    /** The cached metadata of one track. */
    async getTrack(id: EntityId<'track'>): Promise<Track | undefined> {
      return (await db.tracks.get(id))?.track
    },

    // --- Likes -------------------------------------------------------------------------

    /** Whether `trackId` (or the same entity under another YouTube prefix) is liked. */
    async isLiked(trackId: EntityId<'track'>): Promise<boolean> {
      return (await db.likes.get(entityKey(trackId))) !== undefined
    },

    /**
     * Likes `track`: it goes to the top of Liked songs, and its affinity grows. Returns false if
     * it already was liked.
     */
    async like(track: Track): Promise<boolean> {
      return db.transaction('rw', [db.tracks, db.likes, db.playlists, db.affinity], async () => {
        await putTracks([track])
        const liked = await likeInTransaction(track, now())
        if (liked === undefined) return false
        await signal([liked])
        return true
      })
    },

    /**
     * Removes a like, and takes back what it added to the affinity. Returns false if the track
     * wasn't liked.
     */
    async unlike(trackId: EntityId<'track'>): Promise<boolean> {
      return db.transaction('rw', [db.likes, db.playlists, db.tracks, db.affinity], async () => {
        const unliked = await unlikeInTransaction(trackId)
        if (unliked === undefined) return false
        await signal([unliked])
        return true
      })
    },

    /** Likes `track`, or removes its like. Returns whether it is liked now. */
    async toggleLike(track: Track): Promise<boolean> {
      return db.transaction('rw', [db.tracks, db.likes, db.playlists, db.affinity], async () => {
        const unliked = await unlikeInTransaction(track.id)
        if (unliked !== undefined) {
          await signal([unliked])
          return false
        }
        await putTracks([track])
        const liked = await likeInTransaction(track, now())
        if (liked !== undefined) await signal([liked])
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
        [db.tracks, db.playlists, db.likes, db.orders, db.follows, db.affinity],
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
          await signal(tracks.map((track) => ({ type: 'playlist-add', at, track, playlistId: id })))
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
     * of playlists. Built-in playlists can be copied too. Returns the copy's ID. Like any
     * playlist, the copy adds to its tracks' affinity, from the dates it copied.
     */
    async duplicatePlaylist(id: EntityId<'playlist'>): Promise<EntityId<'playlist'>> {
      const copyId = formatId('local', 'playlist', uuid())
      const tables = [db.playlists, db.likes, db.orders, db.follows, db.tracks, db.affinity]
      return db.transaction('rw', tables, async () => {
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
        await signal(
          copy.trackIds.map((trackId) => ({
            type: 'playlist-add',
            at: addedAtOf(copy, trackId),
            track: trackRef(trackId),
            playlistId: copyId,
          })),
        )
        return copyId
      })
    },

    /**
     * Deletes a playlist. Built-in playlists refuse. Its tracks stay in the track cache, and
     * the affinity forgets what the playlist added to them.
     */
    async deletePlaylist(id: EntityId<'playlist'>): Promise<void> {
      const tables = [db.playlists, db.likes, db.orders, db.follows, db.tracks, db.affinity]
      await db.transaction('rw', tables, async () => {
        const record = await requirePlaylist(id)
        if (record.system !== undefined) {
          throw new LibraryError('protected', `${record.name} can't be deleted`)
        }
        await db.playlists.delete(id)
        await removeFromPlaylistOrder(id)
        await signal(removalSignals(record, record.trackIds))
      })
    },

    /**
     * Adds tracks to a playlist, at the end unless `position` says `top`. Tracks already in it
     * (by `entityKey`) are skipped. Adding to Liked songs likes them; Downloads refuses, because
     * only the download manager fills it. Each added track gains affinity.
     */
    async addTracks(
      playlistId: EntityId<'playlist'>,
      tracks: readonly Track[],
      { position = 'bottom' }: { position?: Position } = {},
    ): Promise<{ added: number; skipped: number }> {
      if (playlistId === DOWNLOADS_PLAYLIST_ID) {
        throw new LibraryError('protected', 'Only downloads can be added to Downloads')
      }
      return db.transaction('rw', [db.tracks, db.playlists, db.likes, db.affinity], async () => {
        const unique = dedupeTracks(tracks)
        await putTracks(unique)
        if (playlistId === LIKED_PLAYLIST_ID) {
          const likes: ListeningSignal[] = []
          const at = now()
          // Liked one after another, so the first track ends up on top.
          for (const track of [...unique].reverse()) {
            const liked = await likeInTransaction(track, at)
            if (liked !== undefined) likes.push(liked)
          }
          await signal(likes)
          return { added: likes.length, skipped: tracks.length - likes.length }
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
        await signal(fresh.map((track) => ({ type: 'playlist-add', at, track, playlistId })))
        return { added: fresh.length, skipped: tracks.length - fresh.length }
      })
    },

    /**
     * Removes tracks from a playlist, and takes back what their adds gave their affinity.
     * Removing from Liked songs removes the likes; Downloads refuses, because deleting the
     * download removes it there.
     */
    async removeTracks(
      playlistId: EntityId<'playlist'>,
      trackIds: readonly EntityId<'track'>[],
    ): Promise<number> {
      if (playlistId === DOWNLOADS_PLAYLIST_ID) {
        throw new LibraryError('protected', 'Delete the download to remove it from Downloads')
      }
      return db.transaction('rw', [db.playlists, db.likes, db.tracks, db.affinity], async () => {
        if (playlistId === LIKED_PLAYLIST_ID) {
          const unlikes: ListeningSignal[] = []
          for (const id of trackIds) {
            const unliked = await unlikeInTransaction(id)
            if (unliked !== undefined) unlikes.push(unliked)
          }
          await signal(unlikes)
          return unlikes.length
        }
        const record = await requirePlaylist(playlistId)
        const removing = new Set(trackIds.map(keyOf))
        const kept = record.trackIds.filter((id) => !removing.has(keyOf(id)))
        if (kept.length === record.trackIds.length) return 0
        const next = withOrder(record, kept)
        next.addedAt = Object.fromEntries(
          Object.entries(record.addedAt).filter(([id]) => !removing.has(keyOf(id))),
        )
        await db.playlists.put(next)
        const removed = record.trackIds.filter((id) => removing.has(keyOf(id)))
        await signal(removalSignals(record, removed))
        return removed.length
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

    /**
     * Adds a completed download to the top of Downloads. Like an add to any playlist, it adds
     * to the track's affinity.
     */
    async addDownload(track: Track): Promise<void> {
      await db.transaction('rw', [db.tracks, db.playlists, db.affinity], async () => {
        await putTracks([track])
        const record = await requirePlaylist(DOWNLOADS_PLAYLIST_ID)
        const key = entityKey(track.id)
        if (record.trackIds.some((id) => keyOf(id) === key)) return
        const at = now()
        const next = withOrder(record, [track.id, ...record.trackIds])
        next.addedAt = { ...record.addedAt, [track.id]: at }
        await db.playlists.put(next)
        await signal([{ type: 'playlist-add', at, track, playlistId: DOWNLOADS_PLAYLIST_ID }])
      })
    },

    /** Removes a deleted download from Downloads, and what it added to the affinity. */
    async removeDownload(trackId: EntityId<'track'>): Promise<void> {
      await db.transaction('rw', [db.playlists, db.tracks, db.affinity], async () => {
        const record = await requirePlaylist(DOWNLOADS_PLAYLIST_ID)
        const key = entityKey(trackId)
        const kept = record.trackIds.filter((id) => keyOf(id) !== key)
        if (kept.length === record.trackIds.length) return
        const next = withOrder(record, kept)
        next.addedAt = Object.fromEntries(
          Object.entries(record.addedAt).filter(([id]) => keyOf(id) !== key),
        )
        await db.playlists.put(next)
        const removed = record.trackIds.filter((id) => keyOf(id) === key)
        await signal(removalSignals(record, removed))
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

    // --- History and listening signals (stage 3.1) ----------------------------------------

    /**
     * Records one play (see {@link recordPlays}): the history entry, the track's metadata and
     * the play's signal. Returns the history entry's ID.
     */
    async recordPlay(play: NewPlay): Promise<number> {
      const [id] = await recordPlays([play])
      return id as number
    },

    recordPlays,

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

    /** Every history entry, oldest first. */
    async history(): Promise<HistoryRecord[]> {
      return db.history.orderBy('playedAt').toArray()
    },

    /**
     * Deletes the whole listening history, and with it everything plays added to the
     * affinity: recommendations forget what was played. Likes and playlists keep theirs.
     */
    async clearHistory(): Promise<void> {
      await db.transaction('rw', Object.values(affinityTables), async () => {
        await db.history.clear()
        await rebuildAffinity(affinityTables, now())
      })
    },

    /**
     * Deletes the plays an import brought in (`NewPlay.importId`), and what they added to the
     * affinity: undoing an import of another service's history (stage 3.6). The import's
     * progress record stays until {@link deleteImport}. Returns how many plays went.
     */
    async forgetImportPlays(importId: string): Promise<number> {
      return db.transaction('rw', Object.values(affinityTables), async () => {
        const deleted = await db.history.where('importId').equals(importId).delete()
        if (deleted > 0) await rebuildAffinity(affinityTables, now())
        return deleted
      })
    },

    /**
     * The listening affinity as a core `AffinityReader`, reading at the repository's clock:
     * what the recommendations (stages 3.3 and 3.4) rank with.
     */
    affinity,

    /**
     * The `limit` tracks, artists or tags with the highest affinity now, best first, each with
     * its affinity and skips now. Entries without a positive affinity are left out.
     */
    async topAffinity(kind: AffinityKind, limit = 20): Promise<AffinityScore[]> {
      return topAffinity(db.affinity, kind, limit, now())
    },

    /**
     * The affinity now of the entries of `kind` that `values` name, in the same order: track
     * IDs, artist names or tags, or the keys of entries (see `affinityKey` in `@fxm/core`).
     * `undefined` where there is none.
     */
    async getAffinity(
      kind: AffinityKind,
      values: readonly string[],
    ): Promise<(AffinityScore | undefined)[]> {
      return affinityScores(db.affinity, kind, values, now())
    },

    /**
     * Recomputes the affinity from the history, the likes and the playlists. The repository
     * keeps it up to date with every change, so nothing needs this but a repair. Returns how
     * many entries it holds.
     */
    async rebuildAffinity(): Promise<number> {
      return db.transaction('rw', Object.values(affinityTables), async () =>
        rebuildAffinity(affinityTables, now()),
      )
    },

    /**
     * Rebuilds the affinity if the scoring model changed since it was built, or the clock went
     * back past the times it holds (see `maintainAffinity` in `affinity.ts`). The app runs it
     * when it opens the library. Returns whether it rebuilt.
     */
    async maintainAffinity(): Promise<boolean> {
      return db.transaction('rw', Object.values(affinityTables), async () =>
        maintainAffinity(affinityTables, now()),
      )
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

    /**
     * Forgets an import's progress. The plays it brought in stay in the history:
     * {@link forgetImportPlays} removes them.
     */
    async deleteImport(id: string): Promise<void> {
      await db.importProgress.delete(id)
    },

    // --- The whole library -------------------------------------------------------------------

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

/** The identity of a play: the same track (by `entityKey`) starting at the same time. */
function playKey(entry: Pick<HistoryRecord, 'trackId' | 'playedAt'>): string {
  return `${entityKey(entry.trackId)}|${entry.playedAt}`
}

/**
 * Why {@link LibraryRepo.recordPlays} would refuse `play` at `now`, for people, or `undefined`
 * when it would record it: a track without a valid track ID, a start that is not a valid time
 * or lies after `now`, or a time played that is not a number. Imports (stage 3.6) check each
 * row with it first, so one bad row never fails a whole batch.
 */
export function playRejection(play: NewPlay, now: number): string | undefined {
  if (!isEntityId(play?.track?.id, 'track')) {
    return `A play needs a track ID, not ${String(play?.track?.id)}`
  }
  const playedAt = play.playedAt ?? now
  if (!isSignalTime(playedAt)) return `A play can't start at ${String(playedAt)}`
  // A start in the future would hold the affinity back until the clock caught up with it.
  if (playedAt > now) return `A play can't start after now (${playedAt} > ${now})`
  if (typeof play.playedMs !== 'number' || !Number.isFinite(play.playedMs)) {
    return `A play can't last ${String(play.playedMs)} ms`
  }
  return undefined
}

/** The history entry for `play`, recorded at `now`. @throws LibraryError (`invalid`). */
function historyEntry(play: NewPlay, now: number): Omit<HistoryRecord, 'id'> {
  const rejection = playRejection(play, now)
  if (rejection !== undefined) throw new LibraryError('invalid', rejection)
  const entry: Omit<HistoryRecord, 'id'> = {
    trackId: play.track.id,
    playedAt: play.playedAt ?? now,
    playedMs: Math.max(0, play.playedMs),
    completed: play.completed === true,
    skipped: play.skipped === true,
  }
  // The player knows the real length; the metadata's is the next best thing.
  const durationMs = [play.durationMs, play.track.durationMs].find(
    (length) => length !== undefined && Number.isFinite(length) && length > 0,
  )
  if (durationMs !== undefined) entry.durationMs = durationMs
  if (play.context !== undefined) entry.context = play.context
  if (play.stream !== undefined) entry.stream = play.stream
  if (play.importId !== undefined) entry.importId = play.importId
  return entry
}

/** One play while {@link LibraryRepo.recordPlays} records a batch. */
interface PlaySlot {
  /** The row already in the history, if any. */
  stored?: HistoryRecord
  /** The play as it will be stored. */
  entry: Omit<HistoryRecord, 'id'>
  /** Whether `entry` must be written. */
  changed: boolean
  /** The ID a new row got. */
  id?: number
}

/**
 * Whether a record of a play says more than another of the same play: more time played, or as
 * much with a verdict (completed or skipped) where the other had none.
 */
function saysMore(play: Omit<HistoryRecord, 'id'>, than: Omit<HistoryRecord, 'id'>): boolean {
  if (play.playedMs !== than.playedMs) return play.playedMs > than.playedMs
  const verdict = (one: Omit<HistoryRecord, 'id'>) => one.completed || one.skipped
  return verdict(play) && !verdict(than)
}

/** The play signal of a history entry, with a stand-in track the repository scores itself. */
function playSignal(entry: Omit<HistoryRecord, 'id'>): ListeningSignal {
  const { trackId, playedAt, importId: _import, ...play } = entry
  return { type: 'play', at: playedAt, track: trackRef(trackId), ...play }
}

/** A stand-in for a signal's track: the repository scores it with the cached metadata. */
function trackRef(id: EntityId<'track'>): ListeningSignalTrack {
  return { id, title: '', artists: [] }
}

/** A contribution taken back: its affinity, skips and plays negated. */
function negated(entry: AffinityEntry): AffinityEntry {
  const { lastPlayedAt: _last, ...rest } = entry
  return { ...rest, score: -entry.score, skips: -entry.skips, plays: -entry.plays }
}

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

let current: LibraryRepo | undefined

/**
 * The app's library, on the `fxm` database. Opened on first use, when engine decisions older
 * than about 30 days also leave the match cache (pins stay), and the listening affinity is
 * rebuilt if the scoring model changed or the clock went back (`maintainAffinity`).
 */
export function getLibrary(): LibraryRepo {
  if (current === undefined) {
    current = createLibraryRepo(openDatabase())
    // Housekeeping only: reads already ignore expired decisions, and the affinity stays
    // usable until the rebuild lands.
    current.pruneMatchCache().catch(() => {})
    current.maintainAffinity().catch(() => {})
  }
  return current
}

/**
 * Tests only: closes and deletes the app's database, and starts over with `deps` (a seeded
 * random source, a fixed clock). The next {@link getLibrary} gets a fresh, empty library.
 */
export async function resetLibrary(deps: Partial<RepoDeps> = {}): Promise<LibraryRepo> {
  current?.db.close()
  await Dexie.delete(DB_NAME)
  current = createLibraryRepo(openDatabase(), deps)
  return current
}
