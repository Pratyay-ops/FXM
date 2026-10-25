/**
 * The Android app's transport (Capacitor). Stage 6.2 supplies its native HTTP: an OkHttp-based
 * plugin whose client keeps no cookies (`CookieJar.NO_COOKIES`; the Media3 player may use a
 * client of its own) and follows no redirects (the transport does). User-added hosts
 * (`route: 'user'`) are checked against the user's approved list there. Never Capacitor's global
 * `CapacitorHttp` patch or `CapacitorHttp.request`: the patch drops `Origin`, `Cookie` and
 * `Referer` and corrupts binary bodies, and both send and store WebView cookies through
 * Capacitor's process-wide cookie handler. Until 6.2 this is a stub that reaches only
 * CORS-friendly hosts, through the WebView's own, unpatched `fetch`.
 *
 * @module
 */

import { createNativeStub, createNativeTransport, type NativeHttp } from './native'
import type { Transport, TransportOptions } from './transport'

/** Options for {@link createCapacitorTransport}. */
export interface CapacitorTransportOptions extends TransportOptions {
  /** Stage 6.2's native HTTP (the OkHttp plugin). Without it, the transport is the stub. */
  http?: NativeHttp
  /** A browser `User-Agent` for YouTube and Spotify. */
  userAgent?: string
  /** The WebView's own `fetch`, for the stub. Default: {@link unpatchedFetch}. */
  webFetch?: typeof fetch
}

/** The parts of the WebView's global object Capacitor's patch touches. */
interface CapacitorGlobal {
  fetch: typeof fetch
  /** Where Capacitor keeps the WebView's own `fetch` when it installs its patch. */
  CapacitorWebFetch?: typeof fetch
}

/** The WebView's own `fetch`, never Capacitor's patch of it. */
export function unpatchedFetch(global: object = globalThis): typeof fetch {
  const { CapacitorWebFetch, fetch } = global as CapacitorGlobal
  return (typeof CapacitorWebFetch === 'function' ? CapacitorWebFetch : fetch).bind(global)
}

/** Creates the Android transport, or its stub while `http` is absent. */
export function createCapacitorTransport(options: CapacitorTransportOptions): Transport {
  const { http, userAgent, webFetch, ...shared } = options
  if (http !== undefined) {
    return createNativeTransport({
      ...shared,
      http,
      ...(userAgent === undefined ? {} : { userAgent }),
    })
  }
  return createNativeStub({
    ...shared,
    needs: 'the Android app’s native networking (stage 6.2)',
    webFetch: webFetch ?? unpatchedFetch(),
  })
}
