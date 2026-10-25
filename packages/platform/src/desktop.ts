/**
 * The desktop app's native HTTP (stage 7.2). {@link createDesktopFetch} is the {@link NativeHttp}
 * that the Tauri transport sends every request through:
 *
 * - hosts in the host table go through Tauri's HTTP plugin (`@tauri-apps/plugin-http`). Its
 *   scope in `apps/desktop/src-tauri/capabilities/default.json` lists exactly those hosts, and
 *   its `scopeRedirects` setting checks every redirect against that scope;
 * - hosts the user approved in Settings, such as an Invidious instance, go through FXM's
 *   `user_host_fetch` Rust command instead, because the plugin's scope is fixed at build time.
 *   Rust lets a host through only once the user has approved it in a native dialog
 *   ({@link createDesktopUserHosts}), and only over HTTPS to a public address.
 *
 * The header policy is `createNativeTransport`'s (see `NATIVE_ORIGINS`). This module enforces its
 * rules once more at the last step, so no caller can get around them:
 *
 * - **Never a webview origin.** A request without an `Origin`, or with anything but the `https:`
 *   origin of a real site, goes out with `origin: ''`, which the plugin (built with
 *   `unsafe-headers`) turns into no `Origin` header at all. Otherwise the plugin would add the
 *   webview's own origin (`tauri://localhost`, `http(s)://tauri.localhost` or the dev server's),
 *   which InnerTube refuses with 403.
 * - **Never the plugin's User-Agent** (`tauri-plugin-http/<version>`), which Spotify refuses with
 *   `403 Client/request not allowed` and which would single out FXM's traffic. YouTube and Spotify
 *   get a browser User-Agent and every other host FXM's own, unless the request names one.
 * - **Headers only in `init.headers`,** as a plain object: the plugin reads forbidden headers
 *   such as `Origin` only from there, because a `Request` object's headers drop them.
 * - **No cookies.** The plugin is built without its cookie jar, a `Cookie` header is never sent,
 *   and `Set-Cookie` never reaches page JavaScript.
 *
 * @module
 */

import { FxmError, isFxmError } from '@fxm/core'
import { findHostRule, type HostClass, parseUrl } from './hosts'
import type { NativeHttp, NativeRequestInit } from './native'

/** The options of the HTTP plugin's `fetch` that FXM sets, besides `RequestInit`'s. */
export interface PluginFetchInit extends RequestInit {
  /** How many redirects to follow. `0` follows none and returns the redirect. Default: 10. */
  maxRedirections?: number
  /** The connect timeout, in milliseconds. */
  connectTimeout?: number
}

/** The `fetch` of Tauri's HTTP plugin. */
export type PluginFetch = (input: string, init: PluginFetchInit) => Promise<Response>

/** Tauri's `invoke`, which calls one of the desktop app's Rust commands. */
export type TauriInvoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>

/** What the desktop app's networking takes from Tauri. */
export interface TauriBindings {
  /** `fetch` from `@tauri-apps/plugin-http`. */
  readonly fetch: PluginFetch
  /** `invoke` from `@tauri-apps/api/core`. */
  readonly invoke: TauriInvoke
}

/** Tauri's bindings, or a function that loads them. */
export type TauriBindingsSource = TauriBindings | (() => Promise<TauriBindings>)

/** The desktop app's own Rust commands that the web app calls (`apps/desktop/src-tauri`). */
export const DESKTOP_COMMANDS = {
  /** The hosts the user approved: `string[]`. */
  userHosts: 'user_hosts',
  /** Asks the user, in a native dialog, to approve `{ host }`: the host, or `null` if refused. */
  approveUserHost: 'approve_user_host',
  /** Removes `{ host }` from the approved hosts. */
  revokeUserHost: 'revoke_user_host',
  /** Fetches `{ request: { url, method } }` from an approved host (see {@link createDesktopFetch}). */
  userHostFetch: 'user_host_fetch',
} as const

/** The connect timeout of the desktop app's requests, in milliseconds. */
export const DESKTOP_CONNECT_TIMEOUT_MS = 15_000

/** Where to find FXM, for the User-Agent it sends to services that ask apps to name themselves. */
export const FXM_HOMEPAGE = 'https://github.com/Pratyay-ops/FXM'

