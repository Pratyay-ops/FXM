/**
 * The page's side of the Lite tier: a {@link SandboxTransport} that sends InnerTube calls through
 * `/sandbox/innertube.html` and user-host fetches through `/sandbox/userhost.html`.
 *
 * Each document is framed once, on first use, in a hidden `<iframe sandbox="allow-scripts">`
 * (no `allow-same-origin`), so it has an opaque origin even where its own sandbox header is
 * missing. The frame's URL carries a fresh random token as its fragment. The page accepts the
 * document's `hello` only from that frame, from an opaque origin and with that token, then hands
 * it a `MessagePort`, and sends requests on the port only once the token came back on it. See
 * `document.ts` for the protocol and the document's checks, which the page also runs before it
 * posts anything, so refused requests fail at once.
 *
 * The transport draws nothing from the request budget itself: the transports (`createWebTransport`)
 * draw one slot for every InnerTube call they route here, and the Lite tier's gate
 * (`createLiteTier`) one for the self-test.
 *
 * @module
 */

import { FxmError, isFxmError } from '@fxm/core'
import { type Clock, systemClock } from '../clock'
import { isTransportError } from '../errors'
import { SIMPLE_CONTENT_TYPE, type SimpleInnerTubeRequest } from '../innertube'
import type { SandboxTransport, SelfTestResult, UserHostInit } from '../lite'
import {
  checkSandboxRequest,
  SANDBOX_DOCUMENT_POLICIES,
  SANDBOX_MESSAGE,
  SANDBOX_PROTOCOL,
  type SandboxDocumentKind,
  type SandboxRequestFields,
  type SandboxRequestMessage,
} from './document'
import { isSandboxError, SandboxFailedError, sandboxError } from './errors'

/** Where FXM publishes each sandbox document, on its own origin. */
export const SANDBOX_DOCUMENT_PATHS: Readonly<Record<SandboxDocumentKind, string>> = {
  innertube: '/sandbox/innertube.html',
  userhost: '/sandbox/userhost.html',
}

/** How long a document may take to load and finish its handshake, in milliseconds. */
export const SANDBOX_LOAD_TIMEOUT_MS = 10_000

/**
 * How much longer than a request's own timeout the page waits for the document's reply before
 * it gives the document up for lost, in milliseconds.
 */
export const SANDBOX_REPLY_MARGIN_MS = 5_000

/**
 * The client the default self-test presents itself as: YouTube Music's web client, with the
 * version of the YouTube provider's bundled `youtube-config.json` (stage 1.3).
 */
export const SANDBOX_SELF_TEST_CLIENT = {
  clientName: 'WEB_REMIX',
  clientVersion: '1.20261020.10.00',
  hl: 'en',
} as const

/**
 * The default self-test: one YouTube Music search suggestion request, the smallest call on the
 * allowlist. The app may pass the YouTube provider's own request instead
 * ({@link SandboxTransportOptions.selfTestRequest}), so its client version stays current.
 */
export function defaultSelfTestRequest(): SimpleInnerTubeRequest {
  return {
    url: 'https://music.youtube.com/youtubei/v1/music/get_search_suggestions?prettyPrint=false',
    init: {
      method: 'POST',
      headers: { 'content-type': SIMPLE_CONTENT_TYPE },
      body: JSON.stringify({ context: { client: SANDBOX_SELF_TEST_CLIENT }, input: 'music' }),
      credentials: 'omit',
    },
  }
}

/**
 * The parts of the page's `window` the transport uses. `navigator.onLine` tells an offline
 * browser from InnerTube refusing the self-test.
 */
export type SandboxHostWindow = Pick<
  Window,
  'location' | 'document' | 'addEventListener' | 'removeEventListener'
> & { readonly navigator?: { readonly onLine?: boolean } }

/** Options for one sandbox document. */
export interface SandboxDocumentOptions {
  /**
   * Where the document is served, on the page's own origin. Default:
   * {@link SANDBOX_DOCUMENT_PATHS} on the page's origin.
   */
  readonly url?: string | URL
  /** Longest a request may take, in milliseconds. At most, and by default, the document's limit. */
  readonly timeoutMs?: number
  /** Largest response body, in bytes. At most, and by default, the document's limit. */
  readonly maxResponseBytes?: number
}

