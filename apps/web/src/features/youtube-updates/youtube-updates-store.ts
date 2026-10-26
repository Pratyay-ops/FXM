import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { createSafeStorage } from '../../lib/safe-storage'

/**
 * The YouTube code updates setting of F-Droid builds (stage R.3): whether the user opted in to
 * the signed YouTube resolver module that FXM's website publishes (stage 1.13) with
 * `CODE_UPDATES_CONSENT` of `@fxm/platform`. Off by default; standard builds don't read it.
 */
export interface YouTubeUpdatesState {
  /** Whether the user turned the updates on, in a build that asks first. */
  optedIn: boolean
  /** Turns them on or off. */
  setOptedIn: (optedIn: boolean) => void
}

/** localStorage key. Bump the suffix (and add a migration) on incompatible changes. */
export const YOUTUBE_UPDATES_STORAGE_KEY = 'fxm.youtube-updates.v1'
const YOUTUBE_UPDATES_VERSION = 1

type Persisted = Pick<YouTubeUpdatesState, 'optedIn'>

/** Valid persisted state from an untrusted value: opted in only where it says `true`. */
export function sanitizeYouTubeUpdates(value: unknown): Persisted {
  const stored: Partial<Record<keyof Persisted, unknown>> =
    typeof value === 'object' && value !== null ? value : {}
  return { optedIn: stored.optedIn === true }
}

/** Creates the store, persisted to Web Storage (one per app; tests make their own). */
export function createYouTubeUpdatesStore(options: { storage?: () => Storage | undefined } = {}) {
  return create<YouTubeUpdatesState>()(
    persist(
      (set) => ({
        optedIn: false,
        setOptedIn: (optedIn) => set({ optedIn }),
      }),
      {
        name: YOUTUBE_UPDATES_STORAGE_KEY,
        version: YOUTUBE_UPDATES_VERSION,
        storage: createSafeStorage<Persisted>(options.storage),
        partialize: ({ optedIn }) => ({ optedIn }),
        migrate: (persisted) => sanitizeYouTubeUpdates(persisted),
        merge: (persisted, current) => ({ ...current, ...sanitizeYouTubeUpdates(persisted) }),
      },
    ),
  )
}

export type YouTubeUpdatesStore = ReturnType<typeof createYouTubeUpdatesStore>

export const useYouTubeUpdatesStore: YouTubeUpdatesStore = createYouTubeUpdatesStore()
