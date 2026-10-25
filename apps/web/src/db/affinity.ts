/**
 * The listening affinity on disk (stage 3.1): one record per track, artist and tag in the
 * `affinity` table. The repository merges every new signal into it in the same transaction as
 * the change that caused it (a play, a like, a playlist edit), and rebuilds it from the library
 * when that is simpler: after the history is cleared, after a backup is restored, and in the
 * version 3 upgrade.
 *
 * The math is core's (`signalContributions`, `mergeAffinity`, `affinityRank`); this module
 * reads and writes records. The affinity is derived data: the history holds the plays, the
 * `likes` table the likes, and each playlist the time each of its tracks was added.
 * {@link librarySignals} turns them back into signals, and because taking a like or an add
 * back cancels it exactly, a rebuild gives what the signals added up to one by one.
 *
 * @module
 */

import {
  type AffinityEntry,
  type AffinityKind,
  type AffinityScore,
  affinityAt,
  affinityRank,
  type EntityId,
  isEmptyAffinity,
  type ListeningSignal,
  mergeAffinity,
  type SignalTrack,
  signalContributions,
  type Track,
} from '@fxm/core'
import { Dexie } from 'dexie'
import type { FxmDatabase } from './database'
import type { AffinityRecord, HistoryRecord, LikeRecord, PlaylistRecord } from './types'

/** The affinity table. */
type AffinityTable = FxmDatabase['affinity']

/** The ID of an affinity record: its kind and key, e.g. `artist|radiohead`. */
export function affinityId(kind: AffinityKind, key: string): string {
  return `${kind}|${key}`
}

/** An entry as it is stored, with its ID and rank. */
export function affinityRecord(entry: AffinityEntry): AffinityRecord {
  return { ...entry, id: affinityId(entry.kind, entry.key), rank: affinityRank(entry) }
}

/** A stored record as a core entry. */
export function affinityEntryOf(record: AffinityRecord): AffinityEntry {
  const { id: _id, rank: _rank, ...entry } = record
  return entry
}

/** An entry with its affinity and skips at `now`. */
export function scoreAt(entry: AffinityEntry, now: number): AffinityScore {
  return { entry, ...affinityAt(entry, now) }
}

/**
 * When a playlist's track was added: its own date, else the playlist's creation, which is all
 * that a playlist restored from an old backup may say.
 */
export function addedAtOf(playlist: PlaylistRecord, trackId: EntityId<'track'>): number {
  return Object.hasOwn(playlist.addedAt, trackId)
    ? (playlist.addedAt[trackId] as number)
    : playlist.createdAt
}

/** Merges what `signal` contributes into `changes`, per record ID. */
function collectInto(changes: Map<string, AffinityEntry>, signal: ListeningSignal): void {
  for (const part of signalContributions(signal)) {
    const id = affinityId(part.kind, part.key)
    const pending = changes.get(id)
    changes.set(id, pending === undefined ? part : mergeAffinity(pending, part))
  }
}

/** The contributions of `signals`, merged per record ID. */
function collect(signals: Iterable<ListeningSignal>): Map<string, AffinityEntry> {
  const changes = new Map<string, AffinityEntry>()
  for (const signal of signals) collectInto(changes, signal)
  return changes
}

/**
 * Merges what `signals` contribute into the affinity table: one read and one write per touched
 * record, however many signals there are. Records left holding nothing are deleted. Call it
 * inside a transaction that includes the table, so the change lands with what caused it.
 */
export async function applySignals(
  table: AffinityTable,
  signals: readonly ListeningSignal[],
): Promise<void> {
  const changes = collect(signals)
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

/** What the library holds that stands for listening signals. */
export interface LibraryState {
  /** Every play. */
  history: readonly Omit<HistoryRecord, 'id'>[]
  /** Every like. */
  likes: readonly LikeRecord[]
  /** Every playlist of the library, the built-in ones included. */
  playlists: readonly PlaylistRecord[]
  /** The cached tracks, by ID: their titles, artists and tags. */
  tracks: ReadonlyMap<string, Track>
}

/**
 * The signals the library stands for: a play for every history entry, a like for every like,
 * and a playlist add for every track of every playlist, Downloads included, at the time it was
 * added. Liked songs is left out: its tracks are the likes. A track missing from the cache
 * still counts for itself, without artists or tags, and a play recorded without the track's
 * length (before stage 3.1) is measured against the cached one.
 */
export function librarySignals(state: LibraryState): ListeningSignal[] {
  const trackOf = (id: EntityId<'track'>) => cachedSignalTrack(state.tracks, id)
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

/** The cached track `id` as a signal needs it; a track missing from the cache counts for itself. */
function cachedSignalTrack(tracks: ReadonlyMap<string, Track>, id: EntityId<'track'>): SignalTrack {
  return tracks.get(id) ?? { id, title: '', artists: [] }
}

/**
 * The play signal of a history entry. An entry recorded without the track's length (before
 * stage 3.1) is measured against the cached track's.
 */
export function playSignalOf(
  entry: Omit<HistoryRecord, 'id'>,
  tracks: ReadonlyMap<string, Track>,
): ListeningSignal {
  const durationMs = entry.durationMs ?? tracks.get(entry.trackId)?.durationMs
  return {
    type: 'play',
    at: entry.playedAt,
    track: cachedSignalTrack(tracks, entry.trackId),
    playedMs: entry.playedMs,
    ...(durationMs === undefined ? {} : { durationMs }),
    completed: entry.completed,
    skipped: entry.skipped,
    ...(entry.context === undefined ? {} : { context: entry.context }),
    ...(entry.stream === undefined ? {} : { stream: entry.stream }),
  }
}

/** The tables a rebuild reads, and the one it writes. */
export type AffinityTables = Pick<
  FxmDatabase,
  'affinity' | 'history' | 'likes' | 'playlists' | 'tracks'
>

/**
 * Recomputes the whole affinity from the library and replaces the table's records. Call it
 * inside a transaction over these tables. The history is read one entry at a time, so even a
 * long imported one never sits in memory whole. Returns how many records it wrote.
 */
export async function rebuildAffinity(tables: AffinityTables): Promise<number> {
  const likes = await tables.likes.toArray()
  const playlists = await tables.playlists.toArray()
  const played = (await tables.history.orderBy('trackId').uniqueKeys()) as EntityId<'track'>[]
  const ids = new Set<EntityId<'track'>>([
    ...played,
    ...likes.map((like) => like.trackId),
    ...playlists.flatMap((playlist) => (playlist.system === 'liked' ? [] : playlist.trackIds)),
  ])
  const cached = await tables.tracks.bulkGet([...ids])
  const tracks = new Map<string, Track>()
  for (const record of cached) if (record !== undefined) tracks.set(record.id, record.track)
  const changes = collect(librarySignals({ history: [], likes, playlists, tracks }))
  await tables.history.each((entry) => {
    collectInto(changes, playSignalOf(entry, tracks))
  })
  const records = [...changes.values()]
    .filter((entry) => !isEmptyAffinity(entry))
    .map(affinityRecord)
  await tables.affinity.clear()
  await tables.affinity.bulkPut(records)
  return records.length
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
  if (count === 0) return []
  const records = await table
    .where('[kind+rank]')
    .between([kind, Dexie.minKey], [kind, Dexie.maxKey])
    .reverse()
    .limit(count)
    .toArray()
  return records
    .filter((record) => record.score > 0)
    .map((record) => scoreAt(affinityEntryOf(record), now))
    .sort((a, b) => b.score - a.score || (a.entry.key < b.entry.key ? -1 : 1))
}