/** Options for {@link createSandboxTransport}. */
export interface SandboxTransportOptions {
  /** The page. Default: the global `window`. */
  readonly window?: SandboxHostWindow
  /** `innertube.html`. */
  readonly innerTube?: SandboxDocumentOptions
  /** `userhost.html`. */
  readonly userHost?: SandboxDocumentOptions
  /**
   * The InnerTube request the self-test sends, or a function that builds it, e.g. from the
   * YouTube provider's config. Default {@link defaultSelfTestRequest}.
   */
  readonly selfTestRequest?:
    | SimpleInnerTubeRequest
    | (() => SimpleInnerTubeRequest | Promise<SimpleInnerTubeRequest>)
  /** How long a document may take to load. Default {@link SANDBOX_LOAD_TIMEOUT_MS}. */
  readonly loadTimeoutMs?: number
  /** The clock, for tests. */
  readonly clock?: Clock
}

/** The Lite tier's sandbox documents, as the page uses them. */
export interface BrowserSandboxTransport extends SandboxTransport {
  /** Fetches from a host the user added in Settings: GET or HEAD, without any header. */
  userHost(url: string, init: UserHostInit): Promise<Response>
  /** Removes the frames. Requests in flight, and later ones, reject. */
  dispose(): void
}

/** A framed document and its port. */
interface Connection {
  readonly kind: SandboxDocumentKind
  /** Resolves with the port once the document said `hello` and then `ready` with the token. */
  readonly ready: Promise<MessagePort>
  /** Whether the connection was closed: requests can no longer use it. */
  readonly closed: boolean
  /** Why it was closed, once it is. */
  readonly reason: unknown
  /** Removes the frame and fails what waits on it. */
  close(error: unknown): void
}

/** A request waiting for its reply. */
interface Pending {
  readonly connection: Connection
  settle(outcome: { readonly response: Response } | { readonly error: unknown }): void
}

/** Statuses whose responses have no body. */
const NULL_BODY_STATUSES = [101, 103, 204, 205, 304]

/** Plain-object check that also accepts objects from another realm. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return Object.prototype.toString.call(value) === '[object Object]'
}

/** A positive limit no larger than `max`: `requested` when it is one, else `max`. */
function within(requested: number | undefined, max: number): number {
  return requested !== undefined && Number.isFinite(requested) && requested > 0
    ? Math.min(requested, max)
    : max
}

