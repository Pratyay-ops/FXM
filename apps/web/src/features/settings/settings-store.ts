import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { createSafeStorage } from '../../lib/safe-storage'

/**
 * Which part of the YouTube catalog FXM searches and plays: `music` is YouTube
 * Music catalog songs only, `all` also allows any YouTube video, played as music.
 * Switch to `CatalogMode` from @fxm/core once stage 1.1 adds it.
 */
export type CatalogMode = 'music' | 'all'

/** `system` follows the operating system's light or dark preference. */
export type ThemePreference = 'system' | 'dark' | 'light'

/** The persisted part of the settings. */
export interface Settings {
  catalogMode: CatalogMode
  theme: ThemePreference
}

export interface SettingsState extends Settings {
  setCatalogMode: (catalogMode: CatalogMode) => void
  setTheme: (theme: ThemePreference) => void
}

/** localStorage key. Bump the suffix (and add a migration) on incompatible changes. */
export const SETTINGS_STORAGE_KEY = 'fxm.settings.v1'
const SETTINGS_VERSION = 1

export const DEFAULT_SETTINGS: Readonly<Settings> = { catalogMode: 'music', theme: 'dark' }

export function isCatalogMode(value: unknown): value is CatalogMode {
  return value === 'music' || value === 'all'
}

export function isThemePreference(value: unknown): value is ThemePreference {
  return value === 'system' || value === 'dark' || value === 'light'
}

/** Keeps the valid fields of stored settings and uses the defaults for everything else. */
export function sanitizeSettings(value: unknown): Settings {
  const stored: Partial<Record<keyof Settings, unknown>> =
    typeof value === 'object' && value !== null ? value : {}
  return {
    catalogMode: isCatalogMode(stored.catalogMode)
      ? stored.catalogMode
      : DEFAULT_SETTINGS.catalogMode,
    theme: isThemePreference(stored.theme) ? stored.theme : DEFAULT_SETTINGS.theme,
  }
}

export interface SettingsStoreOptions {
  /** Where to persist. Defaults to `localStorage`; tests pass their own. */
  storage?: () => Storage | undefined
}

/** Creates a settings store persisted to Web Storage (one per app; tests make their own). */
export function createSettingsStore({ storage }: SettingsStoreOptions = {}) {
  return create<SettingsState>()(
    persist(
      (set) => ({
        ...DEFAULT_SETTINGS,
        setCatalogMode: (catalogMode) => set({ catalogMode }),
        setTheme: (theme) => set({ theme }),
      }),
      {
        name: SETTINGS_STORAGE_KEY,
        version: SETTINGS_VERSION,
        storage: createSafeStorage<Settings>(storage),
        partialize: ({ catalogMode, theme }) => ({ catalogMode, theme }),
        // Stored data can be from another version, hand-edited or corrupt: keep what is valid.
        migrate: (persisted) => sanitizeSettings(persisted),
        merge: (persisted, current) => ({ ...current, ...sanitizeSettings(persisted) }),
      },
    ),
  )
}

export type SettingsStore = ReturnType<typeof createSettingsStore>

export const useSettingsStore: SettingsStore = createSettingsStore()

/**
 * Re-reads the settings when another tab changes them, so two open tabs never
 * overwrite each other's choices. Returns the unsubscribe function.
 */
export function syncSettingsAcrossTabs(store: SettingsStore = useSettingsStore): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === SETTINGS_STORAGE_KEY || event.key === null) void store.persist.rehydrate()
  }
  window.addEventListener('storage', onStorage)
  return () => window.removeEventListener('storage', onStorage)
}
