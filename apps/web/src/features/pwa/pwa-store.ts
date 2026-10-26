import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { createSafeStorage } from '../../lib/safe-storage'

/** The user's answer to the browser's install dialog. */
export interface InstallChoice {
  outcome: 'accepted' | 'dismissed'
  platform: string
}

/** Chromium's `beforeinstallprompt` event, which TypeScript's DOM types don't include. */
export interface InstallPromptEvent extends Event {
  /** Shows the browser's install dialog: once per event, and only during a user gesture. */
  prompt(): Promise<unknown>
  /** Settles with the user's answer. */
  readonly userChoice: Promise<InstallChoice>
}

/** The installable web app's state: a waiting new version and the browser's install offer. */
export interface PwaState {
  /** A new version is installed and waits for a reload: the update toast shows. */
  updateReady: boolean
  /** The user put the waiting version off with "Not now". */
  updateDismissed: boolean
  /** Activates the waiting version, and the page reloads into it. */
  applyUpdate: () => Promise<void>
  /** Chromium's deferred install offer, kept while the browser offers to install FXM. */
  installPrompt: InstallPromptEvent | undefined
  /** FXM was installed from this page (the browser reported `appinstalled`). */
  installedHere: boolean
  /**
   * Until when (ms since the epoch) the top bar and the Home page keep quiet about installing,
   * because the user said "Not now" or closed the browser's install dialog. Settings still
   * offers it. Stored, so the offer doesn't come back on the next visit.
   */
  installSnoozedUntil: number
}

/** localStorage key of the stored part (`installSnoozedUntil`). */
export const PWA_STORAGE_KEY = 'fxm.pwa.v1'

type StoredPwaState = Pick<PwaState, 'installSnoozedUntil'>

/** Keeps a valid stored snooze and drops anything else. */
function sanitizeStored(value: unknown): StoredPwaState {
  const until = (value as Partial<Record<keyof StoredPwaState, unknown>> | null)
    ?.installSnoozedUntil
  return {
    installSnoozedUntil: typeof until === 'number' && Number.isFinite(until) ? until : 0,
  }
}

/** One store per app (tests reset it after each test, see src/test/setup.ts). */
export const usePwaStore = create<PwaState>()(
  persist(
    (): PwaState => ({
      updateReady: false,
      updateDismissed: false,
      applyUpdate: async () => {},
      installPrompt: undefined,
      installedHere: false,
      installSnoozedUntil: 0,
    }),
    {
      name: PWA_STORAGE_KEY,
      version: 1,
      storage: createSafeStorage<StoredPwaState>(),
      partialize: ({ installSnoozedUntil }) => ({ installSnoozedUntil }),
      merge: (persisted, current) => ({ ...current, ...sanitizeStored(persisted) }),
    },
  ),
)

export type PwaStore = typeof usePwaStore
