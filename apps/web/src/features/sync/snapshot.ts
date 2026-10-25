/**
 * The part of the library that sync carries between devices, as a normalized snapshot.
 *
 * A snapshot is made of the same records as a library backup (`db/backup.ts`), and every record
 * goes through the backup's guards in `db/validate.ts`, whether it comes from this device's
 * database or from GitHub. So the three snapshots a sync compares (the last synced one, this
 * device's and the gist's) always spell equal data the same way, and nothing invalid reaches
 * the library.
 *
 * What sync carries, and what stays on each device:
 *
 * | Carried | Stays on the device |
 * |---|---|
 * | Tracks (the metadata lists show), likes, playlists with their custom order, Liked songs' order, the order of the playlists list, follows, listening history, reserved settings, the app settings (catalog mode, theme) | Downloads: it lists files stored on this device only |
 * | The user's pins in the match cache ("Not the right version?") | The matching engine's own decisions: a cache each device rebuilds |
 * | | Import progress: an import resumes on the device that runs it |
 * | | Undo orders: Undo applies to this device's last shuffle or saved sort |
 * | Plays of the last {@link HISTORY_WINDOW_MS} (90 days) | Older plays: sync never touches them |
 * | Track metadata that the carried playlists, likes, plays and pins use | The rest of the track cache |
 *
 * Every update of a gist sends the whole gist back, so sync carries what other devices need and
 * no more.
 *
 * @module
 */

import { entityKey, type JsonObject, type JsonValue } from '@fxm/core'
import {
  DOWNLOADS_PLAYLIST_ID,
  type FollowRecord,
  type LikeRecord,
  type MatchCacheRecord,
  type OrderRecord,
  type PlaylistRecord,
  type SettingRecord,
  type TrackRecord,
} from '../../db/types'
import {
  type HistoryEntry,
  sanitizeFollowRecord,
  sanitizeHistoryRecord,
  sanitizeLikeRecord,
  sanitizeMatchRecord,
  sanitizeOrderRecord,
  sanitizePlaylistRecord,
  sanitizeSettingRecord,
  sanitizeTrackRecord,
} from '../../db/validate'
import { canonicalJson, hashHex } from './canonical'

const DAY = 24 * 60 * 60 * 1000

/** How far back plays sync. Older plays stay on each device, and sync never touches them. */
export const HISTORY_WINDOW_MS = 90 * DAY

/**
 * Near the start of the window, a play the gist lacks isn't taken for a deletion: the device
 * that wrote the gist may have cut its window a little later (clocks differ).
 */
export const HISTORY_EDGE_MS = 7 * DAY

/** The backup tables sync carries, by the names backups give them. */
export const SYNC_TABLES = [
  'tracks',
  'likes',
  'playlists',
  'orders',
  'follows',
  'history',
  'settings',
  'matchCache',
] as const

/** One of the {@link SYNC_TABLES}. */
export type SyncTable = (typeof SYNC_TABLES)[number]

/** Whether `value` names one of the {@link SYNC_TABLES}. */
export function isSyncTable(value: unknown): value is SyncTable {
  return typeof value === 'string' && (SYNC_TABLES as readonly string[]).includes(value)
}

/**
 * The synced part of a library. Every list is sorted by its key (history by time), so equal
 * libraries give equal snapshots.
 */
export interface SyncSnapshot {
  tracks: TrackRecord[]
  likes: LikeRecord[]
  /** The user's playlists and Liked songs, without Downloads, and without undo orders. */
  playlists: PlaylistRecord[]
  /** The order of the playlists list, without its undo order. */
  order?: OrderRecord
  follows: FollowRecord[]
  /** Plays, without the database's IDs, which differ on every device. */
  history: HistoryEntry[]
  settings: SettingRecord[]
  /** The match-cache decisions the user pinned. */
  pins: MatchCacheRecord[]
  /** The app's own settings, such as `catalogMode` and `theme`. */
  appSettings: JsonObject
}

/** The rows of each synced table, as a backup or a gist part holds them. */
export type SyncRows = Partial<Record<SyncTable, readonly unknown[]>>