/**
 * The browser User-Agent for when the webview's own is incomplete or missing: a desktop Chrome,
 * the browser most of the web sees (Chrome 156 was current on 2026-10-25).
 */
export const FALLBACK_BROWSER_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36'

/** What a WKWebView's User-Agent lacks to read as Safari's. */
const SAFARI_SUFFIX = 'Version/26.0 Safari/605.1.15'

/**
 * Host classes whose requests get a browser User-Agent: YouTube's web endpoints (InnerTube,
 * `sw.js_data`, the player JavaScript), its media servers and Spotify. Spotify refuses other
 * agents, and YouTube's web endpoints expect a browser, as on the web. This matches
 * `BROWSER_AGENT_KINDS`, which applies the app's chosen agent before a request gets here.
 */
const BROWSER_AGENT_CLASSES: ReadonlySet<HostClass> = new Set([
  'innertube',
  'googlevideo',
  'spotify',
])

/** Response headers page JavaScript never sees: no cookie is ever stored or sent. */
const DROPPED_RESPONSE_HEADERS: ReadonlySet<string> = new Set(['set-cookie', 'set-cookie2'])

/** Statuses whose responses have no body (`new Response` refuses one). */
const NULL_BODY_STATUSES: ReadonlySet<number> = new Set([101, 103, 204, 205, 304])

/** Statuses that redirect. */
const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308])

/** How the plugin words a URL its scope refuses, the requested one or a redirect's target. */
const SCOPE_REFUSAL = 'url not allowed on the configured scope'

/**
 * The browser User-Agent the desktop app sends to YouTube and Spotify: the webview's own when it
 * reads as a browser's (WebView2 on Windows, WebKitGTK on Linux), completed to Safari's on macOS,
 * whose WKWebView leaves out the `Version/… Safari/…` part, and {@link FALLBACK_BROWSER_USER_AGENT}
 * otherwise.
 */
export function desktopBrowserUserAgent(webviewUserAgent: string | undefined): string {
  const agent = webviewUserAgent?.trim() ?? ''
  if (!agent.startsWith('Mozilla/5.0 (')) return FALLBACK_BROWSER_USER_AGENT
  if (/ (?:Safari|Firefox)\/\S+/.test(agent)) return agent
  if (/AppleWebKit\/\S+ \(KHTML, like Gecko\)$/.test(agent)) return `${agent} ${SAFARI_SUFFIX}`
  return FALLBACK_BROWSER_USER_AGENT
}

/**
 * FXM's own User-Agent, for services that ask apps to name themselves (MusicBrainz asks for
 * `Name/version ( contact )`), e.g. `FXM/0.6.0 ( https://github.com/Pratyay-ops/FXM )`.
 */
export function fxmUserAgent(version?: string): string {
  return `FXM${version ? `/${version}` : ''} ( ${FXM_HOMEPAGE} )`
}

/**
 * `origin` when it is the `https:` origin of a real site, such as `https://open.spotify.com`, and
 * `''` otherwise: no `Origin` header at all. A webview's origin (`tauri://localhost`,
 * `http(s)://tauri.localhost`, a dev server's `http://localhost:…`) never passes.
 */
export function siteOrigin(origin: string | undefined): string {
  if (origin === undefined || origin === '') return ''
  let url: URL
  try {
    url = new URL(origin)
  } catch {
    return ''
  }
  const local = url.hostname === 'localhost' || url.hostname.endsWith('.localhost')
  return url.protocol === 'https:' && !local && url.origin === origin ? origin : ''
}

/**
 * The headers a request to a host of class `hostClass` goes out with: lower-case names, no
 * `Cookie`, an `origin` from {@link siteOrigin} (`''` for none), and a User-Agent when the
 * request names none: `browserAgent` for YouTube and Spotify, `appAgent` for every other host.
 */
export function desktopHeaders(
  headers: Readonly<Record<string, string>>,
  hostClass: HostClass,
  agents: { readonly browserAgent: string; readonly appAgent: string },
): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers)) result[name.toLowerCase()] = value
  delete result.cookie
  result.origin = siteOrigin(result.origin)
  if (!result['user-agent']) {
    result['user-agent'] = BROWSER_AGENT_CLASSES.has(hostClass)
      ? agents.browserAgent
      : agents.appAgent
  }
  return result
}

