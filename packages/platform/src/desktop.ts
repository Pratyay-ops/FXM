/**
 * The desktop app's native HTTP (stage 7.2). {@link createDesktopFetch} is the {@link NativeHttp}
 * that the Tauri transport sends every request through:
 *
 * - hosts in the host table go through Tauri's HTTP plugin (`@tauri-apps/plugin-http`). Its
 *   scope in `apps/desktop/src-tauri/capabilities/default.json` lists exactly those hosts;
 * - `user` routes, the hosts the user approved in Settings such as an Invidious instance, go
 *   through FXM's `user_host_fetch` Rust command instead, because the plugin's scope is fixed at
 *   build time. So does any other host off the table. Rust lets a host through only once the user
 *   has approved it in a native dialog ({@link createDesktopUserHosts}), and only over HTTPS to a
 *   public address.
 *
 * Neither follows a redirect: each hands it back as it is (`redirect: 'manual'`), and the
 * transport follows it, checking every hop against the host table before it is sent.
 *
 * The header policy is `createNativeTransport`'s (see `NATIVE_ORIGINS`). This module enforces its
 * rules once more at the last step, so no provider, or anything else that calls `ctx.fetch`, can
 * get around them:
 *
 * - **Never a webview origin.** The `Origin` comes only from `init.origin`. A request without
 *   one (`null`), or with anything but the `https:` origin of a real site, goes out with
 *   `origin: ''`, which the plugin (built with `unsafe-headers`) turns into no `Origin` header at
 *   all. Otherwise the plugin would add the webview's own origin (`tauri://localhost`,
 *   `http(s)://tauri.localhost` or the dev server's), which InnerTube refuses with 403.
 * - **Never the plugin's User-Agent** (`tauri-plugin-http/<version>`), which Spotify refuses with
 *   `403 Client/request not allowed` and which would single out FXM's traffic. Every host that
 *   YouTube (Google) or Spotify runs, their image hosts included, and Last.fm's web player get a
 *   browser User-Agent; every other host gets FXM's own ({@link sendsBrowserAgent}), unless the
 *   request names one.
 * - **Headers only in `init.headers`,** as a plain object: the plugin reads forbidden headers
 *   such as `Origin` only from there, because a `Request` object's headers drop them.
 * - **No cookies and no `Host`.** The plugin is built without its cookie jar, a `Cookie` or `Host`
 *   header is never sent, and `Set-Cookie` never reaches page JavaScript.
 *
 * These rules bind callers of this module. Page script that calls Tauri's IPC itself never passes
 * through here: the desktop app's isolation hook (`apps/desktop/isolation`) applies the `Origin`,
 * `Cookie` and `Host` rules to what reaches the plugin, and drops its per-request proxy, whatever
 * the message's shape or command, except in a start-up gap (see `apps/desktop/README.md`).
 *
 * Errors follow `fetch`, for the response and for reading its body: the signal's reason once the
 * request was aborted, else a `TypeError` when the network failed. Refusals by FXM's network
 * rules are `TransportError`s, with the reasons the transports give for the same refusals. Their
 * messages name a URL only by its origin and path: googlevideo's query carries the user's IP
 * address and signatures.
 *
 * @module
 */

import { FxmError, isFxmError } from '@fxm/core'
import { TransportError, type TransportErrorReason } from './errors'
import { findHostRule, type HostClass, type HostRule, parseUrl } from './hosts'
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
 * `sw.js_data`, the player JavaScript), its media servers, Spotify and Last.fm's web player.
 * Spotify refuses other agents, and these endpoints expect a browser, as on the web, where FXM
 * Connect sends them with the browser's own. This covers `BROWSER_AGENT_KINDS`, which applies the
 * app's chosen agent before a request gets here.
 */
const BROWSER_AGENT_CLASSES: ReadonlySet<HostClass> = new Set([
  'innertube',
  'googlevideo',
  'spotify',
  'lastfm-web',
])

