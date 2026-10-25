/**
 * The contract of the native transports, which reach every host directly: the desktop app
 * (Tauri's HTTP plugin, stage 7.2) and the Android app (FXM's OkHttp plugin, stage 6.2). Both
 * supply a {@link NativeHttp}; this module applies the routing, the request budget and the
 * header policy on top. Until a stage supplies one, its transport is a stub that reaches only
 * CORS-friendly hosts, through the webview's own `fetch`, and refuses the rest.
 *
 * @module
 */

import { createRequestBudget, type RequestBudget } from './budget'
import type { SimpleInnerTubeRequest } from './innertube'
import {
  createTransport,
  type OutgoingRequest,
  type RequestSender,
  type RouteKind,
  type Router,
  type Transport,
  unreachable,
  withBrowserAgent,
} from './transport'

/** The request a {@link NativeHttp} receives. */
export interface NativeRequestInit {
  /** The HTTP method, upper case. */
  readonly method: string
  /**
   * Every header, as a plain object with lower-case names: headers never travel inside a
   * `Request` object, whose forbidden headers a webview silently drops. An `origin` of `''`
   * means "send no `Origin` header at all", which Tauri's HTTP plugin (built with
   * `unsafe-headers`) does for an empty value; 6.2's plugin must do the same.
   */
  readonly headers: Readonly<Record<string, string>>
  /** The body: text, or bytes for anything else. */
  readonly body?: string | Uint8Array<ArrayBuffer>
  /** Cancels the request. */
  readonly signal?: AbortSignal
  /** Redirect handling, as in `fetch`. Native code must still keep redirects within its scope. */
  readonly redirect?: RequestRedirect
}

/**
 * Native HTTP that stage 7.2 (desktop) or 6.2 (Android) supplies. It must:
 *
 * - send exactly the headers given, never adding the webview's origin (`tauri://localhost`,
 *   `http(s)://tauri.localhost`, `https://localhost` or a dev server's), and treat `origin: ''`
 *   as "no `Origin` header";
 * - keep no cookie jar shared with the webview. On Android that rules out Capacitor's global
 *   `CapacitorHttp` patch and `CapacitorHttp.request`, whose process-wide cookie handler sends
 *   WebView cookies: only FXM's OkHttp plugin with its own cookie jar;
 * - return a standard `Response` with binary-safe bodies.
 */
export type NativeHttp = (url: string, init: NativeRequestInit) => Promise<Response>

/** Options for {@link createNativeTransport}. */
export interface NativeTransportOptions {
  /** The native HTTP. */
  http: NativeHttp
  /** The budget InnerTube calls draw from. Default: a new one in memory. */
  budget?: RequestBudget
  /** Hosts the user added in Settings. */
  userHosts?: () => Iterable<string>
  /**
   * A browser `User-Agent` for YouTube and Spotify requests that carry none: Spotify answers
   * non-browser agents with `403 Client/request not allowed`.
   */
  userAgent?: string
}

/**
 * The `Origin` each kind of request gets on a native transport: none (`''`) for everything
 * except Spotify, which gets its own web origin. YouTube's API hosts answer requests without an
 * Origin, but refuse every webview origin with 403.
 */
export const NATIVE_ORIGINS: Readonly<Record<RouteKind, string>> = {
  open: '',
  innertube: '',
  'youtube-web': '',
  googlevideo: '',
  spotify: 'https://open.spotify.com',
  'lastfm-web': '',
  user: '',
}

/**
 * Applies the native header policy to a request: the {@link NATIVE_ORIGINS} entry as `origin`,
 * the browser `User-Agent` for YouTube and Spotify when the request has none, and the body as
 * text or bytes (with the `Content-Type` that `fetch` would have added).
 */
export async function toNativeRequest(
  request: OutgoingRequest | SimpleInnerTubeRequest,
  kind: RouteKind,
  userAgent?: string,
): Promise<{ url: string; init: NativeRequestInit }> {
  const lowerCase: Record<string, string> = {}
  for (const [name, value] of Object.entries(request.init.headers)) {
    lowerCase[name.toLowerCase()] = value
  }
  const headers = withBrowserAgent(lowerCase, kind, userAgent)
  headers.origin = NATIVE_ORIGINS[kind]

  let body: string | Uint8Array<ArrayBuffer> | undefined
  const raw = request.init.body ?? undefined
  if (typeof raw === 'string') {
    body = raw
  } else if (raw !== undefined) {
    const encoded = new Response(raw)
    body = new Uint8Array(await encoded.arrayBuffer())
    const contentType = encoded.headers.get('content-type')
    if (contentType !== null && headers['content-type'] === undefined) {
      headers['content-type'] = contentType
    }
  }
  const { signal, redirect } = request.init as RequestInit
  return {
    url: request.url,
    init: {
      method: request.init.method ?? 'GET',
      headers,
      ...(body === undefined ? {} : { body }),
      ...(signal ? { signal } : {}),
      ...(redirect === undefined ? {} : { redirect }),
    },
  }
}

/**
 * The transport of a native app: every host in the table, and the user's own hosts, directly
 * through `http` with the native header policy. InnerTube calls keep the CORS-simple shape, as
 * on every platform, and draw from the budget.
 */
export function createNativeTransport(options: NativeTransportOptions): Transport {
  const { http, userAgent } = options
  const budget = options.budget ?? createRequestBudget()
  const via =
    (kind: RouteKind): RequestSender =>
    async (request) => {
      const native = await toNativeRequest(request, kind, userAgent)
      return http(native.url, native.init)
    }
  const router: Router = {
    innerTube: (target) => via(target.kind),
    other: (target) => via(target.kind),
  }
  return createTransport(router, {
    budget,
    ...(options.userHosts === undefined ? {} : { userHosts: options.userHosts }),
  })
}

/** Options for {@link createNativeStub}. */
export interface NativeStubOptions {
  /** What is missing, for the error message, e.g. "the desktop app's native networking (7.2)". */
  needs: string
  /** The webview's own `fetch`, used for CORS-friendly hosts. */
  webFetch: typeof fetch
  /** The budget the transport reports. Default: a new one in memory. */
  budget?: RequestBudget
}

/**
 * A native app's transport before its native HTTP exists: CORS-friendly hosts through the
 * webview's `fetch` (what any web page reaches), everything else rejected with an `Unsupported`
 * `FxmError` naming what is missing.
 */
export function createNativeStub(options: NativeStubOptions): Transport {
  const { needs, webFetch } = options
  const router: Router = {
    innerTube(target) {
      throw unreachable(target, needs)
    },
    other(target) {
      if (target.kind !== 'open') throw unreachable(target, needs)
      return (request) => webFetch(request.url, request.init)
    },
  }
  // The webview's fetch follows browser rules: a script-set User-Agent would cause a preflight.
  return createTransport(router, {
    budget: options.budget ?? createRequestBudget(),
    dropHeaders: ['user-agent'],
  })
}
