/**
 * The transport for Node: tests, scripts and the live smoke tests (`FXM_LIVE=1`). Node has no
 * CORS, so every host in the table is reached directly, like on a native app, but with the same
 * allow-list, InnerTube request shape and request budget as everywhere else.
 *
 * @module
 */

import { createRequestBudget, type RequestBudget } from './budget'
import {
  createTransport,
  type RequestSender,
  type RouteKind,
  type Router,
  type Transport,
  withBrowserAgent,
} from './transport'

/** Options for {@link createNodeTransport}. */
export interface NodeTransportOptions {
  /** The `fetch` to send with, e.g. a fake in tests. Default: Node's global `fetch`. */
  fetch?: typeof fetch
  /** The budget InnerTube calls draw from. Default: a new one in memory. */
  budget?: RequestBudget
  /** Extra hosts to allow, as a user would add them in Settings (GET only). */
  userHosts?: () => Iterable<string>
  /**
   * A browser `User-Agent` for YouTube and Spotify requests that carry none, as the native apps
   * send. Node's own (`node`) is sent otherwise.
   */
  userAgent?: string
}

/** Creates the Node transport. */
export function createNodeTransport(options: NodeTransportOptions = {}): Transport {
  const nodeFetch = options.fetch ?? globalThis.fetch.bind(globalThis)
  const budget = options.budget ?? createRequestBudget()
  const { userAgent } = options
  const send =
    (kind: RouteKind): RequestSender =>
    (request) =>
      nodeFetch(request.url, {
        ...request.init,
        headers: withBrowserAgent(request.init.headers, kind, userAgent),
      })
  const router: Router = {
    innerTube: (target) => send(target.kind),
    other: (target) => send(target.kind),
  }
  return createTransport(router, {
    budget,
    ...(options.userHosts === undefined ? {} : { userHosts: options.userHosts }),
  })
}
