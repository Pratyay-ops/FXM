/**
 * Small key-value storage for the state the platform keeps per device: the request budget's
 * hour and pause, and whether FXM Connect was seen before. `localStorage` fits the interface as
 * it is, and {@link memoryStorage} stands in for it in tests and where it is unavailable.
 *
 * @module
 */

/** The subset of the Web Storage API (`localStorage`) the platform uses. */
export interface KeyValueStorage {
  /** The stored value, or `null` when there is none. */
  getItem(key: string): string | null
  /** Stores a value. May throw, e.g. when the quota is used up. */
  setItem(key: string, value: string): void
  /** Removes a value. */
  removeItem(key: string): void
}

/** A {@link KeyValueStorage} in memory, optionally prefilled. Nothing survives a reload. */
export function memoryStorage(initial: Readonly<Record<string, string>> = {}): KeyValueStorage {
  const values = new Map(Object.entries(initial))
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, String(value))
    },
    removeItem: (key) => {
      values.delete(key)
    },
  }
}

/**
 * The window's `localStorage`, or `undefined` when there is none or the browser refuses access
 * to it (reading the property throws in some privacy modes and in sandboxed documents).
 */
export function browserStorage(
  window: { readonly localStorage?: KeyValueStorage } | undefined = globalThis as {
    readonly localStorage?: KeyValueStorage
  },
): KeyValueStorage | undefined {
  try {
    const storage = window?.localStorage
    return storage !== undefined && storage !== null && typeof storage.getItem === 'function'
      ? storage
      : undefined
  } catch {
    return undefined
  }
}

/**
 * Reads and parses a JSON value. Returns `undefined` when the key is missing, the storage throws
 * or the value is not JSON, so callers validate what they get and fall back to defaults.
 */
export function readJson(storage: KeyValueStorage, key: string): unknown {
  try {
    const text = storage.getItem(key)
    return text === null ? undefined : (JSON.parse(text) as unknown)
  } catch {
    return undefined
  }
}

/**
 * Stores a value as JSON. Returns `false` instead of throwing when the storage refuses it, e.g.
 * because its quota is used up, so the caller can keep the state in memory instead.
 */
export function writeJson(storage: KeyValueStorage, key: string, value: unknown): boolean {
  try {
    storage.setItem(key, JSON.stringify(value))
    return true
  } catch {
    return false
  }
}

/** Removes a key, ignoring storage failures. */
export function removeKey(storage: KeyValueStorage, key: string): void {
  try {
    storage.removeItem(key)
  } catch {
    // Nothing to do.
  }
}
