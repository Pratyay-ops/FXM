/**
 * The experimental Lite tier: YouTube without an install. InnerTube answers CORS-simple POSTs
 * from an opaque origin with `Access-Control-Allow-Origin: null` (measured 2026-10-25, not
 * documented by Google), so the web app can send them from a sandboxed document. This module
 * holds the {@link SandboxTransport} contract, which stage 1.10 implements with
 * `/sandbox/innertube.html` and `/sandbox/userhost.html`, and the gate that lets the transports
 * use it only after a self-test passed and while no kill switch is set.
 *
 * @module
 */

import { FxmError, isFxmError } from '@fxm/core'
import type { RequestBudget } from './budget'
import { type Clock, systemClock } from './clock'
import type { SimpleInnerTubeRequest } from './innertube'

/** A GET-only request to a host the user added in Settings, such as an Invidious instance. */
export interface UserHostInit {
  /** `GET`, or `HEAD`. */
  readonly method: 'GET' | 'HEAD'
  /** Cancels the request. */
  readonly signal?: AbortSignal
}

/** Every {@link SelfTestResult}. */
export const SELF_TEST_RESULTS = ['pass', 'refused', 'unreachable'] as const

/**
 * What a sandbox self-test found:
 *
 * - `pass`: InnerTube answered the sandbox's request with a usable response
 * - `refused`: InnerTube demonstrably refused it: a readable error status (such as 403), an
 *   unusable body, or a request that failed while the network otherwise works (in a browser a
 *   CORS refusal looks like a network error, so check that another request, e.g. to the app's
 *   own origin, gets through). A definite answer, remembered for the session
 * - `unreachable`: nothing that says anything about the sandbox: offline, a timeout, a sandbox
 *   document that did not load. Tried again later
 */
export type SelfTestResult = (typeof SELF_TEST_RESULTS)[number]

/**
 * Requests sent from an opaque-origin document, so YouTube sees no FXM origin and FXM Connect's
 * rules, scoped to the FXM origin, never apply. Implemented by stage 1.10; tests use
 * `createFakeSandbox` from `@fxm/platform/testing`.
 */
export interface SandboxTransport {
  /**
   * Sends one real InnerTube request through the sandbox and says what came back (see
   * {@link SelfTestResult}). A rejection counts as `unreachable`. It must stop when `signal`
   * aborts; the gate stops waiting after {@link LITE_DEFAULTS}`.selfTestTimeoutMs` anyway and
   * counts that as `unreachable`.
   */
  selfTest(options?: { signal?: AbortSignal }): Promise<SelfTestResult>
  /**
   * Sends an InnerTube request in the CORS-simple shape (from `toSimpleInnerTubeRequest`) and
   * resolves with InnerTube's response, whatever its status: the transport reads HTTP 429 and
   * `LOGIN_REQUIRED` from it. Rejects with a `Network` `FxmError` when no response arrives (and
   * with the signal's reason when `request.init.signal` aborts). Requests to other hosts or
   * paths, or in another shape, reject with an `Unsupported` `FxmError` before anything is sent.
   */
  innerTube(request: SimpleInnerTubeRequest): Promise<Response>
  /**
   * Fetches from a host the user added in Settings, GET only, without credentials or custom
   * headers (`userhost.html`). It never follows a redirect to another host, and resolves with
   * any HTTP status like `innerTube`. Absent until stage 1.10 implements it.
   */
  userHost?(url: string, init: UserHostInit): Promise<Response>
}

/** Remote switches that turn experimental paths off without a release. */
export interface KillSwitches {
  /** Turns the Lite tier off: InnerTube then needs FXM Connect on the web. */
  readonly lite?: boolean
}

/** Kill switches that say when they change, e.g. backed by the signed remote config (1.13). */
export interface KillSwitchSource {
  /** The current switches. */
  get(): KillSwitches
  /** Calls `listener` whenever the switches change. Returns a function that removes it. */
  subscribe(listener: () => void): () => void
}

/** A {@link KillSwitchSource} the app sets, e.g. whenever a new remote config arrives. */
export interface KillSwitchStore extends KillSwitchSource {
  /** Replaces the switches and tells the listeners. */
  set(switches: KillSwitches): void
}

