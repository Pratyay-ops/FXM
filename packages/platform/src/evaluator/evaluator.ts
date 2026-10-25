/**
 * The host's side of the isolated evaluator: one {@link Evaluator} interface on every platform,
 * over a platform-specific {@link EvaluatorPort} that carries the messages of `protocol.ts` to
 * the document and back:
 *
 * | Platform | Port | Document |
 * |---|---|---|
 * | Web | `createSandboxEvaluator` (`web.ts`) | `/sandbox/eval.html` in a `sandbox="allow-scripts"` iframe |
 * | Desktop | `createTauriEvaluator` (`tauri.ts`) | `fxm-eval://localhost/eval.html` in a hidden webview |
 * | Android | `createCapacitorEvaluator` (`capacitor.ts`) | `eval.html` in a separate WebView, with `https://www.youtube.com/` as its base URL |
 * | Tests | `createInProcessEvaluator` (`@fxm/platform/testing`) | none: the runtime in the test's own realm |
 *
 * @module
 */

import { FxmError, type FxmErrorCode, type JsonObject, type JsonValue } from '@fxm/core'
import { type Clock, systemClock } from '../clock'
import {
  EVALUATOR_CHANNEL,
  EVALUATOR_PROTOCOL_VERSION,
  type EvaluatorErrorCode,
  type EvaluatorMethod,
  type EvaluatorParams,
  type EvaluatorRequest,
  parseEvaluatorHello,
  parseEvaluatorResponse,
} from './protocol'

/** Where an evaluator's document runs. */
export type EvaluatorKind = 'web' | 'desktop' | 'android' | 'in-process'

/** What a ready evaluator reported about itself. */
export interface EvaluatorInfo {
  /** Where its document runs. */
  readonly kind: EvaluatorKind
  /** Its protocol version. */
  readonly version: number
  /**
   * The origin of its document's URL (see `EvaluatorHello.origin`): what scripts that look at
   * their location, such as BotGuard, see.
   */
  readonly origin: string
}

/** Options for one call. */
export interface EvaluatorCallOptions {
  /** Cancels the call; it then rejects with the signal's reason. */
  readonly signal?: AbortSignal
  /** How long the call may take, in milliseconds. Default {@link EVALUATOR_TIMEOUT_MS}. */
  readonly timeoutMs?: number
}

/** Options for {@link Evaluator.evaluate}. */
export interface EvaluateOptions extends EvaluatorCallOptions {
  /**
   * Keeps the compiled script in the document under this name, so that later calls with the same
   * key send only their arguments: for a large script that runs often, such as a player script.
   * Calls with one key must pass the same `source`.
   */
  readonly key?: string
}

/** A BotGuard challenge for {@link Evaluator.botguardSnapshot}, as the host fetched it. */
export interface BotGuardChallenge {
  /** BotGuard's interpreter script. */
  readonly interpreter: string
  /** The challenge's program. */
  readonly program: string
  /** The name of the global the interpreter defines. */
  readonly globalName: string
  /** What BotGuard reads as `yt.config_`, for a challenge from a YouTube page. */
  readonly pageConfig?: JsonObject
}

/**
 * The isolated evaluator. Its document has no access to FXM's pages, storage or network; it only
 * runs what it is given and answers with JSON.
 */
export interface Evaluator {
  /** Where its document runs. */
  readonly kind: EvaluatorKind
  /** Starts the document if it is not running yet, and resolves with what it reported. */
  ready(options?: EvaluatorCallOptions): Promise<EvaluatorInfo>
  /**
   * Runs `source` as the body of a function of `args` and resolves with its result, which must
   * be JSON (a promise is awaited; `undefined` becomes `null`).
   *
   * @throws EvaluatorError `Parse` when the script fails or returns something else than JSON.
   */
  evaluate(source: string, args?: JsonValue, options?: EvaluateOptions): Promise<JsonValue>
  /**
   * Loads a BotGuard challenge and resolves with BotGuard's snapshot, which the host exchanges
   * for an integrity token at Google's `GenerateIT` endpoint. It replaces any earlier session.
   */
  botguardSnapshot(challenge: BotGuardChallenge, options?: EvaluatorCallOptions): Promise<string>
  /**
   * Mints one web PO token per content binding (a video ID, say) with `integrityToken` and the
   * session of the last snapshot, as web-safe base64.
   */
  mintWebPoTokens(
    integrityToken: string,
    contentBindings: readonly string[],
    options?: EvaluatorCallOptions,
  ): Promise<string[]>
  /** Stops the document. Calls after this reject with `Unsupported`. */
  dispose(): void
}

