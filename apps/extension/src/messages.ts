/**
 * The window.postMessage protocol between the FXM page and FXM Connect, and its validation.
 * The content script validates page messages; the background validates them again before it
 * makes any request.
 */

/**
 * Message types. `activate-origin` and `spotify-login-status` only travel between the content
 * script and the background; the content script rejects them from the page.
 */
export const MESSAGE = {
  ping: 'fxm-connect:ping',
  pong: 'fxm-connect:pong',
  spotifyToken: 'fxm-connect:spotify-token',
  spotifyServerTime: 'fxm-connect:spotify-server-time',
  response: 'fxm-connect:response',
  error: 'fxm-connect:error',
  activateOrigin: 'fxm-connect:activate-origin',
  loginStatus: 'fxm-connect:spotify-login-status',
} as const

const PREFIX = 'fxm-connect:'

/** Correlates a request with its reply: a short string or a non-negative integer. */
export type RequestId = string | number

/** Why a request was rejected. The README documents each code. */
export type ErrorCode =
  | 'bad-request'
  | 'unsupported'
  | 'login-disabled'
  | 'rate-limited'
  | 'network-error'
  | 'timeout'
  | 'too-large'
  | 'unavailable'
  | 'internal'

/** The only query parameters the token relay forwards, with the values each may take. */
export const SPOTIFY_TOKEN_PARAMS = {
  reason: /^[A-Za-z][A-Za-z0-9_-]{0,31}$/,
  productType: /^[A-Za-z][A-Za-z0-9_-]{0,31}$/,
  totp: /^[0-9]{6,10}$/,
  totpServer: /^[0-9]{6,10}$/,
  totpVer: /^[0-9]{1,4}$/,
} as const

export type SpotifyTokenParam = keyof typeof SPOTIFY_TOKEN_PARAMS
export type SpotifyTokenParams = Partial<Record<SpotifyTokenParam, string>>

/** Requests the background serves. */
export type BridgeRequest =
  | { type: typeof MESSAGE.spotifyToken; id: RequestId; params: SpotifyTokenParams }
  | { type: typeof MESSAGE.spotifyServerTime; id: RequestId }

/** Reply to `fxm-connect:ping`. */
export interface Pong {
  type: typeof MESSAGE.pong
  version: string
  features: string[]
}

/** A relayed response: the HTTP status and the parsed JSON body (null if it was not JSON). */
export interface BridgeResponse {
  type: typeof MESSAGE.response
  id: RequestId
  status: number
  json: unknown
}

/** A rejected request. `id` is null when the request had no usable ID. */
export interface BridgeError {
  type: typeof MESSAGE.error
  id: RequestId | null
  code: ErrorCode
}

export type BridgeReply = BridgeResponse | BridgeError

/** Everything the content script posts back to the page. */
export type PageReply = Pong | BridgeReply

/**
 * The background's answer to `spotify-login-status`: whether token requests from the asking tab
 * would be served, which decides the `spotify-login` feature of the pong.
 */
export interface LoginStatus {
  type: typeof MESSAGE.loginStatus
  enabled: boolean
}

type Parsed<T> = { ok: true; value: T } | { ok: false; id: RequestId | null; code: ErrorCode }

/**
 * Plain-object check that also works across realms: in Firefox the content script sees page
 * objects through Xray wrappers, whose prototype is the page's Object.prototype.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return Object.prototype.toString.call(value) === '[object Object]'
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key))
}

/** The `type` of a message object, or undefined. */
export function messageType(value: unknown): unknown {
  return isRecord(value) ? value.type : undefined
}

/** Builds an error reply. */
export function errorReply(id: RequestId | null, code: ErrorCode): BridgeError {
  return { type: MESSAGE.error, id, code }
}

/** A request ID, or null if the value is not one. */
export function parseRequestId(value: unknown): RequestId | null {
  if (typeof value === 'string') return /^[A-Za-z0-9_.:-]{1,64}$/.test(value) ? value : null
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? value : null
  return null
}

