/**
 * The transport of the web app in a browser page, for all three tiers:
 *
 * - **Free only:** CORS-friendly hosts, fetched directly.
 * - **Lite:** InnerTube API calls through the sandbox documents (stage 1.10) as well.
 * - **Full (FXM Connect):** InnerTube, YouTube's other pages, googlevideo bytes, Spotify and
 *   Last.fm's station JSON through the page's own `fetch`, which FXM Connect's rules let through.
 *
 * Every request goes out with `credentials: 'omit'` and without `Origin`, `Cookie` or
 * `User-Agent` headers. Browsers would ignore those anyway, except Firefox, which sends a
 * preflight for a script-set `User-Agent`.
 *
 * @module
 */

import { type ConnectFeature, type ConnectStatus, hasConnectFeature } from './connect'
import type { RouteNeed } from './errors'
import type { LiteTier } from './lite'
import {
  createTransport,
  type RequestSender,
  type Router,
  routeClosedError,
  type Target,
  type Transport,
  type TransportOptions,
  transportOptions,
} from './transport'

/** Options for {@link createWebTransport}. */
export interface WebTransportOptions extends TransportOptions {
  /** The page's `fetch`. Default: the global one. */
  fetch?: typeof fetch
  /**
   * FXM Connect, usually the client from `createConnectClient`. The routes it opens follow its
   * current status and features on every request.
   */
  connect?: { readonly status: ConnectStatus | undefined }
  /**
   * The Lite tier, usually from `createLiteTier`. InnerTube uses it only while it is `ready`.
   * User-added hosts go through its sandbox's user-host document.
   */
  lite?: Pick<LiteTier, 'ready' | 'state' | 'sandbox'>
}

/** Which FXM Connect feature opens each route. */
const CONNECT_ROUTES = {
  'youtube-web': 'youtube',
  googlevideo: 'googlevideo',
  spotify: 'spotify',
  'lastfm-web': 'lastfm',
} as const satisfies Partial<Record<Target['kind'], ConnectFeature>>

/**
 * Creates the browser transport. Routing is decided per request, at send time, from FXM
 * Connect's status and the Lite tier's readiness at that moment:
 *
 * | Request | Route |
 * |---|---|
 * | CORS-friendly host | Direct, on every tier |
 * | InnerTube API call | FXM Connect (feature `youtube`), else the Lite sandbox while it is ready |
 * | Other YouTube pages (player JS, `sw.js_data`) | FXM Connect only |
 * | googlevideo bytes | FXM Connect only (`<audio src>` needs no `fetch`) |
 * | Spotify | FXM Connect only. The logged-in token comes from its bridge (`ConnectClient`) |
 * | Last.fm station JSON | FXM Connect only |
 * | A host the user added | The sandbox's user-host document, GET only |
 *
 * A closed route rejects with a `RouteUnavailableError` that says what would open it, and an
 * unknown host with a `TransportError`. An `outdated` FXM Connect opens no routes. The browser
 * follows redirects itself; a response that ended outside the host table is refused.
 */
export function createWebTransport(options: WebTransportOptions): Transport {
  const pageFetch = options.fetch ?? globalThis.fetch.bind(globalThis)
  const { connect, lite } = options
  const direct: RequestSender = (request) => pageFetch(request.url, request.init)
  const has = (feature: ConnectFeature) => hasConnectFeature(connect?.status, feature)
  /** Whether the Lite tier could still open InnerTube: it exists and is not refused or killed. */
  const liteMayOpen = () =>
    lite !== undefined && lite.state !== 'refused' && lite.state !== 'killed'

  const router: Router = {
    innerTube(target) {
      if (has('youtube')) return (request) => pageFetch(request.url, request.init)
      if (lite?.ready === true) return (request) => lite.sandbox.innerTube(request)
      const needs: RouteNeed[] = liteMayOpen()
        ? ['connect', 'lite', 'native']
        : ['connect', 'native']
      throw routeClosedError(target, needs, { connectFeature: 'youtube' })
    },
    other(target) {
      if (target.kind === 'open') return direct
      if (target.kind === 'user') {
        const userHost = lite?.sandbox.userHost?.bind(lite.sandbox)
        if (userHost === undefined) throw routeClosedError(target, ['sandbox'])
        return (request) =>
          userHost(request.url, {
            method: request.init.method === 'HEAD' ? 'HEAD' : 'GET',
            ...(request.init.signal ? { signal: request.init.signal } : {}),
          })
      }
      const feature = target.kind === 'innertube' ? 'youtube' : CONNECT_ROUTES[target.kind]
      if (has(feature)) return direct
      throw routeClosedError(target, ['connect', 'native'], { connectFeature: feature })
    },
  }

  return createTransport(router, {
    ...transportOptions(options),
    redirects: 'browser',
    dropHeaders: ['user-agent'],
  })
}
