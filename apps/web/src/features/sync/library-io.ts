/**
 * Sync's access to the library database: reading the synced part as a snapshot, writing a
 * merge back, and the edits that settle a conflict.
 *
 * Like a backup's restore, each runs in one transaction (the repository's `syncTransaction`), so
 * a change lands whole or not at all. A merge reads this device's library and writes the result
 * in the **same** transaction, so a like or a move made in another tab meanwhile is never
 * overwritten: it waits, then the next sync carries it. Only the records the merge changed are
 * written, and nothing sync doesn't carry is touched (Downloads, import progress, the matching
 * engine's own decisions, undo orders that still apply).
 *
 * @module
 */

import { type EntityId, formatId, type JsonObject, type QueueContext } from '@fxm/core'
import { sameOrder } from '../../db/ordering'
import { LibraryError, type LibraryRepo, randomUuid, type SyncedTables } from '../../db/repo'
import {
  DOWNLOADS_PLAYLIST_ID,
  PLAYLISTS_ORDER_ID,
  type PlaylistRecord,
  type TrackRecord,
} from '../../db/types'
import { sanitizeArtworkItem } from '../../db/validate'
import { canonicalJson } from './canonical'
import {
  conflictOriginalOf,
  countRemovals,
  type MergeInput,
  type MergeResult,
  mergeSnapshots,
  nameBeforeCopy,
  type RemovalCounts,
} from './merge'
import {
  historyKey,
  isPrivatePlayContext,
  SYNCED_SETTING_PREFIX,
  type SyncSnapshot,
  snapshotFromRows,
} from './snapshot'

/**
 * Reads the synced part of the library (see `snapshot.ts`) and no more: the plays that started
 * at `historySince` or later (all of them without it, through the index), the pins of the match
 * cache, and of the track cache only the tracks the rest uses, plus any of `tracks` it holds.
 * Inside a transaction, it reads that transaction's state.
 */
export async function readLibrarySnapshot(
  repo: LibraryRepo,
  appSettings: JsonObject,
  {
    historySince,
    tracks: wanted = [],
  }: { historySince?: number; tracks?: readonly EntityId<'track'>[] } = {},
): Promise<SyncSnapshot> {
  const rows = await repo.syncTransaction('r', async (db) => {
    const playlists = (await db.playlists.toArray()).filter(
      (playlist) => playlist.id !== DOWNLOADS_PLAYLIST_ID,
    )
    const likes = await db.likes.toArray()
    const history =
      historySince === undefined
        ? await db.history.toArray()
        : await db.history.where('playedAt').aboveOrEqual(historySince).toArray()
    const matchCache = await db.matchCache.filter((row) => row.userPinned === true).toArray()
    const used = new Set<EntityId<'track'>>(wanted)
    for (const playlist of playlists) for (const id of playlist.trackIds) used.add(id)
    for (const like of likes) used.add(like.trackId)
    for (const entry of history) used.add(entry.trackId)
    for (const pin of matchCache) used.add(pin.sourceTrackId)
    const tracks = (await db.tracks.bulkGet([...used])).filter((row) => row !== undefined)
    return {
      tracks,
      likes,
      playlists,
      orders: await db.orders.toArray(),
      follows: await db.follows.toArray(),
      history,
      settings: await db.settings.where('key').startsWith(SYNCED_SETTING_PREFIX).toArray(),
      matchCache,
    }
  })
  return snapshotFromRows(rows, appSettings).snapshot
}

/** What merging the gist into the library did. */
export interface LibraryMerge extends MergeResult {
  /** The library before the merge. */
  local: SyncSnapshot
  /** How many records the merge added, changed or removed here. */
  changed: number
}

/**
 * Merges the gist's snapshot into the library in one transaction: reads this device's
 * library, merges (see `merge.ts`), and writes what changed. With `historySince`, plays that
 * started earlier are left out of the merge, so it never changes them.
 *
 * `checkRemovals` sees what the merge would remove here before anything is written; when it
 * throws, the transaction ends and the library stays as it was.
 */
export async function mergeIntoLibrary(
  repo: LibraryRepo,
  input: Omit<MergeInput, 'local'> & {
    appSettings: JsonObject
    historySince?: number
    checkRemovals?: (removed: RemovalCounts, local: SyncSnapshot) => void
  },
): Promise<LibraryMerge> {
  return repo.syncTransaction('rw', async (db) => {
    const local = await readLibrarySnapshot(repo, input.appSettings, {
      ...(input.historySince === undefined ? {} : { historySince: input.historySince }),
      // So that the merge compares the gist's tracks with those cached here.
      tracks: input.remote.tracks.map((row) => row.id),
    })
    const result = mergeSnapshots({
      base: input.base,
      local,
      remote: input.remote,
      remoteFromBase: input.remoteFromBase,
      appSettingsDefaults: input.appSettingsDefaults,
      historyDeletionsSince: input.historyDeletionsSince,
    })
    input.checkRemovals?.(countRemovals(local, result.snapshot), local)
    const changed = await writeChanges(db, local, result.snapshot, input.historySince)
    return { ...result, local, changed }
  })
}

