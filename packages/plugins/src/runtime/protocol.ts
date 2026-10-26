/**
 * The plugin protocol: the messages between the host (`host.ts`, in FXM's page) and the plugin's
 * worker (`worker.ts`), relayed by the plugin's evaluator document (`document.ts`). The host's
 * messages are the arguments of `Evaluator.evaluate`, and the replies are its results, as JSON
 * text.
 *
 * A call goes like this:
 *
 * 1. The host sends `call` with the operation and its input. The worker loads the plugin (once),
 *    starts its handler, and answers as soon as the handler settles, asks for network requests,
 *    or has done neither for a while:
 *    - `done` with the handler's result, or `failed` with why it failed;
 *    - `fetch` with the requests the handler made through `ctx.fetch`;
 *    - `idle` while the handler still works (waiting on a timer, say).
 * 2. After `fetch`, the host checks each request against the plugin's declared hosts and its
 *    request budget, sends the allowed ones through the platform's `fetch`, and answers with
 *    `resume`, carrying the responses (or why each failed). After `idle` it sends `resume` with
 *    no responses. The worker answers again as in step 1.
 * 3. A host that gives up (a timeout, a cancelled caller) sends `cancel`.
 *
 * The document only relays: it starts the worker, hands it the plugin's code and then each
 * message, and gives the host the worker's answer, or answers itself when the worker didn't answer
 * in time (`hung`), answered more than {@link REPLY_LIMITS} allow (`too-large`), answered outside
 * this protocol (`bad-reply`) or couldn't start (`unavailable`). It stops the worker in each of
 * those cases. Code that doesn't compile is the worker's to report (`load-failed`).
 *
 * The host trusts nothing it gets back: {@link parseReply} checks every reply, and the host
 * checks every request and every result again.
 *
 * @module
 */

import type { JsonValue } from '@fxm/core'

/** The version of this protocol, in every message. */
export const PROTOCOL_VERSION = 1

/** What the runtime tells a plugin about the call (`ctx` in the plugin's handlers). */
export interface WireContext {
  /** The catalog mode: `music` or `all`. */
  readonly mode: string
  /** The app: `web`, `desktop` or `android`. */
  readonly platform: string
  /** The preferred language, a BCP 47 tag. */
  readonly locale?: string
  /** The content region, an ISO 3166-1 alpha-2 code. */
  readonly region?: string
}

/** A network request a plugin made through `ctx.fetch`. */
export interface WireRequest {
  /** Its number within the call. */
  readonly id: number
  /** The absolute URL. */
  readonly url: string
  /** The HTTP method, upper case. */
  readonly method: string
  /** The request headers, as name and value pairs. */
  readonly headers: readonly (readonly [string, string])[]
  /** The request body, as text. */
  readonly body?: string
}

/** Why a request failed, as the plugin's `ctx.fetch` rejects. */
export interface WireFailure {
  /** What went wrong: an `FxmError` code, or one of the broker's own (see `broker.ts`). */
  readonly code: string
  /** For people. */
  readonly message: string
  /** The `FxmError` code the plugin should fail with, if it doesn't handle this. */
  readonly fxmCode?: string
  /** For a request that was rate-limited: when to try again, in milliseconds. */
  readonly retryAfterMs?: number
}

/** The answer to one {@link WireRequest}. */
export type WireResponse =
  | {
      readonly id: number
      readonly ok: true
      readonly status: number
      readonly statusText: string
      /** The final URL. */
      readonly url: string
      readonly headers: readonly (readonly [string, string])[]
      /** The body, decoded as UTF-8. */
      readonly body: string
    }
  | { readonly id: number; readonly ok: false; readonly error: WireFailure }

/** What the host sends the runtime. */
export type RuntimeInput =
  | {
      readonly fxmPlugin: typeof PROTOCOL_VERSION
      readonly op: 'call'
      readonly call: string
      /** The operation: one of `PLUGIN_OPERATIONS`. */
      readonly method: string
      /** The handler's input object (see the README's handler table). */
      readonly input: JsonValue
      readonly context: WireContext
      /** The longest the worker waits before it answers `idle`, in milliseconds. */
      readonly stepMs: number
    }
  | {
      readonly fxmPlugin: typeof PROTOCOL_VERSION
      readonly op: 'resume'
      readonly call: string
      readonly responses: readonly WireResponse[]
      readonly stepMs: number
    }
  | { readonly fxmPlugin: typeof PROTOCOL_VERSION; readonly op: 'cancel'; readonly call: string }

/** Why a call failed in the worker or the document. */
export interface RuntimeFailure {
  /**
   * - `load-failed`: the plugin's code does not compile, threw while it loaded, or registered no
   *   handlers
   * - `not-implemented`: it has no handler for the operation
   * - `plugin-failed`: the handler threw
   * - `not-json`: the handler returned something that is not JSON
   * - `busy`: the worker runs too many calls at once
   * - `unknown-call`: the worker doesn't know the call (it was restarted, or the call ended)
   * - `bad-request`: the host's message was malformed
   * - `hung`: the worker didn't answer in time, so the document stopped it
   * - `too-large`: the worker's answer was longer than {@link REPLY_LIMITS}' `chars`
   * - `bad-reply`: the worker answered outside this protocol, so the document stopped it
   * - `unavailable`: no worker could be started in this document
   */
  readonly code:
    | 'load-failed'
    | 'not-implemented'
    | 'plugin-failed'
    | 'not-json'
    | 'busy'
    | 'unknown-call'
    | 'bad-request'
    | 'hung'
    | 'too-large'
    | 'bad-reply'
    | 'unavailable'
  /** For people: the handler's error message, say. */
  readonly message: string
  /** The `FxmError` code the plugin failed with (`fxm.fail(code)`), if it named one. */
  readonly fxmCode?: string
  /** For `RateLimited`: when to try again, in milliseconds. */
  readonly retryAfterMs?: number
}

