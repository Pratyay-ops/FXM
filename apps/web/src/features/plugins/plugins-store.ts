import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { createSafeStorage } from '../../lib/safe-storage'

/**
 * The plugin setting of F-Droid builds (stage 8.3): whether the user opted in to plugins with
 * `PLUGINS_CONSENT` of `@fxm/plugins`. Off by default; standard builds don't read it. The
 * installed plugins themselves live in IndexedDB (`plugins-db.ts`).
 */
export interface PluginsSettingsState {
  /** Whether the user turned plugins on, in a build that asks first. */
  optedIn: boolean
  /** Turns plugins on or off. */
  setOptedIn: (optedIn: boolean) => void
}

/** localStorage key. Bump the suffix (and add a migration) on incompatible changes. */
export const PLUGINS_STORAGE_KEY = 'fxm.plugins.v1'
const PLUGINS_VERSION = 1

type Persisted = Pick<PluginsSettingsState, 'optedIn'>

/** Valid persisted state from an untrusted value: opted in only where it says `true`. */
export function sanitizePluginsSettings(value: unknown): Persisted {
  const stored: Partial<Record<keyof Persisted, unknown>> =
    typeof value === 'object' && value !== null ? value : {}
  return { optedIn: stored.optedIn === true }
}

/** Creates the store, persisted to Web Storage (one per app; tests make their own). */
export function createPluginsSettingsStore(options: { storage?: () => Storage | undefined } = {}) {
  return create<PluginsSettingsState>()(
    persist(
      (set) => ({
        optedIn: false,
        setOptedIn: (optedIn) => set({ optedIn }),
      }),
      {
        name: PLUGINS_STORAGE_KEY,
        version: PLUGINS_VERSION,
        storage: createSafeStorage<Persisted>(options.storage),
        partialize: ({ optedIn }) => ({ optedIn }),
        migrate: (persisted) => sanitizePluginsSettings(persisted),
        merge: (persisted, current) => ({ ...current, ...sanitizePluginsSettings(persisted) }),
      },
    ),
  )
}

export type PluginsSettingsStore = ReturnType<typeof createPluginsSettingsStore>

export const usePluginsSettingsStore: PluginsSettingsStore = createPluginsSettingsStore()