/** The rows of `next` that `previous` lacks or holds differently, and the keys it lost. */
function diff<T>(
  previous: readonly T[],
  next: readonly T[],
  keyOf: (row: T) => string,
): { puts: T[]; deletes: string[] } {
  const before = new Map(previous.map((row) => [keyOf(row), canonicalJson(row)]))
  const after = new Set<string>()
  const puts: T[] = []
  for (const row of next) {
    const key = keyOf(row)
    after.add(key)
    if (before.get(key) !== canonicalJson(row)) puts.push(row)
  }
  const deletes = [...before.keys()].filter((key) => !after.has(key))
  return { puts, deletes }
}

/**
 * Writes what changed from `local` to `merged`. Returns how many records changed. Plays that
 * started before `historySince` weren't merged and stay as they are.
 */
async function writeChanges(
  db: SyncedTables,
  local: SyncSnapshot,
  merged: SyncSnapshot,
  historySince: number | undefined,
): Promise<number> {
  let changed = 0

  // Tracks are a cache: the merge never removes one. `local` holds the cached versions of the
  // gist's tracks too, so only what is new or newer is written.
  const tracks = diff(local.tracks, merged.tracks, (row) => row.id)
  await db.tracks.bulkPut(await keepDeviceArtwork(db, tracks.puts))
  changed += tracks.puts.length

  const likes = diff(local.likes, merged.likes, (row) => row.key)
  await db.likes.bulkPut(likes.puts)
  await db.likes.bulkDelete(likes.deletes)
  changed += likes.puts.length + likes.deletes.length

  const playlists = diff(local.playlists, merged.playlists, (row) => row.id)
  for (const record of playlists.puts) {
    // Undo still applies when the merge left this playlist's order as it was here.
    const current = await db.playlists.get(record.id)
    const next: PlaylistRecord =
      current?.undo !== undefined && sameOrder(current.trackIds, record.trackIds)
        ? { ...record, undo: current.undo }
        : record
    await db.playlists.put(next)
  }
  const removable = playlists.deletes.filter(
    (id) => local.playlists.find((row) => row.id === id)?.system === undefined,
  )
  await db.playlists.bulkDelete(removable as EntityId<'playlist'>[])
  changed += playlists.puts.length + removable.length

  if (
    merged.order !== undefined &&
    canonicalJson(merged.order) !== canonicalJson(local.order ?? null)
  ) {
    const current = await db.orders.get(PLAYLISTS_ORDER_ID)
    await db.orders.put(
      current?.undo !== undefined && sameOrder(current.order, merged.order.order)
        ? { ...merged.order, undo: current.undo }
        : merged.order,
    )
    changed++
  }

  const follows = diff(local.follows, merged.follows, (row) => row.key)
  await db.follows.bulkPut(follows.puts)
  await db.follows.bulkDelete(follows.deletes)
  changed += follows.puts.length + follows.deletes.length

  // Plays have different IDs on every device, so they are found by key: gone and changed plays
  // are deleted, then new and changed ones added. A changed play keeps the context that stays
  // on this device (a search's query), which the gist doesn't carry.
  const history = diff(local.history, merged.history, historyKey)
  const localPlays = new Set(local.history.map(historyKey))
  const gone = new Set([
    ...history.deletes,
    ...history.puts.map(historyKey).filter((key) => localPlays.has(key)),
  ])
  const contexts = new Map<string, QueueContext>()
  if (gone.size > 0) {
    const ids: number[] = []
    const rows =
      historySince === undefined
        ? db.history.toCollection()
        : db.history.where('playedAt').aboveOrEqual(historySince)
    await rows.each((row) => {
      const key = historyKey(row)
      if (!gone.has(key)) return
      ids.push(row.id)
      if (row.context !== undefined && isPrivatePlayContext(row.context)) {
        contexts.set(key, row.context)
      }
    })
    await db.history.bulkDelete(ids)
  }
  await db.history.bulkAdd(
    history.puts.map((entry) => {
      const context = contexts.get(historyKey(entry))
      return context === undefined || entry.context !== undefined ? entry : { ...entry, context }
    }),
  )
  changed += history.puts.length + history.deletes.length

  const settings = diff(local.settings, merged.settings, (row) => row.key)
  await db.settings.bulkPut(settings.puts)
  await db.settings.bulkDelete(settings.deletes)
  changed += settings.puts.length + settings.deletes.length

  // Pins: a pin from the other side replaces the engine's decision here. A pin removed there
  // goes here, but only if the record is still a pin (the engine's own decisions stay).
  const pins = diff(local.pins, merged.pins, (row) => row.key)
  await db.matchCache.bulkPut(pins.puts)
  for (const key of pins.deletes) {
    const current = await db.matchCache.get(key)
    if (current?.userPinned) await db.matchCache.delete(key)
  }
  changed += pins.puts.length + pins.deletes.length

  return changed
}

