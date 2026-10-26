/**
 * The desktop app's transport (Tauri 2). Its native HTTP is stage 7.2's `createDesktopFetch()`
 * (`./desktop`), built on `@tauri-apps/plugin-http` with the `unsafe-headers` feature, which
 * `createPlatform()` supplies by itself in the desktop app. Without one, this is a stub that
 * reaches only CORS-friendly hosts.
 *
 * The contract 7.2 implements (see {@link NativeHttp}):
 *
 * - InnerTube gets no `Origin` (`origin: null`, which the adapter passes to the plugin as `''`,
 *   removing the header), never the webview's origin (`tauri://localhost`,
 *   `http(s)://tauri.localhost` or the dev server's), all of which InnerTube refuses with 403.
 *   `https://www.youtube.com` would be accepted too.
 * - Headers go only in `init.headers`, as a plain object: the webview drops forbidden headers
 *   set on a `Request` object.
 * - Requests go out with `maxRedirections: 0` (`redirect: 'manual'`): the transport follows
 *   redirects itself. YouTube and Spotify get a browser `User-Agent` (`userAgent`).
 * - No cookies: the plugin is built without its `cookies` feature.
 * - User-added hosts (`route: 'user'`) go through a Rust command that checks the user's
 *   approved list, since plugin-http's scopes cannot change at run time.
 *
 * @module
 */

import { createNativeStub, createNativeTransport, type NativeHttp } from './native'
import type { Transport, TransportOptions } from './transport'

/** Options for {@link createTauriTransport}. */
export interface TauriTransportOptions extends TransportOptions {
  /**
   * Stage 7.2's native HTTP, `createDesktopFetch()`. Without it, the transport is the stub. It
   * sends the hosts the user added in Settings (`userHosts`) through a Rust command that checks
   * them again: `createDesktopUserHosts().current` gives the list Rust keeps.
   */
  http?: NativeHttp
  /** A browser `User-Agent` for YouTube and Spotify. */
  userAgent?: string
  /** The webview's own `fetch`, for the stub's CORS-friendly hosts. Default: the global one. */
  webFetch?: typeof fetch
}

/** Creates the desktop transport, or its stub while `http` is absent. */
export function createTauriTransport(options: TauriTransportOptions): Transport {
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
    needs: 'the desktop app’s native networking (stage 7.2)',
    webFetch: webFetch ?? globalThis.fetch.bind(globalThis),
  })
}
