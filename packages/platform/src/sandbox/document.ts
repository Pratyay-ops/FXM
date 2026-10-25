/**
 * The script inside FXM's sandbox documents, `/sandbox/innertube.html` and
 * `/sandbox/userhost.html`, and the message protocol the page speaks with them.
 *
 * Each document has an opaque origin however it is loaded: it is served with a policy that starts
 * with `sandbox allow-scripts`, and FXM frames it with `sandbox="allow-scripts"` as well. Its
 * requests therefore carry `Origin: null` and no cookies, which InnerTube answers for CORS-simple
 * POSTs (measured 2026-10-25), and FXM Connect's rules, scoped to the FXM origin, never match
 * them.
 *
 * The protocol:
 *
 * 1. The document posts `hello` to its parent, addressed to the FXM origin only: the origin of
 *    the document's own URL, which is where FXM serves it.
 * 2. The page answers with `connect` and a `MessagePort`. The document accepts it only when the
 *    message's `origin` is the FXM origin and its `source` is the parent, and only once.
 * 3. Requests, cancellations and replies then travel on that port, which only the page holds.
 *
 * Every request passes {@link checkSandboxRequest} against the document's policy (hosts, paths,
 * methods, headers and sizes) before it is sent, with `credentials: 'omit'`, no referrer and a
 * timeout, and its response body is read up to a size cap.
 *
 * This file is self-contained on purpose: `tools/render.ts` strips its types and inlines it into
 * both documents, whose policy allows that one script by hash. It must not import anything but
 * types, and may use only erasable TypeScript syntax (no enums, namespaces or parameter
 * properties).
 *
 * @module
 */

/** The version of the protocol between the page and the documents. */
export const SANDBOX_PROTOCOL = 1

/** The message types of the protocol. */
export const SANDBOX_MESSAGE = {
  /** Document to page, as a window message: the document is ready for its port. */
  hello: 'fxm-sandbox:hello',
  /** Page to document, as a window message carrying a `MessagePort`: requests follow on it. */
  connect: 'fxm-sandbox:connect',
  /** Page to document, on the port: send a request. */
  request: 'fxm-sandbox:request',
  /** Page to document, on the port: cancel a request. */
  abort: 'fxm-sandbox:abort',
  /** Document to page, on the port: a response. */
  response: 'fxm-sandbox:response',
  /** Document to page, on the port: the request was refused or failed. */
  error: 'fxm-sandbox:error',
} as const

/**
 * Why a sandbox document refused or failed a request (`SANDBOX_ERROR_CODES` in `errors.ts`
 * lists them):
 *
 * - `bad-request`: the request is malformed (no absolute URL, no string body for a POST, a body
 *   on a GET)
 * - `forbidden-host`: not an `https:` URL to an allowed host, or it has credentials or a port the
 *   document does not allow
 * - `forbidden-path`: a path outside the document's allowlist
 * - `forbidden-method`: a CORS-safelisted method the document does not send (`GET` to InnerTube,
 *   `POST` to a user host)
 * - `forbidden-header`: a header on a request that may carry none (user hosts)
 * - `preflight`: the request would make the browser send a CORS preflight, which InnerTube
 *   refuses from an opaque origin: a header that is not CORS-safelisted, or a method other than
 *   `GET`, `HEAD` and `POST`
 * - `too-large`: the request or the response is larger than the document allows
 * - `timeout`: no complete response in time
 * - `network`: the request failed: offline, refused by CORS or the document's policy, or a
 *   redirect where none is allowed
 */
export type SandboxErrorCode =
  | 'bad-request'
  | 'forbidden-host'
  | 'forbidden-path'
  | 'forbidden-method'
  | 'forbidden-header'
  | 'preflight'
  | 'too-large'
  | 'timeout'
  | 'network'

/** The two sandbox documents. */
export type SandboxDocumentKind = 'innertube' | 'userhost'

/** The InnerTube hosts `innertube.html` sends to. */
export const SANDBOX_INNERTUBE_HOSTS = [
  'www.youtube.com',
  'music.youtube.com',
  'youtubei.googleapis.com',
] as const