/**
 * `rows`, to write over the track cache: a track that comes without artwork keeps the artwork
 * here that sync can't carry. A local file's cover (stage 4.4) is a `data:` URL, which the
 * backup's guards drop, so a newer version of the track from another device that has the same
 * folder never brings it, and must not take it away here.
 */
async function keepDeviceArtwork(
  db: SyncedTables,
  rows: readonly TrackRecord[],
): Promise<TrackRecord[]> {
  const cached = await db.tracks.bulkGet(rows.map((row) => row.id))
  return rows.map((row, index) => {
    if (row.track.artwork.length > 0) return row
    const kept = (cached[index]?.track.artwork ?? []).filter(
      (size) => sanitizeArtworkItem(size) === null,
    )
    return kept.length === 0 ? row : { ...row, track: { ...row.track, artwork: kept } }
  })
}

// --- Settling a conflict ---------------------------------------------------------------------

async function requireCopy(db: SyncedTables, copyId: EntityId<'playlist'>) {
  const copy = await db.playlists.get(copyId)
  if (copy === undefined) throw new LibraryError('not-found', 'That version is gone already')
  return copy
}

/** Replaces `from` with `to` in the order of the playlists list (or drops it, without `to`). */
async function replaceInOrder(
  db: SyncedTables,
  from: EntityId<'playlist'>,
  to: EntityId<'playlist'> | undefined,
  now: number,
): Promise<void> {
  const record = await db.orders.get(PLAYLISTS_ORDER_ID)
  if (record === undefined) return
  const order = record.order.flatMap((id) => (id !== from ? [id] : to === undefined ? [] : [to]))
  await db.orders.put({ id: PLAYLISTS_ORDER_ID, order, updatedAt: now })
}

/**
 * "Keep the other version": the playlist takes the copy's name, description and songs in
 * their order, and the copy goes. When the original is gone, the copy simply stays.
 */
export async function keepOtherVersion(
  repo: LibraryRepo,
  copyId: EntityId<'playlist'>,
  now = Date.now(),
): Promise<EntityId<'playlist'>> {
  const originalId = conflictOriginalOf(copyId)
  return repo.syncTransaction('rw', async (db) => {
    const copy = await requireCopy(db, copyId)
    const original = originalId === undefined ? undefined : await db.playlists.get(originalId)
    if (originalId === undefined || original === undefined) return copyId
    const next: PlaylistRecord = {
      id: original.id,
      name: nameBeforeCopy(copy.name),
      createdAt: original.createdAt,
      updatedAt: now,
      trackIds: [...copy.trackIds],
      addedAt: { ...copy.addedAt },
    }
    if (copy.description !== undefined) next.description = copy.description
    if (copy.artwork !== undefined) next.artwork = copy.artwork
    await db.playlists.put(next)
    await db.playlists.delete(copyId)
    await replaceInOrder(db, copyId, undefined, now)
    return original.id
  })
}

/**
 * "Keep both": the copy becomes a playlist of its own, with a new ID in its place in the list,
 * so it no longer reads as a conflict on any device.
 */
export async function keepBothVersions(
  repo: LibraryRepo,
  copyId: EntityId<'playlist'>,
  { now = Date.now(), uuid = randomUuid }: { now?: number; uuid?: () => string } = {},
): Promise<EntityId<'playlist'>> {
  const id = formatId('local', 'playlist', uuid())
  return repo.syncTransaction('rw', async (db) => {
    const copy = await requireCopy(db, copyId)
    await db.playlists.put({ ...copy, id, updatedAt: now })
    await db.playlists.delete(copyId)
    await replaceInOrder(db, copyId, id, now)
    return id
  })
}

/** A conflict between a playlist and its copy, as the library holds it now. */
export interface PlaylistConflict {
  original: { id: EntityId<'playlist'>; name: string }
  copy: { id: EntityId<'playlist'>; name: string }
}

/**
 * The conflicts the library holds: every conflict copy whose original is still there. Every
 * device sees them, because the copies sync like any playlist.
 */
export async function listConflicts(repo: LibraryRepo): Promise<PlaylistConflict[]> {
  const playlists = await repo.syncTransaction('r', (db) => db.playlists.toArray())
  const byId = new Map(playlists.map((playlist) => [playlist.id, playlist]))
  const conflicts: PlaylistConflict[] = []
  for (const playlist of playlists) {
    const originalId = conflictOriginalOf(playlist.id)
    const original = originalId === undefined ? undefined : byId.get(originalId)
    if (original === undefined) continue
    conflicts.push({
      original: { id: original.id, name: original.name },
      copy: { id: playlist.id, name: playlist.name },
    })
  }
  return conflicts.sort((a, b) => a.original.name.localeCompare(b.original.name))
}