/**
 * Hosts of the `open` class that YouTube (Google) or Spotify run: their image servers. They get
 * a browser User-Agent too, so FXM's own never reaches Google or Spotify, which see the same IP
 * address's other requests with a browser's.
 */
export const BROWSER_AGENT_HOSTS: ReadonlySet<string> = new Set([
  'i.ytimg.com',
  '*.ggpht.com',
  'i.scdn.co',
])

/**
 * Request headers that never go out: `Cookie` and `Host`, and `Origin`, which comes only from
 * `init.origin`.
 */
const NEVER_SENT_HEADERS: ReadonlySet<string> = new Set(['cookie', 'host', 'origin'])

/** Response headers page JavaScript never sees: no cookie is ever stored or sent. */
const DROPPED_RESPONSE_HEADERS: ReadonlySet<string> = new Set(['set-cookie', 'set-cookie2'])

/** Statuses whose responses have no body (`new Response` refuses one). */
const NULL_BODY_STATUSES: ReadonlySet<number> = new Set([101, 103, 204, 205, 304])

/** How the plugin words a URL its scope refuses. */
const SCOPE_REFUSAL = 'url not allowed on the configured scope'

/**
 * The `user_host_fetch` errors that FXM's network rules give, and the `TransportError` reason the
 * transports give for the same refusal.
 */
const COMMAND_REFUSALS: ReadonlyMap<string, TransportErrorReason> = new Map([
  ['not-approved', 'unknown-host'],
  ['bad-request', 'bad-request'],
])

/** A header name: an HTTP token. */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/

/** A header value as `Headers` accepts it: a byte string without control characters but tab. */
const HEADER_VALUE = /^[\t\x20-\x7e\x80-\xff]*$/

