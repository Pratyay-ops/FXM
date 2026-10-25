/**
 * The Android app's native HTTP (stage 6.2): a {@link NativeHttp} over `FxmHttp`, FXM's own
 * OkHttp plugin, through the Capacitor bridge. Never Capacitor's global `CapacitorHttp` patch or
 * `CapacitorHttp.request`: both go through `HttpURLConnection`, which sends and stores the
 * WebView's cookies through Capacitor's process-wide cookie handler, and the patch also drops
 * headers and corrupts binary bodies. The app replaces Capacitor's built-in `CapacitorHttp`
 * plugin with one that refuses every call.
 *
 * The plugin keeps FXM's network rules in native code as well, so a request that skipped the
 * transport is held to them too: only hosts on FXM's host table or approved by the user, no
 * cookies at all, no `Origin` or `Referer` a host may not receive, and a browser `User-Agent`
 * for Spotify. The same OkHttp client serves the Media3 player (stage 6.3). See
 * `apps/mobile/android/fxm-http/README.md`.
 *
 * Bodies stream: the `Response` resolves once the headers are in, and the body arrives in chunks
 * that JavaScript pulls one at a time (`read`), base64-encoded so any byte survives the bridge.
 * Aborting the signal, cancelling the body or dropping it unread releases the native response.
 *
 * @module
 */

import { FxmError } from '@fxm/core'
import { TransportError, type TransportErrorReason } from './errors'
import { findHostRule } from './hosts'
import type { NativeHttp, NativeRequestInit } from './native'

/** The plugin's name on the Capacitor bridge (`Capacitor.Plugins.FxmHttp`). */
export const FXM_HTTP_PLUGIN = 'FxmHttp'

/** How many bytes one `read` asks for by default: 256 KiB. */
export const FXM_HTTP_READ_BYTES = 256 * 1024

/** The most one `read` returns, whatever it asks for: 1 MiB. */
export const FXM_HTTP_MAX_READ_BYTES = 1024 * 1024

/**
 * Every code the plugin rejects with (the `code` of the bridge's error):
 *
 * - `BAD_REQUEST`: a malformed message, e.g. no absolute URL, a body on a `GET`, an invalid
 *   header, an id that is in use, or a host on FXM's table given to `approveHosts`
 * - `HOST_NOT_ALLOWED`: not HTTPS, credentials in the URL, or a host on FXM's table at another
 *   port or path
 * - `HOST_NOT_APPROVED`: a host outside FXM's table that the user has not approved; the error's
 *   `data.host` names it
 * - `HEADER_NOT_ALLOWED`: an `Origin` or `Referer` the host may not receive
 * - `METHOD_NOT_ALLOWED`: `CONNECT`, `TRACE` or `TRACK`, or anything but `GET` and `HEAD` to a
 *   host the user added
 * - `REDIRECT`: a redirect the plugin may not follow (to a host outside FXM's table, of another
 *   class, or another user host), one under `redirect: 'error'`, too many, or a broken `Location`
 * - `NETWORK`: the connection failed (DNS, TLS, reset)
 * - `TIMEOUT`: connecting or reading took too long, the response head took over a minute, or the
 *   body trickled in too slowly
 * - `ABORTED`: the request was aborted
 * - `UNKNOWN_ID`: no open response has that id (read to the end, aborted, or idle too long)
 * - `BUSY`: too many responses are open at once, in all or for one user-approved host
 * - `NO_ACTIVITY`: there is no screen to ask the user on
 */
export const FXM_HTTP_ERROR_CODES = [
  'BAD_REQUEST',
  'HOST_NOT_ALLOWED',
  'HOST_NOT_APPROVED',
  'HEADER_NOT_ALLOWED',
  'METHOD_NOT_ALLOWED',
  'REDIRECT',
  'NETWORK',
  'TIMEOUT',
  'ABORTED',
  'UNKNOWN_ID',
  'BUSY',
  'NO_ACTIVITY',
] as const

/** One of {@link FXM_HTTP_ERROR_CODES}. */
export type FxmHttpErrorCode = (typeof FXM_HTTP_ERROR_CODES)[number]

