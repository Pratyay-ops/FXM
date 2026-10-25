import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { createSafeStorage } from '../../lib/safe-storage'

/**
 * localStorage key of the sources settings. Bump the suffix (and add a migration) on
 * incompatible changes.
 */
export const SOURCES_STORAGE_KEY = 'fxm.sources.v1'
const SOURCES_VERSION = 1

/** Spotify is built in and on by default wherever it is reachable (owner decision). */
export const DEFAULT_SPOTIFY_ENABLED = true

/** What is persisted. */
interface PersistedSources {
  spotifyEnabled: boolean
}

/** The user's Spotify switch. */
export interface SpotifySwitchState {
  /**
   * Whether the user lets FXM use Spotify. It is a setting, not a capability: FXM uses Spotify
   * only when this is on and the platform can also reach Spotify.
   */
  enabled: boolean
  /** Switches Spotify on or off. */
  setEnabled: (enabled: boolean) => void
}

function sanitize(value: unknown): PersistedSources {
  const stored: Partial<Record<keyof PersistedSources, unknown>> =
    typeof value === 'object' && value !== null ? value : {}
  return {
    spotifyEnabled:
      typeof stored.spotifyEnabled === 'boolean' ? stored.spotifyEnabled : DEFAULT_SPOTIFY_ENABLED,
  }
}

/** Options for {@link createSpotifySwitch}. */
export interface SpotifySwitchOptions {
  /** Where to persist. Defaults to `localStorage`; tests pass their own. */
  storage?: () => Storage | undefined
}

/**
 * The Spotify switch, persisted to Web Storage like the other settings. Invalid or unreadable
 * data falls back to the default (on), and blocked storage only loses persistence.
 */
export function createSpotifySwitch({ storage }: SpotifySwitchOptions = {}) {
  return create<SpotifySwitchState>()(
    persist(
      (set) => ({
        enabled: DEFAULT_SPOTIFY_ENABLED,
        setEnabled: (enabled) => set({ enabled }),
      }),
      {
        name: SOURCES_STORAGE_KEY,
        version: SOURCES_VERSION,
        storage: createSafeStorage<PersistedSources>(storage),
        partialize: ({ enabled }) => ({ spotifyEnabled: enabled }),
        // Stored data can be from another version, hand-edited or corrupt: keep what is valid.
        migrate: (persisted) => sanitize(persisted),
        merge: (persisted, current) => ({
          ...current,
          enabled: sanitize(persisted).spotifyEnabled,
        }),
      },
    ),
  )
}

/** A persisted Spotify switch store. */
export type SpotifySwitchStore = ReturnType<typeof createSpotifySwitch>

/**
 * Re-reads the switch when another tab changes it, so two open tabs never overwrite each
 * other's choice. Returns the unsubscribe function.
 */
export function syncSpotifySwitchAcrossTabs(store: SpotifySwitchStore): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === SOURCES_STORAGE_KEY || event.key === null) void store.persist.rehydrate()
  }
  window.addEventListener('storage', onStorage)
  return () => window.removeEventListener('storage', onStorage)
}