/** Absolute URLs in a message. */
const URL_IN_TEXT = /\b[a-z][a-z\d+.-]*:\/\/[^\s"'<>()]+/gi

/**
 * A URL for a message: its scheme, host and path, without credentials, query or fragment. A
 * googlevideo URL's query carries the user's IP address and signatures, and other URLs can carry
 * search terms.
 */
export function describeUrl(url: string | URL): string {
  try {
    const parsed = typeof url === 'string' ? new URL(url) : url
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`
  } catch {
    const text = String(url).replace(/^([^:/]+:\/\/)[^@/]*@/, '$1')
    return text.split(/[?#]/, 1)[0] ?? text
  }
}

/** `message` with every URL in it shortened to what {@link describeUrl} keeps. */
export function redactUrls(message: string): string {
  return message.replace(URL_IN_TEXT, (url) => describeUrl(url))
}

/** The text of an error, of any kind, for a message. */
function errorText(error: unknown): string {
  return redactUrls(error instanceof Error ? error.message : String(error))
}

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
 * `''` otherwise, `null` included: no `Origin` header at all. A webview's origin
 * (`tauri://localhost`, `http(s)://tauri.localhost`, a dev server's `http://localhost:…`) never
 * passes.
 */
export function siteOrigin(origin: string | null | undefined): string {
  if (origin === undefined || origin === null || origin === '') return ''
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
 * Whether requests to the host of `rule` get a browser User-Agent: every host YouTube (Google) or
 * Spotify runs, their image servers included ({@link BROWSER_AGENT_HOSTS}), and Last.fm's web
 * player. The other hosts are services that ask apps to name themselves, such as MusicBrainz,
 * LRCLIB, ListenBrainz and Internet Archive: they get FXM's own.
 */
export function sendsBrowserAgent(rule: Pick<HostRule, 'host' | 'hostClass'>): boolean {
  return BROWSER_AGENT_CLASSES.has(rule.hostClass) || BROWSER_AGENT_HOSTS.has(rule.host)
}

/**
 * The headers a request to the host of `rule` goes out with: `init.headers` with lower-case
 * names, without `Cookie`, `Host` or `Origin`; then `init.origin` as `origin`, through
 * {@link siteOrigin} (`''` for none); and a User-Agent when the request names none:
 * `browserAgent` where {@link sendsBrowserAgent} says so, else `appAgent`.
 */
export function desktopHeaders(
  init: Pick<NativeRequestInit, 'headers' | 'origin'>,
  rule: Pick<HostRule, 'host' | 'hostClass'>,
  agents: { readonly browserAgent: string; readonly appAgent: string },
): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [name, value] of Object.entries(init.headers)) {
    const lower = name.toLowerCase()
    if (!NEVER_SENT_HEADERS.has(lower)) result[lower] = value
  }
  result.origin = siteOrigin(init.origin)
  if (!result['user-agent']) {
    result['user-agent'] = sendsBrowserAgent(rule) ? agents.browserAgent : agents.appAgent
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
   * The browser User-Agent for requests that name none to the hosts {@link sendsBrowserAgent}
   * picks: YouTube's, Spotify's and Last.fm's web player. Default: {@link desktopBrowserUserAgent}
   * of the webview's own.
   */
  browserUserAgent?: string
  /** The User-Agent for other requests that name none. Default: {@link fxmUserAgent}`()`. */
  appUserAgent?: string
  /** The connect timeout, in milliseconds. Default: {@link DESKTOP_CONNECT_TIMEOUT_MS}. */
  connectTimeoutMs?: number
}

/**
 * Creates the desktop app's {@link NativeHttp}. Pass it to
 * `createTauriTransport({ budget, http })`; `createPlatform()` does so by itself when it runs in
 * the desktop app.
 *
 * A host in the host table goes through the HTTP plugin with the headers of
 * {@link desktopHeaders}. A `user` route, and any host off the table, goes through the
 * `user_host_fetch` command, which reaches only hosts the user approved (GET and HEAD only,
 * without headers). Every redirect comes back as it is, for the transport to follow. Rejections
 * follow `fetch`, for the response and for reading its body: the signal's reason when it
 * aborted, a `TypeError` when the network failed, plus a `TransportError` when FXM's rules refuse
 * the request: `unknown-host` for an address outside the plugin's scope or a host the user did
 * not approve, `bad-request` for a request the command can't carry. The command's other
 * refusals are `Unsupported` `FxmError`s, and a response that is too large a `Parse` one.
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
    if (rule === undefined || init.route === 'user') {
      return fetchUserHost(tauri.invoke, target, init)
    }
    const headers = desktopHeaders(init, rule, agents)
    return fetchThroughPlugin(tauri.fetch, target, init, headers, connectTimeout)
  }
}

async function fetchThroughPlugin(
  pluginFetch: PluginFetch,
  target: URL,
  init: NativeRequestInit,
  headers: Record<string, string>,
  connectTimeout: number,
): Promise<Response> {
  let response: Response
  try {
    // A fresh object: the plugin deletes its own options from the one it gets. A redirect comes
    // back as it is (`maxRedirections: 0`): the transport follows it, hop by hop.
    response = await pluginFetch(target.href, {
      method: init.method,
      headers,
      ...(init.body === undefined ? {} : { body: init.body }),
      ...(init.signal === undefined ? {} : { signal: init.signal }),
      connectTimeout,
      maxRedirections: 0,
    })
  } catch (error) {
    throw fetchError(error, target, init.signal)
  }
  const body = NULL_BODY_STATUSES.has(response.status)
    ? null
    : fetchBody(response.body, init.signal)
  return pageResponse(body, response, response.headers, response.url || target.href)
}

/**
 * A rejection of the plugin's `fetch`, as `fetch` itself would reject, or a `TransportError`
 * (`unknown-host`) for an address outside the plugin's scope. The message names URLs by origin
 * and path only; the plugin's own error stays in `cause`.
 */
function fetchError(error: unknown, target: URL, signal: AbortSignal | undefined): unknown {
  if (signal?.aborted) return signal.reason
  if (isFxmError(error)) return error
  const message = error instanceof Error ? error.message : String(error)
  if (message.startsWith(SCOPE_REFUSAL)) {
    const refused = message.slice(SCOPE_REFUSAL.length).replace(/^:\s*/, '')
    return new TransportError(
      'unknown-host',
      `The desktop app does not contact ${describeUrl(refused || target)}`,
      { cause: error },
    )
  }
  return new TypeError(`Network request failed: ${errorText(error)}`, { cause: error })
}

/** A failed read of a response body, as reading a `fetch` response's body would fail. */
function bodyError(error: unknown, signal: AbortSignal | undefined): unknown {
  if (signal?.aborted) return signal.reason
  return new TypeError(`Reading the response failed: ${errorText(error)}`, { cause: error })
}

/**
 * The plugin's response body, failing like a `fetch` body: with the signal's reason once the
 * request was aborted, else with a `TypeError`. The plugin itself errors its stream with bare
 * strings, such as `'Request cancelled'`. Read only on demand, and cancelling it cancels the
 * plugin's.
 */
function fetchBody(
  body: ReadableStream<Uint8Array> | null,
  signal: AbortSignal | undefined,
): ReadableStream<Uint8Array> | null {
  if (body === null) return null
  const reader = body.getReader()
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        let chunk: ReadableStreamReadResult<Uint8Array>
        try {
          chunk = await reader.read()
        } catch (error) {
          controller.error(bodyError(error, signal))
          return
        }
        if (chunk.done) controller.close()
        else controller.enqueue(chunk.value)
      },
      cancel: (reason) => reader.cancel(reason),
    },
    { highWaterMark: 0 },
  )
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
 * rejects; a host that isn't approved (`not-approved`) and a request the command can't carry
 * (`bad-request`) as a `TransportError` with the reason the transports give for the same refusal
 * (`unknown-host`, `bad-request`); `too-large` as a `Parse` `FxmError`; anything else FXM refused
 * as `Unsupported`, such as a private address, a proxy, or an approval FXM won't ask about right
 * now (`not-focused`, `busy`, `too-soon`, `refused`). Rust words the messages for people, without
 * URLs' queries, and the command's `{ code, message }` stays in `cause`.
 */
function commandError(error: unknown, signal?: AbortSignal): unknown {
  if (signal?.aborted) return signal.reason
  if (!isCommandError(error)) {
    return new TypeError(`The desktop app failed: ${errorText(error)}`, { cause: error })
  }
  if (error.code === 'network') return new TypeError(error.message, { cause: error })
  const reason = COMMAND_REFUSALS.get(error.code)
  if (reason !== undefined) return new TransportError(reason, error.message, { cause: error })
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
    throw new TransportError('bad-request', `Only GET and HEAD requests go to ${url.host}`)
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

/**
 * The head of a `user_host_fetch` response. Rust gives each header value's bytes as one
 * character each (U+0000 to U+00FF), as browsers expose them, so every value is a byte string.
 */
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
        typeof entry[1] === 'string' &&
        HEADER_NAME.test(entry[0]) &&
        HEADER_VALUE.test(entry[1]),
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
 * the status, status text, URL and headers, then the body. A redirect arrives as it is, with its
 * `Location`, for the transport to follow.
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
   * Rejects with an `Unsupported` `FxmError` whose message says why FXM didn't ask: the host is
   * not one FXM can contact (not a public domain name), FXM's window is not in front, another
   * question is open or one was answered less than 10 seconds ago, or the user refused this host
   * earlier in this session. Call it only when the user asked to add the host, e.g. from the
   * "Add" button in Settings.
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
 * when the user says yes in a native dialog, so no script can make `user_host_fetch` reach a host
 * the user didn't approve. That holds for this command only: what else page script can reach in
 * the desktop app is listed in `apps/desktop/README.md`.
 *
 * Requests to approved hosts never use a proxy: while the system or the environment sets one for
 * a host, they fail with an `Unsupported` `FxmError` rather than go out from the user's own
 * address. Settings should say so next to the hosts. Every refusal keeps the command's own
 * `{ code, message }` in `cause`, here `proxy-configured`.
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
