import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { createSafeStorage } from '../../lib/safe-storage'
import { type AppRelease, parseVersion } from './releases'

/** Why the last check found nothing, for Settings. */
export type AppUpdateProblem =
  /** The device was offline: nothing was asked. */
  | 'offline'
  /** GitHub's hourly limit for this address was used up. */
  | 'rate-limited'
  /** GitHub couldn't be reached, or answered with an error. */
  | 'unreachable'
  /** GitHub's answer wasn't a release FXM understands. */
  | 'unexpected'

/**
 * The Android app's update check (stage 6.6): whether it checks by itself, what the last check
 * found and when the next one is due. Only the switch, the found release, the times and the
 * version the user put off are stored.
 */
export interface AppUpdateState {
  /**
   * Whether FXM checks by itself, once a day (Settings → About → "Check for new versions"; on by
   * default). Off, it asks GitHub only when the user taps "Check now".
   */
  autoCheck: boolean
  /** The newest published release the last successful check found; `null` before one. */
  latest: AppRelease | null
  /** When a check last succeeded (ms since the epoch); 0 before one. */
  lastCheckedAt: number
  /** When the next scheduled check is due (ms since the epoch); 0: as soon as the app starts. */
  nextCheckAt: number
  /** The version whose offer the user answered ("Not now", or Download): no toast for it. */
  dismissedVersion: string | null
  /** A check is under way. */
  checking: boolean
  /** Why the last check failed; `null` when it succeeded. */
  problem: AppUpdateProblem | null
}

/** localStorage key. Bump the suffix (and add a migration) on incompatible changes. */
export const APP_UPDATE_STORAGE_KEY = 'fxm.app-update.v1'

type Persisted = Pick<
  AppUpdateState,
  'autoCheck' | 'latest' | 'lastCheckedAt' | 'nextCheckAt' | 'dismissedVersion'
>

const time = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0

const version = (value: unknown): string | null =>
  typeof value === 'string' && parseVersion(value) !== undefined ? value : null

/** Valid stored state from an untrusted value; anything else falls back to "never checked". */
export function sanitizeAppUpdate(value: unknown): Persisted {
  const stored: Partial<Record<keyof Persisted, unknown>> =
    typeof value === 'object' && value !== null ? value : {}
  const latest = stored.latest as Partial<Record<keyof AppRelease, unknown>> | null | undefined
  const latestVersion = version(latest?.version)
  return {
    // Only an explicit "off" turns the checks off.
    autoCheck: stored.autoCheck !== false,
    latest:
      latestVersion === null
        ? null
        : {
            version: latestVersion,
            hasApk: latest?.hasApk === true,
            ...(typeof latest?.publishedAt === 'string' ? { publishedAt: latest.publishedAt } : {}),
          },
    lastCheckedAt: time(stored.lastCheckedAt),
    nextCheckAt: time(stored.nextCheckAt),
    dismissedVersion: version(stored.dismissedVersion),
  }
}

const initialState: AppUpdateState = {
  autoCheck: true,
  latest: null,
  lastCheckedAt: 0,
  nextCheckAt: 0,
  dismissedVersion: null,
  checking: false,
  problem: null,
}

/** Creates the store, persisted to Web Storage (one per app; tests make their own). */
export function createAppUpdateStore(storage?: () => Storage | undefined) {
  return create<AppUpdateState>()(
    persist(() => initialState, {
      name: APP_UPDATE_STORAGE_KEY,
      version: 1,
      storage: createSafeStorage<Persisted>(storage),
      partialize: ({ autoCheck, latest, lastCheckedAt, nextCheckAt, dismissedVersion }) => ({
        autoCheck,
        latest,
        lastCheckedAt,
        nextCheckAt,
        dismissedVersion,
      }),
      merge: (persisted, current) => ({ ...current, ...sanitizeAppUpdate(persisted) }),
    }),
  )
}

export type AppUpdateStore = ReturnType<typeof createAppUpdateStore>

/** The app's store. */
export const useAppUpdateStore = createAppUpdateStore()