/**
 * The codes that mean FXM's network rules refused the request, and the `TransportError` reason
 * each becomes: the same reasons the transports give for what they refuse themselves.
 */
const REFUSALS: Readonly<Partial<Record<FxmHttpErrorCode, TransportErrorReason>>> = {
  HOST_NOT_ALLOWED: 'unknown-host',
  HOST_NOT_APPROVED: 'unknown-host',
  HEADER_NOT_ALLOWED: 'bad-request',
  METHOD_NOT_ALLOWED: 'bad-request',
  REDIRECT: 'redirect',
}

/** What `FxmHttp.request` takes. */
export interface FxmHttpRequest {
  /** Names the request in `read` and `abort`; chosen by JavaScript, unique while it is open. */
  readonly id: string
  /** The absolute URL. */
  readonly url: string
  /** The method, upper case. */
  readonly method: string
  /** Every header, lower-case names. `origin: ''` means "no `Origin` header". */
  readonly headers: Readonly<Record<string, string>>
  /** The body: text, or base64 for bytes (see `bodyEncoding`). */
  readonly body?: string
  /** How `body` is encoded. Default `utf8`. */
  readonly bodyEncoding?: 'utf8' | 'base64'
  /**
   * Redirect handling, as in `fetch`. Default `follow`; {@link createAndroidHttp} always sends
   * `manual`, because the transport follows redirects itself.
   */
  readonly redirect?: RequestRedirect
}

/** What `FxmHttp.request` resolves with, once the response headers are in. */
export interface FxmHttpResponseHead {
  /** The request's id. */
  readonly id: string
  /** The HTTP status. */
  readonly status: number
  /** The reason phrase; empty over HTTP/2. */
  readonly statusText: string
  /** The final URL, after redirects. */
  readonly url: string
  /** Whether a redirect was followed. */
  readonly redirected: boolean
  /** The response headers as name-value pairs, without `Set-Cookie`. */
  readonly headers: readonly (readonly [string, string])[]
  /**
   * Whether there is a body to `read`. `false` for `HEAD` requests and for statuses without a
   * body (204, 205, 304); the plugin has then released the response already.
   */
  readonly body: boolean
}

/** What `FxmHttp.read` resolves with. */
export interface FxmHttpChunk {
  /** The next bytes, base64-encoded; empty only together with `done`. */
  readonly data: string
  /** Whether the body is complete; the plugin then releases the response. */
  readonly done: boolean
}

/**
 * The `FxmHttp` plugin as the Capacitor bridge exposes it. The plugin rejects with an error whose
 * `code` is one of {@link FXM_HTTP_ERROR_CODES}.
 */
export interface FxmHttpPlugin {
  /** Starts a request; resolves once its response headers are in. */
  request(options: FxmHttpRequest): Promise<FxmHttpResponseHead>
  /** The next chunk of a response body: waits for at least one byte, or the end. */
  read(options: { readonly id: string; readonly maxBytes?: number }): Promise<FxmHttpChunk>
  /** Cancels a request or drops its response. Unknown ids are ignored. */
  abort(options: { readonly id: string }): Promise<void>
  /**
   * Asks the user, in a system dialog JavaScript cannot answer, to let FXM contact hosts outside
   * its host table (`host` or `host:port`). Resolves with the requested hosts that are approved
   * now; hosts approved before are not asked about again. Rejects with `BAD_REQUEST` for a
   * malformed host or one on FXM's table, and with `NO_ACTIVITY` when nobody can be asked.
   */
  approveHosts(options: { readonly hosts: readonly string[] }): Promise<{ approved: string[] }>
  /** The hosts the user has approved. */
  approvedHosts(): Promise<{ hosts: string[] }>
  /** Withdraws approvals; resolves with the hosts still approved. */
  revokeHosts(options: { readonly hosts: readonly string[] }): Promise<{ hosts: string[] }>
}

/** The Android app's native HTTP, plus the user-host approvals Settings needs. */
export interface AndroidHttp extends NativeHttp {
  /**
   * Asks the user to approve hosts they added in Settings (see {@link FxmHttpPlugin.approveHosts})
   * and resolves with those that are approved. It is the only way to ask again about a host the
   * user refused in this session; requests never do.
   */
  approveHosts(hosts: Iterable<string>): Promise<string[]>
  /** The hosts the user has approved. */
  approvedHosts(): Promise<string[]>
  /** Withdraws approvals and resolves with the hosts still approved. */
  revokeHosts(hosts: Iterable<string>): Promise<string[]>
}

