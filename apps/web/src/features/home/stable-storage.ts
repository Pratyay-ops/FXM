/**
 * Where Home keeps Discover (for its week) and the Daily Mixes (for their day) between builds
 * and reloads: `localStorage`, read back through `sanitizeStableShelves`, so a stored list that
 * is corrupt, hand-edited or from another version reads as nothing kept. Storage that is
 * missing, blocked or full only means the lists are built again.
 *
 * @module
 */

import { NO_STABLE_SHELVES, type StableShelves, sanitizeStableShelves } from '@fxm/core'

/** localStorage key. */
export const STABLE_STORAGE_KEY = 'fxm.home.stable.v1'

/** Reads and writes the lists kept between builds. */
export interface StableStore {
  load(): StableShelves
  save(stable: StableShelves): void
}

/** A {@link StableStore} over Web Storage (`localStorage` by default) that never throws. */
export function createStableStore(
  getStorage: () => Storage | undefined = () => globalThis.localStorage,
): StableStore {
  const storage = () => {
    try {
      return getStorage()
    } catch {
      return undefined
    }
  }
  return {
    load() {
      try {
        const raw = storage()?.getItem(STABLE_STORAGE_KEY)
        return raw ? sanitizeStableShelves(JSON.parse(raw)) : NO_STABLE_SHELVES
      } catch {
        return NO_STABLE_SHELVES
      }
    },
    save(stable) {
      try {
        if (stable.entries.length === 0) storage()?.removeItem(STABLE_STORAGE_KEY)
        else storage()?.setItem(STABLE_STORAGE_KEY, JSON.stringify(stable))
      } catch {
        // Quota exceeded or storage blocked: the lists are built again next time.
      }
    },
  }
}