/** The InnerTube paths `innertube.html` sends to, on any of its hosts. */
export const SANDBOX_INNERTUBE_PATHS = [
  '/youtubei/v1/search',
  '/youtubei/v1/next',
  '/youtubei/v1/browse',
  '/youtubei/v1/player',
  '/youtubei/v1/music/get_search_suggestions',
] as const

/** What a sandbox document sends, and the limits it keeps. */
export interface SandboxDocumentPolicy {
  /** Which document this is. */
  readonly kind: SandboxDocumentKind
  /** Host names requests may go to (lower case); `undefined` for any host. */
  readonly hosts: readonly string[] | undefined
  /** Whether a URL may name a port; without it only the default port (443) is allowed. */
  readonly ports: boolean
  /** Paths requests may go to, matched exactly; `undefined` for any path. */
  readonly paths: readonly string[] | undefined
  /** Methods the document sends, upper case. */
  readonly methods: readonly string[]
  /**
   * The headers a request may carry: `cors-simple` for CORS-safelisted headers only, `none` for
   * no header at all.
   */
  readonly headers: 'cors-simple' | 'none'
  /** Whether requests carry a string body (POST) rather than none (GET and HEAD). */
  readonly body: boolean
  /** Largest request body, in UTF-8 bytes. */
  readonly maxRequestBytes: number
  /** Largest response body the document reads, in bytes. A request may ask for less. */
  readonly maxResponseBytes: number
  /** Longest a request may take, headers and body, in milliseconds. A request may ask for less. */
  readonly timeoutMs: number
  /** Whether the document follows redirects or fails on them. */
  readonly redirect: 'error' | 'follow'
}

const MIB = 1024 * 1024

/**
 * `innertube.html`: CORS-simple POSTs to InnerTube's API on its three hosts and five paths, the
 * ones FXM uses. InnerTube answers them from an opaque origin with
 * `Access-Control-Allow-Origin: null`, and refuses preflights from it.
 */
export const INNERTUBE_DOCUMENT_POLICY: SandboxDocumentPolicy = Object.freeze({
  kind: 'innertube',
  hosts: SANDBOX_INNERTUBE_HOSTS,
  ports: false,
  paths: SANDBOX_INNERTUBE_PATHS,
  methods: ['POST'],
  headers: 'cors-simple',
  body: true,
  maxRequestBytes: MIB,
  maxResponseBytes: 8 * MIB,
  timeoutMs: 20_000,
  redirect: 'error',
})

/**
 * `userhost.html`: GET and HEAD requests without any header to hosts the user added in Settings,
 * such as an Invidious instance or the Spotify secret source. The page decides which hosts those
 * are; the document's policy (`connect-src https:`) allows any HTTPS host.
 */
export const USER_HOST_DOCUMENT_POLICY: SandboxDocumentPolicy = Object.freeze({
  kind: 'userhost',
  hosts: undefined,
  ports: true,
  paths: undefined,
  methods: ['GET', 'HEAD'],
  headers: 'none',
  body: false,
  maxRequestBytes: 0,
  maxResponseBytes: 4 * MIB,
  timeoutMs: 20_000,
  redirect: 'follow',
})

/** The policy of each document. Each document's script starts with its entry. */
export const SANDBOX_DOCUMENT_POLICIES: Readonly<
  Record<SandboxDocumentKind, SandboxDocumentPolicy>
> = Object.freeze({ innertube: INNERTUBE_DOCUMENT_POLICY, userhost: USER_HOST_DOCUMENT_POLICY })

/** The fields of a request, as the page sends them in a `request` message. */
export interface SandboxRequestFields {
  /** The absolute URL. */
  readonly url: string
  /** The method. */
  readonly method: string
  /** The headers, as a plain object. */
  readonly headers?: Readonly<Record<string, string>>
  /** The body: a string for POST requests, absent otherwise. */
  readonly body?: string
}

