/**
 * What the installable web app needs from the static host: stage 2.8 writes the `_headers`
 * and `_redirects` rules for /app/. 2.8 started alongside 5.1 and is not merged yet, so the tests
 * check the /app/* policy that docs/PLAN.md §2.8 specifies ({@link PLANNED_APP_CSP}). When 2.8
 * merges, the integration step points them at the rule 2.8 generates instead.
 *
 * @module
 */

/**
 * Directives the app's Content-Security-Policy must open to its own origin (`'self'`), each with
 * the directives a browser falls back to when it is missing (CSP Level 3):
 *
 * - `worker-src`: registering the service worker, `/app/sw.js`
 * - `manifest-src`: the browser loading `/app/manifest.webmanifest`
 * - `img-src`: the app icons
 * - `connect-src`: the service worker downloading the app shell (it runs under the same policy,
 *   which the host sends with `sw.js`)
 */
export const PWA_CSP_NEEDS = {
  'worker-src': ['worker-src', 'child-src', 'script-src', 'default-src'],
  'manifest-src': ['manifest-src', 'default-src'],
  'img-src': ['img-src', 'default-src'],
  'connect-src': ['connect-src', 'default-src'],
} as const satisfies Record<string, readonly string[]>

/**
 * Files that must not be cached for long, by the host or by a CDN, because they announce a new
 * version: the service worker, the manifest and the page. (Cloudflare Pages revalidates every
 * file by default; a long `max-age` or `immutable` belongs on `/app/assets/*` only, whose names
 * carry a content hash.)
 */
export const PWA_REVALIDATE_PATHS = ['/app/sw.js', '/app/manifest.webmanifest', '/app/index.html']

/**
 * The /app/* policy from docs/PLAN.md §2.8 (the `sha256-…` placeholder stands for the inline
 * theme script's hash, which 2.8 computes at build). A stand-in for 2.8's generated rule.
 */
export const PLANNED_APP_CSP =
  "default-src 'self'; script-src 'self' 'sha256-…'; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://*.ytimg.com https://*.googleusercontent.com https://*.ggpht.com https://*.scdn.co https://*.spotifycdn.com https://archive.org https://*.archive.org https://*.jamendo.com; media-src 'self' blob: https:; connect-src 'self' https://www.youtube.com https://music.youtube.com https://youtubei.googleapis.com https://*.googlevideo.com https://open.spotify.com https://api-partner.spotify.com https://spclient.wg.spotify.com https://musicbrainz.org https://archive.org https://*.archive.org https://*.jamendo.com https://lrclib.net; frame-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; object-src 'none'"

/** Splits a Content-Security-Policy into its directives (names lower-cased; the first wins). */
export function parseCsp(policy: string): Map<string, string[]> {
  const directives = new Map<string, string[]>()
  for (const part of policy.split(';')) {
    const [name, ...sources] = part.trim().split(/\s+/)
    if (!name) continue
    const key = name.toLowerCase()
    if (!directives.has(key)) directives.set(key, sources)
  }
  return directives
}

/**
 * What a Content-Security-Policy blocks that the PWA needs, as `<directive> (from <the directive
 * that applies>)`. Empty when the policy allows the service worker, the manifest, the icons and
 * the shell download.
 */
export function pwaCspProblems(policy: string): string[] {
  const directives = parseCsp(policy)
  const problems: string[] = []
  for (const [need, chain] of Object.entries(PWA_CSP_NEEDS)) {
    const applies = chain.find((name) => directives.has(name))
    if (applies === undefined) continue // nothing restricts it
    const sources = directives.get(applies) ?? []
    if (!sources.includes("'self'") && !sources.includes('*')) {
      problems.push(applies === need ? need : `${need} (from ${applies})`)
    }
  }
  return problems
}
