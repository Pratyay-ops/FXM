import type { PersistStorage, StorageValue } from 'zustand/middleware'

/**
 * A zustand `PersistStorage` over Web Storage that never throws.
 *
 * Storage can be missing or blocked (private browsing, disabled site data,
 * sandboxed iframes), full, or hold something that is not valid JSON. Reads then
 * return `null`, so the store keeps its defaults, and writes are dropped, so the
 * app keeps working without persistence. Validating the stored *values* is the
 * store's job (its `merge`), because only it knows the shape.
 */
export function createSafeStorage<S>(
  getStorage: () => Storage | undefined = () => globalThis.localStorage,
): PersistStorage<S, void> {
  const storage = (): Storage | undefined => {
    try {
      return getStorage()
    } catch {
      return undefined
    }
  }

  return {
    getItem(name) {
      try {
        const raw = storage()?.getItem(name)
        if (!raw) return null
        const parsed: unknown = JSON.parse(raw)
        return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
          ? (parsed as StorageValue<S>)
          : null
      } catch {
        return null
      }
    },
    setItem(name, value) {
      try {
        storage()?.setItem(name, JSON.stringify(value))
      } catch {
        // Quota exceeded or storage blocked: keep the in-memory state.
      }
    },
    removeItem(name) {
      try {
        storage()?.removeItem(name)
      } catch {
        // Storage blocked: nothing to remove.
      }
    },
  }
}
