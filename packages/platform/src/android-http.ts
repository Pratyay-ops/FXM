/**
 * The Android app's native HTTP (stage 6.2): a {@link NativeHttp} over `FxmHttp`, FXM's own
 * OkHttp plugin, through the Capacitor bridge. Never Capacitor's global `CapacitorHttp` patch or
 * `CapacitorHttp.request`: both go through `HttpURLConnection`, which sends and stores the
 * WebView's cookies through Capacitor's process-wide cookie handler, and the patch also drops
 * headers and corrupts binary bodies.
 *
 * The plugin keeps FXM's network rules in native code as well, so a request that skipped the
 * transport is held to them too: only hosts on FXM's host table or approved by the user, its own
 * cookie jar (empty unless native code adds a cookie), no `Origin` or `Referer` a host may not
 * receive, and a browser `User-Agent` for Spotify. The same OkHttp client serves the Media3
 * player (stage 6.3). See `apps/mobile/android/fxm-http/README.md`.
 *
 * Bodies stream: the `Response` resolves once the headers are in, and the body arrives in chunks
 * that JavaScript pulls one at a time (`read`), base64-encoded so any byte survives the bridge.
 * Aborting cancels the native call.
 *
 * @module
 */

import { FxmError } from '@fxm/core'
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
 *   header, an id that is in use
 * - `HOST_NOT_ALLOWED`: not HTTPS, credentials in the URL, or a host on FXM's table at another
 *   port or path
 * - `HOST_NOT_APPROVED`: a host outside FXM's table that the user has not approved
 * - `HEADER_NOT_ALLOWED`: an `Origin` or `Referer` the host may not receive
 * - `METHOD_NOT_ALLOWED`: `CONNECT`, `TRACE` or `TRACK`, or anything but `GET` and `HEAD` to a
 *   host the user added
 * - `REDIRECT`: a redirect under `redirect: 'error'`, too many redirects or a broken `Location`
 * - `NETWORK`: the connection failed (DNS, TLS, reset)
 * - `TIMEOUT`: connecting or reading took too long
 * - `ABORTED`: the request was aborted
 * - `UNKNOWN_ID`: no open response has that id (read to the end, aborted, or idle too long)
 * - `BUSY`: too many responses are open at once
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

/** The codes that mean FXM's network rules refused the request: an `Unsupported` `FxmError`. */
const REFUSALS: ReadonlySet<string> = new Set<FxmHttpErrorCode>([
  'HOST_NOT_ALLOWED',
  'HOST_NOT_APPROVED',
  'HEADER_NOT_ALLOWED',
  'METHOD_NOT_ALLOWED',
])

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
  /** Redirect handling, as in `fetch`. Default `follow`. */
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
   * now; hosts approved before are not asked about again.
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
   * and resolves with those that are approved.
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
   * Whether a request to a host the user added but has not approved yet asks them first (once per
   * host at a time) and is retried when they allow it. Default `true`; with `false` it fails with
   * an `Unsupported` `FxmError`.
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

function messageOf(error: unknown): string {
  const message = (error as { message?: unknown } | null)?.message
  return typeof message === 'string' && message !== '' ? message : 'the request failed'
}

/**
 * The error `fetch` would give for a failed request: an `Unsupported` `FxmError` when FXM's
 * network rules refused it, as the transports refuse what they cannot reach, else a `TypeError`
 * (as for a network failure in `fetch`) with the plugin's error as its `cause`.
 */
function requestError(error: unknown): Error {
  const code = fxmHttpErrorCode(error)
  if (code !== undefined && REFUSALS.has(code)) {
    return new FxmError('Unsupported', messageOf(error), { cause: error })
  }
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

/**
 * The body as a stream that reads one chunk from the plugin per pull, so the plugin's buffer is
 * the only one that runs ahead. Aborting the signal or cancelling the stream drops the response.
 */
function bodyStream(
  plugin: FxmHttpPlugin,
  id: string,
  readBytes: number,
  signal: AbortSignal | undefined,
): ReadableStream<Uint8Array<ArrayBuffer>> {
  let finished = false
  let onAbort: (() => void) | undefined
  const finish = () => {
    finished = true
    if (onAbort !== undefined) signal?.removeEventListener('abort', onAbort)
  }
  const drop = () => {
    void plugin.abort({ id }).catch(noop)
  }
  return new ReadableStream<Uint8Array<ArrayBuffer>>(
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
}

/**
 * Creates the Android app's {@link NativeHttp} on the `FxmHttp` plugin. It follows the native
 * contract of `native.ts`: it sends exactly the headers it is given (`origin: ''` reaches the
 * plugin, which sends no `Origin` then), bodies as text or base64, and resolves with a standard
 * `Response` whose body streams, with `url` and `redirected` set. An abort rejects with the
 * signal's reason, or errors the body, and cancels the native call. Errors are as in `fetch`
 * (`TypeError`), except refusals by FXM's network rules: `Unsupported` `FxmError`s.
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
  const asking = new Map<string, Promise<boolean>>()

  /** Asks the user about one host; concurrent requests to it share the question. */
  function approve(host: string): Promise<boolean> {
    let answer = asking.get(host)
    if (answer === undefined) {
      answer = plugin
        .approveHosts({ hosts: [host] })
        .then(
          ({ approved }) => approved.includes(host),
          () => false,
        )
        .finally(() => asking.delete(host))
      asking.set(host, answer)
    }
    return answer
  }

  /** Sends once; rejects with the plugin's own error so the caller can read its code. */
  async function send(url: string, init: NativeRequestInit): Promise<Response> {
    const { signal } = init
    signal?.throwIfAborted()
    const id = nextId()
    const { body } = init
    const request: FxmHttpRequest = {
      id,
      url,
      method: init.method,
      headers: { ...init.headers },
      ...(body === undefined
        ? {}
        : typeof body === 'string'
          ? { body, bodyEncoding: 'utf8' as const }
          : { body: encodeBase64(body), bodyEncoding: 'base64' as const }),
      ...(init.redirect === undefined ? {} : { redirect: init.redirect }),
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
    const stream = hasBody ? bodyStream(plugin, id, readBytes, signal) : null
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
    try {
      return await send(url, init)
    } catch (error) {
      if (init.signal?.aborted) throw init.signal.reason
      if (askToApproveHosts && fxmHttpErrorCode(error) === 'HOST_NOT_APPROVED') {
        const host = new URL(url).host
        if (await raced(approve(host), init.signal)) {
          try {
            return await send(url, init)
          } catch (retryError) {
            if (init.signal?.aborted) throw init.signal.reason
            throw requestError(retryError)
          }
        }
        init.signal?.throwIfAborted()
        throw new FxmError('Unsupported', `You have not allowed FXM to contact ${host}`, {
          cause: error,
        })
      }
      throw requestError(error)
    }
  }

  return Object.assign(nativeHttp, {
    async approveHosts(hosts: Iterable<string>) {
      return (await plugin.approveHosts({ hosts: [...hosts] })).approved
    },
    async approvedHosts() {
      return (await plugin.approvedHosts()).hosts
    },
    async revokeHosts(hosts: Iterable<string>) {
      return (await plugin.revokeHosts({ hosts: [...hosts] })).hosts
    },
  })
}