/**
 * Token query parameters: only the allow-listed names, each a string of the expected form.
 * Returns null for anything else.
 */
export function parseTokenParams(value: unknown): SpotifyTokenParams | null {
  if (!isRecord(value)) return null
  const params: SpotifyTokenParams = {}
  for (const key of Object.keys(value)) {
    if (!Object.hasOwn(SPOTIFY_TOKEN_PARAMS, key)) return null
    const name = key as SpotifyTokenParam
    const raw = value[name]
    if (typeof raw !== 'string' || !SPOTIFY_TOKEN_PARAMS[name].test(raw)) return null
    params[name] = raw
  }
  return params
}

/** Validates a bridge request strictly: known type, valid ID, no unexpected fields. */
export function parseBridgeRequest(data: unknown): Parsed<BridgeRequest> {
  if (!isRecord(data)) return { ok: false, id: null, code: 'bad-request' }
  const id = parseRequestId(data.id)
  const fail = (code: ErrorCode): Parsed<BridgeRequest> => ({ ok: false, id, code })
  switch (data.type) {
    case MESSAGE.spotifyToken: {
      if (id === null || !hasOnlyKeys(data, ['type', 'id', 'params'])) return fail('bad-request')
      const params = parseTokenParams(data.params)
      if (params === null) return fail('bad-request')
      return { ok: true, value: { type: MESSAGE.spotifyToken, id, params } }
    }
    case MESSAGE.spotifyServerTime:
      if (id === null || !hasOnlyKeys(data, ['type', 'id'])) return fail('bad-request')
      return { ok: true, value: { type: MESSAGE.spotifyServerTime, id } }
    default:
      return fail('unsupported')
  }
}

/** The parts of a MessageEvent the content script looks at. */
export interface MessageEventLike {
  source: unknown
  origin: string
  data: unknown
}

/** What the content script should do with a page message. */
export type PageMessage =
  | { kind: 'ping' }
  | { kind: 'bridge'; request: BridgeRequest }
  | { kind: 'reject'; reply: BridgeError }

const REPLY_TYPES: readonly string[] = [MESSAGE.pong, MESSAGE.response, MESSAGE.error]

/**
 * Reads a message posted on the FXM page. Returns null (ignore) unless it comes from the page
 * itself (`event.source` is the page's window and `event.origin` its origin) and is an
 * `fxm-connect:` request. Replies are ignored, so the content script never answers itself.
 * Unknown or malformed `fxm-connect:` requests are rejected with an error reply.
 */
export function readPageMessage(
  event: MessageEventLike,
  expected: { source: unknown; origin: string },
): PageMessage | null {
  if (event.source !== expected.source || event.origin !== expected.origin) return null
  const data = event.data
  if (!isRecord(data) || typeof data.type !== 'string' || !data.type.startsWith(PREFIX)) {
    return null
  }
  if (REPLY_TYPES.includes(data.type)) return null
  if (data.type === MESSAGE.ping) return { kind: 'ping' }
  const parsed = parseBridgeRequest(data)
  return parsed.ok
    ? { kind: 'bridge', request: parsed.value }
    : { kind: 'reject', reply: errorReply(parsed.id, parsed.code) }
}

/** True for a well-formed `spotify-login-status` answer from the background. */
export function isLoginStatus(value: unknown): value is LoginStatus {
  return isRecord(value) && value.type === MESSAGE.loginStatus && typeof value.enabled === 'boolean'
}

/** True for a well-formed reply from the background to the request with this ID. */
export function isBridgeReply(value: unknown, id: RequestId): value is BridgeReply {
  if (!isRecord(value) || value.id !== id) return false
  if (value.type === MESSAGE.response) return typeof value.status === 'number' && 'json' in value
  return value.type === MESSAGE.error && typeof value.code === 'string'
}
