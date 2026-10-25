/**
 * FXM Connect's settings: "Use my Spotify login from this browser", off by default.
 *
 * They live in IndexedDB in the extension's own origin, which only the options page and the
 * background can open: a content script's `indexedDB` is the page's. storage.local would be the
 * obvious place, but content scripts can write it (in Firefox always, in Chromium unless the
 * background restricts it after it starts), so code running in a compromised FXM page renderer
 * could switch the Spotify login on by itself.
 */

export interface Settings {
  /** "Use my Spotify login from this browser". */
  spotifyLogin: boolean
}

export const DEFAULT_SETTINGS: Readonly<Settings> = { spotifyLogin: false }

const KEYS = Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]

export interface SettingsStore {
  /** The current settings. Anything stored but `true` reads as off. */
  read(): Promise<Settings>
  /** Saves the given settings and leaves the others alone. */
  write(changes: Partial<Settings>): Promise<void>
}

/** IndexedDB database and object store that hold the settings. */
export const SETTINGS_DATABASE = { name: 'fxm-connect', version: 1, store: 'settings' } as const

/**
 * BroadcastChannel on which an options page announces a change, so other open options pages
 * reload the settings. The message carries no data: receivers read the database again.
 */
export const SETTINGS_CHANNEL = 'fxm-connect-settings'

function open(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(SETTINGS_DATABASE.name, SETTINGS_DATABASE.version)
    request.onupgradeneeded = () => {
      request.result.createObjectStore(SETTINGS_DATABASE.store)
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

function result<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

function completion(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
    transaction.onabort = () => reject(transaction.error ?? new Error('settings write aborted'))
  })
}

/**
 * Settings stored in IndexedDB. Every call opens the database and closes it again, so no
 * connection outlives a request (the background can be stopped at any time).
 */
export function indexedDbSettings(factory: IDBFactory): SettingsStore {
  return {
    async read() {
      const db = await open(factory)
      try {
        const store = db
          .transaction(SETTINGS_DATABASE.store, 'readonly')
          .objectStore(SETTINGS_DATABASE.store)
        const values = await Promise.all(KEYS.map((key) => result(store.get(key))))
        const settings: Settings = { ...DEFAULT_SETTINGS }
        for (const [index, key] of KEYS.entries()) settings[key] = values[index] === true
        return settings
      } finally {
        db.close()
      }
    },
    async write(changes) {
      const db = await open(factory)
      try {
        const transaction = db.transaction(SETTINGS_DATABASE.store, 'readwrite')
        const store = transaction.objectStore(SETTINGS_DATABASE.store)
        for (const key of KEYS) {
          const value = changes[key]
          if (value !== undefined) store.put(value === true, key)
        }
        await completion(transaction)
      } finally {
        db.close()
      }
    },
  }
}
