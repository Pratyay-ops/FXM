/**
 * The user's choice to connect their Spotify account (the opt-in, off by default), persisted in
 * `localStorage` like the other settings, and followed by the other open tabs. It holds that
 * one choice: never a token, a cookie or anything about the account. Library backups don't read
 * it, so a backup never connects an account on another device.
 *
 * @module
 */

import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { createSafeStorage } from '../../lib/safe-storage'

/**
 * `localStorage` key of the choice. Bump the suffix (and add a migration) on incompatible
 * changes.
 */
export const SPOTIFY_ACCOUNT_STORAGE_KEY = 'fxm.spotify-account.v1'
const VERSION = 1

interface Persisted {
  optedIn: boolean
}

/** The user's choice. */
export interface SpotifyAccountChoice {
  /**
   * Whether the user connected their Spotify account in FXM, after its notice. It is the
   * provider's `isAccountEnabled`: FXM uses the account only while this is on.
   */
  optedIn: boolean
  /** Connects or disconnects, as far as the choice goes. */
  setOptedIn: (optedIn: boolean) => void
}

function sanitize(value: unknown): Persisted {
  const stored =
    typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
  return { optedIn: stored.optedIn === true }
}

/** Options for {@link createAccountChoice}. */
export interface AccountChoiceOptions {
  /** Where to persist. Defaults to `localStorage`; tests pass their own. */
  storage?: () => Storage | undefined
}

/**
 * The choice, persisted to Web Storage. Invalid or unreadable data reads as not connected, and
 * blocked storage only loses persistence.
 */
export function createAccountChoice({ storage }: AccountChoiceOptions = {}) {
  return create<SpotifyAccountChoice>()(
    persist(
      (set) => ({
        optedIn: false,
        setOptedIn: (optedIn) => set({ optedIn }),
      }),
      {
        name: SPOTIFY_ACCOUNT_STORAGE_KEY,
        version: VERSION,
        storage: createSafeStorage<Persisted>(storage),
        partialize: ({ optedIn }) => ({ optedIn }),
        migrate: (persisted) => sanitize(persisted),
        merge: (persisted, current) => ({ ...current, optedIn: sanitize(persisted).optedIn }),
      },
    ),
  )
}

/** A persisted choice store. */
export type AccountChoiceStore = ReturnType<typeof createAccountChoice>

/**
 * Re-reads the choice when another tab changes it, so a Disconnect in one tab stops the account
 * in every tab. Returns the unsubscribe function.
 */
export function syncAccountChoiceAcrossTabs(store: AccountChoiceStore): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === SPOTIFY_ACCOUNT_STORAGE_KEY || event.key === null) {
      void store.persist.rehydrate()
    }
  }
  window.addEventListener('storage', onStorage)
  return () => window.removeEventListener('storage', onStorage)
}
