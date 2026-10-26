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
  /**
   * The origin its document runs at, known without starting it: the page's origin on the web,
   * `fxm-eval://localhost` on desktop, `https://www.youtube.com` on Android. `ready()` refuses a
   * document that reports another one.
   */
  readonly origin: string
  /**
   * Starts the document if it is not running yet, and resolves with what it reported. The start
   * is shared by every caller: one caller's `signal` stops only that caller's wait.
   */
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
 * checks every hello and response, matches ids, applies timeouts and decides when a document is
 * started and stopped.
 */
export interface EvaluatorPort {
  /**
   * Starts a new document, stopping any earlier one, and resolves with its hello, as it arrived.
   * `signal` aborts when the evaluator gives up on the start: the port then stops what it does
   * for it.
   */
  open(signal?: AbortSignal): Promise<unknown>
  /**
   * Delivers `request` and resolves with the response that carries its id, as it arrived.
   * `signal` aborts when the evaluator stops waiting (a timeout or the caller's cancellation):
   * the port then stops waiting for the answer, e.g. stops reading the mailbox.
   */
  send(request: EvaluatorRequest, signal?: AbortSignal): Promise<unknown>
  /** Stops the document and drops what is pending. */
  close(): void
  /**
   * Whether the document the port started still runs, for ports that can tell: the web port
   * sees when its frame's document was replaced. The evaluator starts a new one before the next
   * call when it doesn't.
   */
  alive?(): boolean
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
 * The failures after which the document is not trusted to answer any more (it hangs, is gone, or
 * can't be reached): the next call starts a new one.
 */
const RESTART_AFTER: ReadonlySet<EvaluatorFailure> = new Set(['timeout', 'closed', 'unavailable'])

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

/** Where the document of an evaluator runs, for {@link createEvaluator}. */
export interface EvaluatorOrigin {
  /** The origin its document runs at (see {@link Evaluator.origin}). */
  origin: string
  /** Other origins its document may report for the same place, e.g. on another OS. */
  alsoAccept?: readonly string[]
}

/** Rejects with the signal's reason when `signal` aborts before `work` settles. */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return work
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

/** Rejects with an `EvaluatorError` `timeout` when `timeoutMs` passes before `work` settles. */
function timed<T>(work: Promise<T>, timeoutMs: number, clock: Clock, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = clock.setTimeout(
      () => reject(new EvaluatorError('timeout', `The evaluator did not answer ${what} in time`)),
      timeoutMs,
    )
    work.then(
      (value) => {
        clock.clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clock.clearTimeout(timer)
        reject(error)
      },
    )
  })
}

/**
 * A controller that also aborts when `signal` does, and the function that unlinks the two once
 * the work is over.
 */
function linked(signal: AbortSignal | undefined): { controller: AbortController; unlink(): void } {
  const controller = new AbortController()
  if (signal === undefined) return { controller, unlink() {} }
  const onAbort = () => controller.abort(signal.reason)
  if (signal.aborted) onAbort()
  else signal.addEventListener('abort', onAbort, { once: true })
  return { controller, unlink: () => signal.removeEventListener('abort', onAbort) }
}

/**
 * A random request id to start from, below 2^52 so that ids stay safe integers: two hosts that
 * talk to one document (a desktop window that outlived a reload of the page) never share ids, so
 * neither can take the other's answer.
 */
function firstRequestId(): number {
  const words = crypto.getRandomValues(new Uint32Array(2))
  return ((words[0] ?? 0) & 0xfffff) * 2 ** 32 + (words[1] ?? 0) + 1
}

/**
 * Builds an {@link Evaluator} on a port. The document starts on the first call, once for every
 * caller. A document that fails to start, or that stops answering (a call timed out, or the
 * document is gone), is stopped, and the next call starts a new one.
 */
