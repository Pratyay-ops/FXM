/**
 * JSON backups of the whole library: every table, custom orders included, plus the app's own
 * settings (catalog mode, theme) when the caller passes them. The listening affinity is left
 * out, with the version of the model that built it: it is derived from the history, the likes,
 * the playlists and the track cache, and rebuilt on import.
 *
 * - **Export** reads every table in one transaction, so the file is a consistent snapshot.
 * - **Import** parses and validates first: anything that isn't an FXM backup, or comes from a
 *   newer FXM, is refused, and each record goes through the guards in `validate.ts`, which drop
 *   bad ones. Then it writes in one transaction, so a failure leaves the library as it was.
 *   - **Replace** makes the library exactly the backup's.
 *   - **Merge** keeps everything here and adds what the backup has on top (see
 *     {@link importLibrary} for the rules).
 *
 * @module
 */

import { APP_NAME, APP_VERSION, type EntityId, entityKey, type JsonObject } from '@fxm/core'
import { AFFINITY_MODEL_SETTING, rebuildAffinity } from './affinity'
import {
  ensureSystemRecords,
  type FxmDatabase,
  SCHEMA_VERSION,
  TABLE_NAMES,
  type TableName,
} from './database'
import type { LibraryRepo } from './repo'
import type {
  FollowRecord,
  HistoryRecord,
  ImportProgressRecord,
  LikeRecord,
  MatchCacheRecord,
  OrderRecord,
  PlaylistRecord,
  SettingRecord,
  TrackRecord,
} from './types'
import {
  type HistoryEntry,
  sanitizeFollowRecord,
  sanitizeHistoryRecord,
  sanitizeImportProgress,
  sanitizeLikeRecord,
  sanitizeMatchRecord,
  sanitizeOrderRecord,
  sanitizePlaylistRecord,
  sanitizeSettingRecord,
  sanitizeTrackRecord,
} from './validate'

/** What every FXM library backup says it is. */
export const BACKUP_FORMAT = 'fxm-library-backup'

/** The backup file format's version. Imports accept this one and older ones. */
export const BACKUP_VERSION = 1

/** Largest backup file accepted, in bytes. */
export const MAX_BACKUP_BYTES = 64 * 1024 * 1024

/** The rows of every table. */
export interface BackupTables {
  tracks: TrackRecord[]
  likes: LikeRecord[]
  playlists: PlaylistRecord[]
  orders: OrderRecord[]
  follows: FollowRecord[]
  history: (HistoryEntry & { id?: number })[]
  settings: SettingRecord[]
  matchCache: MatchCacheRecord[]
  importProgress: ImportProgressRecord[]
}

/** A library backup file, as JSON. */
export interface LibraryBackup {
  format: typeof BACKUP_FORMAT
  version: typeof BACKUP_VERSION
  /** When it was made, as an ISO 8601 date. */
  exportedAt: string
  /** The app that made it. */
  app: { name: string; version: string }
  /** The database schema version that wrote it. */
  schemaVersion: number
  /** The app's own settings, such as the catalog mode and theme, when included. */
  appSettings?: JsonObject
  /** Every table's rows. */
  tables: BackupTables
}

/** Why a file can't be imported. */
export type BackupErrorCode = 'too-large' | 'not-json' | 'not-a-backup' | 'too-new'

/** A file that can't be imported, with a {@link BackupErrorCode}. */
export class BackupError extends Error {
  override readonly name = 'BackupError'
  readonly code: BackupErrorCode

  constructor(code: BackupErrorCode, message: string) {
    super(message)
    this.code = code
  }
}

/** Reads the whole library into a backup. Pass `appSettings` to include them. */
export async function exportLibrary(
  repo: LibraryRepo,
  { appSettings, now = new Date() }: { appSettings?: JsonObject; now?: Date } = {},
): Promise<LibraryBackup> {
  const { db } = repo
  const tables = await db.transaction(
    'r',
    TABLE_NAMES.map((name) => db.table(name)),
    async () => {
      const read = <T>(name: TableName) => db.table<T>(name).toArray()
      return {
        tracks: await read<TrackRecord>('tracks'),
        likes: await read<LikeRecord>('likes'),
        playlists: await read<PlaylistRecord>('playlists'),
        orders: await read<OrderRecord>('orders'),
        follows: await read<FollowRecord>('follows'),
        history: await read<HistoryRecord>('history'),
        settings: (await read<SettingRecord>('settings')).filter(isPortableSetting),
        matchCache: await read<MatchCacheRecord>('matchCache'),
        importProgress: await read<ImportProgressRecord>('importProgress'),
      }
    },
  )
  const backup: LibraryBackup = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: now.toISOString(),
    app: { name: APP_NAME, version: APP_VERSION },
    schemaVersion: SCHEMA_VERSION,
    tables,
  }
  if (appSettings !== undefined) backup.appSettings = appSettings
  return backup
}

/** The file name for a backup made on `date`, e.g. `fxm-library-2026-10-25.json`. */
export function backupFileName(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `fxm-library-${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}.json`
}

