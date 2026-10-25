/**
 * The Android app's transport (Capacitor). Stage 6.2 supplies its native HTTP: an OkHttp-based
 * plugin with its own cookie jar, shared with the Media3 player. Never Capacitor's global
 * `CapacitorHttp` patch or `CapacitorHttp.request`: the patch drops `Origin`, `Cookie` and
 * `Referer` and corrupts binary bodies, and both send WebView cookies through Capacitor's
 * process-wide cookie handler. Until 6.2 this is a stub that reaches only CORS-friendly hosts,
 * through the WebView's own, unpatched `fetch`.
 *
 * @module
 */

import type { RequestBudget } from './budget'
import { createNativeStub, createNativeTransport, type NativeHttp } from './native'
import type { Transport } from './transport'

/** Options for {@link createCapacitorTransport}. */
export interface CapacitorTransportOptions {
  /** Stage 6.2's native HTTP (the OkHttp plugin). Without it, the transport is the stub. */
  http?: NativeHttp
  /** The budget InnerTube calls draw from. */
  budget?: RequestBudget
  /** Hosts the user added in Settings (6.2 checks them against the approved list). */
  userHosts?: () => Iterable<string>
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
export function createCapacitorTransport(options: CapacitorTransportOptions = {}): Transport {
  if (options.http !== undefined) {
    return createNativeTransport({
      http: options.http,
      ...(options.budget === undefined ? {} : { budget: options.budget }),
      ...(options.userHosts === undefined ? {} : { userHosts: options.userHosts }),
      ...(options.userAgent === undefined ? {} : { userAgent: options.userAgent }),
    })
  }
  return createNativeStub({
    needs: 'the Android app’s native networking (stage 6.2)',
    webFetch: options.webFetch ?? unpatchedFetch(),
    ...(options.budget === undefined ? {} : { budget: options.budget }),
  })
}
