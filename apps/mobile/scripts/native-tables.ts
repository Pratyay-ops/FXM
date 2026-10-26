/**
 * What FXM's native HTTP (android/fxm-http) shares with @fxm/platform, written as Kotlin: the
 * host table (`HOST_RULES` in packages/platform/src/hosts.ts) and the FxmHttp bridge's constants
 * (packages/platform/src/android-http.ts). Native code enforces the same table as the transports,
 * and both sides of the bridge use the same error codes.
 *
 * native-tables.test.ts fails while the committed PlatformTables.kt differs from this output.
 * Regenerate it with `scripts/run.sh pnpm vitest run apps/mobile/scripts -u` and commit it.
 */

import {
  FXM_HTTP_ERROR_CODES,
  FXM_HTTP_MAX_READ_BYTES,
  FXM_HTTP_PLUGIN,
  FXM_HTTP_READ_BYTES,
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