/** A snapshot of an empty library. */
export function emptySnapshot(): SyncSnapshot {
  return {
    tracks: [],
    likes: [],
    playlists: [],
    follows: [],
    history: [],
    settings: [],
    pins: [],
    appSettings: {},
  }
}

/** What identifies a play across devices: the track (by `entityKey`) and when it started. */
export function historyKey(entry: Pick<HistoryEntry, 'trackId' | 'playedAt'>): string {
  return `${entityKey(entry.trackId)}|${entry.playedAt}`
}

const byKey =
  <T>(keyOf: (row: T) => string) =>
  (a: T, b: T): number => {
    const left = keyOf(a)
    const right = keyOf(b)
    return left < right ? -1 : left > right ? 1 : 0
  }

const byPlay = (a: HistoryEntry, b: HistoryEntry): number =>
  a.playedAt - b.playedAt || byKey(historyKey)(a, b)

/** The rows `sanitize` accepts, each key once (the first wins), and how many it dropped. */
function clean<T>(
  rows: readonly unknown[] | undefined,
  sanitize: (row: unknown) => T | null,
  keyOf: (row: T) => string,
  keep: (row: T) => boolean = () => true,
): { rows: T[]; skipped: number } {
  const seen = new Set<string>()
  const result: T[] = []
  let skipped = 0
  for (const row of rows ?? []) {
    const value = sanitize(row)
    if (value === null) {
      skipped++
      continue
    }
    if (!keep(value)) continue
    const key = keyOf(value)
    if (seen.has(key)) continue
    seen.add(key)
    result.push(value)
  }
  return { rows: result, skipped }
}

function withoutUndo<T extends { undo?: unknown }>(record: T): T {
  if (record.undo === undefined) return record
  const { undo: _undo, ...rest } = record
  return rest as T
}

function isJsonValue(value: unknown, depth = 16): value is JsonValue {
  if (depth < 0) return false
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.every((item) => isJsonValue(item, depth - 1))
  return (
    typeof value === 'object' &&
    Object.values(value as Record<string, unknown>).every((item) => isJsonValue(item, depth - 1))
  )
}

/** A plain object of JSON values, dropping fields that aren't; `{}` for anything else. */
export function cleanJsonObject(value: unknown): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  const result: Record<string, JsonValue> = {}
  for (const [key, field] of Object.entries(value as Record<string, unknown>)) {
    if (isJsonValue(field)) result[key] = field
  }
  return result
}

/**
 * Builds a snapshot from table rows (a backup's tables, or the parts of a gist), keeping only
 * what sync carries and cleaning every record with the backup's guards. Returns how many
 * records were dropped as invalid.
 */
export function snapshotFromRows(
  rows: SyncRows,
  appSettings: unknown,
): { snapshot: SyncSnapshot; skipped: number } {
  let skipped = 0
  const take = <T>(result: { rows: T[]; skipped: number }): T[] => {
    skipped += result.skipped
    return result.rows
  }
  const tracks = take(clean(rows.tracks, sanitizeTrackRecord, (row) => row.id))
  const likes = take(clean(rows.likes, sanitizeLikeRecord, (row) => row.key))
  const playlists = take(
    clean(
      rows.playlists,
      sanitizePlaylistRecord,
      (row) => row.id,
      (row) => row.id !== DOWNLOADS_PLAYLIST_ID,
    ),
  ).map(withoutUndo)
  const [order] = take(clean(rows.orders, sanitizeOrderRecord, (row) => row.id)).map(withoutUndo)
  const follows = take(clean(rows.follows, sanitizeFollowRecord, (row) => row.key))
  const history = take(
    clean(
      rows.history,
      sanitizeHistoryRecord,
      (row) => historyKey(row),
      () => true,
    ),
  ).map(({ id: _id, ...entry }) => entry)
  const settings = take(clean(rows.settings, sanitizeSettingRecord, (row) => row.key))
  const pins = take(
    clean(
      rows.matchCache,
      sanitizeMatchRecord,
      (row) => row.key,
      (row) => row.userPinned,
    ),
  )
  const snapshot: SyncSnapshot = {
    tracks,
    likes,
    playlists,
    follows,
    history,
    settings,
    pins,
    appSettings: cleanJsonObject(appSettings),
  }
  if (order !== undefined) snapshot.order = order
  return { snapshot: normalizeSnapshot(snapshot), skipped }
}