/** What the runtime answers. */
export type RuntimeReply =
  | { readonly state: 'done'; readonly value: JsonValue }
  | { readonly state: 'failed'; readonly error: RuntimeFailure }
  | { readonly state: 'fetch'; readonly requests: readonly WireRequest[] }
  | { readonly state: 'idle' }
  | { readonly state: 'cancelled' }

/** Limits on what a reply may carry. */
export const REPLY_LIMITS = {
  /**
   * A whole reply, as JSON text, in characters: a result or a turn's requests. Twice the
   * broker's limit on one response, so a plugin can pass on what it fetched, but never a result
   * that would weigh on the page.
   */
  chars: 4 * 1024 * 1024,
  /** Requests in one `fetch` reply. */
  requests: 16,
  /** A request URL, in characters. */
  url: 2048,
  /** Headers on one request. */
  headers: 32,
  /** A header name or value, in characters. */
  header: 1024,
  /** A request body, in characters. */
  body: 256 * 1024,
  /** A failure message, in characters. */
  message: 300,
} as const

const FAILURE_CODES: readonly RuntimeFailure['code'][] = [
  'load-failed',
  'not-implemented',
  'plugin-failed',
  'not-json',
  'busy',
  'unknown-call',
  'bad-request',
  'hung',
  'too-large',
  'bad-reply',
  'unavailable',
]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseHeaders(value: unknown): (readonly [string, string])[] | undefined {
  if (!Array.isArray(value) || value.length > REPLY_LIMITS.headers) return undefined
  const pairs: (readonly [string, string])[] = []
  for (const pair of value) {
    if (!Array.isArray(pair) || pair.length !== 2) return undefined
    const [name, text] = pair as unknown[]
    if (typeof name !== 'string' || typeof text !== 'string') return undefined
    if (name.length > REPLY_LIMITS.header || text.length > REPLY_LIMITS.header) return undefined
    pairs.push([name, text])
  }
  return pairs
}

function parseRequest(value: unknown): WireRequest | undefined {
  if (!isRecord(value)) return undefined
  const { id, url, method, headers, body } = value
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 1) return undefined
  if (typeof url !== 'string' || url.length > REPLY_LIMITS.url) return undefined
  if (typeof method !== 'string' || !/^[A-Z]{1,10}$/u.test(method)) return undefined
  const pairs = parseHeaders(headers)
  if (pairs === undefined) return undefined
  if (body !== undefined && (typeof body !== 'string' || body.length > REPLY_LIMITS.body)) {
    return undefined
  }
  return { id, url, method, headers: pairs, ...(body === undefined ? {} : { body }) }
}

function parseFailure(value: unknown): RuntimeFailure | undefined {
  if (!isRecord(value)) return undefined
  const { code, message, fxmCode, retryAfterMs } = value
  if (!FAILURE_CODES.includes(code as RuntimeFailure['code'])) return undefined
  return {
    code: code as RuntimeFailure['code'],
    message: typeof message === 'string' ? message.slice(0, REPLY_LIMITS.message) : '',
    ...(typeof fxmCode === 'string' ? { fxmCode: fxmCode.slice(0, 40) } : {}),
    ...(typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs) && retryAfterMs >= 0
      ? { retryAfterMs }
      : {}),
  }
}

/** Why {@link parseReply} refused a reply. */
export type ReplyProblem = 'too-large' | 'malformed'

/**
 * Checks a reply, which arrives as JSON text: a {@link RuntimeReply}, or why it is none. Text
 * longer than {@link REPLY_LIMITS}' `chars` is refused before it is parsed (`too-large`), and so
 * is anything that is not text, not JSON, not a reply, a request with a bad shape, more than
 * `requests` requests, or two requests with one number (`malformed`).
 */
export function parseReply(text: unknown): RuntimeReply | ReplyProblem {
  if (typeof text !== 'string') return 'malformed'
  if (text.length > REPLY_LIMITS.chars) return 'too-large'
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return 'malformed'
  }
  if (!isRecord(value) || value.fxmPluginReply !== PROTOCOL_VERSION) return 'malformed'
  switch (value.state) {
    case 'done':
      return 'value' in value ? { state: 'done', value: value.value as JsonValue } : 'malformed'
    case 'failed': {
      const error = parseFailure(value.error)
      return error === undefined ? 'malformed' : { state: 'failed', error }
    }
    case 'fetch': {
      const { requests } = value
      if (!Array.isArray(requests) || requests.length === 0) return 'malformed'
      if (requests.length > REPLY_LIMITS.requests) return 'malformed'
      const parsed: WireRequest[] = []
      for (const request of requests) {
        const checked = parseRequest(request)
        if (checked === undefined || parsed.some((other) => other.id === checked.id)) {
          return 'malformed'
        }
        parsed.push(checked)
      }
      return { state: 'fetch', requests: parsed }
    }
    case 'idle':
      return { state: 'idle' }
    case 'cancelled':
      return { state: 'cancelled' }
    default:
      return 'malformed'
  }
}