/** Loads Tauri's bindings. Imported on first use, so a browser never downloads them. */
export async function loadTauriBindings(): Promise<TauriBindings> {
  const [http, core] = await Promise.all([
    import('@tauri-apps/plugin-http'),
    import('@tauri-apps/api/core'),
  ])
  return { fetch: http.fetch, invoke: core.invoke }
}

/** Whether the page runs in the Tauri desktop app, whose runtime defines `__TAURI_INTERNALS__`. */
export function isTauriRuntime(global: object = globalThis): boolean {
  const internals = (global as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
  return typeof internals === 'object' && internals !== null
}

/** The bindings from `source`, loaded once; a failed load is tried again on the next call. */
function bindingsOnce(source: TauriBindingsSource): () => Promise<TauriBindings> {
  if (typeof source !== 'function') return async () => source
  let loading: Promise<TauriBindings> | undefined
  return () => {
    loading ??= source().catch((error: unknown) => {
      loading = undefined
      throw error
    })
    return loading
  }
}

/** The webview's own User-Agent, if there is one. */
function webviewUserAgent(): string | undefined {
  const agent = (globalThis as { navigator?: { userAgent?: unknown } }).navigator?.userAgent
  return typeof agent === 'string' ? agent : undefined
}

/** Options for {@link createDesktopFetch}. */
export interface DesktopFetchOptions {
  /**
   * Tauri's bindings. Default: {@link loadTauriBindings}, on the first request, so creating the
   * fetch never touches Tauri.
   */
  tauri?: TauriBindingsSource
  /**
   * The browser User-Agent for YouTube and Spotify requests that name none. Default:
   * {@link desktopBrowserUserAgent} of the webview's own.
   */
  browserUserAgent?: string
  /** The User-Agent for other requests that name none. Default: {@link fxmUserAgent}`()`. */
  appUserAgent?: string
  /** The connect timeout, in milliseconds. Default: {@link DESKTOP_CONNECT_TIMEOUT_MS}. */
  connectTimeoutMs?: number
}

/**
 * Creates the desktop app's {@link NativeHttp}. Pass it to `createTauriTransport({ http })`;
 * `createPlatform()` does so by itself when it runs in the desktop app.
 *
 * A host in the host table goes through the HTTP plugin with the headers of
 * {@link desktopHeaders}; any other host goes through the `user_host_fetch` command, which
 * reaches only hosts the user approved (GET and HEAD only, without headers). `redirect: 'manual'`
 * returns a redirect as it is, and `redirect: 'error'` rejects one; by default the plugin follows
 * up to 10, each checked against its scope. Rejections follow `fetch`: the signal's reason when it
 * aborted, a `TypeError` when the network failed, plus an `Unsupported` `FxmError` when FXM
 * refuses the address, e.g. a redirect out of the scope.
 */
export function createDesktopFetch(options: DesktopFetchOptions = {}): NativeHttp {
  const bindings = bindingsOnce(options.tauri ?? loadTauriBindings)
  const agents = {
    browserAgent: options.browserUserAgent ?? desktopBrowserUserAgent(webviewUserAgent()),
    appAgent: options.appUserAgent ?? fxmUserAgent(),
  }
  const connectTimeout = options.connectTimeoutMs ?? DESKTOP_CONNECT_TIMEOUT_MS

  return async (url, init) => {
    init.signal?.throwIfAborted()
    const target = parseUrl(url)
    const rule = findHostRule(target)
    const tauri = await bindings()
    init.signal?.throwIfAborted()
    if (rule === undefined) return fetchUserHost(tauri.invoke, target, init)
    const headers = desktopHeaders(init.headers, rule.hostClass, agents)
    return fetchThroughPlugin(tauri.fetch, target.href, init, headers, connectTimeout)
  }
}

async function fetchThroughPlugin(
  pluginFetch: PluginFetch,
  url: string,
  init: NativeRequestInit,
  headers: Record<string, string>,
  connectTimeout: number,
): Promise<Response> {
  const redirect = init.redirect ?? 'follow'
  let response: Response
  try {
    // A fresh object: the plugin deletes its own options from the one it gets.
    response = await pluginFetch(url, {
      method: init.method,
      headers,
      ...(init.body === undefined ? {} : { body: init.body }),
      ...(init.signal === undefined ? {} : { signal: init.signal }),
      connectTimeout,
      ...(redirect === 'follow' ? {} : { maxRedirections: 0 }),
    })
  } catch (error) {
    throw fetchError(error, init.signal)
  }
  if (redirect === 'error' && REDIRECT_STATUSES.has(response.status)) {
    await response.body?.cancel().catch(() => {})
    throw new TypeError(`${url} redirects, and the request asked not to follow redirects`)
  }
  return pageResponse(response.body, response, response.headers, response.url || url)
}

/** A rejection of the plugin's `fetch`, as `fetch` itself would reject. */
function fetchError(error: unknown, signal: AbortSignal | undefined): unknown {
  if (signal?.aborted) return signal.reason
  if (isFxmError(error) || error instanceof TypeError) return error
  const message = error instanceof Error ? error.message : String(error)
  if (message.startsWith(SCOPE_REFUSAL)) {
    return new FxmError(
      'Unsupported',
      `The desktop app does not contact that address: ${message}`,
      {
        cause: error,
      },
    )
  }
  return new TypeError(`Network request failed: ${message}`, { cause: error })
}

/**
 * The response page JavaScript gets: the given body, status and headers minus `Set-Cookie`, and
 * a `url` that survives `clone()`, which a constructed `Response` would leave empty.
 */
function pageResponse(
  body: BodyInit | null,
  head: { readonly status: number; readonly statusText: string },
  headers: Iterable<readonly [string, string]>,
  url: string,
): Response {
  const kept = new Headers()
  for (const [name, value] of headers) {
    if (!DROPPED_RESPONSE_HEADERS.has(name.toLowerCase())) kept.append(name, value)
  }
  const response = new Response(NULL_BODY_STATUSES.has(head.status) ? null : body, {
    status: head.status,
    statusText: head.statusText,
    headers: kept,
  })
  return withUrl(response, url)
}

function withUrl(response: Response, url: string): Response {
  const clone = response.clone.bind(response)
  Object.defineProperty(response, 'url', { value: url })
  Object.defineProperty(response, 'clone', { value: () => withUrl(clone(), url) })
  return response
}

/** The error a desktop command rejects with (`CommandError` in `src-tauri/src/user_hosts.rs`). */
interface CommandError {
  readonly code: string
  readonly message: string
}

function isCommandError(value: unknown): value is CommandError {
  const error = value as Partial<CommandError> | null
  return (
    typeof error === 'object' &&
    error !== null &&
    typeof error.code === 'string' &&
    typeof error.message === 'string'
  )
}

/**
 * A desktop command's rejection as an error: `network` failures as a `TypeError`, as `fetch`
 * rejects; `too-large` as a `Parse` `FxmError`; anything else FXM refused as `Unsupported`.
 */
function commandError(error: unknown, signal?: AbortSignal): unknown {
  if (signal?.aborted) return signal.reason
  if (!isCommandError(error)) {
    return new TypeError(`The desktop app failed: ${String(error)}`, { cause: error })
  }
  if (error.code === 'network') return new TypeError(error.message, { cause: error })
  const code = error.code === 'too-large' ? 'Parse' : 'Unsupported'
  return new FxmError(code, error.message, { cause: error })
}

/** `promise`, or a rejection with the signal's reason as soon as it aborts. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return promise
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', abort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort)
        reject(error)
      },
    )
  })
}

async function fetchUserHost(
  invoke: TauriInvoke,
  url: URL,
  init: NativeRequestInit,
): Promise<Response> {
  const method = init.method.toUpperCase()
  if (method !== 'GET' && method !== 'HEAD') {
    throw new FxmError('Unsupported', `Only GET and HEAD requests go to ${url.host}`)
  }
  let raw: unknown
  try {
    raw = await abortable(
      invoke<unknown>(DESKTOP_COMMANDS.userHostFetch, { request: { url: url.href, method } }),
      init.signal,
    )
  } catch (error) {
    throw commandError(error, init.signal)
  }
  return decodeUserHostResponse(raw, url.href)
}

/** The head of a `user_host_fetch` response. */
interface UserHostHead {
  readonly status: number
  readonly statusText: string
  readonly url: string
  readonly headers: readonly (readonly [string, string])[]
}

function isUserHostHead(value: unknown): value is UserHostHead {
  const head = value as Partial<UserHostHead> | null
  return (
    typeof head === 'object' &&
    head !== null &&
    Number.isInteger(head.status) &&
    typeof head.statusText === 'string' &&
    typeof head.url === 'string' &&
    Array.isArray(head.headers) &&
    head.headers.every(
      (entry) =>
        Array.isArray(entry) &&
        entry.length === 2 &&
        typeof entry[0] === 'string' &&
        typeof entry[1] === 'string',
    )
  )
}

/** The bytes of a raw command response, however the IPC delivered them. */
function rawBytes(raw: unknown): Uint8Array {
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw)
  if (ArrayBuffer.isView(raw)) return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength)
  if (Array.isArray(raw) && raw.every((byte) => Number.isInteger(byte))) {
    return Uint8Array.from(raw as number[])
  }
  throw new TypeError('The desktop app answered with something other than bytes')
}