/** `snapshot` with every list in its canonical order. Returns a new object. */
export function normalizeSnapshot(snapshot: SyncSnapshot): SyncSnapshot {
  const result: SyncSnapshot = {
    tracks: [...snapshot.tracks].sort(byKey((row) => row.id)),
    likes: [...snapshot.likes].sort(byKey((row) => row.key)),
    playlists: [...snapshot.playlists].sort(byKey((row) => row.id)),
    follows: [...snapshot.follows].sort(byKey((row) => row.key)),
    history: [...snapshot.history].sort(byPlay),
    settings: [...snapshot.settings].sort(byKey((row) => row.key)),
    pins: [...snapshot.pins].sort(byKey((row) => row.key)),
    appSettings: snapshot.appSettings,
  }
  if (snapshot.order !== undefined) result.order = snapshot.order
  return result
}

/** `snapshot` with only the plays that started at `since` or later. */
export function withHistorySince(snapshot: SyncSnapshot, since: number): SyncSnapshot {
  if (snapshot.history.every((entry) => entry.playedAt >= since)) return snapshot
  return { ...snapshot, history: snapshot.history.filter((entry) => entry.playedAt >= since) }
}

/**
 * `snapshot` with only the cached tracks its playlists, likes, plays and pins use: what other
 * devices need to show them. Tracks are a cache, so leaving one out deletes nothing anywhere.
 */
export function withUsedTracks(snapshot: SyncSnapshot): SyncSnapshot {
  const used = new Set<string>()
  for (const playlist of snapshot.playlists) for (const id of playlist.trackIds) used.add(id)
  for (const like of snapshot.likes) used.add(like.trackId)
  for (const entry of snapshot.history) used.add(entry.trackId)
  for (const pin of snapshot.pins) used.add(pin.sourceTrackId)
  if (snapshot.tracks.every((row) => used.has(row.id))) return snapshot
  return { ...snapshot, tracks: snapshot.tracks.filter((row) => used.has(row.id)) }
}

/**
 * Whether two snapshots differ only in what changes in the background, plays and the track
 * cache, which can wait for a later push.
 */
export function differOnlyInBackground(a: SyncSnapshot, b: SyncSnapshot): boolean {
  const rest = (snapshot: SyncSnapshot) =>
    canonicalJson({ ...normalizeSnapshot(snapshot), history: [], tracks: [] })
  return rest(a) === rest(b)
}

/** A snapshot's rows by table name, as a gist part or a backup holds them. */
export function snapshotRows(snapshot: SyncSnapshot): Record<SyncTable, readonly unknown[]> {
  return {
    tracks: snapshot.tracks,
    likes: snapshot.likes,
    playlists: snapshot.playlists,
    orders: snapshot.order === undefined ? [] : [snapshot.order],
    follows: snapshot.follows,
    history: snapshot.history,
    settings: snapshot.settings,
    matchCache: snapshot.pins,
  }
}

/** A short hash of a snapshot's whole content: equal snapshots have equal fingerprints. */
export function snapshotFingerprint(snapshot: SyncSnapshot): string {
  return hashHex(canonicalJson(normalizeSnapshot(snapshot)))
}

/** How many of each thing a snapshot holds, for people. */
export interface SnapshotSummary {
  playlists: number
  likes: number
  follows: number
  plays: number
}

/** Counts a snapshot's playlists (the user's own), likes, follows and plays. */
export function summarizeSnapshot(snapshot: SyncSnapshot): SnapshotSummary {
  return {
    playlists: snapshot.playlists.filter((playlist) => playlist.system === undefined).length,
    likes: snapshot.likes.length,
    follows: snapshot.follows.length,
    plays: snapshot.history.length,
  }
}

/** Whether a snapshot holds anything of the user's: a playlist, a like, a follow or a play. */
export function hasLibraryData(snapshot: SyncSnapshot): boolean {
  const summary = summarizeSnapshot(snapshot)
  return summary.playlists + summary.likes + summary.follows + summary.plays > 0
}
