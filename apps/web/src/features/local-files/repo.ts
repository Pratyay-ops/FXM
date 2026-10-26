/**
 * The local-files repository: the only code that reads and writes the local-files database
 * (`database.ts`). Writes that belong together run in one transaction.
 *
 * Cover thumbnails no file uses any more are deleted by {@link LocalFilesRepo.prunePictures},
 * never as a side effect of another write: a running scan stores a thumbnail before the records
 * that use it, so the facade prunes only while no scan runs.
 *
 * Folder handles go through a {@link HandleStore}: in the app, the database's `handles` table;
 * in tests, memory, because a fake handle can't be stored in IndexedDB.
 *
 * @module
 */

import type { LocalFilesDatabase } from './database'
import {
  fileKey,
  type LocalFileRecord,
  type LocalPictureRecord,
  type LocalRootKind,
  type LocalRootRecord,
} from './types'

/** Where the folder handles of `folder` roots are kept. */
export interface HandleStore {
  get(rootId: string): Promise<FileSystemDirectoryHandle | undefined>
  put(rootId: string, handle: FileSystemDirectoryHandle): Promise<void>
  delete(rootId: string): Promise<void>
}

/** Handles in the database, where the browser keeps them across visits. */
export function databaseHandleStore(db: LocalFilesDatabase): HandleStore {
  return {
    get: async (rootId) => (await db.handles.get(rootId))?.handle,
    put: async (rootId, handle) => {
      await db.handles.put({ rootId, handle })
    },
    delete: (rootId) => db.handles.delete(rootId),
  }
}

/** Handles in memory, for tests and for browsers that can't store them. */
export function memoryHandleStore(): HandleStore {
  const handles = new Map<string, FileSystemDirectoryHandle>()
  return {
    get: async (rootId) => handles.get(rootId),
    put: async (rootId, handle) => {
      handles.set(rootId, handle)
    },
    delete: async (rootId) => {
      handles.delete(rootId)
    },
  }
}