/** `count` random bytes as lower-case hexadecimal digits. */
function randomHex(count: number): string {
  const bytes = new Uint8Array(count)
  globalThis.crypto.getRandomValues(bytes)
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** Whether an InnerTube answer is usable: a JSON object with a `responseContext`. */
function isUsableAnswer(json: unknown): boolean {
  return isRecord(json) && isRecord(json.responseContext)
}

/** `promise`, or the signal's reason once it aborts. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return promise
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
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

/**
 * The `Response` a `response` message describes, or `undefined` when the message is malformed
 * or its body is larger than `maxBytes`.
 */
function toResponse(data: Record<string, unknown>, maxBytes: number): Response | undefined {
  const { status, statusText, url, redirected, headers, body } = data
  if (typeof status !== 'number' || !Number.isInteger(status) || status < 200 || status > 599) {
    return undefined
  }
  if (!(body instanceof ArrayBuffer) || body.byteLength > maxBytes) return undefined
  const responseHeaders = new Headers()
  if (Array.isArray(headers)) {
    for (const pair of headers) {
      if (!Array.isArray(pair) || typeof pair[0] !== 'string' || typeof pair[1] !== 'string') {
        continue
      }
      try {
        responseHeaders.append(pair[0], pair[1])
      } catch {
        // An invalid header name or value is dropped.
      }
    }
  }
  const content = NULL_BODY_STATUSES.includes(status) ? null : body
  let response: Response
  try {
    response = new Response(content, {
      status,
      statusText: typeof statusText === 'string' ? statusText : '',
      headers: responseHeaders,
    })
  } catch {
    // A status text that is not a valid reason phrase.
    response = new Response(content, { status, headers: responseHeaders })
  }
  // As the document saw them, so the transports' redirect checks see them too.
  if (typeof url === 'string' && url !== '') {
    Object.defineProperty(response, 'url', { value: url, enumerable: true })
  }
  if (redirected === true) {
    Object.defineProperty(response, 'redirected', { value: true, enumerable: true })
  }
  return response
}

/**
 * What a self-test's answer says: `pass` for a usable one; `unreachable` for HTTP 429 and 5xx,
 * which say nothing about the sandbox; `refused` for any other error status and for an unusable
 * body.
 */
async function answerVerdict(response: Response): Promise<SelfTestResult> {
  if (response.status === 429 || response.status >= 500) return 'unreachable'
  if (!response.ok) return 'refused'
  try {
    return isUsableAnswer(await response.json()) ? 'pass' : 'refused'
  } catch {
    return 'refused'
  }
}

/**
 * What a failed self-test says. A `network` failure once the document had loaded is `refused`,
 * since a CORS refusal looks like a network error and the document's load showed that the FXM
 * origin is reachable, unless the browser says it is offline. Refusals by the checks, a response
 * over the cap and other `Unsupported` errors (a document of another protocol, a document URL on
 * another origin) are `refused` too, being definite. A document that did not load, a timeout, a
 * redirect and anything else are `unreachable`.
 */
function failureVerdict(error: unknown, connected: boolean, offline: boolean): SelfTestResult {
  if (isSandboxError(error)) {
    switch (error.sandboxCode) {
      case 'network':
        return connected && !offline ? 'refused' : 'unreachable'
      case 'too-large':
        return 'refused'
      case 'redirect':
      case 'timeout':
        return 'unreachable'
      default:
        return isTransportError(error) ? 'refused' : 'unreachable'
    }
  }
  return isFxmError(error, 'Unsupported') ? 'refused' : 'unreachable'
}

/**
 * Creates the page's side of the sandbox documents. Nothing is framed until the first request,
 * so creating it is free when FXM Connect or a kill switch means Lite is never used.
 *
 * - `innerTube(request)` sends a request in the CORS-simple shape (`toSimpleInnerTubeRequest`)
 *   through `innertube.html`;
 * - `userHost(url, init)` fetches through `userhost.html`;
 * - `selfTest()` sends one real InnerTube request and resolves with what it says (`pass`,
 *   `refused` or `unreachable`; see `failureVerdict` for the failures).
 *
 * Requests the documents would refuse reject at once with a `SandboxRefusedError` (a
 * `TransportError`), as do the documents' own refusals; failures once sent reject with a
 * `SandboxFailedError` (`Network`, or `Parse` for a response over the cap). A document that does
 * not load, or stops answering, is removed, and the next request frames a new one.
 *
 * The handshake's token keeps a page that frames this one from swapping its own document into the
 * sandbox frame and taking the requests. A page that creates the transport should still forbid
 * other frames with `frame-src 'self'`, as FXM's pages do (stage 2.8): then another site cannot
 * put a document of its own into the frame at all, and can at most break the frame, which it can
 * always do to a page it frames.
 */
export function createSandboxTransport(
  options: SandboxTransportOptions = {},
): BrowserSandboxTransport {
  const page = options.window ?? (globalThis as { window?: SandboxHostWindow }).window
  if (page === undefined) {
    throw new FxmError('Unsupported', 'The sandbox documents need a browser page')
  }
  const host: SandboxHostWindow = page
  const clock = options.clock ?? systemClock
  const loadTimeoutMs = options.loadTimeoutMs ?? SANDBOX_LOAD_TIMEOUT_MS
  const selfTestRequest = options.selfTestRequest ?? defaultSelfTestRequest
  const documents: Record<SandboxDocumentKind, SandboxDocumentOptions> = {
    innertube: options.innerTube ?? {},
    userhost: options.userHost ?? {},
  }
  const limits = (kind: SandboxDocumentKind) => ({
    timeoutMs: within(documents[kind].timeoutMs, SANDBOX_DOCUMENT_POLICIES[kind].timeoutMs),
    maxResponseBytes: within(
      documents[kind].maxResponseBytes,
      SANDBOX_DOCUMENT_POLICIES[kind].maxResponseBytes,
    ),
  })
  const connections = new Map<SandboxDocumentKind, Connection>()
  const pending = new Map<string, Pending>()
  const idPrefix = randomHex(6)
  let nextId = 0
  let disposed = false

  const disposedError = () => new FxmError('Unsupported', 'The sandbox transport was disposed')

  /** The document's URL, which must be on the page's own origin, without a fragment. */
  function documentUrl(kind: SandboxDocumentKind): URL {
    let url: URL
    try {
      url = new URL(documents[kind].url ?? SANDBOX_DOCUMENT_PATHS[kind], host.location.origin)
    } catch (cause) {
      throw new FxmError('Unsupported', `No URL for the ${kind} sandbox document`, { cause })
    }
    // The document talks only to the origin it is served from.
    if (url.origin !== host.location.origin) {
      throw new FxmError(
        'Unsupported',
        `The ${kind} sandbox document must be served from ${host.location.origin}, not ${url.origin}`,
      )
    }
    url.hash = ''
    return url
  }

  function onReply(connection: Connection, data: unknown): void {
    if (!isRecord(data) || typeof data.id !== 'string') return
    const request = pending.get(data.id)
    if (request === undefined || request.connection !== connection) return
    if (data.type === SANDBOX_MESSAGE.response) {
      const response = toResponse(data, limits(connection.kind).maxResponseBytes)
      request.settle(
        response === undefined
          ? { error: new SandboxFailedError('network', 'The sandbox sent a malformed response') }
          : { response },
      )
    } else if (data.type === SANDBOX_MESSAGE.error) {
      const code = typeof data.code === 'string' ? data.code.slice(0, 64) : 'network'
      const message = typeof data.message === 'string' ? data.message.slice(0, 500) : undefined
      request.settle({ error: sandboxError(code, message) })
    }
  }

  function open(kind: SandboxDocumentKind): Connection {
    const url = documentUrl(kind)
    const where = url.href
    const parent = host.document.body ?? host.document.documentElement
    if (parent === null) throw new FxmError('Unsupported', 'The page has no element to frame in')
    // Only the document loaded at this URL can read the token; it proves the document's messages.
    const token = randomHex(16)
    url.hash = token
    const frame = host.document.createElement('iframe')
    let port: MessagePort | undefined
    let connected = false
    let closed = false
    let reason: unknown
    let resolveReady: (port: MessagePort) => void = () => undefined
    let rejectReady: (error: unknown) => void = () => undefined
    const ready = new Promise<MessagePort>((resolve, reject) => {
      resolveReady = resolve
      rejectReady = reject
    })
    // Whoever waits for the port sees the failure; nobody may be waiting.
    ready.catch(() => undefined)

    const impostor = () =>
      new SandboxFailedError(
        'network',
        `The sandbox frame holds a document this page did not frame, not ${where}`,
      )

    const onPortMessage = (event: MessageEvent) => {
      if (connected) {
        onReply(connection, event.data)
        return
      }
      // The first message must be the document's `ready` with the token: anything else means the
      // port went to another document, swapped into the frame after the `hello`.
      const data: unknown = event.data
      if (!isRecord(data) || data.type !== SANDBOX_MESSAGE.ready || data.token !== token) {
        connection.close(impostor())
        return
      }
      connected = true
      clock.clearTimeout(loadTimer)
      if (port !== undefined) resolveReady(port)
    }

    const onMessage = (event: MessageEvent) => {
      const source = frame.contentWindow
      // Only this frame's document, from an opaque origin, may say hello.
      if (closed || port !== undefined || source === null) return
      if (event.source !== source || event.origin !== 'null') return
      const data: unknown = event.data
      if (!isRecord(data) || data.type !== SANDBOX_MESSAGE.hello) return
      if (data.protocol !== SANDBOX_PROTOCOL || data.document !== kind) {
        connection.close(
          new FxmError(
            'Unsupported',
            `The document at ${where} is not the ${kind} sandbox of protocol ${SANDBOX_PROTOCOL}`,
          ),
        )
        return
      }
      if (data.token !== token) {
        connection.close(impostor())
        return
      }
      host.removeEventListener('message', onMessage)
      const channel = new MessageChannel()
      port = channel.port1
      port.addEventListener('message', onPortMessage)
      port.start()
      // An opaque origin has no name to address it by, so the target origin is '*'. Should
      // another document have taken the frame's place, it gets the port but not the token, and
      // the page sends nothing on the port until the token comes back on it.
      source.postMessage({ type: SANDBOX_MESSAGE.connect, protocol: SANDBOX_PROTOCOL }, '*', [
        channel.port2,
      ])
    }

    const connection: Connection = {
      kind,
      ready,
      get closed() {
        return closed
      },
      get reason() {
        return reason
      },
      close(error) {
        if (closed) return
        closed = true
        reason = error
        clock.clearTimeout(loadTimer)
        host.removeEventListener('message', onMessage)
        port?.removeEventListener('message', onPortMessage)
        port?.close()
        frame.remove()
        if (connections.get(kind) === connection) connections.delete(kind)
        rejectReady(error)
        for (const request of [...pending.values()]) {
          if (request.connection === connection) request.settle({ error })
        }
      },
    }

    const loadTimer = clock.setTimeout(() => {
      connection.close(
        new SandboxFailedError('timeout', `The sandbox document at ${where} did not load`),
      )
    }, loadTimeoutMs)
    host.addEventListener('message', onMessage)
    frame.setAttribute('sandbox', 'allow-scripts')
    frame.setAttribute('title', `FXM ${kind} sandbox`)
    frame.setAttribute('aria-hidden', 'true')
    frame.setAttribute('tabindex', '-1')
    frame.setAttribute('referrerpolicy', 'no-referrer')
    frame.hidden = true
    frame.src = url.href
    parent.appendChild(frame)
    return connection
  }

  function connect(kind: SandboxDocumentKind): Connection {
    let connection = connections.get(kind)
    if (connection === undefined) {
      connection = open(kind)
      connections.set(kind, connection)
    }
    return connection
  }

  /**
   * Sends one request through a document. `onConnected` runs once the document is ready for it,
   * before it is posted.
   */
  async function send(
    kind: SandboxDocumentKind,
    fields: SandboxRequestFields,
    signal: AbortSignal | undefined,
    onConnected?: () => void,
  ): Promise<Response> {
    signal?.throwIfAborted()
    if (disposed) throw disposedError()
    const refused = checkSandboxRequest(SANDBOX_DOCUMENT_POLICIES[kind], fields)
    if (refused !== undefined) throw sandboxError(refused.code, refused.message)
    const connection = connect(kind)
    const port = await untilAborted(connection.ready, signal)
    signal?.throwIfAborted()
    // `dispose()`, or a failure of another request, may have closed the connection meanwhile.
    if (disposed) throw disposedError()
    if (connection.closed) throw connection.reason
    onConnected?.()
    nextId += 1
    const id = `${idPrefix}.${nextId}`
    const { timeoutMs, maxResponseBytes } = limits(kind)

    return new Promise<Response>((resolve, reject) => {
      let settled = false
      const onAbort = () => {
        port.postMessage({ type: SANDBOX_MESSAGE.abort, id })
        settle({ error: signal?.reason })
      }
      // No reply at all means the document is gone or stuck: this request fails, and the next
      // one frames a new document.
      const timer = clock.setTimeout(() => {
        const error = new SandboxFailedError('timeout', 'The sandbox document stopped answering')
        settle({ error })
        connection.close(error)
      }, timeoutMs + SANDBOX_REPLY_MARGIN_MS)
      function settle(outcome: { readonly response: Response } | { readonly error: unknown }) {
        if (settled) return
        settled = true
        pending.delete(id)
        clock.clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        if ('response' in outcome) resolve(outcome.response)
        else reject(outcome.error)
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      pending.set(id, { connection, settle })
      const message: SandboxRequestMessage = {
        type: SANDBOX_MESSAGE.request,
        id,
        url: fields.url,
        method: fields.method,
        headers: fields.headers ?? {},
        ...(fields.body === undefined ? {} : { body: fields.body }),
        timeoutMs,
        maxResponseBytes,
      }
      port.postMessage(message)
    })
  }

  return {
    async selfTest(testOptions = {}) {
      const { signal } = testOptions
      let connected = false
      try {
        const request =
          typeof selfTestRequest === 'function' ? await selfTestRequest() : selfTestRequest
        const response = await send(
          'innertube',
          {
            url: request.url,
            method: request.init.method,
            headers: request.init.headers,
            body: request.init.body,
          },
          signal,
          () => {
            connected = true
          },
        )
        return await answerVerdict(response)
      } catch (error) {
        if (signal?.aborted) throw signal.reason ?? error
        return failureVerdict(error, connected, host.navigator?.onLine === false)
      }
    },
    innerTube(request) {
      const { method, headers, body, signal } = request.init
      return send('innertube', { url: request.url, method, headers, body }, signal)
    },
    userHost(url, init) {
      return send('userhost', { url, method: init.method, headers: {} }, init.signal)
    },
    dispose() {
      if (disposed) return
      disposed = true
      for (const connection of [...connections.values()]) connection.close(disposedError())
    },
  }
}