/**
 * Decodes a `user_host_fetch` response: a 4-byte big-endian length, that many bytes of JSON with
 * the status, status text, final URL and headers, then the body.
 */
export function decodeUserHostResponse(raw: unknown, requestUrl: string): Response {
  const bytes = rawBytes(raw)
  const malformed = (cause?: unknown) =>
    new TypeError(
      'The desktop app answered with a malformed response',
      cause === undefined ? {} : { cause },
    )
  if (bytes.byteLength < 4) throw malformed()
  const length = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0)
  if (4 + length > bytes.byteLength) throw malformed()
  let head: unknown
  try {
    head = JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + length)))
  } catch (cause) {
    throw malformed(cause)
  }
  if (!isUserHostHead(head) || head.status < 200 || head.status > 599) throw malformed()
  return pageResponse(bytes.slice(4 + length), head, head.headers, head.url || requestUrl)
}

/** The hosts the user approved for the desktop app, kept by its Rust side. */
export interface DesktopUserHosts {
  /**
   * The approved hosts (`host` or `host:port`) as last loaded, for the transport's `userHosts`
   * option: `createPlatform({ userHosts: () => hosts.current() })`.
   */
  current(): readonly string[]
  /** Loads the approved hosts again. */
  refresh(): Promise<readonly string[]>
  /**
   * Asks the user, in a native dialog, whether FXM may contact `host` (`host` or `host:port`).
   * Resolves with the host as it was stored once approved, or `undefined` when the user said no.
   * Rejects with an `Unsupported` `FxmError` when the host is not one FXM can contact (not a
   * public domain name) or another approval is waiting for the user.
   */
  approve(host: string): Promise<string | undefined>
  /** Removes `host` from the approved hosts. */
  revoke(host: string): Promise<void>
}

