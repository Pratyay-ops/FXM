/**
 * The desktop app's transport (Tauri 2). Its native HTTP is stage 7.2's `createDesktopFetch()`
 * (`./desktop`), built on `@tauri-apps/plugin-http` with the `unsafe-headers` feature, which
 * `createPlatform()` supplies by itself in the desktop app. Without one, this is a stub that
 * reaches only CORS-friendly hosts.
 *
 * The contract 7.2 implements (see {@link NativeHttp}):
 *
 * - InnerTube gets `Origin: ''`, which the plugin turns into no `Origin` header, never the
 *   webview's origin (`tauri://localhost`, `http(s)://tauri.localhost` or the dev server's), all
 *   of which InnerTube refuses with 403. `https://www.youtube.com` would be accepted too.
 * - Headers go only in `init.headers`, as a plain object: the webview drops forbidden headers
 *   set on a `Request` object.
 * - Redirects stay within the plugin's scope (`scopeRedirects`), and YouTube and Spotify get a
 *   browser `User-Agent` (`userAgent`).
 *
 * @module
 */

import type { RequestBudget } from './budget'
import { createNativeStub, createNativeTransport, type NativeHttp } from './native'
import type { Transport } from './transport'

/** Options for {@link createTauriTransport}. */
export interface TauriTransportOptions {
  /** Stage 7.2's native HTTP, `createDesktopFetch()`. Without it, the transport is the stub. */
  http?: NativeHttp
  /** The budget InnerTube calls draw from. */
  budget?: RequestBudget
  /**
   * Hosts the user added in Settings. `createDesktopFetch()` sends them through a Rust command
   * that checks them again: `createDesktopUserHosts().current` gives the list Rust keeps.
   */
  userHosts?: () => Iterable<string>
  /** A browser `User-Agent` for YouTube and Spotify. */
  userAgent?: string
  /** The webview's own `fetch`, for the stub's CORS-friendly hosts. Default: the global one. */
  webFetch?: typeof fetch
}

/** Creates the desktop transport, or its stub while `http` is absent. */
export function createTauriTransport(options: TauriTransportOptions = {}): Transport {
  if (options.http !== undefined) {
    return createNativeTransport({
      http: options.http,
      ...(options.budget === undefined ? {} : { budget: options.budget }),
      ...(options.userHosts === undefined ? {} : { userHosts: options.userHosts }),
      ...(options.userAgent === undefined ? {} : { userAgent: options.userAgent }),
    })
  }
  return createNativeStub({
    needs: 'the desktop app’s native networking (stage 7.2)',
    webFetch: options.webFetch ?? globalThis.fetch.bind(globalThis),
    ...(options.budget === undefined ? {} : { budget: options.budget }),
  })
}