/** A `request` message: one request and the limits the page asks for. */
export interface SandboxRequestMessage extends SandboxRequestFields {
  /** Always {@link SANDBOX_MESSAGE}`.request`. */
  readonly type: typeof SANDBOX_MESSAGE.request
  /** Identifies the request in the reply; unique among the page's requests. */
  readonly id: string
  /** At most this long, in milliseconds; never longer than the document's own limit. */
  readonly timeoutMs?: number
  /** At most this many response bytes; never more than the document's own limit. */
  readonly maxResponseBytes?: number
}

/** A `response` message. */
export interface SandboxResponseMessage {
  /** Always {@link SANDBOX_MESSAGE}`.response`. */
  readonly type: typeof SANDBOX_MESSAGE.response
  /** The request's ID. */
  readonly id: string
  /** The HTTP status. */
  readonly status: number
  /** The HTTP status text. */
  readonly statusText: string
  /** The response's URL. */
  readonly url: string
  /** The response headers the document could read (CORS hides the rest). */
  readonly headers: readonly (readonly [string, string])[]
  /** The body, transferred. */
  readonly body: ArrayBuffer
}

/** An `error` message. */
export interface SandboxErrorMessage {
  /** Always {@link SANDBOX_MESSAGE}`.error`. */
  readonly type: typeof SANDBOX_MESSAGE.error
  /** The request's ID. */
  readonly id: string
  /** Why it failed. */
  readonly code: SandboxErrorCode
  /** Details, for logs. */
  readonly message: string
}

/** Why {@link checkSandboxRequest} refused a request. */
export interface SandboxRefusal {
  /** The reason, as an error code. */
  readonly code: SandboxErrorCode
  /** Details, for logs. */
  readonly message: string
}

/** Longest URL a document accepts. */
const MAX_URL_LENGTH = 8192

/** Methods that never cause a CORS preflight. */
const SAFELISTED_METHODS = ['GET', 'HEAD', 'POST']

/** `Content-Type` essences that never cause a preflight. */
const SAFELISTED_CONTENT_TYPES = [
  'application/x-www-form-urlencoded',
  'multipart/form-data',
  'text/plain',
]

/** The printable "CORS-unsafe request-header bytes" of the Fetch standard. */
const UNSAFE_PRINTABLE = '"():<>?@[\\]{}'

/** The bytes `Accept-Language` and `Content-Language` may hold. */
const LANGUAGE_VALUE = /^[0-9A-Za-z *,\-.;=]*$/

/** A single range with a start, such as `bytes=0-` (suffix ranges are not safelisted). */
const SIMPLE_RANGE = /^bytes=(\d+)-(\d*)$/

/** Whether a header value holds a CORS-unsafe request-header byte. */
function hasUnsafeByte(value: string): boolean {
  for (const char of value) {
    const code = char.charCodeAt(0)
    if ((code < 0x20 && code !== 0x09) || code === 0x7f || UNSAFE_PRINTABLE.includes(char)) {
      return true
    }
  }
  return false
}

/**
 * Whether a header (name in lower case) is CORS-safelisted, so that it never causes a preflight.
 * The same rules as `isCorsSafelistedRequestHeader` in `src/cors.ts`, repeated here because this
 * file must stand alone; a test keeps the two in step.
 */
export function isSafelistedHeader(name: string, value: string): boolean {
  if (value.length > 128) return false
  switch (name) {
    case 'accept':
      return !hasUnsafeByte(value)
    case 'accept-language':
    case 'content-language':
      return LANGUAGE_VALUE.test(value)
    case 'content-type': {
      if (hasUnsafeByte(value)) return false
      const essence = (value.split(';', 1)[0] ?? '').trim().toLowerCase()
      return SAFELISTED_CONTENT_TYPES.includes(essence)
    }
    case 'range': {
      const match = SIMPLE_RANGE.exec(value)
      if (match === null) return false
      const end = match[2] ?? ''
      return end === '' || Number(match[1]) <= Number(end)
    }
    default:
      return false
  }
}

/** Plain-object check that also accepts objects from another realm. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return Object.prototype.toString.call(value) === '[object Object]'
}

/** The headers as `[lower-case name, value]` pairs, or `undefined` when they are malformed. */
function headerPairs(headers: unknown): [string, string][] | undefined {
  if (headers === undefined || headers === null) return []
  if (!isRecord(headers)) return undefined
  const pairs: [string, string][] = []
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value !== 'string') return undefined
    pairs.push([name.toLowerCase(), value])
  }
  return pairs
}

