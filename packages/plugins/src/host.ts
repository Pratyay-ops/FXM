/**
 * The plugin host: runs one operation of one plugin and relays its network requests through the
 * broker. It is the host's side of the plugin protocol (`runtime/protocol.ts`): it starts the
 * call, answers `fetch` replies with the broker's responses and `idle` ones with nothing, and
 * stops at the first `done` or `failed`, at its time limit, or at its request limit. Whatever goes
 * wrong, the call is cancelled and the document is given back.
 *
 * The plugin's code runs in a worker that the plugin's evaluator document starts
 * (`runtime/document.ts`, `runtime/worker.ts`), never in the document and never in FXM's page.
 *
 * **Errors.** A failed operation rejects with a `PluginError` whose `FxmError` code says what the
 * app should do (see `errors.ts`): a plugin's own failures and broken rules skip the item
 * (`Unavailable`, or the code of {@link PLUGIN_FAIL_CODES} the plugin failed with), slow or
 * unanswered calls are retried (`Network`), and only an evaluator that can't run here, or a route
 * to the plugin's hosts that the platform has closed, is `Unsupported`.
 *
 * @module
 */

import type { JsonValue, ProviderContext } from '@fxm/core'
import { type Clock, isEvaluatorError, type RequestPriority, systemClock } from '@fxm/platform'
import type { FetchBroker } from './broker'
import { cleanText, PLUGIN_FAIL_CODES, PluginError } from './errors'
import type { PluginManifest, PluginOperation } from './manifest'
import { pluginSource } from './runtime/document'
import {
  PROTOCOL_VERSION,
  parseReply,
  REPLY_LIMITS,
  type RuntimeFailure,
  type WireResponse,
} from './runtime/protocol'
import type { PluginEvaluator, PluginSandboxes } from './sandboxes'

/** The limits of one plugin's operations. */
export interface RunnerLimits {
  /** One operation, from start to result, in milliseconds. */
  readonly callMs: number
  /** How long the worker waits for a handler before it answers `idle`, in milliseconds. */
  readonly stepMs: number
  /** One round trip to the evaluator, in milliseconds. Longer than `stepMs`. */
  readonly evaluateMs: number
  /** Network requests in one operation. */
  readonly requests: number
  /** Operations of one plugin at once; the others wait. */
  readonly concurrency: number
}

/** The defaults of {@link RunnerLimits}. */
export const RUNNER_LIMITS: RunnerLimits = {
  callMs: 45_000,
  stepMs: 10_000,
  evaluateMs: 20_000,
  requests: 30,
  concurrency: 4,
}

/** The longest a plugin may ask the player to wait (`fxm.fail('RateLimited', …)`), in ms. */
const MAX_RETRY_AFTER_MS = 60 * 60_000

/** Options for {@link createPluginRunner}. */
export interface PluginRunnerOptions {
  /** The plugin's manifest. */
  readonly manifest: PluginManifest
  /** Its code, already checked against the manifest's checksum. */
  readonly code: string
  /** Where it runs. */
  readonly sandboxes: PluginSandboxes
  /** Its way to the network. */
  readonly broker: FetchBroker
  /** Overrides of {@link RUNNER_LIMITS}. */
  readonly limits?: Partial<RunnerLimits>
  /** The clock, for tests. */
  readonly clock?: Clock
}

/** Runs the operations of one plugin. */
export interface PluginRunner {
  /** The plugin's manifest. */
  readonly manifest: PluginManifest
  /**
   * Runs `operation` with its `input` object (JSON) for a provider call, whose `ctx.fetch` carries
   * the plugin's requests, at `priority` in the plugin's request budget (default `interactive`).
   * Resolves with the handler's result, unchecked: the provider checks it. Rejects with a
   * `PluginError`, or with the reason of `ctx.signal` when the caller cancels.
   */
  run(
    operation: PluginOperation,
    input: JsonValue,
    ctx: ProviderContext,
    priority?: RequestPriority,
  ): Promise<JsonValue>
  /** Stops it: later operations reject with `disabled`. */
  dispose(): void
}

/** How long the host waits for the document to drop a call it gave up on, in milliseconds. */
const CANCEL_TIMEOUT_MS = 2_000

/** Random hexadecimal: `bytes` random bytes. */
function randomHex(bytes: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('')
}

/**
 * The evaluator key of a plugin's runner, under which its document keeps the compiled relay and
 * the relay its worker: the code's checksum and the runner's own `instance` (16 hexadecimal
 * digits), as the evaluator's keys allow (64 characters of letters, digits, `_`, `.`, `:` and
 * `-`). A new version or a new runner (the plugin switched off and on) starts afresh.
 */
