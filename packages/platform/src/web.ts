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

import { createRequestBudget, type RequestBudget } from './budget'
import { type ConnectFeature, type ConnectStatus, hasConnectFeature } from './connect'
import type { LiteTier } from './lite'
import { browserStorage, memoryStorage } from './storage'
import {
  createTransport,
  type RequestSender,
  type Router,
  type Target,
  type Transport,
  unreachable,
} from './transport'

/** Options for {@link createWebTransport}. */
export interface WebTransportOptions {
  /** The page's `fetch`. Default: the global one. */
  fetch?: typeof fetch
  /**
   * FXM Connect, usually the client from `createConnectClient`. The routes it opens follow its
   * current status and features on every request.
   */
  connect?: { readonly status: ConnectStatus | undefined }
  /** The Lite tier, usually from `createLiteTier`. InnerTube uses it only while it is `ready`. */
  lite?: Pick<LiteTier, 'ready' | 'sandbox'>
  /**
   * The budget InnerTube calls draw from. Default: one kept in `localStorage`, which every
   * budget on this device that uses the same storage shares.
   */
  budget?: RequestBudget
  /** Hosts the user added in Settings, reached through the sandbox's user-host document. */
  userHosts?: () => Iterable<string>
}

/** Which FXM Connect feature opens each route. */
const CONNECT_ROUTES = {
  'youtube-web': 'youtube',
  googlevideo: 'googlevideo',
  spotify: 'spotify',
  'lastfm-web': 'lastfm',
} as const satisfies Partial<Record<Target['kind'], ConnectFeature>>

/**
 * Creates the browser transport. Routing is decided per request from FXM Connect's status and
 * the Lite tier's readiness at that moment:
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
 * Anything else, and any route that is closed, rejects with an `Unsupported` `FxmError`. An
 * `outdated` FXM Connect opens no routes.
 */
export function createWebTransport(options: WebTransportOptions = {}): Transport {
  const pageFetch = options.fetch ?? globalThis.fetch.bind(globalThis)
  const budget =
    options.budget ?? createRequestBudget({ storage: browserStorage() ?? memoryStorage() })
  const { connect, lite } = options
  const direct: RequestSender = (request) => pageFetch(request.url, request.init)
  const has = (feature: ConnectFeature) => hasConnectFeature(connect?.status, feature)

  const router: Router = {
    innerTube(target) {
      if (has('youtube')) return (request) => pageFetch(request.url, request.init)
      if (lite?.ready === true) return (request) => lite.sandbox.innerTube(request)
      throw unreachable(target, 'FXM Connect, the Lite tier or the desktop or Android app')
    },
    other(target) {
      if (target.kind === 'open') return direct
      if (target.kind === 'user') {
        const userHost = lite?.sandbox.userHost?.bind(lite.sandbox)
        if (userHost === undefined) {
          throw unreachable(target, 'the sandbox documents of the web app')
        }
        return (request) =>
          userHost(request.url, {
            method: request.init.method === 'HEAD' ? 'HEAD' : 'GET',
            ...(request.init.signal ? { signal: request.init.signal } : {}),
          })
      }
      const feature = target.kind === 'innertube' ? 'youtube' : CONNECT_ROUTES[target.kind]
      if (has(feature)) return direct
      throw unreachable(target, 'FXM Connect or the desktop or Android app')
    },
  }

  return createTransport(router, {
    budget,
    ...(options.userHosts === undefined ? {} : { userHosts: options.userHosts }),
    dropHeaders: ['user-agent'],
  })
}
