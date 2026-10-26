/**
 * The listening affinity on disk (stage 3.1): one record per track, artist and tag in the
 * `affinity` table. The repository merges every new signal into it in the same transaction as
 * the change that caused it (a play, a like, a playlist edit), and rebuilds it from the library
 * when that is simpler: after the history is cleared, after a backup is restored, in the
 * version 3 upgrade, and when the scoring model or the clock changed (see
 * {@link maintainAffinity}).
 *
 * The math is core's (`affinityContributions`, `mergeAffinity`, `reattributeAffinity`,
 * `affinityRank`); this module reads and writes records. The affinity is derived data: the
 * history holds the plays, the `likes` table the likes, and each playlist the time each of its
 * tracks was added. {@link librarySignals} turns them back into signals.
 *
 * ## Which metadata counts
 *
 * Every signal of a track is scored with the track's **effective metadata**: of the cached
 * spellings of the track (a video's `ytm` and `yt` IDs are one track), the one saved last
 * ({@link effectiveRecord}). When saving a track changes which artists, tags or kind that
 * metadata credits, the repository moves what the track holds to the new credits in the same
 * transaction (`reattributeAffinity`). So the table always equals a rebuild from the library and
 * the current cache, and taking a like or an add back cancels exactly what it added.
 *
 * @module
 */

import {
  AFFINITY_MODEL_VERSION,
  type AffinityCredit,
  type AffinityEntry,
  type AffinityKind,
  type AffinityReader,
  type AffinityScore,
  affinityContributions,
  affinityCredits,
  affinityEntryId,
  affinityKey,
  affinityRank,
  affinityScoreAt,
  compareAffinityScores,
  type EntityId,
  entityKey,
  formatId,
  isEmptyAffinity,
  type ListeningSignal,
  type ListeningSignalTrack,
  mergeAffinity,
  parseId,
  playContextOf,
  reattributeAffinity,
  type Track,
} from '@fxm/core'
import { Dexie } from 'dexie'
import type { FxmDatabase } from './database'
import type {
  AffinityRecord,
  HistoryRecord,
  LikeRecord,
  PlaylistRecord,
  TrackRecord,
} from './types'

/** The affinity table. */
type AffinityTable = FxmDatabase['affinity']

/** The settings row that holds the `AFFINITY_MODEL_VERSION` the table was built with. */
export const AFFINITY_MODEL_SETTING = 'affinity.model'

/**
 * How far past the clock an affinity entry may be dated before {@link maintainAffinity} counts
 * the clock as having gone back and rebuilds. Less than this decays new contributions by less
 * than a quarter of a percent, and heals as the clock catches up.
 */
export const CLOCK_SKEW_MS = 60 * 60 * 1000

/** An entry as it is stored, with its ID and rank. */
export function affinityRecord(entry: AffinityEntry): AffinityRecord {
  return { ...entry, id: affinityEntryId(entry.kind, entry.key), rank: affinityRank(entry) }
}

/** A stored record as a core entry. */
export function affinityEntryOf(record: AffinityRecord): AffinityEntry {
  const { id: _id, rank: _rank, ...entry } = record
  return entry
}

/** Every ID `id` may be stored under: both YouTube prefixes of a video, else `id` itself. */
export function spellingsOf(id: EntityId<'track'>): EntityId<'track'>[] {
  const parts = parseId(id)
  if (parts === null || (parts.source !== 'ytm' && parts.source !== 'yt')) return [id]
  return [formatId('ytm', 'track', parts.nativeId), formatId('yt', 'track', parts.nativeId)]
}

/**
 * Of the cached spellings of one track, the one whose metadata the affinity scores the track
 * with: the one saved last, the greater ID when two were saved at the same time.
 */
export function effectiveRecord(
  records: Iterable<TrackRecord | undefined>,
): TrackRecord | undefined {
  let best: TrackRecord | undefined
  for (const record of records) {
    if (record === undefined) continue
    if (
      best === undefined ||
      record.updatedAt > best.updatedAt ||
      (record.updatedAt === best.updatedAt && record.id > best.id)
    ) {
      best = record
    }
  }
  return best
}

/** The cached rows of every spelling of `ids`, by track ID. */
export async function cachedSpellings(
  tracks: FxmDatabase['tracks'],
  ids: Iterable<EntityId<'track'>>,
): Promise<Map<EntityId<'track'>, TrackRecord>> {
  const spellings = [...new Set([...ids].flatMap(spellingsOf))]
  const rows = await tracks.bulkGet(spellings)
  const byId = new Map<EntityId<'track'>, TrackRecord>()
  spellings.forEach((id, index) => {
    const row = rows[index]
    if (row !== undefined) byId.set(id, row)
  })
  return byId
}

