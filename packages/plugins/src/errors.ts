/**
 * Typed errors of the plugin system. Every failure is a {@link PluginError}: an `FxmError`
 * whose `code` the app already knows, plus a `pluginCode` that says exactly what went wrong, so
 * the settings page can explain it without parsing messages.
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
 * - `load-failed`: the plugin's code threw while it loaded, or registered no handlers
 * - `not-implemented`: the plugin has no handler for an operation its manifest declares
 * - `plugin-failed`: a handler threw (its own `code`, when it gave a known one, is the error's)
 * - `bad-result`: a handler returned something that is not what the operation returns
 * - `bad-reply`: the evaluator document answered outside the plugin protocol
 * - `timeout`: an operation took longer than its time limit
 * - `too-many-requests`: an operation asked for more network requests than one may make
 * - `disabled`: the plugin is switched off or was removed
 * - `unavailable`: plugins can't run here (no isolated evaluator on this platform)
 */
export type PluginErrorCode = (typeof PLUGIN_ERROR_CODES)[number]

/** The `FxmError` code of each failure, unless the error names another. */
const FXM_CODES: Readonly<Record<PluginErrorCode, FxmErrorCode>> = {
  'invalid-manifest': 'Parse',
  'invalid-file': 'Parse',
  'checksum-mismatch': 'Parse',
  'too-large': 'Parse',
  'needs-newer-fxm': 'Unsupported',
  'unsupported-api': 'Unsupported',
  'not-newer': 'Unsupported',
  'id-mismatch': 'Unsupported',
  'download-failed': 'Network',
  'load-failed': 'Parse',
  'not-implemented': 'Unsupported',
  'plugin-failed': 'Unavailable',
  'bad-result': 'Parse',
  'bad-reply': 'Parse',
  timeout: 'Network',
  'too-many-requests': 'RateLimited',
  disabled: 'Unsupported',
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
