/**
 * The `_redirects` file `make dist` writes: 200 rewrites that answer the embed's routes with its
 * page. A player's address, such as `/embed/track/ytm:dQw4w9WgXcQ`, matches no file, and Pages
 * answers such a path with the nearest `404.html` (the embed's copy of its page) and status 404,
 * which some embedding sites and link previews treat as an error. With a rewrite it answers 200,
 * with the same page and the same headers.
 *
 * Pages applies `_redirects` rules before it looks for a file, so a rule must match no file:
 * only the embed's route prefixes, one per kind of player (`/embed/<kind>/*`), never the folder
 * itself or `/embed/assets/*` (`redirectProblems` checks every rule against every file). Each
 * rewrites to `/embed/`, which Pages answers with `embed/index.html`; `/embed/index.html` would
 * answer with a redirect to `/embed/`, which drops the player's address (Pages' parser even
 * ignores such a rule, as a loop). A 200 rule only replaces the path Pages looks the file up by:
 * headers still follow the path the browser asked for, so a player keeps the `/embed/*` rule
 * (Pages' asset server and `_redirects` parser in wrangler 4.149, read 2026-10-26).
 *
 * The web app keeps its 404 for its routes: they share `/app/` with its files under names no
 * prefix tells apart (`/app/search` and `/app/sw.js`), and the app reads the address the same
 * either way. Its 404 is the trade-off README.md describes.
 */
import { servedPaths } from './rules.ts'

/**
 * The kinds of player the embed's routes name: `/embed/<kind>/<source>:<native ID>`
 * (`EMBED_KINDS` in apps/web/src/embed/target.ts; a test keeps the two in step).
 */
export const EMBED_ROUTE_KINDS = ['track', 'album', 'playlist'] as const

/** One `_redirects` rule. FXM writes only rewrites: status 200. */
export interface RedirectRule {
  /** The request path: literal, ending in `*`, which stands for the rest of the path. */
  readonly from: string
  /** The path whose file answers instead, with the request's own path and headers kept. */
  readonly to: string
  readonly status: 200
}

/** The rewrites a composed folder needs: the embed's routes, once the embed is in it. */
export function redirectRules(files: readonly string[]): RedirectRule[] {
  if (!files.includes('embed/index.html')) return []
  return EMBED_ROUTE_KINDS.map((kind) => ({ from: `/embed/${kind}/*`, to: '/embed/', status: 200 }))
}

/** Pages' pattern for a rule's path: anchored, with `*` for any rest of the path. */
function patternOf(from: string): RegExp {
  const escaped = from
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*')
  return new RegExp(`^${escaped}$`)
}

/** The rule that answers a request path (as the browser sent it), if any. */
export function matchRedirect(
  rules: readonly RedirectRule[],
  pathname: string,
): RedirectRule | undefined {
  return rules.find((rule) => patternOf(rule.from).test(pathname))
}

/**
 * Why the rules can't go to Pages with these files (an empty list when they can): a rule that
 * matches a path a file is served at, which it would hide, a target no file answers with 200,
 * a rule whose path isn't literal up to a final `*`, or a status other than 200.
 */
export function redirectProblems(
  rules: readonly RedirectRule[],
  files: readonly string[],
): string[] {
  const problems: string[] = []
  const fileSet = new Set(files)
  const served = files.flatMap((file) => servedPaths(file, fileSet).map((path) => ({ file, path })))
  for (const rule of rules) {
    if (rule.status !== 200) problems.push(`${rule.from}: FXM's rules are 200 rewrites only`)
    if (!/^\/[^*:\s]*\*?$/.test(rule.from) || rule.from.endsWith('/') || !rule.from.endsWith('*')) {
      problems.push(`${rule.from}: a rule's path is literal and ends in /* (a folder's rest)`)
    }
    for (const { file, path } of served) {
      if (patternOf(rule.from).test(path)) {
        problems.push(`${rule.from} would answer ${path} instead of ${file}: rules win over files`)
      }
    }
    const [canonical] = served.filter(({ path }) => path === rule.to).map(({ path }) => path)
    if (canonical === undefined || !rule.to.endsWith('/')) {
      problems.push(
        `${rule.from}: ${rule.to} is not a folder whose index.html Pages serves, so the rewrite would answer with a redirect or a 404`,
      )
    }
  }
  return problems
}

/** The `_redirects` file: comment lines, then one `from to status` line per rule. */
export function serializeRedirects(
  rules: readonly RedirectRule[],
  comments: readonly string[] = [],
): string {
  return [
    ...comments.map((comment) => `# ${comment}`),
    ...rules.map((rule) => `${rule.from} ${rule.to} ${rule.status}`),
  ]
    .map((line) => `${line}\n`)
    .join('')
}

/** The rules of a `_redirects` file, and the lines that aren't rules FXM writes. */
export function parseRedirects(text: string): { rules: RedirectRule[]; invalid: string[] } {
  const rules: RedirectRule[] = []
  const invalid: string[] = []
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const [from, to, status, ...rest] = line.split(/\s+/)
    if (from?.startsWith('/') && to?.startsWith('/') && status === '200' && rest.length === 0) {
      rules.push({ from, to, status: 200 })
    } else {
      invalid.push(`line ${index + 1}: "${line}" is not a 200 rewrite (from to 200)`)
    }
  }
  return { rules, invalid }
}
