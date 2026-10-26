/**
 * JSON backups of the whole library: every table, custom orders included, plus the app's own
 * settings (catalog mode, theme) when the caller passes them. This module owns the file format
 * and its validation; the repository reads and writes the tables (`snapshot` and `restore` in
 * `repo.ts`). The listening affinity is left out, with the version of the model that built it:
 * it is derived from the history, the likes, the playlists and the track cache, and the
 * repository rebuilds it on import.
 *
 * - **Export** takes the repository's snapshot, read in one transaction, so the file is
 *   consistent.
 * - **Import** parses and validates first: anything that isn't an FXM backup, or comes from a
 *   newer FXM (a newer file format or a newer database schema), is refused, and each record
 *   goes through the guards in `validate.ts`, which drop bad ones. Then the repository writes
 *   it in one transaction, so a failure leaves the library as it was.
 *   - **Replace** makes the library exactly the backup's.
 *   - **Merge** keeps everything here and adds what the backup has on top (the rules are in
 *     `merge.ts`).
 *
 * @module
 */

import { APP_NAME, APP_VERSION, type JsonObject } from '@fxm/core'
import { SCHEMA_VERSION, type TableName } from './database'
import type { LibraryRepo } from './repo'
import type { LibraryTables, RestoreMode } from './types'
import {
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
  tables: LibraryTables
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
  const tables = await repo.snapshot()
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
 * isn't an FXM library backup or comes from a newer FXM, whose file format or database schema
 * this version can't know; drops invalid records and counts them.
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
  // A newer schema may hold tables and fields this version would silently drop.
  const schemaVersion = Number.isSafeInteger(data.schemaVersion)
    ? (data.schemaVersion as number)
    : 0
  if (schemaVersion > SCHEMA_VERSION) {
    throw new BackupError('too-new', 'The backup comes from a newer version of FXM')
  }
  const raw = data.tables
  let skipped = 0
  const take = <T>(name: TableName, sanitize: (row: unknown) => T | null): T[] => {
    const result = sanitizeTable(raw[name], sanitize)
    skipped += result.skipped
    return result.rows
  }
  const tables: LibraryTables = {
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
    schemaVersion,
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
export type ImportMode = RestoreMode

/**
 * Writes a parsed backup into the library, in one transaction (the repository's `restore`).
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
  await repo.restore(parsed.backup.tables, mode)
}
