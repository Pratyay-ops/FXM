/**
 * The typed error of the Lite tier's sandbox documents.
 *
 * @module
 */

import { FxmError, type FxmErrorCode } from '@fxm/core'
import type { SandboxErrorCode } from './document'

/** How each sandbox error maps to an `FxmError` code; the type makes it list every code. */
const FXM_CODES: Readonly<Record<SandboxErrorCode, FxmErrorCode>> = {
  'bad-request': 'Unsupported',
  'forbidden-host': 'Unsupported',
  'forbidden-path': 'Unsupported',
  'forbidden-method': 'Unsupported',
  'forbidden-header': 'Unsupported',
  preflight: 'Unsupported',
  'too-large': 'Parse',
  timeout: 'Network',
  network: 'Network',
}

/** Default messages, for replies that carry none. */
const MESSAGES: Readonly<Record<SandboxErrorCode, string>> = {
  'bad-request': 'The sandbox refused a malformed request',
  'forbidden-host': 'The sandbox does not send requests to this host',
  'forbidden-path': 'The sandbox does not send requests to this path',
  'forbidden-method': 'The sandbox does not send requests with this method',
  'forbidden-header': 'The sandbox sends no headers to this host',
  preflight: 'The request would need a CORS preflight, which InnerTube refuses from the sandbox',
  'too-large': 'The response is larger than the sandbox allows',
  timeout: 'The sandbox got no complete response in time',
  network: 'The sandbox request failed',
}

/** Every {@link SandboxErrorCode}. */
export const SANDBOX_ERROR_CODES = Object.freeze(Object.keys(FXM_CODES) as SandboxErrorCode[])

/** Whether `code` is a {@link SandboxErrorCode}. */
export function isSandboxErrorCode(code: unknown): code is SandboxErrorCode {
  return (SANDBOX_ERROR_CODES as readonly unknown[]).includes(code)
}

/**
 * A request the sandbox refused or could not complete, mapped to an `FxmError` code:
 *
 * | `sandboxCode` | `FxmError` code |
 * |---|---|
 * | `bad-request`, `forbidden-host`, `forbidden-path`, `forbidden-method`, `forbidden-header`, `preflight` | `Unsupported` |
 * | `too-large` | `Parse` |
 * | `timeout`, `network`, and codes this app does not know | `Network` |
 */
export class SandboxError extends FxmError {
  /** The sandbox's reason, e.g. `preflight`; may be a code this app does not know. */
  readonly sandboxCode: string

  /**
   * @param sandboxCode The sandbox's reason.
   * @param message Details, for logs. Default: a description of the code.
   * @param options The underlying cause.
   */
  constructor(sandboxCode: string, message?: string, options: { cause?: unknown } = {}) {
    const known = isSandboxErrorCode(sandboxCode) ? sandboxCode : undefined
    super(
      known === undefined ? 'Network' : FXM_CODES[known],
      message ?? (known === undefined ? `The sandbox failed (${sandboxCode})` : MESSAGES[known]),
      'cause' in options ? { cause: options.cause } : {},
    )
    this.sandboxCode = sandboxCode
  }
}

/** Whether `value` is a {@link SandboxError}, optionally with a given `sandboxCode`. */
export function isSandboxError(value: unknown, sandboxCode?: string): value is SandboxError {
  const matches =
    value instanceof SandboxError ||
    (value instanceof Error &&
      value.name === 'FxmError' &&
      typeof (value as { sandboxCode?: unknown }).sandboxCode === 'string')
  return (
    matches && (sandboxCode === undefined || (value as SandboxError).sandboxCode === sandboxCode)
  )
}
