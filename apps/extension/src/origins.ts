/**
 * Helpers for FXM origins, shared by the build (manifests, rulesets) and the runtime scripts.
 * Pure functions with no browser or Node APIs.
 */

/**
 * Validates an FXM origin: an exact `scheme://host[:port]` serialization, HTTPS unless the host
 * is `localhost`. Returns its URL.
 */
export function parseOrigin(origin: string): URL {
  let url: URL
  try {
    url = new URL(origin)
  } catch {
    throw new Error(`not an origin: ${origin}`)
  }
  if (url.origin !== origin) throw new Error(`not an exact origin: ${origin}`)
  const local = url.hostname === 'localhost'
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
    throw new Error(`FXM origins must use HTTPS (http is only allowed for localhost): ${origin}`)
  }
  return url
}

/** True for the development build's localhost origins. */
export function isLocalhost(origin: string): boolean {
  return parseOrigin(origin).hostname === 'localhost'
}

/** Host name of an origin, the form DNR's `initiatorDomains` expects (no scheme, no port). */
export function originHost(origin: string): string {
  return parseOrigin(origin).hostname
}

/**
 * Match pattern for an origin's pages. Ports are left out: match patterns treat ports
 * differently in Chromium and Firefox, and the scripts check the exact origin at runtime.
 */
export function originMatchPattern(origin: string): string {
  const url = parseOrigin(origin)
  return `${url.protocol}//${url.hostname}/*`
}

/**
 * True when another allowed origin has the same host. DNR matches initiators by host only, so
 * such origins (the two localhost ports of the dev build) need one ruleset each, and only one
 * of them can be enabled at a time.
 */
export function sharesHost(origin: string, origins: readonly string[]): boolean {
  const host = originHost(origin)
  return origins.some((other) => other !== origin && originHost(other) === host)
}

/** Manifest ID of an origin's static ruleset, e.g. `fxmusic_pages_dev` or `localhost_5173`. */
export function rulesetId(origin: string): string {
  const url = parseOrigin(origin)
  return `${url.hostname}${url.port ? `_${url.port}` : ''}`.replace(/[^a-z0-9]+/g, '_')
}

/** Ruleset changes that make an origin's rules the active ones for its host. */
export interface RulesetSwitch {
  enableRulesetIds: string[]
  disableRulesetIds: string[]
}

/**
 * For an origin that shares its host with other FXM origins, enables its ruleset and disables
 * theirs. Returns null for origins with a host of their own, which is always the case in the
 * production build.
 */
export function rulesetSwitch(origin: string, origins: readonly string[]): RulesetSwitch | null {
  if (!origins.includes(origin) || !sharesHost(origin, origins)) return null
  const host = originHost(origin)
  return {
    enableRulesetIds: [rulesetId(origin)],
    disableRulesetIds: origins
      .filter((other) => other !== origin && originHost(other) === host)
      .map(rulesetId),
  }
}
