/**
 * What FXM's native code shares with @fxm/platform, written as Kotlin:
 *
 * - for its native HTTP (android/fxm-http), the host table (`HOST_RULES` in
 *   packages/platform/src/hosts.ts) and the FxmHttp bridge's constants
 *   (packages/platform/src/android-http.ts): native code enforces the same table as the
 *   transports, and both sides of the bridge use the same error codes;
 * - for its Spotify login (android/fxm-spotify), the FxmSpotifyLogin bridge's constants
 *   (packages/platform/src/android-spotify-login.ts): its error codes, its rate limit and the
 *   token parameters' allow-list, which is FXM Connect's.
 *
 * native-tables.test.ts fails while the committed PlatformTables.kt or LoginTables.kt differs
 * from this output. Regenerate them with `scripts/run.sh pnpm vitest run apps/mobile/scripts -u`
 * and commit them.
 */

import {
  FXM_HTTP_ERROR_CODES,
  FXM_HTTP_MAX_READ_BYTES,
  FXM_HTTP_PLUGIN,
  FXM_HTTP_READ_BYTES,
  FXM_SPOTIFY_LOGIN_ERROR_CODES,
  FXM_SPOTIFY_LOGIN_PLUGIN,
  FXM_SPOTIFY_LOGIN_RATE_LIMIT,
  FXM_SPOTIFY_LOGIN_TOKEN_PARAMS,
  FXM_SPOTIFY_TOKEN_MAX_BYTES,
  FXM_SPOTIFY_TOKEN_TIMEOUT_MS,
  HOST_RULES,
  type HostClass,
  type HostRule,
} from '@fxm/platform'

/** Where the generated file lives, relative to apps/mobile. */
export const PLATFORM_TABLES_PATH =
  'android/fxm-http/src/main/kotlin/io/github/pratyayops/fxm/http/PlatformTables.kt'

/** The Kotlin `HostClass` entry of each host class. */
export const KOTLIN_HOST_CLASSES: Readonly<Record<HostClass, string>> = {
  open: 'OPEN',
  innertube: 'INNERTUBE',
  googlevideo: 'GOOGLEVIDEO',
  spotify: 'SPOTIFY',
  'lastfm-web': 'LASTFM_WEB',
}

/** A Kotlin string literal: JSON's escapes, plus `$`, which starts a Kotlin template. */
export function kotlinString(value: string): string {
  return JSON.stringify(value).replaceAll('$', '\\$')
}

function hostRule(rule: HostRule): string {
  const args = [
    kotlinString(rule.host),
    `HostClass.${KOTLIN_HOST_CLASSES[rule.hostClass]}`,
    kotlinString(rule.service),
    ...(rule.pathPrefix === undefined ? [] : [`pathPrefix = ${kotlinString(rule.pathPrefix)}`]),
  ]
  const line = `    HostRule(${args.join(', ')}),`
  if (line.length <= 100) return line
  return ['    HostRule(', ...args.map((arg) => `      ${arg},`), '    ),'].join('\n')
}

/** The contents of PlatformTables.kt for a host table and the bridge's error codes. */
export function kotlinPlatformTables(
  rules: readonly HostRule[] = HOST_RULES,
  errorCodes: readonly string[] = FXM_HTTP_ERROR_CODES,
): string {
  return `// Generated from @fxm/platform by apps/mobile/scripts/native-tables.ts. Do not edit: after
// changing packages/platform/src/hosts.ts or android-http.ts, run
// \`scripts/run.sh pnpm vitest run apps/mobile/scripts -u\` and commit the result.
package io.github.pratyayops.fxm.http

/** FXM's host table: \`HOST_RULES\` in packages/platform/src/hosts.ts. */
val HOST_RULES: List<HostRule> =
  listOf(
${rules.map(hostRule).join('\n')}
  )

/**
 * The codes the FxmHttp plugin rejects with: \`FXM_HTTP_ERROR_CODES\` in
 * packages/platform/src/android-http.ts, which documents each.
 */
enum class BridgeErrorCode {
${errorCodes.map((code) => `  ${code},`).join('\n')}
}

/** The FxmHttp bridge's constants, from packages/platform/src/android-http.ts. */
object BridgeProtocol {
  /** The plugin's name on the Capacitor bridge. */
  const val PLUGIN_NAME = ${kotlinString(FXM_HTTP_PLUGIN)}

  /** Bytes per read when JavaScript asks for no particular amount. */
  const val READ_BYTES = ${FXM_HTTP_READ_BYTES}

  /** The most one read returns. */
  const val MAX_READ_BYTES = ${FXM_HTTP_MAX_READ_BYTES}
}
`
}