export function createEvaluator(
  kind: EvaluatorKind,
  port: EvaluatorPort,
  options: CreateEvaluatorOptions & EvaluatorOrigin,
): Evaluator {
  const clock = options.clock ?? systemClock
  const timeoutMs = options.timeoutMs ?? EVALUATOR_TIMEOUT_MS
  const openTimeoutMs = options.openTimeoutMs ?? EVALUATOR_OPEN_TIMEOUT_MS
  const origins = new Set([options.origin, ...(options.alsoAccept ?? [])])
  let opening: Promise<EvaluatorInfo> | undefined
  /** Aborts the start in progress, if one is. */
  let starting: AbortController | undefined
  let disposed = false
  let nextId = firstRequestId()
  /** Keys defined in the running document. */
  let definedKeys = new Set<string>()

  function closed(): EvaluatorError {
    return new EvaluatorError('closed', 'The evaluator was stopped')
  }

  /** Stops the running document, if `document` is still it: the next call starts a new one. */
  function restart(document: Promise<EvaluatorInfo> | undefined): void {
    if (document === undefined || opening !== document) return
    opening = undefined
    definedKeys = new Set()
    port.close()
  }

  /**
   * Starts a document, for every caller: no caller's signal stops it, only its timeout or
   * `dispose`.
   */
  async function open(): Promise<EvaluatorInfo> {
    const controller = new AbortController()
    starting = controller
    let raw: unknown
    try {
      raw = await untilAborted(
        timed(port.open(controller.signal), openTimeoutMs, clock, 'its start'),
        controller.signal,
      )
    } catch (error) {
      controller.abort(error)
      throw isEvaluatorError(error) && error.evaluatorCode !== 'timeout'
        ? error
        : new EvaluatorError('unavailable', 'The evaluator document did not start', {
            cause: error,
          })
    } finally {
      if (starting === controller) starting = undefined
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
    if (!origins.has(hello.origin)) {
      throw new EvaluatorError(
        'unavailable',
        `The evaluator document runs at ${hello.origin}, not ${options.origin}`,
      )
    }
    return { kind, version: hello.version, origin: hello.origin }
  }

  /** The running document, started if needed. */
  function document(): Promise<EvaluatorInfo> {
    if (opening === undefined) {
      definedKeys = new Set()
      const attempt = open()
      opening = attempt
      // A document that did not start is stopped, so that nothing of it keeps running.
      attempt.catch(() => restart(attempt))
    }
    return opening
  }

  function ready(callOptions: EvaluatorCallOptions = {}): Promise<EvaluatorInfo> {
    if (disposed) return Promise.reject(closed())
    return untilAborted(document(), callOptions.signal)
  }

  /**
   * The running document once it is ready, starting the next one if it stopped meanwhile. (It is
   * wrapped: an async function would resolve a promise it returns.)
   */
  async function running(
    callOptions: EvaluatorCallOptions,
  ): Promise<{ readonly document: Promise<EvaluatorInfo> }> {
    for (;;) {
      if (disposed) throw closed()
      const current = document()
      await untilAborted(current, callOptions.signal)
      if (disposed) throw closed()
      if (opening !== current) continue
      if (port.alive?.() === false) {
        restart(current)
        continue
      }
      return { document: current }
    }
  }

  async function call<M extends EvaluatorMethod>(
    method: M,
    params: EvaluatorParams[M],
    callOptions: EvaluatorCallOptions,
  ): Promise<JsonValue> {
    const { document: current } = await running(callOptions)
    const id = nextId
    nextId = nextId >= Number.MAX_SAFE_INTEGER ? 1 : nextId + 1
    const request = { channel: EVALUATOR_CHANNEL, id, method, params } as EvaluatorRequest
    const { controller, unlink } = linked(callOptions.signal)
    let raw: unknown
    try {
      raw = await untilAborted(
        timed(
          port.send(request, controller.signal),
          callOptions.timeoutMs ?? timeoutMs,
          clock,
          method,
        ),
        callOptions.signal,
      )
    } catch (error) {
      // Whatever the port still does for this request stops here.
      controller.abort(error)
      if (callOptions.signal?.aborted && error === callOptions.signal.reason) throw error
      const failure = isEvaluatorError(error)
        ? error
        : new EvaluatorError('unavailable', `The evaluator could not be reached for ${method}`, {
            cause: error,
          })
      if (RESTART_AFTER.has(failure.evaluatorCode)) restart(current)
      throw failure
    } finally {
      unlink()
    }
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
    origin: options.origin,
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
      starting?.abort(closed())
      port.close()
    },
  }
}