/**
 * The effective metadata (see the module documentation) of each track that `rows` has a
 * spelling of, by `entityKey`.
 */
export function effectiveTracks(
  rows: ReadonlyMap<EntityId<'track'>, TrackRecord>,
): Map<string, Track> {
  const byEntity = new Map<string, TrackRecord[]>()
  for (const row of rows.values()) {
    const key = entityKey(row.id)
    byEntity.set(key, [...(byEntity.get(key) ?? []), row])
  }
  const tracks = new Map<string, Track>()
  for (const [key, records] of byEntity) {
    const best = effectiveRecord(records)
    if (best !== undefined) tracks.set(key, best.track)
  }
  return tracks
}

/** The effective metadata of the tracks `ids`, by `entityKey`, read from the cache. */
export async function readEffectiveTracks(
  tracks: FxmDatabase['tracks'],
  ids: Iterable<EntityId<'track'>>,
): Promise<Map<string, Track>> {
  return effectiveTracks(await cachedSpellings(tracks, ids))
}

/**
 * What a signal about `id` says about its track: the track's effective metadata under the ID
 * the signal names. A track missing from the cache counts for itself, without artists or tags.
 */
export function signalTrackOf(
  tracks: ReadonlyMap<string, Track>,
  id: EntityId<'track'>,
): ListeningSignalTrack {
  const track = tracks.get(entityKey(id))
  return track === undefined ? { id, title: '', artists: [] } : { ...track, id }
}

/** `signal` scored with the effective metadata of its track. */
export function withEffectiveTrack(
  signal: ListeningSignal,
  tracks: ReadonlyMap<string, Track>,
): ListeningSignal {
  return { ...signal, track: signalTrackOf(tracks, signal.track.id) }
}

/** Merges `entries` into `changes`, per record ID. */
function collectEntries(changes: Map<string, AffinityEntry>, entries: Iterable<AffinityEntry>) {
  for (const part of entries) {
    const id = affinityEntryId(part.kind, part.key)
    const pending = changes.get(id)
    changes.set(id, pending === undefined ? part : mergeAffinity(pending, part))
  }
}

/**
 * Merges entries (contributions, or the changes of `reattributeAffinity`) into the affinity
 * table: one read and one write per touched record, however many entries there are. Records
 * left holding nothing are deleted. Call it inside a transaction that includes the table, so
 * the change lands with what caused it.
 */
export async function applyEntries(
  table: AffinityTable,
  entries: Iterable<AffinityEntry>,
): Promise<void> {
  const changes = new Map<string, AffinityEntry>()
  collectEntries(changes, entries)
  if (changes.size === 0) return
  const ids = [...changes.keys()]
  const stored = await table.bulkGet(ids)
  const puts: AffinityRecord[] = []
  const deletes: string[] = []
  ids.forEach((id, index) => {
    const change = changes.get(id) as AffinityEntry
    const record = stored[index]
    const merged = record === undefined ? change : mergeAffinity(affinityEntryOf(record), change)
    if (isEmptyAffinity(merged)) deletes.push(id)
    else puts.push(affinityRecord(merged))
  })
  if (puts.length > 0) await table.bulkPut(puts)
  if (deletes.length > 0) await table.bulkDelete(deletes)
}

/**
 * Merges what `signals` contribute into the affinity table (see {@link applyEntries}). Each
 * signal must already carry its track's effective metadata ({@link withEffectiveTrack}).
 */
export async function applySignals(
  table: AffinityTable,
  signals: readonly ListeningSignal[],
): Promise<void> {
  await applyEntries(
    table,
    signals.flatMap((signal) => affinityContributions(signal)),
  )
}

/** The effective metadata of one track before and after a save. */
export interface MetadataChange {
  /** The track's `entityKey`. */
  key: string
  /** Its effective metadata before; `undefined` when it wasn't cached. */
  from: ListeningSignalTrack | undefined
  /** Its effective metadata after. */
  to: ListeningSignalTrack | undefined
}

function sameCredits(a: readonly AffinityCredit[], b: readonly AffinityCredit[]): boolean {
  return (
    a.length === b.length &&
    a.every((credit, index) => {
      const other = b[index]
      return (
        other !== undefined &&
        credit.kind === other.kind &&
        credit.key === other.key &&
        credit.share === other.share
      )
    })
  )
}

/**
 * Moves the affinity of tracks whose effective metadata changed to the artists and tags the
 * new metadata credits (`reattributeAffinity`). Call it in the transaction that saved the
 * metadata, before scoring any new signal of those tracks.
 */