/**
 * Carries messages between the host and one document. Ports only move messages: the evaluator
 * checks every hello and response, matches ids and applies timeouts.
 */
export interface EvaluatorPort {
  /** Starts the document and resolves with its hello, as it arrived. */
  open(signal?: AbortSignal): Promise<unknown>
  /** Delivers `request` and resolves with the response that carries its id, as it arrived. */
  send(request: EvaluatorRequest, signal?: AbortSignal): Promise<unknown>
  /** Stops the document and drops what is pending. */
  close(): void
}

/** How long a call may take by default, in milliseconds: BotGuard's snapshot can take seconds. */
export const EVALUATOR_TIMEOUT_MS = 20_000

/** How long starting the document may take, in milliseconds. */
export const EVALUATOR_OPEN_TIMEOUT_MS = 15_000

/** Why an evaluator call failed, beyond the document's own {@link EvaluatorErrorCode}s. */
export type EvaluatorFailure = EvaluatorErrorCode | 'unavailable' | 'closed'

/** The `FxmError` code of each failure. */
const FXM_CODES: Readonly<Record<EvaluatorFailure, FxmErrorCode>> = {
  'bad-request': 'Parse',
  'unknown-key': 'Parse',
  'script-error': 'Parse',
  'not-json': 'Parse',
  timeout: 'Network',
  'botguard-unavailable': 'Parse',
  'botguard-failed': 'Parse',
  'no-botguard-session': 'Parse',
  unavailable: 'Unsupported',
  closed: 'Unsupported',
}

/**
 * An evaluator failure: an `FxmError` (`Unsupported` when the document cannot run, `Network`
 * for a timeout, `Parse` for everything the document reported) that keeps the precise reason as
 * `evaluatorCode`.
 */
export class EvaluatorError extends FxmError {
  /** Why the call failed. */
  readonly evaluatorCode: EvaluatorFailure

  constructor(evaluatorCode: EvaluatorFailure, message: string, options: { cause?: unknown } = {}) {
    super(FXM_CODES[evaluatorCode], message, options)
    this.evaluatorCode = evaluatorCode
  }
}

/** Whether `error` is an {@link EvaluatorError}, optionally with one `evaluatorCode`. */
export function isEvaluatorError(
  error: unknown,
  evaluatorCode?: EvaluatorFailure,
): error is EvaluatorError {
  return (
    error instanceof EvaluatorError &&
    (evaluatorCode === undefined || error.evaluatorCode === evaluatorCode)
  )
}

/** Options for {@link createEvaluator}. */
export interface CreateEvaluatorOptions {
  /** How long a call may take by default. Default {@link EVALUATOR_TIMEOUT_MS}. */
  timeoutMs?: number
  /** How long opening may take. Default {@link EVALUATOR_OPEN_TIMEOUT_MS}. */
  openTimeoutMs?: number
  /** The clock for the timeouts, for tests. */
  clock?: Clock
}

/** Rejects when `signal` aborts or `timeoutMs` passes, whichever comes first. */
function guarded<T>(
  work: Promise<T>,
  timeoutMs: number,
  clock: Clock,
  what: string,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (signal?.aborted) return Promise.reject(signal.reason)
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => finish(() => reject(signal?.reason))
    const timer = clock.setTimeout(
      () =>
        finish(() =>
          reject(new EvaluatorError('timeout', `The evaluator did not answer ${what} in time`)),
        ),
      timeoutMs,
    )
    let done = false
    function finish(settle: () => void) {
      if (done) return
      done = true
      clock.clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      settle()
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    work.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    )
  })
}

/**
 * Builds an {@link Evaluator} on a port. The document starts on the first call; if it fails to
 * start, the next call tries again.
 */
