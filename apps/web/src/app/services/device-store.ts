/**
 * Small state of this device that must survive a reload but never leaves it: the YouTube
 * session's visitorData (stage 1.3), so a reload does not ask YouTube for a new session, and
 * the stream ladder's rung health (stage 1.4), so a rung that keeps failing on this IP address
 * stays cooled down. It lives in its own IndexedDB database, `fxm-device`, apart from the
 * library: it belongs to this browser, so backups never carry it.
 *
 * IndexedDB can be missing or refuse to open (some private windows, blocked site data, a full
 * disk). The store then keeps the values in memory for the session, so the app works the same,
 * only without persistence. No call ever rejects.
 *
 * @module
 */

import type { RungHealthStore, VisitorDataStore } from '@fxm/sources/youtube'

/** A tiny key-value store whose calls never reject. */
export interface DeviceStore {
  /** The value saved under `key`, or `undefined`. */
  get(key: string): Promise<unknown>
  /** Saves `value` (a structured-cloneable value, such as JSON) under `key`. */
  set(key: string, value: unknown): Promise<void>
  /** Forgets `key`. */
  delete(key: string): Promise<void>
}

/** The IndexedDB database of {@link createIndexedDbStore}. */
export const DEVICE_DB_NAME = 'fxm-device'

/** Its one object store, keyed by the caller's keys. */
const STATE_STORE = 'state'

/** The schema version. Bump it, with an upgrade step, when the object stores change. */
const DB_VERSION = 1

/** Where the YouTube session's visitorData is saved. */
export const VISITOR_DATA_KEY = 'youtube.visitorData'

/** Where the stream ladder's rung health is saved. */
export const RUNG_HEALTH_KEY = 'youtube.rungHealth'

/** A {@link DeviceStore} in memory only, for tests and as the fallback. */
export function createMemoryStore(): DeviceStore {
  const values = new Map<string, unknown>()
  return {
    get: async (key) => values.get(key),
    async set(key, value) {
      values.set(key, value)
    },
    async delete(key) {
      values.delete(key)
    },
  }
}

/** Wraps an `IDBRequest` in a promise. */
function done<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

/** Opens the database, creating its object store on first use. */
function openDatabase(factory: IDBFactory, name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(name, DB_VERSION)
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STATE_STORE)) {
        request.result.createObjectStore(STATE_STORE)
      }
    }
    request.onsuccess = () => {
      const db = request.result
      // Another tab upgrading the schema later: let it, this tab falls back to memory.
      db.onversionchange = () => db.close()
      resolve(db)
    }
    request.onerror = () => reject(request.error)
    request.onblocked = () => reject(new Error(`${name} is blocked by another tab`))
  })
}

/** Options for {@link createIndexedDbStore}. */
export interface IndexedDbStoreOptions {
  /** The IndexedDB to use. Default: the page's `indexedDB`, if any. */
  factory?: IDBFactory | undefined
  /** The database name. Default {@link DEVICE_DB_NAME}. */
  name?: string
}

/**
 * A {@link DeviceStore} in IndexedDB, opened on first use. When IndexedDB is missing or fails,
 * the values stay in memory instead (see the module documentation).
 */
export function createIndexedDbStore(options: IndexedDbStoreOptions = {}): DeviceStore {
  const factory =
    'factory' in options ? options.factory : (globalThis as { indexedDB?: IDBFactory }).indexedDB
  const name = options.name ?? DEVICE_DB_NAME
  const memory = createMemoryStore()
  let database: Promise<IDBDatabase | undefined> | undefined

  function db(): Promise<IDBDatabase | undefined> {
    database ??= (async () => {
      if (factory === undefined) return undefined
      try {
        return await openDatabase(factory, name)
      } catch {
        return undefined
      }
    })()
    return database
  }

  /** Runs `use` in a transaction, or on memory when IndexedDB is unusable. */
  async function run<T>(
    mode: IDBTransactionMode,
    use: (store: IDBObjectStore) => IDBRequest<T>,
    fallback: () => Promise<T>,
  ): Promise<T> {
    const opened = await db()
    if (opened === undefined) return fallback()
    try {
      return await done(use(opened.transaction(STATE_STORE, mode).objectStore(STATE_STORE)))
    } catch {
      return fallback()
    }
  }

  return {
    async get(key) {
      const value = await run(
        'readonly',
        (store) => store.get(key),
        () => memory.get(key),
      )
      return value ?? (await memory.get(key))
    },
    async set(key, value) {
      // Memory first, so a value survives the session even when the write below fails.
      await memory.set(key, value)
      await run(
        'readwrite',
        (store) => store.put(value, key),
        async () => key,
      )
    },
    async delete(key) {
      await memory.delete(key)
      await run(
        'readwrite',
        (store) => store.delete(key),
        async () => undefined,
      )
    },
  }
}

/** The YouTube session's visitorData (stage 1.3), kept in `store`. */
export function visitorDataStore(store: DeviceStore): VisitorDataStore {
  return {
    load: async () => {
      const value = await store.get(VISITOR_DATA_KEY)
      // The session checks the value's shape itself; anything but a string is nothing.
      return typeof value === 'string' ? value : undefined
    },
    save: (visitorData) => store.set(VISITOR_DATA_KEY, visitorData),
    clear: () => store.delete(VISITOR_DATA_KEY),
  }
}

/** The stream ladder's rung health (stage 1.4), kept in `store`. The ladder checks what it reads. */
export function rungHealthStore(store: DeviceStore): RungHealthStore {
  return {
    load: () => store.get(RUNG_HEALTH_KEY),
    save: (state) => store.set(RUNG_HEALTH_KEY, state),
  }
}