/** Creates a {@link KillSwitchStore}, by default with every switch off. */
export function createKillSwitchStore(initial: KillSwitches = {}): KillSwitchStore {
  let switches = { ...initial }
  const listeners = new Set<() => void>()
  return {
    get: () => switches,
    set(next) {
      switches = { ...next }
      for (const listener of [...listeners]) {
        try {
          listener()
        } catch {
          // A failing listener must not stop the others.
        }
      }
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

/** The defaults of {@link LiteTierOptions}. */
export const LITE_DEFAULTS = {
  /** The gate waits at most 10 s for a self-test. */
  selfTestTimeoutMs: 10_000,
  /** An `unreachable` self-test is tried again after 15 s, then twice as long each time... */
  retryMs: 15_000,
  /** ...up to 5 minutes between attempts... */
  maxRetryMs: 5 * 60_000,
  /** ...for 8 attempts; after that only `online` events and explicit checks try again. */
  retries: 8,
} as const

/**
 * Where the Lite tier stands:
 *
 * - `unchecked`: the self-test has not run yet
 * - `checking`: it is running
 * - `passed`: it passed; the transports use the sandbox
 * - `refused`: InnerTube refused the sandbox; remembered for the session
 * - `unreachable`: the last attempt got no answer; it is tried again later
 * - `killed`: the remote kill switch is set, whatever the self-test said
 */
export type LiteState = 'unchecked' | 'checking' | 'passed' | 'refused' | 'unreachable' | 'killed'

/** The parts of `window` the Lite tier listens to: the browser coming back online. */
export interface OnlineEvents {
  /** Listens for `online`. */
  addEventListener(type: 'online', listener: () => void): void
  /** Stops listening. */
  removeEventListener(type: 'online', listener: () => void): void
}

/** Options for {@link createLiteTier}. */
export interface LiteTierOptions {
  /** The sandbox documents. */
  sandbox: SandboxTransport
  /**
   * The remote kill switches: a function read whenever they matter, or a
   * {@link KillSwitchSource}, whose changes reach the tier's subscribers (and so the
   * capabilities) at once. With a function, call `capabilities.refresh()` after a change.
   */
  killSwitches?: (() => KillSwitches) | KillSwitchSource
  /** The request budget the self-test's InnerTube call draws from, at `interactive` priority. */
  budget?: RequestBudget
  /** The clock, for tests. */
  clock?: Clock
  /** How long to wait for a self-test. Default {@link LITE_DEFAULTS}. */
  selfTestTimeoutMs?: number
  /** The first delay before an `unreachable` self-test is tried again. */
  retryMs?: number
  /** The longest delay between attempts. */
  maxRetryMs?: number
  /** How many automatic attempts follow an `unreachable` one. */
  retries?: number
  /** Where `online` events come from, usually the window: an `unreachable` test runs again. */
  onlineEvents?: OnlineEvents
}

/** Options for {@link LiteTier.check}. */
export interface LiteCheckOptions {
  /** Runs the self-test again even if it ran before, e.g. from Settings → Diagnostics. */
  force?: boolean
  /** Stops waiting for the self-test; the check then rejects with the signal's reason. */
  signal?: AbortSignal
}

/** The Lite tier's gate: whether the transports may send InnerTube calls through the sandbox. */
export interface LiteTier {
  /** The sandbox documents. */
  readonly sandbox: SandboxTransport
  /** Whether the self-test passed and the kill switch is off, right now. */
  readonly ready: boolean
  /** Where the tier stands, e.g. for Settings → Diagnostics. */
  readonly state: LiteState
  /**
   * Says whether Lite is ready, running the self-test first when it has to: when it never ran,
   * or the last attempt was `unreachable` and its retry delay has passed. A `passed` or
   * `refused` result is kept for the session unless `force` is set. Concurrent calls share one
   * run, which goes on in the background when a caller's signal aborts.
   */
  check(options?: LiteCheckOptions): Promise<boolean>
  /**
   * Calls `listener` with the new state whenever it changes: a self-test started or ended, or a
   * {@link KillSwitchSource} changed. Returns a function that removes the listener.
   */
  subscribe(listener: (state: LiteState) => void): () => void
  /** Stops retrying and listening, and ends a running self-test. Lite is no longer ready. */
  dispose(): void
}

function isSelfTestResult(value: unknown): value is SelfTestResult {
  return (SELF_TEST_RESULTS as readonly unknown[]).includes(value)
}

/** Waits for `promise`, or rejects with the signal's reason as soon as it aborts. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return promise
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
}

/**
 * Creates the Lite tier's gate around a sandbox. The self-test runs on demand ({@link
 * LiteTier.check}), at most {@link LITE_DEFAULTS}`.selfTestTimeoutMs` long. Only a definite answer
 * is kept: after an `unreachable` one, the tier tries again on its own with a growing delay, and
 * whenever the browser comes back online, and tells its subscribers when it becomes ready.
 */
export function createLiteTier(options: LiteTierOptions): LiteTier {
  const { sandbox, budget } = options
  const clock = options.clock ?? systemClock
  const selfTestTimeoutMs = options.selfTestTimeoutMs ?? LITE_DEFAULTS.selfTestTimeoutMs
  const retryMs = options.retryMs ?? LITE_DEFAULTS.retryMs
  const maxRetryMs = options.maxRetryMs ?? LITE_DEFAULTS.maxRetryMs
  const retries = options.retries ?? LITE_DEFAULTS.retries
  const switches = options.killSwitches
  const readSwitches: () => KillSwitches =
    typeof switches === 'function'
      ? switches
      : switches === undefined
        ? () => ({})
        : () => switches.get()
  const killed = () => readSwitches().lite === true

  const listeners = new Set<(state: LiteState) => void>()
  const lifetime = new AbortController()
  // The last result (or none yet), and whether a self-test is running. A forced re-run after a
  // pass keeps the tier ready until it ends.
  let outcome: 'unchecked' | 'passed' | 'refused' | 'unreachable' = 'unchecked'
  let checking = false
  let running: Promise<boolean> | undefined
  let failures = 0
  let retryAt = 0
  let retryTimer: unknown
  let disposed = false

  const currentState = (): LiteState => (killed() ? 'killed' : checking ? 'checking' : outcome)
  let announced = currentState()

  /** Tells the listeners when the state differs from the last one they heard. */
  function announce(): void {
    if (disposed) return
    const state = currentState()
    if (state === announced) return
    announced = state
    for (const listener of [...listeners]) {
      try {
        listener(state)
      } catch {
        // A failing listener must not stop the others.
      }
    }
  }

  function cancelRetry(): void {
    if (retryTimer === undefined) return
    clock.clearTimeout(retryTimer)
    retryTimer = undefined
  }

  /** Runs the self-test once; concurrent callers share the run. */
  function start(): Promise<boolean> {
    running ??= run().finally(() => {
      running = undefined
    })
    return running
  }

  /** Sends the self-test, bounded by the timeout; anything but a definite answer is unreachable. */
  async function selfTest(): Promise<SelfTestResult> {
    if (lifetime.signal.aborted) return 'unreachable'
    const controller = new AbortController()
    const stop = () => controller.abort(lifetime.signal.reason)
    lifetime.signal.addEventListener('abort', stop, { once: true })
    const stopped = new Promise<SelfTestResult>((resolve) => {
      controller.signal.addEventListener('abort', () => resolve('unreachable'), { once: true })
    })
    const timer = clock.setTimeout(() => {
      controller.abort(
        new FxmError('Network', `The Lite self-test did not finish in ${selfTestTimeoutMs} ms`),
      )
    }, selfTestTimeoutMs)
    try {
      const result = await Promise.race([sandbox.selfTest({ signal: controller.signal }), stopped])
      return isSelfTestResult(result) ? result : 'unreachable'
    } catch {
      return 'unreachable'
    } finally {
      clock.clearTimeout(timer)
      lifetime.signal.removeEventListener('abort', stop)
    }
  }

  async function run(): Promise<boolean> {
    if (disposed || killed()) {
      announce()
      return false
    }
    cancelRetry()
    checking = true
    announce()
    try {
      await budget?.acquire('interactive', { signal: lifetime.signal })
    } catch (error) {
      if (disposed) return false
      // No slot right now: try again once one frees up.
      return settle('unreachable', isFxmError(error) ? error.retryAfterMs : undefined)
    }
    return settle(await selfTest())
  }

  /** Records a result; an `unreachable` one schedules the next attempt. */
  function settle(result: SelfTestResult, retryAfterMs?: number): boolean {
    checking = false
    if (disposed) return false
    if (result === 'unreachable') {
      failures += 1
      const delayMs = retryAfterMs ?? Math.min(retryMs * 2 ** (failures - 1), maxRetryMs)
      retryAt = clock.now() + delayMs
      if (failures <= retries) {
        retryTimer = clock.setTimeout(() => {
          retryTimer = undefined
          void start()
        }, delayMs)
      }
    } else {
      failures = 0
      retryAt = 0
    }
    outcome = result === 'pass' ? 'passed' : result
    announce()
    return result === 'pass' && !killed()
  }

  const onOnline = () => {
    if (outcome === 'unreachable') void start()
  }
  options.onlineEvents?.addEventListener('online', onOnline)
  const unsubscribeSwitches =
    typeof switches === 'object' ? switches.subscribe(() => announce()) : undefined

  return {
    sandbox,
    get ready() {
      return !disposed && outcome === 'passed' && !killed()
    },
    get state() {
      return currentState()
    },
    async check(checkOptions = {}) {
      const { force = false, signal } = checkOptions
      signal?.throwIfAborted()
      // Notices a kill switch read through a function that changed since the last look.
      announce()
      if (disposed || killed()) return false
      if (!force) {
        if (outcome === 'passed') return true
        if (outcome === 'refused') return false
        if (outcome === 'unreachable' && clock.now() < retryAt) return false
      }
      return abortable(start(), signal)
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    dispose() {
      if (disposed) return
      disposed = true
      cancelRetry()
      lifetime.abort(new FxmError('Unsupported', 'The Lite tier was disposed'))
      unsubscribeSwitches?.()
      options.onlineEvents?.removeEventListener('online', onOnline)
      listeners.clear()
    },
  }
}
