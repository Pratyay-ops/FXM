/**
 * What the installable web app needs from the static host: the `_headers` rule for /app/*,
 * which stage 2.8 generates (`appPolicy()` in scripts/build-dist/src/policies.ts). 5.1 started
 * before 2.8 merged, so the tests check the /app/* policy that docs/PLAN.md §2.8 specifies
 * ({@link PLANNED_APP_CSP}), and the build revisions the service worker's copy of the page with
 * that rule ({@link APP_HEADERS}). An integration step points both at the rule 2.8 generates.
 *
 * @module
 */

import { createHash } from 'node:crypto'

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

/**
 * The headers of the /app/* rule (docs/PLAN.md §2.8): a stand-in for the rule 2.8's `_headers`
 * generator builds.
 *
 * The service worker answers every navigation with its stored copy of index.html, and with the
 * headers that copy came with, the CSP among them. It fetches the page again only when its
 * precache revision changes, which by default happens only when the page's own content does. So
 * the build folds these headers into that revision ({@link headersRevision}, `pwaOptions` in
 * options.ts): a deploy that changes nothing but this rule still ships a new service worker, the
 * update toast, and the new policy. Integration: 2.8 hands the build the rule it writes.
 */
export const APP_HEADERS: Readonly<Record<string, string>> = {
  'Content-Security-Policy': PLANNED_APP_CSP,
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
}

/**
 * A short fingerprint of a header rule: it changes when any header name or value does, and
 * not with the order the rule lists them in.
 */
export function headersRevision(headers: Readonly<Record<string, string>>): string {
  const canonical = Object.entries(headers)
    .map(([name, value]) => `${name.toLowerCase()}: ${value.trim()}`)
    .sort()
    .join('\n')
  return createHash('sha256').update(canonical).digest('hex').slice(0, 12)
}

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