/** The repository over `db`. */
export function createLocalFilesRepo(
  db: LocalFilesDatabase,
  { handles = databaseHandleStore(db) }: { handles?: HandleStore } = {},
) {
  return {
    /** The database this repository works on. */
    db,
    /** Where folder handles are kept. */
    handles,

    // --- Roots -------------------------------------------------------------------------

    /** Every root, oldest first. */
    async listRoots(): Promise<LocalRootRecord[]> {
      return db.roots.orderBy('addedAt').toArray()
    },

    async getRoot(id: string): Promise<LocalRootRecord | undefined> {
      return db.roots.get(id)
    },

    /** Adds or replaces a root. */
    async putRoot(root: LocalRootRecord): Promise<void> {
      await db.roots.put(root)
    },

    /** The root picked through a file input under `name`, so choosing it again finds it. */
    async findPickedRoot(kind: LocalRootKind, name: string): Promise<LocalRootRecord | undefined> {
      const roots = await db.roots.toArray()
      return roots.find((root) => root.kind === kind && root.name === name)
    },

    /**
     * Removes a root with its files and handle; their covers go at the next
     * {@link prunePictures}. The library keeps the tracks it holds: liked songs and playlists
     * still list them.
     */
    async removeRoot(id: string): Promise<void> {
      await db.transaction('rw', [db.roots, db.files], async () => {
        await db.files.where('rootId').equals(id).delete()
        await db.roots.delete(id)
      })
      await handles.delete(id)
    },

    /**
     * Puts `root` and moves into it the files of the roots in `moves`, each under its path
     * inside `root` (`Jazz/a.flac` for `a.flac` of a folder `Jazz` inside it), in one
     * transaction. The files keep their IDs, sizes, dates and tags, so a scan of `root` finds
     * them unchanged; the moved roots and their handles go. A move of `root` itself (a folder
     * found again higher up) rewrites its own paths.
     */
    async adoptRoot(
      root: LocalRootRecord,
      moves: readonly { rootId: string; path: string }[],
    ): Promise<void> {
      await db.transaction('rw', [db.roots, db.files], async () => {
        await db.roots.put(root)
        for (const { rootId, path } of moves) {
          const files = await db.files.where('rootId').equals(rootId).toArray()
          const moved = files.map((file) => {
            const inside = path === '' ? file.path : `${path}/${file.path}`
            return { ...file, rootId: root.id, path: inside, key: fileKey(root.id, inside) }
          })
          await db.files.bulkDelete(files.map((file) => file.key))
          await db.files.bulkPut(moved)
          if (rootId !== root.id) await db.roots.delete(rootId)
        }
      })
      for (const { rootId } of moves) {
        if (rootId !== root.id) await handles.delete(rootId)
      }
    },

    // --- Files -------------------------------------------------------------------------

    /** Every listed file. */
    async listFiles(): Promise<LocalFileRecord[]> {
      return db.files.toArray()
    },

    async filesOfRoot(rootId: string): Promise<LocalFileRecord[]> {
      return db.files.where('rootId').equals(rootId).toArray()
    },

    /** How many files a root lists. */
    async countFiles(rootId: string): Promise<number> {
      return db.files.where('rootId').equals(rootId).count()
    },

    /** The file whose track has this native ID. */
    async fileById(nativeId: string): Promise<LocalFileRecord | undefined> {
      return db.files.where('id').equals(nativeId).first()
    },

    /** The files whose tracks have these native IDs, where listed. */
    async filesByIds(nativeIds: readonly string[]): Promise<LocalFileRecord[]> {
      return db.files
        .where('id')
        .anyOf([...nativeIds])
        .toArray()
    },

    /** The files tagged with this ISRC (canonical, see `normalizeIsrc`). */
    async filesByIsrc(isrc: string): Promise<LocalFileRecord[]> {
      return db.files.where('tags.isrc').equals(isrc).toArray()
    },

    /** Every native ID in use, so a new file never takes one. */
    async nativeIds(): Promise<Set<string>> {
      return new Set((await db.files.orderBy('id').keys()) as string[])
    },

    /** Writes and deletes files in one transaction, e.g. a file that moved. */
    async applyFiles(changes: {
      put?: readonly LocalFileRecord[]
      remove?: readonly string[]
    }): Promise<void> {
      const { put = [], remove = [] } = changes
      if (put.length === 0 && remove.length === 0) return
      await db.transaction('rw', db.files, async () => {
        if (remove.length > 0) await db.files.bulkDelete([...remove])
        if (put.length > 0) await db.files.bulkPut([...put])
      })
    },

    // --- Pictures ----------------------------------------------------------------------

    async hasPicture(key: string): Promise<boolean> {
      return (await db.pictures.get(key)) !== undefined
    },

    /** The keys of every stored picture. */
    async pictureKeys(): Promise<Set<string>> {
      return new Set((await db.pictures.toCollection().primaryKeys()) as string[])
    },

    /**
     * Deletes the pictures no file refers to, in one transaction. Call it only while no scan
     * runs: a scan stores a thumbnail before the records that use it.
     */
    async prunePictures(): Promise<number> {
      return db.transaction('rw', [db.files, db.pictures], async () => {
        const used = new Set<string>()
        await db.files.each((file) => {
          if (file.pictureKey !== undefined) used.add(file.pictureKey)
        })
        const keys = (await db.pictures.toCollection().primaryKeys()) as string[]
        const unused = keys.filter((key) => !used.has(key))
        if (unused.length > 0) await db.pictures.bulkDelete(unused)
        return unused.length
      })
    },

    async putPicture(picture: LocalPictureRecord): Promise<void> {
      await db.pictures.put(picture)
    },

    /** The pictures with these keys, where stored. */
    async getPictures(keys: readonly string[]): Promise<Map<string, LocalPictureRecord>> {
      const found = await db.pictures.bulkGet([...keys])
      return new Map(found.flatMap((picture) => (picture ? [[picture.key, picture]] : [])))
    },

    /** Deletes everything (tests, and "forget my local files"). */
    async clear(): Promise<void> {
      const roots = await db.roots.toCollection().primaryKeys()
      await db.transaction('rw', [db.roots, db.files, db.pictures], async () => {
        await Promise.all([db.roots.clear(), db.files.clear(), db.pictures.clear()])
      })
      for (const id of roots) await handles.delete(id)
    },
  }
}

/** The local-files repository. */
export type LocalFilesRepo = ReturnType<typeof createLocalFilesRepo>
