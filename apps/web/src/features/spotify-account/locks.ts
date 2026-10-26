/**
 * The Web Lock that keeps the sync to one tab at a time: a sync holds it while it runs,
 * Disconnect takes it to forget what the sync followed, and the tidy-up after a Disconnect
 * (`tidy.ts`) runs only while nobody holds it. A module of its own, so that the tidy-up can use
 * it without loading the runtime.
 *
 * @module
 */

/** The Web Lock one sync holds, so that two tabs never sync at once. */
export const SYNC_LOCK = 'fxm-spotify-account-sync'

/** Web Locks, as far as the account feature uses them. */
export interface LockManagerLike {
  request<T>(
    name: string,
    options: { ifAvailable?: boolean; signal?: AbortSignal },
    callback: (lock: unknown) => Promise<T>,
  ): Promise<T>
}

/** The browser's Web Locks, when it has them. */
export function browserLocks(): LockManagerLike | undefined {
  const locks = (globalThis.navigator as { locks?: LockManagerLike } | undefined)?.locks
  return typeof locks?.request === 'function' ? locks : undefined
}