/** The UTF-8 length of a string. */
function utf8Length(text: string): number {
  return new TextEncoder().encode(text).byteLength
}

function refusal(code: SandboxErrorCode, message: string): SandboxRefusal {
  return { code, message }
}

/**
 * Checks a request against a document's policy, without sending anything. Returns why the
 * document would refuse it, or `undefined` when it would send it. The page runs the same check
 * before it posts a request, and the document runs it again on what arrives.
 */
export function checkSandboxRequest(
  policy: SandboxDocumentPolicy,
  request: { readonly url?: unknown; readonly method?: unknown; headers?: unknown; body?: unknown },
): SandboxRefusal | undefined {
  const { url: rawUrl, method: rawMethod } = request
  if (typeof rawUrl !== 'string' || rawUrl.length > MAX_URL_LENGTH) {
    return refusal('bad-request', 'The URL must be a string of at most 8,192 characters')
  }
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return refusal('bad-request', `Not an absolute URL: ${rawUrl.slice(0, 100)}`)
  }
  const where = `${url.protocol}//${url.host}`
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') {
    return refusal(
      'forbidden-host',
      `The ${policy.kind} sandbox sends only to https: URLs without credentials, not ${where}`,
    )
  }
  if (!policy.ports && url.port !== '') {
    return refusal(
      'forbidden-host',
      `The ${policy.kind} sandbox sends only to the default port, not ${where}`,
    )
  }
  if (policy.hosts !== undefined && !policy.hosts.includes(url.hostname)) {
    return refusal(
      'forbidden-host',
      `The ${policy.kind} sandbox sends only to ${policy.hosts.join(', ')}, not ${url.hostname}`,
    )
  }
  if (policy.paths !== undefined && !policy.paths.includes(url.pathname)) {
    return refusal('forbidden-path', `The ${policy.kind} sandbox does not send to ${url.pathname}`)
  }
  if (typeof rawMethod !== 'string') return refusal('bad-request', 'The method must be a string')
  const method = rawMethod.toUpperCase()
  if (!policy.methods.includes(method)) {
    return SAFELISTED_METHODS.includes(method)
      ? refusal(
          'forbidden-method',
          `The ${policy.kind} sandbox sends only ${policy.methods.join(' and ')} requests, not ${method}`,
        )
      : refusal('preflight', `A ${method} request needs a CORS preflight`)
  }
  const headers = headerPairs(request.headers)
  if (headers === undefined) {
    return refusal('bad-request', 'Headers must be a plain object of strings')
  }
  if (policy.headers === 'none' && headers.length > 0) {
    return refusal(
      'forbidden-header',
      `Requests to user hosts carry no header, not ${headers.map(([name]) => name).join(', ')}`,
    )
  }
  const unsafe = headers.filter(([name, value]) => !isSafelistedHeader(name, value))
  if (unsafe.length > 0) {
    return refusal(
      'preflight',
      `These headers need a CORS preflight: ${unsafe.map(([name]) => name).join(', ')}`,
    )
  }
  if (headers.reduce((total, [, value]) => total + value.length, 0) > 1024) {
    return refusal('preflight', 'Safelisted headers of more than 1,024 bytes need a CORS preflight')
  }
  const { body } = request
  if (policy.body) {
    if (typeof body !== 'string')
      return refusal('bad-request', `A ${method} request needs a string body`)
    if (body.length > policy.maxRequestBytes || utf8Length(body) > policy.maxRequestBytes) {
      return refusal('too-large', `Request bodies are at most ${policy.maxRequestBytes} bytes`)
    }
  } else if (body !== undefined && body !== null) {
    return refusal('bad-request', `A ${method} request carries no body`)
  }
  return undefined
}

/** A positive limit no larger than `max`: `requested` when it is one, else `max`. */
function within(requested: unknown, max: number): number {
  return typeof requested === 'number' && Number.isFinite(requested) && requested > 0
    ? Math.min(requested, max)
    : max
}

