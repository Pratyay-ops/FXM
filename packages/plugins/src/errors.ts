/**
 * Typed errors of the plugin system. Its failures are {@link PluginError}s: `FxmError`s whose
 * `code` the app already knows, plus a `pluginCode` that says exactly what went wrong, so the
 * settings page can explain it without parsing messages.
 *
 * The `code` decides what the player does with a failed track (`classifyFailure` of
 * `@fxm/player`): `Unavailable`, `NotFound` and `GeoBlocked` skip it, `Unsupported` stops the
 * player until the user acts, and the rest are retried. So a plugin's failures are `Unsupported`
 * only where plugins can't run or reach anything here: one broken plugin track is skipped, never a
 * reason to stop the queue.
 *
 * @module
 */

import { FxmError, type FxmErrorCode } from '@fxm/core'

/** Every {@link PluginErrorCode}. */
export const PLUGIN_ERROR_CODES = [
  'invalid-manifest',
  'invalid-file',
  'checksum-mismatch',
  'too-large',
  'needs-newer-fxm',
  'unsupported-api',
  'not-newer',
  'id-mismatch',
  'download-failed',
  'load-failed',
  'not-implemented',
  'plugin-failed',
  'bad-result',
  'bad-reply',
  'timeout',
  'too-many-requests',
  'disabled',
  'wrong-source',
  'unreachable',
  'unavailable',
] as const

/**
 * What went wrong:
 *
 * - `invalid-manifest`: the manifest is not one FXM accepts (see `parseManifest`)
 * - `invalid-file`: a plugin file or download that is not a plugin at all
 * - `checksum-mismatch`: the code's SHA-256 is not the one the manifest declares
 * - `too-large`: a manifest, a plugin file or the code is over its size limit
 * - `needs-newer-fxm`: the plugin needs a newer version of FXM than this one
 * - `unsupported-api`: the plugin was written for another version of the plugin API
 * - `not-newer`: an update whose version is not higher than the installed one
 * - `id-mismatch`: an update that names another plugin
 * - `download-failed`: the manifest or the code could not be downloaded
 * - `load-failed`: the plugin's code does not compile, threw while it loaded, or registered no
 *   handlers
 * - `not-implemented`: the plugin has no handler for an operation its manifest declares
 * - `plugin-failed`: a handler threw, or one of its requests broke the plugin's rules (see
 *   {@link PLUGIN_FAIL_CODES} for the codes a plugin may fail with)
 * - `bad-result`: a handler returned something that is not what the operation returns, or more
 *   than a result may hold
 * - `bad-reply`: the plugin's worker or document answered outside the plugin protocol
 * - `timeout`: an operation took longer than its time limit, or the plugin stopped answering
 * - `too-many-requests`: an operation asked for more network requests than one may make
 * - `disabled`: the plugin is switched off or was removed
 * - `wrong-source`: a plugin was asked about an entity or a candidate of another source
 * - `unreachable`: the platform can't reach the plugin's hosts right now (its route for them is
 *   closed, e.g. without the web app's sandbox documents); the `cause` says what would open it
 * - `unavailable`: plugins can't run here: no isolated evaluator, or no worker in it
 */
export type PluginErrorCode = (typeof PLUGIN_ERROR_CODES)[number]

/**
 * The `FxmError` codes a plugin may fail with (`fxm.fail(code)`): what a source says about one
 * item or one request. A plugin can't claim a bot check, a login or that FXM can't reach
 * something here: those are the platform's to report, and they would stop the player. Any other
 * code becomes `Unavailable`.
 */
export const PLUGIN_FAIL_CODES: readonly FxmErrorCode[] = [
  'NotFound',
  'Unavailable',
  'GeoBlocked',
  'RateLimited',
  'Network',
  'Parse',
  'Expired',
]

/** The `FxmError` code of each failure, unless the error names another. */
const FXM_CODES: Readonly<Record<PluginErrorCode, FxmErrorCode>> = {
  // Adding and updating, where the dialog explains them: never during playback.
  'invalid-manifest': 'Parse',
  'invalid-file': 'Parse',
  'checksum-mismatch': 'Parse',
  'too-large': 'Parse',
  'needs-newer-fxm': 'Unsupported',
  'unsupported-api': 'Unsupported',
  'not-newer': 'Unsupported',
  'id-mismatch': 'Unsupported',
  'download-failed': 'Network',
  // A plugin's operations: one broken plugin or item is skipped, and slow ones are retried.
  'load-failed': 'Unavailable',
  'not-implemented': 'Unavailable',
  'plugin-failed': 'Unavailable',
  'bad-result': 'Unavailable',
  'bad-reply': 'Unavailable',
  timeout: 'Network',
  'too-many-requests': 'Unavailable',
  disabled: 'Unavailable',
  'wrong-source': 'NotFound',
  // Plugins can't run or reach anything here: the user must act.
  unreachable: 'Unsupported',
  unavailable: 'Unsupported',
}

/** Options for the {@link PluginError} constructor. */
export interface PluginErrorOptions {
  /** The underlying error. */
  cause?: unknown
  /** The `FxmError` code, when it is not the failure's usual one (see {@link PluginErrorCode}). */
  code?: FxmErrorCode
  /** For `RateLimited`: how long to wait before trying again, in milliseconds. */
  retryAfterMs?: number
}

/** A failure of the plugin system, or of a plugin. */
export class PluginError extends FxmError {
  /** What went wrong. */
  readonly pluginCode: PluginErrorCode

  constructor(pluginCode: PluginErrorCode, message: string, options: PluginErrorOptions = {}) {
    super(options.code ?? FXM_CODES[pluginCode], message, {
      ...('cause' in options ? { cause: options.cause } : {}),
      ...(options.retryAfterMs === undefined ? {} : { retryAfterMs: options.retryAfterMs }),
    })
    this.pluginCode = pluginCode
  }
}

/** Whether `error` is a {@link PluginError}, optionally with one `pluginCode`. */
export function isPluginError(error: unknown, pluginCode?: PluginErrorCode): error is PluginError {
  return (
    error instanceof PluginError && (pluginCode === undefined || error.pluginCode === pluginCode)
  )
}

/**
 * Text from a plugin or a remote file, made safe to show and log: control characters become
 * spaces, runs of white space one space, and it is cut to `max` characters.
 */
export function cleanText(text: string, max = 300): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it removes
  const flat = text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/gu, ' ')
  const squeezed = flat.replace(/\s+/gu, ' ').trim()
  return squeezed.length > max ? `${squeezed.slice(0, max - 1)}…` : squeezed
}