/** Options for {@link createAndroidHttp}. */
export interface AndroidHttpOptions {
  /** The plugin. Default: the one the Capacitor bridge exposes ({@link findFxmHttpPlugin}). */
  plugin?: FxmHttpPlugin
  /** Bytes per `read`, at most {@link FXM_HTTP_MAX_READ_BYTES}. Default {@link FXM_HTTP_READ_BYTES}. */
  readBytes?: number
  /**
   * Whether a request to a host the user added (`route: 'user'`) that they have not approved yet
   * asks them first, once per host at a time, and is retried when they allow it. Default `true`.
   * With `false`, and for a host they refused in this session, it fails with a `TransportError`
   * (`unknown-host`).
   */
  askToApproveHosts?: boolean
}

/** The parts of the WebView's global object the plugin lookup reads. */
interface CapacitorGlobal {
  Capacitor?: {
    isNativePlatform?: () => boolean
    Plugins?: Readonly<Record<string, unknown>>
  }
}

const PLUGIN_METHODS = ['request', 'read', 'abort', 'approveHosts', 'approvedHosts', 'revokeHosts']

/**
 * The `FxmHttp` plugin of the Android app, or `undefined` outside it: only on a native Capacitor
 * platform whose bridge has the plugin with all its methods.
 */
export function findFxmHttpPlugin(global: object = globalThis): FxmHttpPlugin | undefined {
  const capacitor = (global as CapacitorGlobal).Capacitor
  if (typeof capacitor?.isNativePlatform !== 'function' || !capacitor.isNativePlatform()) {
    return undefined
  }
  const plugin = capacitor.Plugins?.[FXM_HTTP_PLUGIN]
  if (typeof plugin !== 'object' || plugin === null) return undefined
  const methods = plugin as Record<string, unknown>
  return PLUGIN_METHODS.every((name) => typeof methods[name] === 'function')
    ? (plugin as FxmHttpPlugin)
    : undefined
}

/** {@link createAndroidHttp} over the bridge's plugin, or `undefined` outside the Android app. */
export function androidHttpIfAvailable(global: object = globalThis): AndroidHttp | undefined {
  const plugin = findFxmHttpPlugin(global)
  return plugin === undefined ? undefined : createAndroidHttp({ plugin })
}

/** Statuses whose responses never have a body (the Fetch standard's null body statuses). */
const NULL_BODY_STATUSES: ReadonlySet<number> = new Set([101, 103, 204, 205, 304])

/** Where request ids come from: unique per page load, so a reload never reuses an open id. */
const idPrefix = `r${Math.floor(Math.random() * 2 ** 32).toString(36)}`
let lastId = 0

function nextId(): string {
  lastId += 1
  return `${idPrefix}-${lastId.toString(36)}`
}

function noop(): void {}

/** The bridge error's `code`, when it is one of {@link FXM_HTTP_ERROR_CODES}. */
export function fxmHttpErrorCode(error: unknown): FxmHttpErrorCode | undefined {
  const code = (error as { code?: unknown } | null)?.code
  return (FXM_HTTP_ERROR_CODES as readonly unknown[]).includes(code)
    ? (code as FxmHttpErrorCode)
    : undefined
}

/** The host a `HOST_NOT_APPROVED` error names (`data.host`), if it names one. */
function refusedHost(error: unknown): string | undefined {
  const data = (error as { data?: unknown } | null)?.data
  const host = (data as { host?: unknown } | null | undefined)?.host
  return typeof host === 'string' ? host : undefined
}

function messageOf(error: unknown): string {
  const message = (error as { message?: unknown } | null)?.message
  return typeof message === 'string' && message !== '' ? message : 'the request failed'
}

/**
 * The error `fetch` would give for a failed request: a `TransportError` when FXM's network rules
 * refused it, with the reason the transports give for the same refusal, else a `TypeError` (as
 * for a network failure in `fetch`) with the plugin's error as its `cause`.
 */