/** Where the Spotify login's generated file lives, relative to apps/mobile. */
export const LOGIN_TABLES_PATH =
  'android/fxm-spotify/src/main/kotlin/io/github/pratyayops/fxm/spotify/LoginTables.kt'

/** A JavaScript `RegExp` as a Kotlin `Regex`: these allow-list forms mean the same in both. */
function kotlinRegex(form: RegExp): string {
  if (form.flags !== '') throw new TypeError(`A form with flags has no Kotlin twin: ${form}`)
  return `Regex(${kotlinString(form.source)})`
}

/** The contents of LoginTables.kt, from the FxmSpotifyLogin bridge's constants. */
export function kotlinLoginTables(
  errorCodes: readonly string[] = FXM_SPOTIFY_LOGIN_ERROR_CODES,
): string {
  const params = FXM_SPOTIFY_LOGIN_TOKEN_PARAMS.map(
    ([name, form]) => `      ${kotlinString(name)} to ${kotlinRegex(form)},`,
  )
  return `// Generated from @fxm/platform by apps/mobile/scripts/native-tables.ts. Do not edit: after
// changing packages/platform/src/android-spotify-login.ts, run
// \`scripts/run.sh pnpm vitest run apps/mobile/scripts -u\` and commit the result.
package io.github.pratyayops.fxm.spotify

/**
 * The codes the FxmSpotifyLogin plugin rejects with: \`FXM_SPOTIFY_LOGIN_ERROR_CODES\` in
 * packages/platform/src/android-spotify-login.ts, which documents each.
 */
enum class LoginErrorCode {
${errorCodes.map((code) => `  ${code},`).join('\n')}
}

/** The FxmSpotifyLogin bridge's constants, from packages/platform/src/android-spotify-login.ts. */
object LoginProtocol {
  /** The plugin's name on the Capacitor bridge. */
  const val PLUGIN_NAME = ${kotlinString(FXM_SPOTIFY_LOGIN_PLUGIN)}

  /**
   * The token request's query parameters, in the order they are sent, and the form each must
   * have: FXM Connect's allow-list (\`SPOTIFY_TOKEN_PARAM_FORMS\` in
   * packages/platform/src/connect.ts).
   */
  val TOKEN_PARAMS: Map<String, Regex> =
    linkedMapOf(
${params.join('\n')}
    )

  /** How many token requests may be sent in [RATE_LIMIT_WINDOW_MS]. */
  const val RATE_LIMIT_MAX = ${FXM_SPOTIFY_LOGIN_RATE_LIMIT.max}

  /** The rate limit's rolling window. */
  const val RATE_LIMIT_WINDOW_MS = ${FXM_SPOTIFY_LOGIN_RATE_LIMIT.windowMs}L

  /** The largest token endpoint answer that is read. */
  const val MAX_TOKEN_BYTES = ${FXM_SPOTIFY_TOKEN_MAX_BYTES}L

  /** How long one token request may take, the response included. */
  const val TOKEN_TIMEOUT_MS = ${FXM_SPOTIFY_TOKEN_TIMEOUT_MS}L
}
`
}