export function pluginKey(manifest: Pick<PluginManifest, 'sha256'>, instance: string): string {
  return `plugin:${manifest.sha256.slice(0, 40)}:${instance.slice(0, 16)}`
}

/** A small semaphore: at most `size` holders at once, the others wait in order. */
function semaphore(size: number) {
  let held = 0
  const waiting: { resolve(): void; reject(reason: unknown): void; signal?: AbortSignal }[] = []
  return {
    async acquire(signal: AbortSignal | undefined): Promise<void> {
      signal?.throwIfAborted()
      if (held < size) {
        held += 1
        return
      }
      await new Promise<void>((resolve, reject) => {
        const entry = {
          resolve: () => {
            signal?.removeEventListener('abort', onAbort)
            resolve()
          },
          reject,
          ...(signal === undefined ? {} : { signal }),
        }
        const onAbort = () => {
          const index = waiting.indexOf(entry)
          if (index !== -1) waiting.splice(index, 1)
          reject(signal?.reason)
        }
        signal?.addEventListener('abort', onAbort, { once: true })
        waiting.push(entry)
      })
    },
    release(): void {
      const next = waiting.shift()
      if (next === undefined) held -= 1
      else next.resolve()
    },
  }
}

/** A `retryAfterMs` a plugin gave, kept within an hour. */
function retryAfter(value: number | undefined): { retryAfterMs?: number } {
  return value === undefined ? {} : { retryAfterMs: Math.min(MAX_RETRY_AFTER_MS, value) }
}

/** The error for a failure the worker or the document reported. */
function failureError(manifest: PluginManifest, failure: RuntimeFailure): PluginError {
  const message = cleanText(failure.message, 300)
  switch (failure.code) {
    case 'load-failed':
      return new PluginError('load-failed', `${manifest.name} could not start: ${message}`)
    case 'not-implemented':
      return new PluginError('not-implemented', `${manifest.name}: ${message}`)
    case 'not-json':
      return new PluginError('bad-result', `${manifest.name} returned something that isn't data`)
    case 'too-large':
      return new PluginError('bad-result', `${manifest.name} returned too much: ${message}`)
    case 'busy':
      return new PluginError('plugin-failed', `${manifest.name} is busy: try again`, {
        code: 'RateLimited',
      })
    case 'unknown-call':
      return new PluginError('plugin-failed', `${manifest.name} was restarted during the call`)
    case 'hung':
      return new PluginError('timeout', `${manifest.name} stopped answering, so FXM stopped it`)
    case 'bad-request':
    case 'bad-reply':
      return new PluginError('bad-reply', `${manifest.name} answered outside the plugin protocol`)
    case 'unavailable':
      return new PluginError('unavailable', `Plugins can't run here: ${message}`)
    default: {
      // A plugin may fail as a source does with one item; anything else skips the item.
      const code = PLUGIN_FAIL_CODES.find((candidate) => candidate === failure.fxmCode)
      return new PluginError('plugin-failed', `${manifest.name} failed: ${message}`, {
        code: code ?? 'Unavailable',
        ...retryAfter(failure.retryAfterMs),
      })
    }
  }
}

/** The error for an evaluator failure. */
function evaluatorFailure(manifest: PluginManifest, error: unknown, disposed: boolean): unknown {
  if (!isEvaluatorError(error)) return error
  switch (error.evaluatorCode) {
    case 'script-error':
      return new PluginError(
        'load-failed',
        `${manifest.name}'s code does not run: ${cleanText(error.message, 300)}`,
        { cause: error },
      )
    case 'timeout':
      return new PluginError('timeout', `${manifest.name} did not answer in time`, {
        cause: error,
      })
    case 'unavailable':
      return new PluginError('unavailable', 'The plugin sandbox could not be started', {
        cause: error,
      })
    case 'closed':
      // Its document was stopped during the call: the plugin was switched off, or the document
      // was replaced. The next call starts a new one.
      return disposed
        ? new PluginError('disabled', `${manifest.name} was switched off`, { cause: error })
        : new PluginError('plugin-failed', `${manifest.name}'s document closed during the call`, {
            cause: error,
          })
    default:
      return new PluginError('bad-reply', `${manifest.name}'s document answered wrongly`, {
        cause: error,
      })
  }
}

