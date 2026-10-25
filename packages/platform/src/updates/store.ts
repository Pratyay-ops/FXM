/**
 * Where the updater keeps the last good version of each artifact: its signature file and its
 * bytes, exactly as downloaded. Nothing in the store is trusted: the updater verifies the
 * signature and the bytes again before every use, so a damaged or tampered copy only means
 * falling back to the copy the app ships with.
 *
 * The resolver module is about a megabyte, so the apps keep it in IndexedDB
 * ({@link indexedDbUpdateStore}); tests use {@link memoryUpdateStore}.
 *
 * @module
 */

/** One stored artifact. */
export interface StoredUpdate {
  /** Its signature file, as downloaded. */
  readonly signature: Uint8Array<ArrayBuffer>
  /** Its bytes, as downloaded. */
  readonly bytes: Uint8Array<ArrayBuffer>
}

/** Keeps one {@link StoredUpdate} per artifact kind. Every method may reject. */
export interface UpdateStore {
  /** The stored artifact of `kind`, if there is one. */
  get(kind: string): Promise<StoredUpdate | undefined>
  /** Replaces the stored artifact of `kind`. */
  set(kind: string, update: StoredUpdate): Promise<void>
  /** Forgets the stored artifact of `kind`. */
  delete(kind: string): Promise<void>
}

function isStoredUpdate(value: unknown): value is StoredUpdate {
  const { signature, bytes } = (value ?? {}) as Partial<StoredUpdate>
  return signature instanceof Uint8Array && bytes instanceof Uint8Array
}

/** A copy that shares nothing with the caller's arrays. */
function copy(update: StoredUpdate): StoredUpdate {
  return { signature: new Uint8Array(update.signature), bytes: new Uint8Array(update.bytes) }
}

/** An {@link UpdateStore} in memory: nothing survives a restart. */
export function memoryUpdateStore(): UpdateStore {
  const updates = new Map<string, StoredUpdate>()
  return {
    get: async (kind) => {
      const update = updates.get(kind)
      return update === undefined ? undefined : copy(update)
    },
    set: async (kind, update) => {
      updates.set(kind, copy(update))
    },
    delete: async (kind) => {
      updates.delete(kind)
    },
  }
}

/** Options for {@link indexedDbUpdateStore}. */
export interface IndexedDbUpdateStoreOptions {
  /** The database name. Default `fxm-updates`. */
  readonly name?: string
  /** The IndexedDB to use. Default: the global `indexedDB`. */
  readonly indexedDB?: IDBFactory
}

const OBJECT_STORE = 'artifacts'

function request<T>(operation: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    operation.onsuccess = () => resolve(operation.result)
    operation.onerror = () => reject(operation.error ?? new Error('IndexedDB request failed'))
  })
}

/**
 * An {@link UpdateStore} in IndexedDB: one object store, keyed by artifact kind. The database
 * opens on first use; when IndexedDB is missing or refuses (some private modes), every method
 * rejects and the updater carries on without a stored copy.
 */
export function indexedDbUpdateStore(options: IndexedDbUpdateStoreOptions = {}): UpdateStore {
  const name = options.name ?? 'fxm-updates'
  let database: Promise<IDBDatabase> | undefined

  function open(): Promise<IDBDatabase> {
    database ??= new Promise<IDBDatabase>((resolve, reject) => {
      const factory = options.indexedDB ?? (globalThis as { indexedDB?: IDBFactory }).indexedDB
      if (factory === undefined) {
        reject(new Error('IndexedDB is not available'))
        return
      }
      const opening = factory.open(name, 1)
      opening.onupgradeneeded = () => {
        if (!opening.result.objectStoreNames.contains(OBJECT_STORE)) {
          opening.result.createObjectStore(OBJECT_STORE)
        }
      }
      opening.onsuccess = () => resolve(opening.result)
      opening.onerror = () => reject(opening.error ?? new Error('IndexedDB did not open'))
      opening.onblocked = () => reject(new Error('IndexedDB is blocked by another tab'))
    }).catch((error: unknown) => {
      database = undefined
      throw error
    })
    return database
  }

  async function run<T>(
    mode: IDBTransactionMode,
    operation: (store: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> {
    const db = await open()
    const transaction = db.transaction(OBJECT_STORE, mode)
    const done = new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve()
      transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB aborted'))
      transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB failed'))
    })
    const result = await request(operation(transaction.objectStore(OBJECT_STORE)))
    await done
    return result
  }

  return {
    async get(kind) {
      const value: unknown = await run('readonly', (store) => store.get(kind))
      return isStoredUpdate(value) ? copy(value) : undefined
    },
    async set(kind, update) {
      await run('readwrite', (store) => store.put(copy(update), kind))
    },
    async delete(kind) {
      await run('readwrite', (store) => store.delete(kind))
    },
  }
}
