/**
 * The typed errors of the Lite tier's sandbox documents. Each keeps the document's reason as
 * `sandboxCode` ({@link SandboxErrorCode}) and is one of two kinds, so code that knows only the
 * transports' errors, or only `@fxm/core`'s codes, reads it right:
 *
 * - a {@link SandboxRefusedError}: a request a document refused without sending it, or a
 *   redirect it did not follow. It is a `TransportError` (`Unsupported`), with reason
 *   `bad-request`, or `redirect` for a redirect, like the other transports' refusals
 * - a {@link SandboxFailedError}: a request that failed once sent: `Network` when no complete
 *   response arrived (also a document that did not load or stopped answering), `Parse` for a
 *   response over the size cap
 *
 * @module
 */

import { FxmError, type FxmErrorCode, isFxmError } from '@fxm/core'
import { TransportError, type TransportErrorReason } from '../errors'
import type { SandboxErrorCode } from './document'

/** The codes of {@link SandboxRefusedError}: refused before sending, or a redirect not followed. */
export type SandboxRefusalCode = Extract<
  SandboxErrorCode,
  | 'bad-request'
  | 'forbidden-host'
  | 'forbidden-path'
  | 'forbidden-method'
  | 'forbidden-header'
  | 'preflight'
  | 'request-too-large'
  | 'redirect'
>

/** The codes of {@link SandboxFailedError}. */
export type SandboxFailureCode = Exclude<SandboxErrorCode, SandboxRefusalCode>

/** The `TransportError` reason of each refusal; the type makes it list every one. */
const REASONS: Readonly<Record<SandboxRefusalCode, TransportErrorReason>> = {
  'bad-request': 'bad-request',
  'forbidden-host': 'bad-request',
  'forbidden-path': 'bad-request',
  'forbidden-method': 'bad-request',
  'forbidden-header': 'bad-request',
  preflight: 'bad-request',
  'request-too-large': 'bad-request',
  redirect: 'redirect',
}

/** The `FxmError` code of each failure; the type makes it list every one. */
const FXM_CODES: Readonly<Record<SandboxFailureCode, FxmErrorCode>> = {
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
  'request-too-large': 'The request body is larger than the sandbox allows',
  redirect: 'The host answered with a redirect, which the sandbox does not follow',
  'too-large': 'The response is larger than the sandbox allows',
  timeout: 'The sandbox got no complete response in time',
  network: 'The sandbox request failed',
}

/** Every {@link SandboxErrorCode}. */
export const SANDBOX_ERROR_CODES = Object.freeze([
  ...Object.keys(REASONS),
  ...Object.keys(FXM_CODES),
] as SandboxErrorCode[])

/** Whether `code` is a {@link SandboxErrorCode}. */
export function isSandboxErrorCode(code: unknown): code is SandboxErrorCode {
  return (SANDBOX_ERROR_CODES as readonly unknown[]).includes(code)
}

/** Whether `code` is a {@link SandboxRefusalCode}. */
export function isSandboxRefusalCode(code: unknown): code is SandboxRefusalCode {
  return typeof code === 'string' && Object.hasOwn(REASONS, code)
}

/**
 * A request a sandbox document refused without sending it (the page runs the same check first),
 * or a redirect it did not follow: a `TransportError` with reason `bad-request` or `redirect`.
 */
export class SandboxRefusedError extends TransportError {
  /** The document's reason, e.g. `preflight`. */
  readonly sandboxCode: SandboxRefusalCode

  /**
   * @param sandboxCode The document's reason.
   * @param message Details, for logs. Default: a description of the code.
   * @param options The underlying cause.
   */
  constructor(
    sandboxCode: SandboxRefusalCode,
    message?: string,
    options: { cause?: unknown } = {},
  ) {
    super(REASONS[sandboxCode], message ?? MESSAGES[sandboxCode], options)
    this.sandboxCode = sandboxCode
  }
}

/**
 * A sandbox request that failed once sent: `Network` for no complete response in time, a network
 * failure, a document that did not load or stopped answering, and codes this app does not know;
 * `Parse` for a response over the size cap (`too-large`).
 */
export class SandboxFailedError extends FxmError {
  /** The document's reason, e.g. `timeout`; may be a code this app does not know. */
  readonly sandboxCode: string

  /**
   * @param sandboxCode The document's reason.
   * @param message Details, for logs. Default: a description of the code.
   * @param options The underlying cause.
   */
  constructor(sandboxCode: string, message?: string, options: { cause?: unknown } = {}) {
    const known = Object.hasOwn(FXM_CODES, sandboxCode)
      ? (sandboxCode as SandboxFailureCode)
      : undefined
    super(
      known === undefined ? 'Network' : FXM_CODES[known],
      message ?? (known === undefined ? `The sandbox failed (${sandboxCode})` : MESSAGES[known]),
      'cause' in options ? { cause: options.cause } : {},
    )
    this.sandboxCode = sandboxCode
  }
}

/** An error of the sandbox documents: refused, or failed. */
export type SandboxError = SandboxRefusedError | SandboxFailedError

/**
 * The error for a sandbox code: a {@link SandboxRefusedError} for a refusal, else a
 * {@link SandboxFailedError}.
 */
export function sandboxError(sandboxCode: string, message?: string): SandboxError {
  return isSandboxRefusalCode(sandboxCode)
    ? new SandboxRefusedError(sandboxCode, message)
    : new SandboxFailedError(sandboxCode, message)
}

/**
 * Whether `value` is a {@link SandboxError}, optionally with a given `sandboxCode`. Like
 * `isFxmError`, it also recognizes errors from a second copy of this module.
 */
export function isSandboxError(value: unknown, sandboxCode?: string): value is SandboxError {
  if (!isFxmError(value)) return false
  const found = (value as { sandboxCode?: unknown }).sandboxCode
  return typeof found === 'string' && (sandboxCode === undefined || found === sandboxCode)
}
