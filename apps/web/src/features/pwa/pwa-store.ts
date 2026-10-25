import { create } from 'zustand'

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
}

/** One store per app (tests reset it after each test, see src/test/setup.ts). */
export const usePwaStore = create<PwaState>()(() => ({
  updateReady: false,
  updateDismissed: false,
  applyUpdate: async () => {},
  installPrompt: undefined,
}))

export type PwaStore = typeof usePwaStore
