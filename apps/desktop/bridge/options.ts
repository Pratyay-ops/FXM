/**
 * How the desktop app tunes the player and the stream lifecycle (stage 7.3).
 *
 * @module
 */

import { playbackProblemOf } from '@fxm/core'
import { classifyFailure, type FailureClass } from '@fxm/player'

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

/**
 * What the desktop app's player does after a failed attempt: what `classifyFailure` from
 * `@fxm/player` says, except that a song whose sources offered nothing the engine may play
 * (`unavailable`, `no-stream`) is retried rather than skipped.
 *
 * In the desktop app that mostly means the end-of-file probe got no answer, on the top rung and
 * on the fallback alike: `DesktopAudioEngine` refuses an IP-bound URL that is still `unverified`
 * (see `engine.ts`), where the web app would play it. A flaky connection is no reason to mark a
 * song unavailable, so the player tries it again after its usual wait (`retryDelaysMs`), up to
 * `maxRetries` times, and the stream lifecycle resolves it afresh from the top rung, which probes
 * again. A song that keeps failing then counts toward `maxConsecutiveFailures` (4 in a row stop
 * playback), as network failures do, rather than toward `maxConsecutiveSkips` (10).
 *
 * The stream lifecycle takes such a retry for the user playing the song again. That matters only
 * for a Suggest-band guess, and a resolution that held a guess back fails with `needs-review`,
 * which is still skipped.
 */
export function desktopClassifyFailure(error: Error): FailureClass {
  const problem = playbackProblemOf(error)
  if (problem?.type === 'unavailable' && problem.reason === 'no-stream') return 'retry'
  return classifyFailure(error)
}

/** Options for `new Player(...)` in the desktop app. */
export const DESKTOP_PLAYER_OPTIONS = Object.freeze({
  refreshBeforeExpiryMs: DESKTOP_URL_REFRESH_MARGIN_MS,
  classifyFailure: desktopClassifyFailure,
})