/**
 * The origin FXM serves the document from, which is the only origin the document talks to:
 * the origin of its own URL. A sandboxed document's own origin is opaque (`self.origin` is
 * `'null'`), but its URL still says where it came from. `undefined` for a URL without a usable
 * origin, such as `about:srcdoc`.
 */
export function fxmOriginOf(href: unknown): string | undefined {
  if (typeof href !== 'string') return undefined
  try {
    const { origin, protocol } = new URL(href)
    return origin !== 'null' && (protocol === 'https:' || protocol === 'http:') ? origin : undefined
  } catch {
    return undefined
  }
}

/** The window a sandbox document posts its `hello` to. */
export interface SandboxPeer {
  /** `window.postMessage`. */
  postMessage(message: unknown, targetOrigin: string): void
}

/**
 * The attribute a document sets on its `<html>` while it listens for its page: `listening`.
 * Only the document itself can read it (its origin is opaque); tests and diagnostics use it to
 * tell a document that ignores a message from one whose script never ran.
 */
export const SANDBOX_MARKER_ATTRIBUTE = 'data-fxm-sandbox'

/**
 * The parts of a document's global scope (its `window`) the script uses. Tests pass a fake;
 * the documents pass `globalThis`.
 */
export interface SandboxScope {
  /** The document's own URL. */
  readonly location?: { readonly href: string } | undefined
  /** The document, whose `<html>` gets {@link SANDBOX_MARKER_ATTRIBUTE}. */
  readonly document?:
    | {
        readonly documentElement: {
          setAttribute(name: string, value: string): void
          removeAttribute(name: string): void
        } | null
      }
    | undefined
  /** The parent window: the page that framed the document, or the window itself at top level. */
  readonly parent?: SandboxPeer | null | undefined
  /** Listens for window messages. */
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void
  /** Stops listening. */
  removeEventListener(type: 'message', listener: (event: MessageEvent) => void): void
  /** The document's `fetch`. */
  fetch(input: string, init: RequestInit): Promise<Response>
  /** Starts a timer. */
  setTimeout(callback: () => void, delayMs: number): unknown
  /** Cancels a timer. */
  clearTimeout(handle: unknown): void
}

/** A running document, for tests. */
export interface SandboxDocumentHandle {
  /** Whether the document said `hello` and listens for its port. */
  readonly listening: boolean
  /** Stops listening and cancels every request in flight. */
  stop(): void
}

/** Thrown while reading a body that grew past its cap. */
const TOO_LARGE = { tooLarge: true }

/** Whether two references are the same object, whatever their types. */
function isSame(a: unknown, b: unknown): boolean {
  return a === b
}

/** `Name: message` of an error, also of one from another realm. */
function describeError(error: unknown): string {
  const { name, message } = (isObject(error) ? error : {}) as { name?: unknown; message?: unknown }
  if (typeof message !== 'string') return 'The request failed'
  return `${typeof name === 'string' ? name : 'Error'}: ${message}`
}

function isObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null
}

/** Reads a response body, failing with {@link TOO_LARGE} once it passes `maxBytes`. */
async function readBody(response: Response, maxBytes: number): Promise<ArrayBuffer> {
  if (response.body === null) return new ArrayBuffer(0)
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      reader.cancel().catch(() => undefined)
      throw TOO_LARGE
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes.buffer
}

/**
 * Runs a sandbox document in `scope`: says `hello` to the parent at the FXM origin, takes the
 * port from the parent's `connect`, and serves the requests that arrive on it under `policy`.
 * Does nothing at top level, or when the document's URL has no origin to trust.
 */
