/**
 * The header rule stage 2.8 gives `/embed/*` (docs/PLAN.md, and the README in src/embed/,
 * "Headers"), as the embed's browser tests and its preview server send it. 2.8's `_headers`
 * generator is the source of truth for the deploy; keep this copy in step with it.
 *
 * @module
 */

/**
 * The `/app/*` policy of docs/PLAN.md, with `script-src 'self'`: the embed has no inline
 * script, so the app's theme-script hash isn't needed (the deploy's copy may keep it). Workers
 * only from its own origin, as the deploy's policy allows them (`WORKER_SOURCES` in
 * scripts/build-dist/src/policies.ts).
 */
export const APP_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "worker-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https://*.ytimg.com https://*.googleusercontent.com https://*.ggpht.com https://*.scdn.co https://*.spotifycdn.com https://archive.org https://*.archive.org https://*.jamendo.com",
  "media-src 'self' blob: https:",
  "connect-src 'self' https://www.youtube.com https://music.youtube.com https://youtubei.googleapis.com https://*.googlevideo.com https://open.spotify.com https://api-partner.spotify.com https://spclient.wg.spotify.com https://musicbrainz.org https://archive.org https://*.archive.org https://*.jamendo.com https://lrclib.net https://sponsor.ajay.app",
  "frame-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "object-src 'none'",
].join('; ')

/**
 * The `/embed/*` policy: as `/app/*`, without `frame-ancestors`, so any site may frame the
 * player. Its `frame-src` must stay exactly `'self'`: browsers check it when the embedding page
 * navigates the player's sandbox frame, and it is what keeps that page from putting a document
 * of its own there (the browser tests check it).
 */
export const EMBED_POLICY = APP_POLICY.replace("; frame-ancestors 'none'", '')

/**
 * Every header of the `/embed/*` rule. `Cross-Origin-Opener-Policy: same-origin` cuts a player
 * opened at top level off from the page that opened it, which otherwise could count the
 * player's frames (`window.length`) and tell whether the visitor has FXM Connect. Browsers
 * ignore it in frames, so it doesn't get in the way of embedding.
 */
export const EMBED_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'content-security-policy': EMBED_POLICY,
  'cross-origin-opener-policy': 'same-origin',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
})
