import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { createSafeStorage } from '../../lib/safe-storage'

/**
 * The autoplay setting (stage 3.4): whether the queue keeps going with songs like the last
 * plays once it runs low. On by default; Settings → Playback and the queue panel switch it. It
 * has its own key, next to the other settings.
 */
export interface AutoplayState {
  /** Whether autoplay adds songs when the queue runs low. On by default. */
  enabled: boolean
  /** Switches autoplay on or off. */
  setEnabled: (enabled: boolean) => void
}

/** localStorage key. Bump the suffix (and add a migration) on incompatible changes. */
export const AUTOPLAY_STORAGE_KEY = 'fxm.autoplay.v1'
const AUTOPLAY_VERSION = 1

type Persisted = Pick<AutoplayState, 'enabled'>

/** Valid persisted state from an untrusted value: on unless it says `false`. */
export function sanitizeAutoplay(value: unknown): Persisted {
  const stored: Partial<Record<keyof Persisted, unknown>> =
    typeof value === 'object' && value !== null ? value : {}
  return { enabled: stored.enabled !== false }
}

export interface AutoplayStoreOptions {
  /** Where to persist. Defaults to `localStorage`; tests pass their own. */
  storage?: () => Storage | undefined
}

/** Creates the autoplay store, persisted to Web Storage (one per app; tests make their own). */
export function createAutoplayStore({ storage }: AutoplayStoreOptions = {}) {
  return create<AutoplayState>()(
    persist(
      (set) => ({
        enabled: true,
        setEnabled: (enabled) => set({ enabled }),
      }),
      {
        name: AUTOPLAY_STORAGE_KEY,
        version: AUTOPLAY_VERSION,
        storage: createSafeStorage<Persisted>(storage),
        partialize: ({ enabled }) => ({ enabled }),
        // Stored data can be from another version, hand-edited or corrupt: keep what is valid.
        migrate: (persisted) => sanitizeAutoplay(persisted),
        merge: (persisted, current) => ({ ...current, ...sanitizeAutoplay(persisted) }),
      },
    ),
  )
}

export type AutoplayStore = ReturnType<typeof createAutoplayStore>

export const useAutoplayStore: AutoplayStore = createAutoplayStore()

/**
 * Re-reads the setting when another tab changes it, so two open tabs agree on whether autoplay
 * is on. Returns the unsubscribe function.
 */
export function syncAutoplayAcrossTabs(store: AutoplayStore = useAutoplayStore): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === AUTOPLAY_STORAGE_KEY || event.key === null) void store.persist.rehydrate()
  }
  window.addEventListener('storage', onStorage)
  return () => window.removeEventListener('storage', onStorage)
}
