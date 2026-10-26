/**
 * The plugin host: runs one operation of one plugin in its isolated document and relays its
 * network requests through the broker. It is the host's side of the plugin protocol
 * (`runtime/protocol.ts`): it starts the call, answers `fetch` replies with the broker's
 * responses and `idle` ones with nothing, and stops at the first `done` or `failed`, at its time
 * limit, or at its request limit. Whatever goes wrong, the call is cancelled in the document and
 * the document is given back.
 *
 * @module
 */

import { FXM_ERROR_CODES, type FxmErrorCode, type JsonValue, type ProviderContext } from '@fxm/core'
import { type Clock, isEvaluatorError, systemClock } from '@fxm/platform'
import type { FetchBroker } from './broker'
import { cleanText, PluginError } from './errors'
import type { PluginManifest, PluginOperation } from './manifest'
import { pluginSource } from './runtime/document'
import {
  PROTOCOL_VERSION,
  parseReply,
  type RuntimeFailure,
  type WireResponse,
} from './runtime/protocol'
import type { PluginEvaluator, PluginSandboxes } from './sandboxes'

/** The limits of one plugin's operations. */
export interface RunnerLimits {
  /** One operation, from start to result, in milliseconds. */
  readonly callMs: number
  /** How long the runtime waits for a handler before it answers `idle`, in milliseconds. */
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
   * Runs `operation` with `params` (JSON) for a provider call, whose `ctx.fetch` carries the
   * plugin's requests. Resolves with the handler's result, unchecked: the provider checks it.
   * Rejects with a `PluginError`, or with the reason of `ctx.signal` when the caller cancels.
   */
  run(
    operation: PluginOperation,
    params: readonly JsonValue[],
    ctx: ProviderContext,
  ): Promise<JsonValue>
  /** Stops it: later operations reject with `disabled`. */
  dispose(): void
}

/** How long the host waits for the document to drop a call it gave up on, in milliseconds. */
const CANCEL_TIMEOUT_MS = 2_000

/** The `FxmError` codes a plugin may fail with. A bot check is the platform's to report. */
const PLUGIN_FXM_CODES: readonly FxmErrorCode[] = FXM_ERROR_CODES.filter(
  (code) => code !== 'BotCheck',
)

/** A random call ID: 64 bits, as hexadecimal. */
function callId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(8)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('')
}

/**
 * The evaluator key of a plugin's code, under which its document keeps the compiled code and
 * the runtime its state: the code's checksum, as the evaluator's keys allow (64 characters of
 * letters, digits, `_`, `.`, `:` and `-`). Each plugin has a document of its own, so the code
 * alone tells versions apart.
 */
export function pluginKey(manifest: Pick<PluginManifest, 'sha256'>): string {
  return `plugin:${manifest.sha256.slice(0, 48)}`
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

/** The error for a failure the document reported. */
function failureError(manifest: PluginManifest, failure: RuntimeFailure): PluginError {
  const message = cleanText(failure.message, 300)
  switch (failure.code) {
    case 'load-failed':
      return new PluginError('load-failed', `${manifest.name} could not start: ${message}`)
    case 'not-implemented':
      return new PluginError('not-implemented', `${manifest.name}: ${message}`)
    case 'not-json':
      return new PluginError('bad-result', `${manifest.name} returned something that isn't data`)
    case 'busy':
      return new PluginError('plugin-failed', `${manifest.name} is busy: try again`, {
        code: 'RateLimited',
      })
    case 'unknown-call':
      return new PluginError('plugin-failed', `${manifest.name} was restarted during the call`)
    case 'bad-request':
      return new PluginError('bad-reply', `${manifest.name}'s document refused the call`)
    default: {
      const code = PLUGIN_FXM_CODES.find((candidate) => candidate === failure.fxmCode)
      return new PluginError('plugin-failed', `${manifest.name} failed: ${message}`, {
        ...(code === undefined ? {} : { code }),
        ...(failure.retryAfterMs === undefined ? {} : { retryAfterMs: failure.retryAfterMs }),
      })
    }
  }
}

/** The error for an evaluator failure. */
function evaluatorFailure(manifest: PluginManifest, error: unknown): unknown {
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
    case 'closed':
      return new PluginError('unavailable', 'The plugin sandbox could not be started', {
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
  const source = pluginSource(options.code, pluginKey(manifest))
  const key = pluginKey(manifest)
  const gate = semaphore(limits.concurrency)
  let disposed = false

  async function drive(
    evaluator: PluginEvaluator,
    operation: PluginOperation,
    params: readonly JsonValue[],
    ctx: ProviderContext,
  ): Promise<JsonValue> {
    const { signal } = ctx
    const call = callId()
    const deadline = clock.now() + limits.callMs
    const evaluate = (input: JsonValue) =>
      evaluator.evaluate(source, input, {
        key,
        timeoutMs: limits.evaluateMs,
        ...(signal === undefined ? {} : { signal }),
      })
    const context: Record<string, string> = { mode: ctx.mode, platform: ctx.platform }
    if (ctx.locale !== undefined) context.locale = ctx.locale
    if (ctx.region !== undefined) context.region = ctx.region
    let finished = false
    let requests = 0
    try {
      let raw = await evaluate({
        fxmPlugin: PROTOCOL_VERSION,
        op: 'call',
        call,
        method: operation,
        params: [...params],
        context,
        stepMs: limits.stepMs,
      })
      for (;;) {
        const reply = parseReply(raw)
        if (reply === undefined) {
          throw new PluginError('bad-reply', `${manifest.name}'s document answered wrongly`)
        }
        let responses: WireResponse[] = []
        if (reply.state === 'done') {
          finished = true
          return reply.value
        }
        if (reply.state === 'failed') {
          finished = true
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
          responses = await Promise.all(reply.requests.map((request) => broker.fetch(request, ctx)))
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
        // Best effort, before the document is given back: the document drops the call, and the
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
      throw evaluatorFailure(manifest, error)
    }
  }

  return {
    manifest,
    async run(operation, params, ctx) {
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
          return await drive(lease.evaluator, operation, params, ctx)
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
