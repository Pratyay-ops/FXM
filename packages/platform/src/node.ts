/**
 * The transport for Node: tests, scripts and the live smoke tests (`FXM_LIVE=1`). Node has no
 * CORS, so every host in the table is reached directly, like on a native app, but with the same
 * allow-list, InnerTube request shape, redirect checks and request budget as everywhere else.
 *
 * @module
 */

import {
  createTransport,
  type RequestSender,
  type RouteKind,
  type Router,
  type Transport,
  type TransportOptions,
  transportOptions,
  withBrowserAgent,
} from './transport'

/** Options for {@link createNodeTransport}. */
export interface NodeTransportOptions extends TransportOptions {
  /**
   * The `fetch` to send with, e.g. a fake in tests. Default: Node's global `fetch`. It gets
   * `redirect: 'manual'` and must return redirect responses with their `Location` header, as
   * Node's own does: the transport follows redirects itself.
   */
  fetch?: typeof fetch
  /**
   * A browser `User-Agent` for YouTube and Spotify requests that carry none, as the native apps
   * send. Node's own (`node`) is sent otherwise.
   */
  userAgent?: string
}

/** Creates the Node transport. */
export function createNodeTransport(options: NodeTransportOptions): Transport {
  const nodeFetch = options.fetch ?? globalThis.fetch.bind(globalThis)
  const { userAgent } = options
  const send =
    (kind: RouteKind): RequestSender =>
    (request) =>
      nodeFetch(request.url, {
        ...request.init,
        headers: withBrowserAgent(request.init.headers, kind, userAgent),
        redirect: 'manual',
      })
  const router: Router = {
    innerTube: (target) => send(target.kind),
    other: (target) => send(target.kind),
  }
  return createTransport(router, { ...transportOptions(options), redirects: 'manual' })
}
