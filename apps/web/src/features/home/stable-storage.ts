/**
 * Where Home keeps Discover (for its week) and the Daily Mixes (for their day) between builds
 * and reloads: `localStorage`, read back through `sanitizeStableShelves`, so a stored list that
 * is corrupt, hand-edited or from another version reads as nothing kept. Storage that is
 * missing, blocked or full only means the lists are built again.
 *
 * The lists are kept with the listening history they were built from, as the time it starts
 * (`historyStart` of the library). Clearing the history, replacing the library from a backup
 * or importing older plays changes that time, and the lists read as nothing kept: Home forgets
 * them with the plays they came from.
 *
 * @module
 */

import { NO_STABLE_SHELVES, type StableShelves, sanitizeStableShelves } from '@fxm/core'

/** localStorage key. */
export const STABLE_STORAGE_KEY = 'fxm.home.stable.v1'

/**
 * Which listening history lists were built from: the time it starts, or `null` while there are
 * no plays.
 */
export type HistoryBasis = number | null

/** Reads and writes the lists kept between builds. */
export interface StableStore {
  /** The lists kept from builds over the same listening history; nothing for any other. */
  load(history: HistoryBasis): StableShelves
  /** Keeps the lists a build made over that listening history. */
  save(stable: StableShelves, history: HistoryBasis): void
}

/** What is stored: the lists, and the history they came from. */
interface Stored extends StableShelves {
  readonly history: HistoryBasis
}

function isBasis(value: unknown): value is HistoryBasis {
  return value === null || (typeof value === 'number' && Number.isFinite(value))
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
    load(history) {
      try {
        const raw = storage()?.getItem(STABLE_STORAGE_KEY)
        if (!raw) return NO_STABLE_SHELVES
        const stored: unknown = JSON.parse(raw)
        const basis = (stored as Partial<Stored> | null)?.history
        // Lists from another history, or stored without one, are out of date.
        if (!isBasis(basis) || basis !== history) return NO_STABLE_SHELVES
        return sanitizeStableShelves(stored)
      } catch {
        return NO_STABLE_SHELVES
      }
    },
    save(stable, history) {
      try {
        if (stable.entries.length === 0) {
          storage()?.removeItem(STABLE_STORAGE_KEY)
          return
        }
        const stored: Stored = { history, entries: stable.entries }
        storage()?.setItem(STABLE_STORAGE_KEY, JSON.stringify(stored))
      } catch {
        // Quota exceeded or storage blocked: the lists are built again next time.
      }
    },
  }
}
