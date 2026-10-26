/**
 * The local-files database: Dexie over IndexedDB, named `fxm-local-files`, apart from the
 * library's `fxm` database.
 *
 * It is kept apart because everything in it describes this device: the folders the user gave
 * FXM access to (with their handles, which can't be written to a backup file), the files in
 * them and small cover thumbnails. The library's backups leave it out, and removing a folder
 * or clearing it never touches the library. The tracks the user likes or adds to playlists are
 * in the library, like every other track.
 *
 * To change the schema, add a version with only the tables that change and, when stored
 * records need rewriting, an `upgrade`; never edit a shipped version (see the library's
 * `src/db/README.md`, which this follows). Only `repo.ts` reads and writes these tables.
 *
 * @module
 */

import { Dexie, type DexieOptions, type EntityTable } from 'dexie'
import type { HandleRecord, LocalFileRecord, LocalPictureRecord, LocalRootRecord } from './types'

/** The IndexedDB database of the local-files feature. */
export const LOCAL_DB_NAME = 'fxm-local-files'

/** The local-files database with its typed tables. Create one with {@link openLocalDatabase}. */
export type LocalFilesDatabase = Dexie & {
  roots: EntityTable<LocalRootRecord, 'id'>
  files: EntityTable<LocalFileRecord, 'key'>
  pictures: EntityTable<LocalPictureRecord, 'key'>
  handles: EntityTable<HandleRecord, 'rootId'>
}

/**
 * Version 1. `files` is indexed by root (a root's files), by native ID (playing a track), by when
 * each file was first listed (Recently added) and by ISRC (a local copy of a catalog track).
 */
export const LOCAL_SCHEMA_V1 = {
  roots: 'id, addedAt',
  files: 'key, rootId, id, addedAt, tags.isrc',
  pictures: 'key',
  handles: 'rootId',
} as const

/** Opens (lazily, on first use) the local-files database. Tests pass a name and a fake `indexedDB`. */
export function openLocalDatabase(
  name: string = LOCAL_DB_NAME,
  options?: DexieOptions,
): LocalFilesDatabase {
  const db = new Dexie(name, options) as LocalFilesDatabase
  db.version(1).stores(LOCAL_SCHEMA_V1)
  return db
}