export function createEvaluator(
  kind: EvaluatorKind,
  port: EvaluatorPort,
  options: CreateEvaluatorOptions = {},
): Evaluator {
  const clock = options.clock ?? systemClock
  const timeoutMs = options.timeoutMs ?? EVALUATOR_TIMEOUT_MS
  const openTimeoutMs = options.openTimeoutMs ?? EVALUATOR_OPEN_TIMEOUT_MS
  let opening: Promise<EvaluatorInfo> | undefined
  let disposed = false
  let nextId = 1
  /** Keys defined in the running document. */
  let definedKeys = new Set<string>()

  function closed(): EvaluatorError {
    return new EvaluatorError('closed', 'The evaluator was stopped')
  }

  async function open(signal: AbortSignal | undefined): Promise<EvaluatorInfo> {
    let raw: unknown
    try {
      raw = await guarded(port.open(signal), openTimeoutMs, clock, 'its start', signal)
    } catch (error) {
      if (signal?.aborted) throw error
      throw isEvaluatorError(error) && error.evaluatorCode !== 'timeout'
        ? error
        : new EvaluatorError('unavailable', 'The evaluator document did not start', {
            cause: error,
          })
    }
    const hello = parseEvaluatorHello(raw)
    if (hello === undefined) {
      throw new EvaluatorError('unavailable', 'The evaluator document announced itself wrongly')
    }
    if (hello.version !== EVALUATOR_PROTOCOL_VERSION) {
      throw new EvaluatorError(
        'unavailable',
        `The evaluator document speaks version ${hello.version}, not ${EVALUATOR_PROTOCOL_VERSION}`,
      )
    }
    return { kind, version: hello.version, origin: hello.origin }
  }

  function ready(callOptions: EvaluatorCallOptions = {}): Promise<EvaluatorInfo> {
    if (disposed) return Promise.reject(closed())
    if (opening === undefined) {
      definedKeys = new Set()
      const attempt = open(callOptions.signal)
      opening = attempt
      attempt.catch(() => {
        if (opening === attempt) opening = undefined
      })
    }
    return opening
  }

  async function call<M extends EvaluatorMethod>(
    method: M,
    params: EvaluatorParams[M],
    callOptions: EvaluatorCallOptions,
  ): Promise<JsonValue> {
    await ready(callOptions)
    if (disposed) throw closed()
    const id = nextId
    nextId += 1
    const request = { channel: EVALUATOR_CHANNEL, id, method, params } as EvaluatorRequest
    const raw = await guarded(
      port.send(request, callOptions.signal),
      callOptions.timeoutMs ?? timeoutMs,
      clock,
      method,
      callOptions.signal,
    )
    const response = parseEvaluatorResponse(raw)
    if (response === undefined || response.id !== id) {
      throw new EvaluatorError('bad-request', `The evaluator answered ${method} wrongly`)
    }
    if (!response.ok) {
      throw new EvaluatorError(
        response.error.code,
        `The evaluator could not ${method}: ${response.error.message}`,
      )
    }
    return response.result
  }

  async function evaluate(
    source: string,
    args: JsonValue = null,
    evaluateOptions: EvaluateOptions = {},
  ): Promise<JsonValue> {
    const { key } = evaluateOptions
    if (key === undefined) return call('evaluate', { source, args }, evaluateOptions)
    const define = async () => {
      await call('define', { key, source }, evaluateOptions)
      definedKeys.add(key)
    }
    if (!definedKeys.has(key)) await define()
    try {
      return await call('invoke', { key, args }, evaluateOptions)
    } catch (error) {
      if (!isEvaluatorError(error, 'unknown-key')) throw error
      // The document forgot it, or restarted: define it again, once.
      await define()
      return call('invoke', { key, args }, evaluateOptions)
    }
  }

  return {
    kind,
    ready,
    evaluate,
    async botguardSnapshot(challenge, callOptions = {}) {
      const result = await call(
        'botguard.snapshot',
        {
          interpreter: challenge.interpreter,
          program: challenge.program,
          globalName: challenge.globalName,
          ...(challenge.pageConfig === undefined ? {} : { pageConfig: challenge.pageConfig }),
          timeoutMs: Math.max(1_000, (callOptions.timeoutMs ?? timeoutMs) - 1_000),
        },
        callOptions,
      )
      if (typeof result !== 'string') {
        throw new EvaluatorError('bad-request', 'The evaluator answered no BotGuard snapshot')
      }
      return result
    },
    async mintWebPoTokens(integrityToken, contentBindings, callOptions = {}) {
      const result = await call(
        'botguard.mint',
        { integrityToken, contentBindings: [...contentBindings] },
        callOptions,
      )
      if (
        !Array.isArray(result) ||
        result.length !== contentBindings.length ||
        !result.every((token) => typeof token === 'string' && token !== '')
      ) {
        throw new EvaluatorError('bad-request', 'The evaluator answered no PO tokens')
      }
      return result as string[]
    },
    dispose() {
      if (disposed) return
      disposed = true
      opening = undefined
      port.close()
    },
  }
}
