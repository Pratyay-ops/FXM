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

import type { RequestBudget } from './budget'
import type { SimpleInnerTubeRequest } from './innertube'

/** A GET-only request to a host the user added in Settings, such as an Invidious instance. */
export interface UserHostInit {
  /** `GET`, or `HEAD`. */
  readonly method: 'GET' | 'HEAD'
  /** Cancels the request. */
  readonly signal?: AbortSignal
}

/**
 * Requests sent from an opaque-origin document, so YouTube sees no FXM origin and FXM Connect's
 * rules, scoped to the FXM origin, never apply. Implemented by stage 1.10; tests use
 * `createFakeSandbox` from `@fxm/platform/testing`.
 */
export interface SandboxTransport {
  /**
   * Sends one real InnerTube request through the sandbox and says whether a usable answer came
   * back. Never rejects for a failed test: it resolves `false`. Called at most once per session
   * unless forced (see {@link LiteTier.check}).
   */
  selfTest(options?: { signal?: AbortSignal }): Promise<boolean>
  /**
   * Sends an InnerTube request in the CORS-simple shape (from `toSimpleInnerTubeRequest`) and
   * returns InnerTube's response. Requests to other hosts or paths, or in another shape, fail.
   */
  innerTube(request: SimpleInnerTubeRequest): Promise<Response>
  /**
   * Fetches from a host the user added in Settings, GET only, without credentials or custom
   * headers (`userhost.html`). Absent until stage 1.10 implements it.
   */
  userHost?(url: string, init: UserHostInit): Promise<Response>
}

/** Remote switches that turn experimental paths off without a release. */
export interface KillSwitches {
  /** Turns the Lite tier off: InnerTube then needs FXM Connect on the web. */
  readonly lite?: boolean
}

/** Options for {@link createLiteTier}. */
export interface LiteTierOptions {
  /** The sandbox documents. */
  sandbox: SandboxTransport
  /** The current kill switches, read on every check, e.g. from the remote config. */
  killSwitches?: () => KillSwitches
  /** The request budget the self-test's InnerTube call draws from. */
  budget?: RequestBudget
}

/** Options for {@link LiteTier.check}. */
export interface LiteCheckOptions {
  /** Runs the self-test again even if it ran before, e.g. from Settings → Diagnostics. */
  force?: boolean
  /** Cancels the self-test. */
  signal?: AbortSignal
}

/** The Lite tier's gate: whether the transports may send InnerTube calls through the sandbox. */
export interface LiteTier {
  /** The sandbox documents. */
  readonly sandbox: SandboxTransport
  /** Whether the self-test passed and the kill switch is off, right now. */
  readonly ready: boolean
  /**
   * Runs the self-test unless it already ran (or the kill switch is on) and says whether Lite is
   * ready. Concurrent calls share one run. When the budget refuses the self-test's call, it
   * answers `false` without remembering a result, so a later check tries again.
   */
  check(options?: LiteCheckOptions): Promise<boolean>
}

/** Creates the Lite tier's gate around a sandbox. */
export function createLiteTier(options: LiteTierOptions): LiteTier {
  const { sandbox, budget } = options
  const killed = () => options.killSwitches?.().lite === true
  let passed: boolean | undefined
  let running: Promise<boolean> | undefined

  async function run(signal: AbortSignal | undefined): Promise<boolean> {
    try {
      await budget?.acquire('interactive', signal === undefined ? {} : { signal })
    } catch (error) {
      if (signal?.aborted) throw error
      return false
    }
    let result: boolean
    try {
      signal?.throwIfAborted()
      result = (await sandbox.selfTest(signal === undefined ? {} : { signal })) === true
    } catch (error) {
      if (signal?.aborted) throw error
      result = false
    }
    passed = result
    return result
  }

  return {
    sandbox,
    get ready() {
      return passed === true && !killed()
    },
    async check(checkOptions = {}) {
      if (killed()) return false
      if (passed !== undefined && checkOptions.force !== true) return passed
      running ??= run(checkOptions.signal).finally(() => {
        running = undefined
      })
      return (await running) && !killed()
    },
  }
}