export async function reattribute(
  table: AffinityTable,
  changes: readonly MetadataChange[],
): Promise<void> {
  const moved = changes.flatMap((change) => {
    const from = change.from === undefined ? [] : affinityCredits(change.from)
    const to = change.to === undefined ? [] : affinityCredits(change.to)
    return sameCredits(from, to) ? [] : [{ id: affinityEntryId('track', change.key), from, to }]
  })
  if (moved.length === 0) return
  const tracks = await table.bulkGet(moved.map((change) => change.id))
  await applyEntries(
    table,
    moved.flatMap(({ from, to }, index) => {
      const track = tracks[index]
      return track === undefined ? [] : reattributeAffinity(affinityEntryOf(track), from, to)
    }),
  )
}

/** When a playlist's track was added: its own date, else the playlist's creation. */
export function addedAtOf(playlist: PlaylistRecord, trackId: EntityId<'track'>): number {
  return Object.hasOwn(playlist.addedAt, trackId)
    ? (playlist.addedAt[trackId] as number)
    : playlist.createdAt
}

/** What the library holds that stands for listening signals. */
export interface LibraryState {
  /** Every play. */
  history: readonly Omit<HistoryRecord, 'id'>[]
  /** Every like. */
  likes: readonly LikeRecord[]
  /** Every playlist of the library, the built-in ones included. */
  playlists: readonly PlaylistRecord[]
  /** The effective metadata of the tracks, by `entityKey` ({@link effectiveTracks}). */
  tracks: ReadonlyMap<string, Track>
}

/**
 * The signals the library stands for: a play for every history entry, a like for every like,
 * and a playlist add for every track of every playlist, Downloads included, at the time it was
 * added. Liked songs is left out: its tracks are the likes. Each is scored with its track's
 * effective metadata; a track missing from the cache still counts for itself, without artists
 * or tags.
 */
export function librarySignals(state: LibraryState): ListeningSignal[] {
  const trackOf = (id: EntityId<'track'>) => signalTrackOf(state.tracks, id)
  const signals = state.history.map((entry) => playSignalOf(entry, state.tracks))
  for (const like of state.likes) {
    signals.push({ type: 'like', at: like.likedAt, track: trackOf(like.trackId) })
  }
  for (const playlist of state.playlists) {
    if (playlist.system === 'liked') continue
    for (const trackId of playlist.trackIds) {
      signals.push({
        type: 'playlist-add',
        at: addedAtOf(playlist, trackId),
        track: trackOf(trackId),
        playlistId: playlist.id,
      })
    }
  }
  return signals
}

/**
 * The play signal of a history entry, scored with its track's effective metadata. The history
 * keeps the queue's context; the signal its stored form (`playContextOf`).
 */
export function playSignalOf(
  entry: Omit<HistoryRecord, 'id'>,
  tracks: ReadonlyMap<string, Track>,
): ListeningSignal {
  const context = playContextOf(entry.context)
  return {
    type: 'play',
    at: entry.playedAt,
    track: signalTrackOf(tracks, entry.trackId),
    playedMs: entry.playedMs,
    ...(entry.durationMs === undefined ? {} : { durationMs: entry.durationMs }),
    completed: entry.completed,
    skipped: entry.skipped,
    ...(context === undefined ? {} : { context }),
    ...(entry.stream === undefined ? {} : { stream: entry.stream }),
  }
}

/** The tables a rebuild reads, and the ones it writes. */
export type AffinityTables = Pick<
  FxmDatabase,
  'affinity' | 'history' | 'likes' | 'playlists' | 'settings' | 'tracks'
>

/**
 * Brings every stored time the affinity reads that lies after `now` back to `now`: when likes
 * were made, when plays started, and when tracks were added to playlists (a playlist's
 * creation, for its tracks without a date of their own). Only a clock that went back, or data
 * from a device whose clock ran ahead, leaves such times, and the affinity must never hold one.
 * Returns the playlists as they are now.
 */
async function settleTimes(tables: AffinityTables, now: number): Promise<PlaylistRecord[]> {
  await tables.likes.where('likedAt').above(now).modify({ likedAt: now })
  await tables.history.where('playedAt').above(now).modify({ playedAt: now })
  const playlists = await tables.playlists.toArray()
  const settled = playlists.map((playlist) => {
    // Liked songs' tracks count by their likes.
    if (playlist.system === 'liked') return playlist
    const lateAdd = Object.values(playlist.addedAt).some((at) => at > now)
    const lateCreation =
      playlist.createdAt > now &&
      playlist.trackIds.some((id) => !Object.hasOwn(playlist.addedAt, id))
    if (!lateAdd && !lateCreation) return playlist
    return {
      ...playlist,
      createdAt: lateCreation ? now : playlist.createdAt,
      addedAt: Object.fromEntries(
        Object.entries(playlist.addedAt).map(([id, at]) => [id, Math.min(at, now)]),
      ),
    }
  })
  const changed = settled.filter((playlist, index) => playlist !== playlists[index])
  if (changed.length > 0) await tables.playlists.bulkPut(changed)
  return settled
}