/** Creates the runner of one plugin. */
export function createPluginRunner(options: PluginRunnerOptions): PluginRunner {
  const { manifest, sandboxes, broker } = options
  const limits = { ...RUNNER_LIMITS, ...options.limits }
  const clock = options.clock ?? systemClock
  const key = pluginKey(manifest, randomHex(8))
  const source = pluginSource(options.code, key, {
    // The relay answers before the evaluator's own timeout would replace the whole document.
    waitMs: Math.max(limits.stepMs + 1_000, limits.evaluateMs - 2_000),
    maxReplyChars: REPLY_LIMITS.chars,
    idleMs: Math.max(60_000, 2 * limits.callMs),
  })
  const gate = semaphore(limits.concurrency)
  let disposed = false

  async function drive(
    evaluator: PluginEvaluator,
    operation: PluginOperation,
    input: JsonValue,
    ctx: ProviderContext,
    priority: RequestPriority,
  ): Promise<JsonValue> {
    const { signal } = ctx
    const call = randomHex(8)
    const deadline = clock.now() + limits.callMs
    const evaluate = (message: JsonValue) =>
      evaluator.evaluate(source, message, {
        key,
        timeoutMs: limits.evaluateMs,
        ...(signal === undefined ? {} : { signal }),
      })
    const context: Record<string, string> = { mode: ctx.mode, platform: ctx.platform }
    if (ctx.locale !== undefined) context.locale = ctx.locale
    if (ctx.region !== undefined) context.region = ctx.region
    let finished = false
    let requests = 0
    /** A closed route the broker met during this call: the platform's, so trusted. */
    let closedRoute: unknown
    try {
      let raw = await evaluate({
        fxmPlugin: PROTOCOL_VERSION,
        op: 'call',
        call,
        method: operation,
        input,
        context,
        stepMs: limits.stepMs,
      })
      for (;;) {
        const reply = parseReply(raw)
        if (reply === 'too-large') {
          throw new PluginError(
            'bad-result',
            `${manifest.name} returned more than ${REPLY_LIMITS.chars} characters`,
          )
        }
        if (reply === 'malformed') {
          throw new PluginError('bad-reply', `${manifest.name}'s document answered wrongly`)
        }
        let responses: WireResponse[] = []
        if (reply.state === 'done') {
          finished = true
          return reply.value
        }
        if (reply.state === 'failed') {
          finished = true
          if (closedRoute !== undefined) {
            throw new PluginError(
              'unreachable',
              `FXM can't reach ${manifest.name}'s addresses here right now`,
              { cause: closedRoute },
            )
          }
          throw failureError(manifest, reply.error)
        }
        if (reply.state === 'cancelled') {
          finished = true
          throw new PluginError('plugin-failed', `${manifest.name}'s call was cancelled`)
        }
        if (reply.state === 'fetch') {
          requests += reply.requests.length
          if (requests > limits.requests) {
            throw new PluginError(
              'too-many-requests',
              `${manifest.name} made more than ${limits.requests} requests for one operation`,
            )
          }
          const outcomes = await Promise.all(
            reply.requests.map((request) => broker.fetch(request, ctx, priority)),
          )
          responses = outcomes.map((outcome) => outcome.response)
          closedRoute ??= outcomes.find((outcome) => outcome.closedRoute !== undefined)?.closedRoute
        }
        if (clock.now() > deadline) {
          throw new PluginError(
            'timeout',
            `${manifest.name} took longer than ${Math.round(limits.callMs / 1000)} s`,
          )
        }
        raw = await evaluate({
          fxmPlugin: PROTOCOL_VERSION,
          op: 'resume',
          call,
          responses: responses as unknown as JsonValue,
          stepMs: limits.stepMs,
        })
      }
    } catch (error) {
      // A document that hung or is gone was stopped by the evaluator, and with it the call.
      const lost =
        isEvaluatorError(error) &&
        (error.evaluatorCode === 'timeout' ||
          error.evaluatorCode === 'unavailable' ||
          error.evaluatorCode === 'closed')
      if (!finished && !lost) {
        // Best effort, before the document is given back: the worker drops the call, and the
        // handler's pending requests fail.
        await evaluator
          .evaluate(
            source,
            { fxmPlugin: PROTOCOL_VERSION, op: 'cancel', call },
            { key, timeoutMs: CANCEL_TIMEOUT_MS },
          )
          .catch(() => undefined)
      }
      if (signal?.aborted && error === signal.reason) throw error
      throw evaluatorFailure(manifest, error, disposed)
    }
  }

  return {
    manifest,
    async run(operation, input, ctx, priority = 'interactive') {
      if (disposed) throw new PluginError('disabled', `${manifest.name} is switched off`)
      if (!manifest.provides.includes(operation)) {
        throw new PluginError('not-implemented', `${manifest.name} doesn't provide ${operation}`)
      }
      const { signal } = ctx
      await gate.acquire(signal)
      try {
        if (disposed) throw new PluginError('disabled', `${manifest.name} is switched off`)
        const lease = await sandboxes.acquire(manifest.id, signal === undefined ? {} : { signal })
        try {
          return await drive(lease.evaluator, operation, input, ctx, priority)
        } finally {
          lease.release()
        }
      } finally {
        gate.release()
      }
    },
    dispose() {
      disposed = true
    },
  }
}
