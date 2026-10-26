/**
 * A part of FXM's code that failed to download while the browser was online. The build names
 * every code file after its content, so a tab opened before a new version was published asks
 * for files that are gone, and only a reload, which fetches the new version, helps. Music tabs
 * stay open for days, so this happens. Offline, the same failure is a network error instead
 * (see `createLoader` in `app/services/lazy-provider.ts`).
 *
 * @module
 */

/** A code file failed to download while online: most likely FXM was updated meanwhile. */
export class AppUpdatedError extends Error {
  override readonly name = 'AppUpdatedError'
}

/** Whether `error` is an {@link AppUpdatedError}, also one from a second copy of this module. */
export function isAppUpdatedError(error: unknown): error is AppUpdatedError {
  return error instanceof Error && error.name === 'AppUpdatedError'
}

/** What the pages say about one. */
export const APP_UPDATED_MESSAGE = 'FXM was updated. Reload to get the new version.'

/**
 * Reloads the page, which fetches the new version. Only ever on the user's request: a reload
 * stops the music.
 */
export function reloadApp(): void {
  window.location.reload()
}