/**
 * Recomputes the whole affinity from the library and replaces the table's records, after
 * bringing any stored time after `now` back to `now`. Call it inside a transaction over these
 * tables. The history is read one entry at a time, so even a long imported one never sits in
 * memory whole. Records the model version it was built with. Returns how many records it
 * wrote.
 */
export async function rebuildAffinity(tables: AffinityTables, now: number): Promise<number> {
  const playlists = await settleTimes(tables, now)
  const likes = await tables.likes.toArray()
  const played = (await tables.history.orderBy('trackId').uniqueKeys()) as EntityId<'track'>[]
  const ids = new Set<EntityId<'track'>>([
    ...played,
    ...likes.map((like) => like.trackId),
    ...playlists.flatMap((playlist) => (playlist.system === 'liked' ? [] : playlist.trackIds)),
  ])
  const tracks = await readEffectiveTracks(tables.tracks, ids)
  const changes = new Map<string, AffinityEntry>()
  const contribute = (signal: ListeningSignal) => {
    collectEntries(changes, affinityContributions(signal, { now }))
  }
  librarySignals({ history: [], likes, playlists, tracks }).forEach(contribute)
  await tables.history.each((entry) => contribute(playSignalOf(entry, tracks)))
  const records = [...changes.values()]
    .filter((entry) => !isEmptyAffinity(entry))
    .map(affinityRecord)
  await tables.affinity.clear()
  await tables.affinity.bulkPut(records)
  await tables.settings.put({
    key: AFFINITY_MODEL_SETTING,
    value: AFFINITY_MODEL_VERSION,
    updatedAt: now,
  })
  return records.length
}

/**
 * Rebuilds the affinity when it no longer fits: when the scoring model changed since it was
 * built (`AFFINITY_MODEL_VERSION`: the half-life, the weights, the keys or the credits), or
 * when it holds a time more than {@link CLOCK_SKEW_MS} after `now` (the clock went back).
 * Call it inside a transaction over these tables. Returns whether it rebuilt.
 */
export async function maintainAffinity(tables: AffinityTables, now: number): Promise<boolean> {
  const model = await tables.settings.get(AFFINITY_MODEL_SETTING)
  const ahead = await tables.affinity
    .where('at')
    .above(now + CLOCK_SKEW_MS)
    .first()
  if (model?.value === AFFINITY_MODEL_VERSION && ahead === undefined) return false
  await rebuildAffinity(tables, now)
  return true
}

/**
 * The `limit` entries of `kind` with the highest affinity at `now`, best first, read straight
 * off the `[kind+rank]` index. Entries without a positive affinity are left out.
 */
export async function topAffinity(
  table: AffinityTable,
  kind: AffinityKind,
  limit: number,
  now: number,
): Promise<AffinityScore[]> {
  const count = Math.max(0, Math.floor(limit))
  if (!(count > 0)) return []
  const records = await table
    .where('[kind+rank]')
    .between([kind, Dexie.minKey], [kind, Dexie.maxKey])
    .reverse()
    .limit(count)
    .toArray()
  return records
    .filter((record) => record.score > 0)
    .map((record) => affinityScoreAt(affinityEntryOf(record), now))
    .sort(compareAffinityScores)
}

/**
 * The affinity at `now` of the entries of `kind` that `values` name: track IDs, artist names,
 * tags, or keys (see `affinityKey`). `undefined` where there is none.
 */
export async function affinityScores(
  table: AffinityTable,
  kind: AffinityKind,
  values: readonly string[],
  now: number,
): Promise<(AffinityScore | undefined)[]> {
  const ids = values.map((value) => {
    const key = affinityKey(kind, value)
    // No record has an empty ID, so a value that names nothing reads as missing.
    return key === undefined ? '' : affinityEntryId(kind, key)
  })
  const records = await table.bulkGet(ids)
  return records.map((record) =>
    record === undefined ? undefined : affinityScoreAt(affinityEntryOf(record), now),
  )
}

/** The affinity table as a core `AffinityReader`, reading at `clock` unless told when. */
export function affinityTableReader(table: AffinityTable, clock: () => number): AffinityReader {
  return {
    top: (kind, { limit = 20, now = clock() } = {}) => topAffinity(table, kind, limit, now),
    scores: (kind, values, { now = clock() } = {}) => affinityScores(table, kind, values, now),
  }
}
