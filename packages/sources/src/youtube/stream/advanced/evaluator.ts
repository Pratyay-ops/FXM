/**
 * What the experimental rungs need from the isolated evaluator of `@fxm/platform` (stage 1.11):
 * the subset of its `Evaluator` interface they call, so that the platform's evaluator on each
 * platform (the web's sandboxed `eval.html`, the desktop app's hidden webview, the Android app's
 * evaluator WebView) can be passed as it is, and tests can pass `createInProcessEvaluator()`.
 * This package does not depend on `@fxm/platform`.
 *
 * @module
 */

import type { JsonObject, JsonValue } from '@fxm/core'

/** Options every evaluator call takes. */
export interface StreamEvaluatorCallOptions {
  /** Cancels the call. */
  readonly signal?: AbortSignal
}

/** The isolated evaluator, as the experimental rungs use it. */
export interface StreamEvaluator {
  /**
   * The origin its document runs at, the location scripts such as BotGuard see. The platform's
   * evaluators know it when they are created, so the rungs decide where they can run without
   * starting the document.
   */
  readonly origin: string
  /** Starts the document if needed. */
  ready(options?: StreamEvaluatorCallOptions): Promise<{ readonly origin: string }>
  /** Runs `source` as the body of an async function of `args`; resolves with its JSON result. */
  evaluate(
    source: string,
    args?: JsonValue,
    options?: StreamEvaluatorCallOptions & { readonly key?: string },
  ): Promise<JsonValue>
  /** Loads a BotGuard challenge and resolves with BotGuard's snapshot. */
  botguardSnapshot(
    challenge: {
      readonly interpreter: string
      readonly program: string
      readonly globalName: string
      readonly pageConfig?: JsonObject
    },
    options?: StreamEvaluatorCallOptions,
  ): Promise<string>
  /** Mints one web PO token per content binding with the integrity token of the last snapshot. */
  mintWebPoTokens(
    integrityToken: string,
    contentBindings: readonly string[],
    options?: StreamEvaluatorCallOptions,
  ): Promise<string[]>
}

/**
 * The origin BotGuard's attestation needs to see: measured on 2026-10-26, YouTube's page
 * challenge only earns an integrity token when the document BotGuard runs in is at
 * `https://www.youtube.com` (see `CLEAN-ROOM.md`). Android's evaluator WebView loads its
 * document with that base URL; the web's opaque `eval.html` and the desktop app's `fxm-eval:`
 * document cannot.
 */
export const ATTESTATION_ORIGIN = 'https://www.youtube.com'

/**
 * The `evaluatorCode` of a failure of the platform's evaluator (its `EvaluatorError`), read
 * without depending on `@fxm/platform`.
 */
export function evaluatorCodeOf(error: unknown): string | undefined {
  const code = (error as { evaluatorCode?: unknown } | null | undefined)?.evaluatorCode
  return typeof code === 'string' ? code : undefined
}

/**
 * Whether `error` says the evaluator's document could not start or is gone (`unavailable`,
 * `closed`), as opposed to a failure of what ran in it.
 */
export function isEvaluatorDown(error: unknown): boolean {
  const code = evaluatorCodeOf(error)
  return code === 'unavailable' || code === 'closed'
}
