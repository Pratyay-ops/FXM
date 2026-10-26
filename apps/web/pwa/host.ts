/**
 * What the installable web app needs from the static host: the `_headers` rule for /app/*,
 * which make dist generates (`appPolicy()` and `COMMON_HEADERS` in
 * scripts/build-dist/src/policies.ts, whose tests check that the policy allows what
 * {@link pwaCspProblems} asks for).
 *
 * The service worker serves its stored copy of the page with the headers it came with, so the
 * page's precache revision must change with that rule too. The app's build knows neither the
 * rule nor the final page (make dist adds the policy's meta elements to it): it revisions the
 * page with a stand-in rule ({@link APP_HEADERS}), and make dist replaces that revision with one
 * from the deployed page and rule ({@link pageRevision}, {@link setPageRevision}).
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
 * theme script's hash, which make dist computes): the policy of the stand-in rule
 * {@link APP_HEADERS}.
 */
export const PLANNED_APP_CSP =
  "default-src 'self'; script-src 'self' 'sha256-…'; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://*.ytimg.com https://*.googleusercontent.com https://*.ggpht.com https://*.scdn.co https://*.spotifycdn.com https://archive.org https://*.archive.org https://*.jamendo.com; media-src 'self' blob: https:; connect-src 'self' https://www.youtube.com https://music.youtube.com https://youtubei.googleapis.com https://*.googlevideo.com https://open.spotify.com https://api-partner.spotify.com https://spclient.wg.spotify.com https://musicbrainz.org https://archive.org https://*.archive.org https://*.jamendo.com https://lrclib.net; frame-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; object-src 'none'"

/**
 * The stand-in for the /app/* rule (docs/PLAN.md §2.8) that the app's build folds into the
 * page's precache revision.
 *
 * The service worker answers every navigation with its stored copy of index.html, and with the
 * headers that copy came with, the CSP among them. It fetches the page again only when its
 * precache revision changes, which by default happens only when the page's own content does. So
 * the build appends `-<headersRevision(APP_HEADERS)>` to that revision (`pwaOptions` in
 * options.ts), and make dist, which knows the real rule and the final page, replaces the whole
 * revision with {@link pageRevision} ({@link setPageRevision}): a deploy that changes nothing
 * but the rule still ships a new service worker, the update toast, and the new headers. Builds
 * outside make dist (`vite build`, the e2e tests) keep the stand-in's revision.
 */
export const APP_HEADERS: Readonly<Record<string, string>> = {
  'Content-Security-Policy': PLANNED_APP_CSP,
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
}

/** A header rule as text that changes with any name or value, and not with their order. */
function canonicalHeaders(headers: Readonly<Record<string, string>>): string {
  return Object.entries(headers)
    .map(([name, value]) => `${name.toLowerCase()}: ${value.trim()}`)
    .sort()
    .join('\n')
}

/**
 * A short fingerprint of a header rule: it changes when any header name or value does, and
 * not with the order the rule lists them in.
 */
export function headersRevision(headers: Readonly<Record<string, string>>): string {
  return createHash('sha256').update(canonicalHeaders(headers)).digest('hex').slice(0, 12)
}

/**
 * The page's precache revision as deployed: a fingerprint of the final index.html and of the
 * /app/* rule it is served with. It changes when either does, a policy-only deploy included,
 * and not with the order of the rule's headers.
 */
export function pageRevision(page: string, headers: Readonly<Record<string, string>>): string {
  return createHash('sha256')
    .update(page)
    .update('\0')
    .update(canonicalHeaders(headers))
    .digest('hex')
    .slice(0, 32)
}

/**
 * The built service worker with `revision` as the page's precache revision, in place of the one
 * the build gave it: the only revision that ends in `-<headersRevision(APP_HEADERS)>`
 * (`revisionPageWithHeaders` in options.ts). Throws unless it finds exactly that one.
 */
export function setPageRevision(serviceWorker: string, revision: string): string {
  const marker = headersRevision(APP_HEADERS)
  const built = new RegExp(`(["'])[^"'\\s]*-${marker}\\1`, 'g')
  const found = serviceWorker.match(built)?.length ?? 0
  if (found !== 1) {
    throw new Error(
      `the service worker has ${found} precache revisions ending in -${marker}, not the page's one`,
    )
  }
  return serviceWorker.replace(built, (_revision, quote: string) => `${quote}${revision}${quote}`)
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