/** Options for {@link createDesktopUserHosts}. */
export interface DesktopUserHostsOptions {
  /** Tauri's bindings. Default: {@link loadTauriBindings}, on first use. */
  tauri?: TauriBindingsSource
}

/**
 * Creates the client for the desktop app's approved hosts. Call `refresh()` once at start-up.
 * Page script can read and shrink the list, but only the user can grow it: Rust adds a host only
 * when the user says yes in a native dialog, so no script, such as a resolver module, can make
 * FXM contact a new host on its own.
 */
export function createDesktopUserHosts(options: DesktopUserHostsOptions = {}): DesktopUserHosts {
  const bindings = bindingsOnce(options.tauri ?? loadTauriBindings)
  let hosts: readonly string[] = Object.freeze([])

  async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
    const { invoke } = await bindings()
    try {
      return await invoke<T>(command, args)
    } catch (error) {
      throw commandError(error)
    }
  }

  async function refresh(): Promise<readonly string[]> {
    const list = await call<unknown>(DESKTOP_COMMANDS.userHosts)
    if (!Array.isArray(list) || !list.every((host) => typeof host === 'string')) {
      throw new TypeError('The desktop app answered with a malformed host list')
    }
    hosts = Object.freeze([...list])
    return hosts
  }

  return {
    current: () => hosts,
    refresh,
    async approve(host) {
      const approved = await call<unknown>(DESKTOP_COMMANDS.approveUserHost, { host })
      await refresh()
      return typeof approved === 'string' ? approved : undefined
    },
    async revoke(host) {
      await call<unknown>(DESKTOP_COMMANDS.revokeUserHost, { host })
      await refresh()
    },
  }
}