export function startSandboxDocument(
  scope: SandboxScope,
  policy: SandboxDocumentPolicy,
): SandboxDocumentHandle {
  const origin = fxmOriginOf(scope.location?.href)
  const parent = scope.parent
  // At top level `parent` is the window itself, and there is nobody to talk to.
  if (origin === undefined || parent === undefined || parent === null || isSame(parent, scope)) {
    return { listening: false, stop() {} }
  }
  const page: SandboxPeer = parent
  const fxmOrigin: string = origin
  const inflight = new Map<string, AbortController>()
  let port: MessagePort | undefined
  let stopped = false

  function reply(message: SandboxResponseMessage | SandboxErrorMessage): void {
    if (stopped || port === undefined) return
    if (message.type === SANDBOX_MESSAGE.response) port.postMessage(message, [message.body])
    else port.postMessage(message)
  }

  function fail(id: string, code: SandboxErrorCode, message: string): void {
    reply({ type: SANDBOX_MESSAGE.error, id, code, message })
  }

  async function serve(data: Record<string, unknown>): Promise<void> {
    const { id } = data
    if (typeof id !== 'string' || id === '' || id.length > 128 || inflight.has(id)) return
    const refused = checkSandboxRequest(policy, data)
    if (refused !== undefined) {
      fail(id, refused.code, refused.message)
      return
    }
    const controller = new AbortController()
    inflight.set(id, controller)
    const maxBytes = within(data.maxResponseBytes, policy.maxResponseBytes)
    let timedOut = false
    const timer = scope.setTimeout(
      () => {
        timedOut = true
        controller.abort()
      },
      within(data.timeoutMs, policy.timeoutMs),
    )
    try {
      const init: RequestInit = {
        method: String(data.method).toUpperCase(),
        headers: (data.headers ?? {}) as Record<string, string>,
        credentials: 'omit',
        mode: 'cors',
        redirect: policy.redirect,
        referrerPolicy: 'no-referrer',
        signal: controller.signal,
      }
      if (policy.body) init.body = data.body as string
      const response = await scope.fetch(data.url as string, init)
      const declared = Number(response.headers.get('content-length') ?? Number.NaN)
      if (declared > maxBytes) {
        response.body?.cancel().catch(() => undefined)
        throw TOO_LARGE
      }
      const body = await readBody(response, maxBytes)
      reply({
        type: SANDBOX_MESSAGE.response,
        id,
        status: response.status,
        statusText: response.statusText,
        url: response.url,
        headers: [...response.headers],
        body,
      })
    } catch (error) {
      if (error === TOO_LARGE) {
        fail(id, 'too-large', `The response is larger than ${maxBytes} bytes`)
      } else if (timedOut) {
        fail(id, 'timeout', 'No complete response in time')
      } else if (!controller.signal.aborted) {
        // When the page cancelled the request, it waits for no reply.
        fail(id, 'network', describeError(error))
      }
    } finally {
      scope.clearTimeout(timer)
      inflight.delete(id)
    }
  }

  function onPortMessage(event: MessageEvent): void {
    const data: unknown = event.data
    if (stopped || !isRecord(data)) return
    if (data.type === SANDBOX_MESSAGE.abort) {
      if (typeof data.id === 'string') inflight.get(data.id)?.abort()
    } else if (data.type === SANDBOX_MESSAGE.request) {
      void serve(data)
    }
  }

  function onWindowMessage(event: MessageEvent): void {
    // Only the page that framed the document, at the origin FXM serves it from, may connect.
    if (stopped || port !== undefined || event.origin !== fxmOrigin || event.source !== page) {
      return
    }
    const data: unknown = event.data
    if (!isRecord(data) || data.type !== SANDBOX_MESSAGE.connect) return
    if (data.protocol !== SANDBOX_PROTOCOL) return
    const candidate = event.ports[0]
    if (candidate === undefined) return
    port = candidate
    port.addEventListener('message', onPortMessage)
    port.start()
  }

  scope.addEventListener('message', onWindowMessage)
  scope.document?.documentElement?.setAttribute(SANDBOX_MARKER_ATTRIBUTE, 'listening')
  page.postMessage(
    { type: SANDBOX_MESSAGE.hello, protocol: SANDBOX_PROTOCOL, document: policy.kind },
    fxmOrigin,
  )

  return {
    get listening() {
      return !stopped
    },
    stop() {
      if (stopped) return
      stopped = true
      scope.removeEventListener('message', onWindowMessage)
      scope.document?.documentElement?.removeAttribute(SANDBOX_MARKER_ATTRIBUTE)
      for (const controller of inflight.values()) controller.abort()
      inflight.clear()
      port?.close()
    },
  }
}
