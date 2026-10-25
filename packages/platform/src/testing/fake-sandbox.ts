/**
 * A fake {@link SandboxTransport} for tests. It behaves like the opaque-origin documents of
 * stage 1.10 from the outside: it refuses requests that are not CORS-simple InnerTube calls to an
 * allowed path, as InnerTube refuses their preflights, and answers the rest from a handler.
 *
 * @module
 */

import { FxmError } from '@fxm/core'
import { isCorsSimpleRequest } from '../cors'
import { findHostRule } from '../hosts'
import type { SimpleInnerTubeRequest } from '../innertube'
import type { SandboxTransport, SelfTestResult, UserHostInit } from '../lite'

/** The InnerTube paths stage 1.10's sandbox allows. */
export const SANDBOX_INNERTUBE_PATHS = [
  '/youtubei/v1/search',
  '/youtubei/v1/next',
  '/youtubei/v1/browse',
  '/youtubei/v1/player',
  '/youtubei/v1/music/get_search_suggestions',
] as const

/** Options for {@link createFakeSandbox}. */
export interface FakeSandboxOptions {
  /**
   * What the self-test answers, or a function deciding it (it gets the self-test's options, so
   * it can watch the signal). Default `pass`.
   */
  selfTest?:
    | SelfTestResult
    | ((options?: { signal?: AbortSignal }) => SelfTestResult | Promise<SelfTestResult>)
  /** Answers InnerTube calls. Default: 200 with `{}`. */
  respond?: (request: SimpleInnerTubeRequest) => Response | Promise<Response>
  /** Answers user-host requests. Without it, the fake has no `userHost` method. */
  userHost?: (url: string, init: UserHostInit) => Response | Promise<Response>
  /** The InnerTube paths it accepts. Default {@link SANDBOX_INNERTUBE_PATHS}. */
  paths?: readonly string[]
}

/** A fake sandbox that records what it was asked. */
export interface FakeSandbox extends SandboxTransport {
  /** The InnerTube calls it accepted, in order. */
  readonly requests: readonly SimpleInnerTubeRequest[]
  /** The user-host requests it served, in order. */
  readonly userHostRequests: readonly { url: string; init: UserHostInit }[]
  /** How often the self-test ran. */
  readonly selfTests: number
}

/** Creates a fake sandbox. */
export function createFakeSandbox(options: FakeSandboxOptions = {}): FakeSandbox {
  const requests: SimpleInnerTubeRequest[] = []
  const userHostRequests: { url: string; init: UserHostInit }[] = []
  const paths = options.paths ?? SANDBOX_INNERTUBE_PATHS
  let selfTests = 0

  const sandbox: FakeSandbox = {
    get requests() {
      return requests
    },
    get userHostRequests() {
      return userHostRequests
    },
    get selfTests() {
      return selfTests
    },
    async selfTest(testOptions) {
      selfTests += 1
      const { selfTest = 'pass' } = options
      return typeof selfTest === 'function' ? selfTest(testOptions) : selfTest
    },
    async innerTube(request) {
      const url = new URL(request.url)
      const { init } = request
      const allowed =
        findHostRule(url)?.hostClass === 'innertube' &&
        paths.includes(url.pathname) &&
        init.method === 'POST' &&
        init.credentials === 'omit' &&
        typeof init.body === 'string' &&
        isCorsSimpleRequest(init.method, Object.entries(init.headers))
      if (!allowed) {
        throw new FxmError('Unsupported', `The sandbox refuses this request: ${url.pathname}`)
      }
      requests.push(request)
      return options.respond?.(request) ?? Response.json({})
    },
  }
  const { userHost } = options
  if (userHost !== undefined) {
    sandbox.userHost = async (url, init) => {
      userHostRequests.push({ url, init })
      return userHost(url, init)
    }
  }
  return sandbox
}
