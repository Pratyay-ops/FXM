/**
 * The installed plugins on disk: an IndexedDB database of its own, `fxm-plugins`, apart from the
 * library's `fxm`. So the library's schema never changes for it, and library backups never carry
 * plugins: restoring a backup must never install code the user didn't approve on this device.
 *
 * @module
 */

import type { PluginStore, StoredPlugin } from '@fxm/plugins'
import { Dexie, type EntityTable } from 'dexie'

/** The database's name. */
export const PLUGINS_DB_NAME = 'fxm-plugins'

/** The plugins database with its typed table. */
export type PluginsDatabase = Dexie & { plugins: EntityTable<StoredPlugin, 'id'> }

/** Version 1: one table of plugins, keyed by their ID. */
export const PLUGINS_SCHEMA_V1 = { plugins: 'id' } as const

/** Opens (lazily, on first use) the plugins database. Tests pass another name. */
export function openPluginsDatabase(name: string = PLUGINS_DB_NAME): PluginsDatabase {
  const db = new Dexie(name) as PluginsDatabase
  db.version(1).stores(PLUGINS_SCHEMA_V1)
  return db
}

/** A plugin store (`PluginStore` of `@fxm/plugins`) on the plugins database. */
export function createDexiePluginStore(db: PluginsDatabase): PluginStore {
  return {
    list: () => db.plugins.toArray(),
    async put(plugin) {
      await db.plugins.put(plugin)
    },
    async delete(id) {
      await db.plugins.delete(id)
    },
  }
}
