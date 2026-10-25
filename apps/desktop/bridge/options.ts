/**
 * How the desktop app tunes the player and the stream lifecycle (stage 7.3).
 *
 * @module
 */

/**
 * How long before a stream URL expires the desktop app resolves it again: one hour. YouTube's
 * URLs expire about 6 hours after they were resolved (`expire`), so the desktop app resolves a
 * URL again once it is about 5 hours old: the URL cache stops handing it out, and a stream loaded
 * that long ago, say before a long pause, is refreshed before it plays again.
 *
 * The web app's default margin is 10 minutes. The desktop app keeps a wider one because it
 * often plays for hours in the background: an hour leaves room for a long track that starts on
 * an old URL, whose media element may ask for more bytes near its end, and for a clock that is
 * off by some minutes. A 403 still makes the stream lifecycle resolve again at any age.
 */
export const DESKTOP_URL_REFRESH_MARGIN_MS = 60 * 60_000

/** Options for `new Player(...)` in the desktop app. */
export const DESKTOP_PLAYER_OPTIONS = Object.freeze({
  refreshBeforeExpiryMs: DESKTOP_URL_REFRESH_MARGIN_MS,
})