function requestError(error: unknown): Error {
  const code = fxmHttpErrorCode(error)
  const reason = code === undefined ? undefined : REFUSALS[code]
  if (reason !== undefined) return new TransportError(reason, messageOf(error), { cause: error })
  return new TypeError(`Network request failed: ${messageOf(error)}`, { cause: error })
}

/** Rejects with the signal's reason as soon as it aborts, as `fetch` does. */
function raced<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return promise
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason)
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

/** Base64 for bytes, in slices so large bodies stay within the argument limit. */
export function encodeBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let start = 0; start < bytes.length; start += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000))
  }
  return btoa(binary)
}

/** The bytes of a base64 string. */
export function decodeBase64(data: string): Uint8Array<ArrayBuffer> {
  const binary = atob(data)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

/** The response headers, skipping any pair `Headers` refuses rather than failing the request. */
function responseHeaders(pairs: FxmHttpResponseHead['headers']): Headers {
  const headers = new Headers()
  for (const [name, value] of pairs) {
    try {
      headers.append(name, value)
    } catch {
      // A header value outside Latin-1, which no browser would expose either.
    }
  }
  return headers
}

/** The user's answer about one host, or `unavailable` when nobody could be asked. */
type HostAnswer = 'approved' | 'denied' | 'unavailable'

/**
 * What the page keeps about user-added hosts, per plugin, so that every {@link AndroidHttp} over
 * it shares it: the questions on screen, and the hosts the user refused in this session, which
 * requests never ask about again (only {@link AndroidHttp.approveHosts} does).
 */
interface Approvals {
  readonly asking: Map<string, Promise<HostAnswer>>
  readonly denied: Set<string>
}

const approvalsByPlugin = new WeakMap<FxmHttpPlugin, Approvals>()

function approvalsOf(plugin: FxmHttpPlugin): Approvals {
  let approvals = approvalsByPlugin.get(plugin)
  if (approvals === undefined) {
    approvals = { asking: new Map(), denied: new Set() }
    approvalsByPlugin.set(plugin, approvals)
  }
  return approvals
}

/**
 * A host as Settings stores it (`host` or `host:port`) in the form `URL.host` gives it, which is
 * also the form the plugin stores approvals in; `undefined` when it is not a host.
 */
function normalizedHost(entry: string): string | undefined {
  const trimmed = entry.trim()
  if (trimmed === '' || /[/?#@\\\s]/u.test(trimmed)) return undefined
  try {
    return new URL(`https://${trimmed}/`).host
  } catch {
    return undefined
  }
}

/** Releases native responses whose body was dropped unread, once the page collects them. */
interface BodyRegistry {
  register(body: object, id: string, token: object): void
  unregister(token: object): void
}

function bodyRegistry(plugin: FxmHttpPlugin): BodyRegistry | undefined {
  if (typeof FinalizationRegistry !== 'function') return undefined
  return new FinalizationRegistry<string>((id) => {
    void plugin.abort({ id }).catch(noop)
  })
}

/**
 * The body as a stream that reads one chunk from the plugin per pull, so the plugin's buffer is
 * the only one that runs ahead. Aborting the signal or cancelling the stream drops the response,
 * and so does collecting the stream unread (`registry`).
 */
function bodyStream(
  plugin: FxmHttpPlugin,
  id: string,
  readBytes: number,
  signal: AbortSignal | undefined,
  registry: BodyRegistry | undefined,
): ReadableStream<Uint8Array<ArrayBuffer>> {
  let finished = false
  let onAbort: (() => void) | undefined
  const token = {}
  const finish = () => {
    finished = true
    registry?.unregister(token)
    if (onAbort !== undefined) signal?.removeEventListener('abort', onAbort)
  }
  const drop = () => {
    void plugin.abort({ id }).catch(noop)
  }
  const stream = new ReadableStream<Uint8Array<ArrayBuffer>>(
    {
      start(controller) {
        if (signal === undefined) return
        onAbort = () => {
          if (finished) return
          finish()
          controller.error(signal.reason)
          drop()
        }
        if (signal.aborted) onAbort()
        else signal.addEventListener('abort', onAbort, { once: true })
      },
      async pull(controller) {
        let chunk: FxmHttpChunk
        let bytes: Uint8Array<ArrayBuffer> | undefined
        try {
          chunk = await plugin.read({ id, maxBytes: readBytes })
          if (finished) return
          if (chunk.data !== '') bytes = decodeBase64(chunk.data)
        } catch (error) {
          if (finished) return
          finish()
          if (fxmHttpErrorCode(error) === undefined) drop() // not the plugin's: release it
          controller.error(
            new TypeError(`The response body broke off: ${messageOf(error)}`, { cause: error }),
          )
          return
        }
        if (bytes !== undefined) controller.enqueue(bytes)
        if (chunk.done) {
          finish()
          controller.close()
        }
      },
      cancel() {
        if (finished) return
        finish()
        drop()
      },
    },
    { highWaterMark: 0 },
  )
  if (!finished) registry?.register(stream, id, token)
  return stream
}

/**
 * Creates the Android app's {@link NativeHttp} on the `FxmHttp` plugin. It follows the native
 * contract of `native.ts`:
 *
 * - it sends exactly the headers it is given, plus `init.origin` as the plugin's `origin`
 *   header (`''` for `null`, which the plugin sends as no `Origin` at all); an `origin` or
 *   `cookie` in `init.headers` is never sent;
 * - every request goes with `redirect: 'manual'`: a 3xx comes back as it is, with its
 *   `Location`, and the transport follows it;
 * - bodies go as text or base64, and the `Response` streams its body, with `url` and
 *   `redirected` set. An abort rejects with the signal's reason, or errors the body, and cancels
 *   the native call. A streaming body the caller drops unread is released when the page collects
 *   it, but cancel bodies you do not read (`response.body?.cancel()`): until then they hold one
 *   of the plugin's 64 slots, which it frees after a minute at the latest;
 * - a `user` route whose own host the user has not approved asks them in a system dialog, once
 *   per host at a time, and is retried if they allow it (see
 *   {@link AndroidHttpOptions.askToApproveHosts}). After "Don't allow", requests to that host fail
 *   at once for the rest of the session.
 *
 * Errors are as in `fetch` (`TypeError`), except refusals by FXM's network rules:
 * `TransportError`s, with the reason the transports give for the same refusal.
 *
 * Throws an `Unsupported` `FxmError` when there is no plugin, i.e. outside the Android app.
 */
export function createAndroidHttp(options: AndroidHttpOptions = {}): AndroidHttp {
  const found = options.plugin ?? findFxmHttpPlugin()
  if (found === undefined) {
    throw new FxmError('Unsupported', 'Native HTTP needs the Android app’s FxmHttp plugin')
  }
  const plugin: FxmHttpPlugin = found
  const readBytes = Math.max(
    1,
    Math.min(Math.floor(options.readBytes ?? FXM_HTTP_READ_BYTES), FXM_HTTP_MAX_READ_BYTES),
  )
  const askToApproveHosts = options.askToApproveHosts ?? true
  const approvals = approvalsOf(plugin)
  const registry = bodyRegistry(plugin)

  /** Asks the user about one host; concurrent requests to it share the question. */
  function ask(host: string): Promise<HostAnswer> {
    let answer = approvals.asking.get(host)
    if (answer === undefined) {
      answer = plugin
        .approveHosts({ hosts: [host] })
        .then(
          ({ approved }): HostAnswer => (approved.includes(host) ? 'approved' : 'denied'),
          (): HostAnswer => 'unavailable',
        )
        .then((result) => {
          if (result === 'denied') approvals.denied.add(host)
          return result
        })
        .finally(() => approvals.asking.delete(host))
      approvals.asking.set(host, answer)
    }
    return answer
  }

  /** The refusal for a host the user did not allow. */
  function notAllowed(host: string, cause?: unknown): TransportError {
    return new TransportError(
      'unknown-host',
      `You have not allowed FXM to contact ${host}`,
      cause === undefined ? {} : { cause },
    )
  }

  /**
   * The host to ask the user about after `error`: a `user` route's own host, off FXM's table,
   * that the plugin refused because it is not approved. Never the host of a redirect or one on
   * the table, so the dialog only ever names a server the user added.
   */
  function hostToAsk(url: URL, init: NativeRequestInit, error: unknown): string | undefined {
    if (!askToApproveHosts || init.route !== 'user') return undefined
    if (fxmHttpErrorCode(error) !== 'HOST_NOT_APPROVED' || findHostRule(url) !== undefined) {
      return undefined
    }
    return refusedHost(error) === url.host ? url.host : undefined
  }

  /** Sends once; rejects with the plugin's own error so the caller can read its code. */
  async function send(url: string, init: NativeRequestInit): Promise<Response> {
    const { signal, body } = init
    signal?.throwIfAborted()
    const id = nextId()
    const headers: Record<string, string> = {}
    for (const [name, value] of Object.entries(init.headers)) {
      const lower = name.toLowerCase()
      if (lower !== 'origin' && lower !== 'cookie') headers[lower] = value
    }
    headers.origin = init.origin ?? ''
    const request: FxmHttpRequest = {
      id,
      url,
      method: init.method,
      headers,
      ...(body === undefined
        ? {}
        : typeof body === 'string'
          ? { body, bodyEncoding: 'utf8' as const }
          : { body: encodeBase64(body), bodyEncoding: 'base64' as const }),
      redirect: 'manual',
    }
    const onAbort = () => {
      void plugin.abort({ id }).catch(noop)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    let head: FxmHttpResponseHead
    try {
      head = await raced(plugin.request(request), signal)
    } finally {
      signal?.removeEventListener('abort', onAbort)
    }
    const { status } = head
    if (!Number.isInteger(status) || status < 200 || status > 599) {
      onAbort()
      throw Object.assign(new Error(`Unexpected HTTP status ${status}`), { code: 'NETWORK' })
    }
    const hasBody = head.body && !NULL_BODY_STATUSES.has(status) && init.method !== 'HEAD'
    if (head.body && !hasBody) onAbort()
    const responseInit = { status, headers: responseHeaders(head.headers) }
    const stream = hasBody ? bodyStream(plugin, id, readBytes, signal, registry) : null
    let response: Response
    try {
      response = new Response(stream, { ...responseInit, statusText: head.statusText })
    } catch {
      response = new Response(stream, responseInit) // a reason phrase `Response` refuses
    }
    Object.defineProperties(response, {
      url: { value: head.url, enumerable: true },
      redirected: { value: head.redirected, enumerable: true },
    })
    return response
  }

  async function nativeHttp(url: string, init: NativeRequestInit): Promise<Response> {
    const target = new URL(url)
    if (init.route === 'user' && approvals.denied.has(target.host)) {
      init.signal?.throwIfAborted()
      throw notAllowed(target.host)
    }
    try {
      return await send(url, init)
    } catch (error) {
      if (init.signal?.aborted) throw init.signal.reason
      const host = hostToAsk(target, init, error)
      if (host === undefined) throw requestError(error)
      if (approvals.denied.has(host)) throw notAllowed(host, error)
      const answer = await raced(ask(host), init.signal)
      if (answer === 'denied') throw notAllowed(host, error)
      if (answer === 'unavailable') {
        throw new TransportError('unknown-host', `FXM could not ask you about ${host}`, {
          cause: error,
        })
      }
      try {
        return await send(url, init)
      } catch (retryError) {
        if (init.signal?.aborted) throw init.signal.reason
        throw requestError(retryError)
      }
    }
  }

  return Object.assign(nativeHttp, {
    async approveHosts(hosts: Iterable<string>) {
      const asked = [...hosts]
      const normalized = asked.flatMap((host) => normalizedHost(host) ?? [])
      for (const host of normalized) approvals.denied.delete(host)
      const { approved } = await plugin.approveHosts({ hosts: asked })
      for (const host of normalized) {
        if (!approved.includes(host)) approvals.denied.add(host)
      }
      return approved
    },
    async approvedHosts() {
      return (await plugin.approvedHosts()).hosts
    },
    async revokeHosts(hosts: Iterable<string>) {
      return (await plugin.revokeHosts({ hosts: [...hosts] })).hosts
    },
  })
}
