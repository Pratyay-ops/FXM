/**
 * The user's matching setting: **Auto**, whether a match the engine is sure of plays without
 * asking (stage 1.12). It counts only while the matching config makes the Auto band available
 * (`isAutoMatchAvailable()` from `@fxm/core`), which it doesn't in this release: Settings shows
 * the switch only then, and `matchingOptions` ignores the stored value otherwise, so a value
 * kept from a build that offered it never lets a guess play unasked.
 *
 * @module
 */

import {
  isAutoMatchAvailable,
  type MatchingConfig,
  type MatchOptions,
  matchingOptions,
} from '@fxm/core'
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { createSafeStorage } from '../../lib/safe-storage'
import type { CatalogMode } from './settings-store'

/** The persisted part. */
export interface MatchingSettings {
  /** The Auto setting: matches the engine is sure of play without asking. Off by default. */
  autoMatch: boolean
}

export interface MatchingState extends MatchingSettings {
  setAutoMatch: (autoMatch: boolean) => void
}

/** localStorage key. Bump the suffix (and add a migration) on incompatible changes. */
export const MATCHING_STORAGE_KEY = 'fxm.matching.v1'

/** Only a stored `true` turns Auto on. */
export function sanitizeMatchingSettings(value: unknown): MatchingSettings {
  const stored = typeof value === 'object' && value !== null ? value : {}
  return { autoMatch: (stored as { autoMatch?: unknown }).autoMatch === true }
}

/** Creates the store, persisted to Web Storage (one per app; tests make their own). */
export function createMatchingStore({ storage }: { storage?: () => Storage | undefined } = {}) {
  return create<MatchingState>()(
    persist((set) => ({ autoMatch: false, setAutoMatch: (autoMatch) => set({ autoMatch }) }), {
      name: MATCHING_STORAGE_KEY,
      version: 1,
      storage: createSafeStorage<MatchingSettings>(storage),
      partialize: ({ autoMatch }) => ({ autoMatch }),
      migrate: (persisted) => sanitizeMatchingSettings(persisted),
      merge: (persisted, current) => ({ ...current, ...sanitizeMatchingSettings(persisted) }),
    }),
  )
}

export type MatchingStore = ReturnType<typeof createMatchingStore>

export const useMatchingStore: MatchingStore = createMatchingStore()

/**
 * Whether the user's Auto setting is in effect now: the config makes the band available and the
 * switch is on.
 */
export function appAutoMatch(
  store: MatchingStore = useMatchingStore,
  config?: MatchingConfig,
): boolean {
  return matchingOptions({ autoMatch: store.getState().autoMatch }, config).auto === true
}

/**
 * The options the app matches with in `mode` (`matchingOptions` from `@fxm/core`): the matching
 * config's thresholds and measured fallback, the mode, and Auto as {@link appAutoMatch} says.
 */
export function appMatchOptions(
  mode: CatalogMode,
  store: MatchingStore = useMatchingStore,
  config?: MatchingConfig,
): MatchOptions {
  return matchingOptions({ mode, autoMatch: store.getState().autoMatch }, config)
}

/** Whether Settings offers the Auto switch: only while the matching config allows the band. */
export function autoMatchOffered(config?: MatchingConfig): boolean {
  return isAutoMatchAvailable(config)
}

/** Re-reads the setting when another tab changes it. Returns the unsubscribe function. */
export function syncMatchingAcrossTabs(store: MatchingStore = useMatchingStore): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === MATCHING_STORAGE_KEY || event.key === null) void store.persist.rehydrate()
  }
  window.addEventListener('storage', onStorage)
  return () => window.removeEventListener('storage', onStorage)
}