/** A backup as a JSON file. */
export function backupBlob(backup: LibraryBackup): Blob {
  return new Blob([JSON.stringify(backup)], { type: 'application/json' })
}

/** How many records of each kind a backup holds, for the import preview. */
export interface BackupSummary {
  playlists: number
  likes: number
  follows: number
  plays: number
  tracks: number
}

/** A validated backup, ready to import. */
export interface ParsedBackup {
  backup: LibraryBackup
  summary: BackupSummary
  /** Records dropped because they were invalid. */
  skipped: number
}

function sanitizeTable<T>(
  rows: unknown,
  sanitize: (row: unknown) => T | null,
): { rows: T[]; skipped: number } {
  if (!Array.isArray(rows)) return { rows: [], skipped: 0 }
  const clean: T[] = []
  for (const row of rows) {
    const value = sanitize(row)
    if (value !== null) clean.push(value)
  }
  return { rows: clean, skipped: rows.length - clean.length }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Parses and validates a backup file's text. Throws a {@link BackupError} for anything that
 * isn't an FXM library backup or comes from a newer FXM; drops invalid records and counts them.
 */
export function parseBackup(text: string): ParsedBackup {
  if (text.length > MAX_BACKUP_BYTES) {
    throw new BackupError('too-large', 'The file is too large to be an FXM backup')
  }
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    throw new BackupError('not-json', 'The file is not valid JSON')
  }
  if (!isObject(data) || data.format !== BACKUP_FORMAT || !isObject(data.tables)) {
    throw new BackupError('not-a-backup', 'The file is not an FXM library backup')
  }
  if (!Number.isSafeInteger(data.version) || (data.version as number) < 1) {
    throw new BackupError('not-a-backup', 'The backup has no valid version')
  }
  if ((data.version as number) > BACKUP_VERSION) {
    throw new BackupError('too-new', 'The backup comes from a newer version of FXM')
  }
  const raw = data.tables
  let skipped = 0
  const take = <T>(name: TableName, sanitize: (row: unknown) => T | null): T[] => {
    const result = sanitizeTable(raw[name], sanitize)
    skipped += result.skipped
    return result.rows
  }
  const tables: BackupTables = {
    tracks: take('tracks', sanitizeTrackRecord),
    likes: take('likes', sanitizeLikeRecord),
    playlists: take('playlists', sanitizePlaylistRecord),
    orders: take('orders', sanitizeOrderRecord),
    follows: take('follows', sanitizeFollowRecord),
    history: take('history', sanitizeHistoryRecord),
    settings: take('settings', sanitizeSettingRecord),
    matchCache: take('matchCache', sanitizeMatchRecord),
    importProgress: take('importProgress', sanitizeImportProgress),
  }
  const app = isObject(data.app) ? data.app : {}
  const backup: LibraryBackup = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: typeof data.exportedAt === 'string' ? data.exportedAt : '',
    app: {
      name: typeof app.name === 'string' ? app.name : APP_NAME,
      version: typeof app.version === 'string' ? app.version : '',
    },
    schemaVersion: Number.isSafeInteger(data.schemaVersion) ? (data.schemaVersion as number) : 0,
    tables,
  }
  if (isObject(data.appSettings)) backup.appSettings = data.appSettings as JsonObject
  const userPlaylists = tables.playlists.filter((playlist) => playlist.system === undefined)
  return {
    backup,
    skipped,
    summary: {
      playlists: userPlaylists.length,
      likes: tables.likes.length,
      follows: tables.follows.length,
      plays: tables.history.length,
      tracks: tables.tracks.length,
    },
  }
}

/** How an import treats the library that is already here. */
export type ImportMode = 'merge' | 'replace'

