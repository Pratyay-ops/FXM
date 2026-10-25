/**
 * The contract of the native transports, which reach every host directly: the desktop app
 * (Tauri's HTTP plugin, stage 7.2) and the Android app (FXM's OkHttp plugin, stage 6.2). Both
 * supply a {@link NativeHttp}; this module applies the routing, the request budget, the header
 * policy and the redirect checks on top. Until a stage supplies one, its transport is a stub
 * that reaches only CORS-friendly hosts, through the webview's own `fetch`, and refuses the rest.
 *
 * @module
 */

import type { SimpleInnerTubeRequest } from './innertube'
import {
  createTransport,
  type OutgoingRequest,
  type RequestSender,
  type RouteKind,
  type Router,
  routeClosedError,
  type Transport,
  type TransportOptions,
  transportOptions,
  withBrowserAgent,
} from './transport'

/** The request a {@link NativeHttp} receives. */
export interface NativeRequestInit {
  /** The HTTP method, upper case. */
  readonly method: string
  /**
   * Every header to send, as a plain object with lower-case names: headers never travel inside a
   * `Request` object, whose forbidden headers a webview silently drops. Never `origin` or
   * `cookie`: the origin comes in {@link NativeRequestInit.origin}, and cookies are never sent.
   */
  readonly headers: Readonly<Record<string, string>>
  /**
   * The `Origin` header: `null` for none at all, otherwise the value to send. Never the
   * webview's own origin. Tauri's HTTP plugin (built with `unsafe-headers`) removes the header
   * for an empty value, so 7.2's adapter passes `''` for `null`; OkHttp simply sends none.
   */
  readonly origin: string | null
  /**
   * How the transport routed the request. User-added hosts (`user`) must go through the native
   * command that checks the user's approved list (7.2: a Rust command, because plugin-http's
   * scopes cannot change at run time; 6.2: the same check in the plugin).
   */
  readonly route: RouteKind
  /** Always `omit`: the request neither sends nor stores cookies. */
  readonly credentials: 'omit'
  /**
   * Always `manual`: return a redirect response (3xx, with its `Location` header readable) as it
   * is, never following it. The transport follows redirects itself, checking every hop against
   * the host table before it is sent.
   */
  readonly redirect: 'manual'
  /** The body: text, or bytes for anything else. */
  readonly body?: string | Uint8Array<ArrayBuffer>
  /** Cancels the request. */
  readonly signal?: AbortSignal
}

/**
 * Native HTTP that stage 7.2 (desktop) or 6.2 (Android) supplies. It must:
 *
 * - send exactly the headers given plus {@link NativeRequestInit.origin}, never adding the
 *   webview's origin (`tauri://localhost`, `http(s)://tauri.localhost`, `https://localhost` or a
 *   dev server's);
 * - neither send nor store cookies. The client behind it has no cookie jar at all: OkHttp with
 *   `CookieJar.NO_COOKIES` (Media3 may keep a client of its own), and plugin-http built without
 *   its `cookies` feature. Capacitor's global `CapacitorHttp` patch and `CapacitorHttp.request`
 *   are ruled out: their process-wide cookie handler sends and stores WebView cookies. The
 *   user's Spotify login cookies are only ever used by the token commands of stages 7.4 and 6.5
 *   (see `SessionTokenSource`), never here;
 * - never follow redirects (see {@link NativeRequestInit.redirect});
 * - send `user` routes through the check of the user's approved hosts;
 * - resolve with a standard `Response` for every HTTP status, with binary-safe bodies, and
 *   reject only when no response arrives (or with the signal's reason when it aborts).
 */
export type NativeHttp = (url: string, init: NativeRequestInit) => Promise<Response>

/** Options for {@link createNativeTransport}. */
export interface NativeTransportOptions extends TransportOptions {
  /** The native HTTP. */
  http: NativeHttp
  /**
   * A browser `User-Agent` for YouTube and Spotify requests that carry none: Spotify answers
   * non-browser agents with `403 Client/request not allowed`.
   */
  userAgent?: string
}

/**
 * The `Origin` each kind of request gets on a native transport: none (`null`) for everything
 * except Spotify, which gets its own web origin. YouTube's API hosts answer requests without an
 * Origin, but refuse every webview origin with 403.
 */
export const NATIVE_ORIGINS: Readonly<Record<RouteKind, string | null>> = {
  open: null,
  innertube: null,
  'youtube-web': null,
  googlevideo: null,
  spotify: 'https://open.spotify.com',
  'lastfm-web': null,
  user: null,
}

/** Headers a native request never carries in `headers`. */
const NEVER_IN_HEADERS = ['origin', 'cookie']

/**
 * Applies the native policy to a request: the {@link NATIVE_ORIGINS} entry as `origin`, the
 * browser `User-Agent` for YouTube and Spotify when the request has none, the body as text or
 * bytes (with the `Content-Type` that `fetch` would have added), no cookies and manual redirects.
 */
export async function toNativeRequest(
  request: OutgoingRequest | SimpleInnerTubeRequest,
  kind: RouteKind,
  userAgent?: string,
): Promise<{ url: string; init: NativeRequestInit }> {
  const lowerCase: Record<string, string> = {}
  for (const [name, value] of Object.entries(request.init.headers)) {
    const lower = name.toLowerCase()
    if (!NEVER_IN_HEADERS.includes(lower)) lowerCase[lower] = value
  }
  const headers = withBrowserAgent(lowerCase, kind, userAgent)

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
  const { signal } = request.init as RequestInit
  return {
    url: request.url,
    init: {
      method: request.init.method ?? 'GET',
      headers,
      origin: NATIVE_ORIGINS[kind],
      route: kind,
      credentials: 'omit',
      redirect: 'manual',
      ...(body === undefined ? {} : { body }),
      ...(signal ? { signal } : {}),
    },
  }
}

/**
 * The transport of a native app: every host in the table, and the user's own hosts, directly
 * through `http` with the native policy. InnerTube calls keep the CORS-simple shape, as on every
 * platform, and draw from the budget. Redirects are followed by the transport, hop by hop.
 */
export function createNativeTransport(options: NativeTransportOptions): Transport {
  const { http, userAgent } = options
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
  return createTransport(router, { ...transportOptions(options), redirects: 'manual' })
}

/** Options for {@link createNativeStub}. */
export interface NativeStubOptions extends TransportOptions {
  /** What is missing, for the error message, e.g. "the desktop app's native networking (7.2)". */
  needs: string
  /** The webview's own `fetch`, used for CORS-friendly hosts. */
  webFetch: typeof fetch
}

/**
 * A native app's transport before its native HTTP exists: CORS-friendly hosts through the
 * webview's `fetch` (what any web page reaches), everything else rejected with a
 * `RouteUnavailableError` (needs `native`) naming what is missing.
 */
export function createNativeStub(options: NativeStubOptions): Transport {
  const { needs, webFetch } = options
  const router: Router = {
    innerTube(target) {
      throw routeClosedError(target, ['native'], { detail: needs })
    },
    other(target) {
      if (target.kind !== 'open') throw routeClosedError(target, ['native'], { detail: needs })
      return (request) => webFetch(request.url, request.init)
    },
  }
  // The webview's fetch follows browser rules: a script-set User-Agent would cause a preflight,
  // and it follows redirects itself.
  return createTransport(router, {
    ...transportOptions(options),
    redirects: 'browser',
    dropHeaders: ['user-agent'],
  })
}
