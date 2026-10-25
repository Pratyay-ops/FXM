/**
 * The one request shape FXM uses for InnerTube, YouTube's internal API, on every platform: a
 * CORS-simple `POST`. The Lite tier's opaque-origin sandbox can only send this shape, because
 * InnerTube refuses preflights from it, and using it everywhere keeps provider code and fixtures
 * the same on every tier.
 *
 * @module
 */

import { FxmError } from '@fxm/core'
import { findHostRule, INNERTUBE_API_PREFIX, parseUrl } from './hosts'

/** The `Content-Type` of the simple shape: what `fetch` sends for a string body anyway. */
export const SIMPLE_CONTENT_TYPE = 'text/plain;charset=UTF-8'

/**
 * Headers youtubei.js and YouTube's web clients send whose values InnerTube also reads from
 * `context.client`, where the simple shape carries them.
 */
const CLIENT_FIELD_HEADERS = [
  ['x-goog-visitor-id', 'visitorData'],
  ['x-youtube-client-version', 'clientVersion'],
] as const

/** The `init` of a {@link SimpleInnerTubeRequest}. */
export interface SimpleInnerTubeInit {
  /** Always `POST`. */
  readonly method: 'POST'
  /** Only `content-type: text/plain;charset=UTF-8`, which is CORS-safelisted. */
  readonly headers: Readonly<Record<string, string>>
  /** The JSON payload as a string, with the client fields and visitorData in `context.client`. */
  readonly body: string
  /** Always `omit`: InnerTube calls never carry cookies. */
  readonly credentials: 'omit'
  /** Cancels the request. */
  readonly signal?: AbortSignal
}

/** An InnerTube request in the CORS-simple shape, ready for any transport's `fetch`. */
export interface SimpleInnerTubeRequest {
  /** The API URL with `prettyPrint=false`. */
  readonly url: string
  /** The request options. */
  readonly init: SimpleInnerTubeInit
}

/**
 * Turns any InnerTube API request, such as the ones youtubei.js makes, into the CORS-simple shape:
 *
 * - `POST` with the JSON payload as a string body, which `fetch` labels `text/plain` and
 *   InnerTube parses as JSON;
 * - no other header at all: no `Content-Type: application/json`, no `X-Goog-*`, `X-YouTube-*` or
 *   `Authorization`, and no `Origin` or `Cookie`. `X-Goog-Visitor-Id` and
 *   `X-YouTube-Client-Version` move into `context.client.visitorData` and `.clientVersion` unless
 *   the payload has them (the payload already names the client);
 * - `prettyPrint=false` in the URL, and `credentials: 'omit'`.
 *
 * `input` may be a URL string, a `URL` or a `Request`; as with `fetch`, `init.headers` replace
 * the request's headers and `init.body` its body. A payload that needs no change is sent as it
 * came, byte for byte. Rejects with an `Unsupported` `FxmError` when the URL is not an InnerTube
 * API URL (`/youtubei/v1/…` on `www.youtube.com`, `music.youtube.com` or
 * `youtubei.googleapis.com`), or when the body is not a JSON object, e.g. protobuf, which needs
 * a `Content-Type` that is not CORS-safelisted.
 */
export async function toSimpleInnerTubeRequest(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<SimpleInnerTubeRequest> {
  const request = isRequestLike(input) ? input : undefined
  const url = parseUrl(requestUrl(input))
  if (
    findHostRule(url)?.hostClass !== 'innertube' ||
    !url.pathname.startsWith(INNERTUBE_API_PREFIX)
  ) {
    throw new FxmError('Unsupported', `Not an InnerTube API URL: ${url.origin}${url.pathname}`)
  }
  url.hash = ''
  url.searchParams.set('prettyPrint', 'false')

  const headers = new Headers(init?.headers ?? request?.headers)
  const text = await readBody(init, request)
  const body = withClientFields(text, headers)
  const signal = init?.signal ?? request?.signal ?? undefined
  return {
    url: url.href,
    init: {
      method: 'POST',
      headers: { 'content-type': SIMPLE_CONTENT_TYPE },
      body,
      credentials: 'omit',
      ...(signal === undefined ? {} : { signal }),
    },
  }
}

/** Whether `input` is a `Request` (from any realm) rather than a URL. */
export function isRequestLike(input: unknown): input is Request {
  if (typeof input !== 'object' || input === null || input instanceof URL) return false
  const candidate = input as Partial<Request>
  return (
    typeof candidate.url === 'string' &&
    typeof candidate.method === 'string' &&
    typeof candidate.headers === 'object'
  )
}

/** The URL of a `fetch` input, as a string. */
export function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input
  return isRequestLike(input) ? input.url : String(input)
}

function noJsonBody(cause?: unknown): FxmError {
  return new FxmError(
    'Unsupported',
    'InnerTube requests must carry a JSON object as their body',
    cause === undefined ? {} : { cause },
  )
}

async function readBody(init: RequestInit | undefined, request: Request | undefined) {
  const body = init?.body ?? undefined
  if (body === undefined) {
    if (request === undefined || request.body === null) throw noJsonBody()
    return request.text()
  }
  if (typeof body === 'string') return body
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(body)
    } catch (cause) {
      throw noJsonBody(cause)
    }
  }
  if (typeof Blob !== 'undefined' && body instanceof Blob) return body.text()
  throw noJsonBody()
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The payload with header-borne client fields moved into `context.client`. */
function withClientFields(text: string, headers: Headers): string {
  let payload: unknown
  try {
    payload = JSON.parse(text)
  } catch (cause) {
    throw noJsonBody(cause)
  }
  if (!isPlainObject(payload)) throw noJsonBody()
  const moves = CLIENT_FIELD_HEADERS.flatMap(([header, field]) => {
    const value = headers.get(header)
    return value ? [[field, value] as const] : []
  })
  if (moves.length === 0) return text

  const context = payload.context ?? {}
  const client = isPlainObject(context) ? (context.client ?? {}) : undefined
  if (!isPlainObject(context) || !isPlainObject(client)) {
    throw new FxmError('Unsupported', 'InnerTube payloads keep their client in context.client')
  }
  let changed = false
  for (const [field, value] of moves) {
    if (client[field] === undefined || client[field] === '') {
      client[field] = value
      changed = true
    }
  }
  if (!changed) return text
  context.client = client
  payload.context = context
  return JSON.stringify(payload)
}