/** Merges two orders: `first`, then the items of `second` it lacks, by `entityKey`. */
function unionOrder<K extends string>(first: readonly K[], second: readonly K[]): K[] {
  const seen = new Set(first.map((id) => entityKey(id as unknown as EntityId)))
  const extra = second.filter((id) => {
    const key = entityKey(id as unknown as EntityId)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  return [...first, ...extra]
}

/** One playlist that exists here and in the backup: the newer edit leads. */
function mergePlaylist(here: PlaylistRecord, incoming: PlaylistRecord): PlaylistRecord {
  const [newer, older] = incoming.updatedAt > here.updatedAt ? [incoming, here] : [here, incoming]
  const trackIds = unionOrder(newer.trackIds, older.trackIds)
  const addedAt: Record<string, number> = {}
  for (const id of trackIds) {
    const dates = [here.addedAt[id], incoming.addedAt[id]].filter(
      (at): at is number => at !== undefined,
    )
    if (dates.length > 0) addedAt[id] = Math.min(...dates)
  }
  const { undo: _undo, ...rest } = newer
  return {
    ...rest,
    createdAt: Math.min(here.createdAt, incoming.createdAt),
    trackIds,
    addedAt,
  }
}

/** Whether `incoming` should replace `here` in the match cache: a pin always wins. */
function newerDecision(here: MatchCacheRecord, incoming: MatchCacheRecord): boolean {
  if (here.userPinned !== incoming.userPinned) return incoming.userPinned
  return incoming.decidedAt > here.decidedAt
}

async function writeMerged(db: FxmDatabase, tables: BackupTables): Promise<void> {
  // Tracks: the most recently saved metadata wins.
  const tracksHere = await db.tracks.bulkGet(tables.tracks.map((row) => row.id))
  await db.tracks.bulkPut(
    tables.tracks.filter((row, index) => {
      const here = tracksHere[index]
      return here === undefined || row.updatedAt > here.updatedAt
    }),
  )
  // Likes, follows and reserved settings: what is here stays; the backup adds the rest.
  await db.likes.bulkAdd(await missing(db.likes, tables.likes, (row) => row.key))
  await db.follows.bulkAdd(await missing(db.follows, tables.follows, (row) => row.key))
  await db.settings.bulkAdd(await missing(db.settings, tables.settings, (row) => row.key))
  // Playlists: new ones are added; one that exists in both merges, the newer edit leading.
  for (const incoming of tables.playlists) {
    const here = await db.playlists.get(incoming.id)
    await db.playlists.put(here === undefined ? incoming : mergePlaylist(here, incoming))
  }
  // The list of playlists: this order first, then the backup's playlists it lacks.
  const order = await db.orders.get('playlists')
  const incomingOrder = tables.orders.find((row) => row.id === 'playlists')
  if (incomingOrder !== undefined) {
    await db.orders.put({
      id: 'playlists',
      order: unionOrder(order?.order ?? [], incomingOrder.order),
      updatedAt: Math.max(order?.updatedAt ?? 0, incomingOrder.updatedAt),
    })
  }
  // History: plays of the same track at the same time are the same play.
  const seen = new Set<string>()
  await db.history.each((entry) => {
    seen.add(`${entityKey(entry.trackId)}|${entry.playedAt}`)
  })
  const plays = tables.history
    .filter((entry) => {
      const key = `${entityKey(entry.trackId)}|${entry.playedAt}`
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
      return here === undefined || newerDecision(here, row)
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

/** The rows of `rows` whose key `table` doesn't have yet, each key once. */
async function missing<T>(
  table: { bulkGet(keys: string[]): PromiseLike<unknown[]> },
  rows: readonly T[],
  keyOf: (row: T) => string,
): Promise<T[]> {
  const unique = new Map(rows.map((row) => [keyOf(row), row]))
  const existing = await table.bulkGet([...unique.keys()])
  return [...unique.values()].filter((_, index) => existing[index] === undefined)
}

async function writeReplaced(db: FxmDatabase, tables: BackupTables): Promise<void> {
  for (const name of TABLE_NAMES) await db.table(name).clear()
  await db.tracks.bulkPut(tables.tracks)
  await db.likes.bulkPut(tables.likes)
  await db.playlists.bulkPut(tables.playlists)
  await db.orders.bulkPut(tables.orders)
  await db.follows.bulkPut(tables.follows)
  await db.history.bulkPut(tables.history as HistoryRecord[])
  await db.settings.bulkPut(tables.settings)
  await db.matchCache.bulkPut(tables.matchCache)
  await db.importProgress.bulkPut(tables.importProgress)
}

/** Whether a setting belongs in a backup: all but the affinity's own, which is rebuilt. */
function isPortableSetting(row: SettingRecord): boolean {
  return row.key !== AFFINITY_MODEL_SETTING
}

/**
 * The backup's tables as they may enter the library at `now`: without plays that start after
 * `now`, and without the affinity's model version, which the rebuild writes. The listening
 * affinity must never hold a time after the library's clock, and a play moved to now would be a
 * new play every time the same backup is merged again, so such plays stay out. Likes and
 * playlist entries dated after `now` count from now (the rebuild after the import brings them
 * back).
 */
function importable(tables: BackupTables, now: number): BackupTables {
  return {
    ...tables,
    history: tables.history.filter((entry) => entry.playedAt <= now),
    settings: tables.settings.filter(isPortableSetting),
  }
}

/**
 * Writes a parsed backup into the library, in one transaction.
 *
 * - `replace`: the library becomes exactly the backup's, custom orders included.
 * - `merge`: nothing here is lost. New playlists, likes, follows and plays are added. A
 *   playlist that is in both keeps the name and order of its newer edit, followed by the
 *   tracks only the other one has. The list of playlists keeps its order here, and the
 *   backup's playlists that it lacks follow at the end. In the match cache a pin wins.
 *
 * The built-in playlists exist afterwards in both modes, and the listening affinity is
 * recomputed from the library that results. No time after the library's clock gets in: plays
 * that start later are left out, and likes and playlist entries dated later count from now.
 */
export async function importLibrary(
  repo: LibraryRepo,
  parsed: ParsedBackup,
  mode: ImportMode,
): Promise<void> {
  const { db } = repo
  const now = repo.now()
  const tables = importable(parsed.backup.tables, now)
  await db.transaction(
    'rw',
    TABLE_NAMES.map((name) => db.table(name)),
    async () => {
      if (mode === 'replace') await writeReplaced(db, tables)
      else await writeMerged(db, tables)
      await ensureSystemRecords(db, now)
      await rebuildAffinity(db, now)
    },
  )
}
