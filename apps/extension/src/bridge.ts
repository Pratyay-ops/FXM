/**
 * The background side of FXM Connect: the optional Spotify session bridge, the login status
 * behind the pong's `spotify-login` feature and, in the dev build, switching between rulesets of
 * origins that share a host.
 *
 * The bridge makes exactly two requests, both to fixed URLs:
 * - GET https://open.spotify.com/api/token with allow-listed query parameters and the browser's
 *   own open.spotify.com cookies (`credentials: 'include'`), only while the user has enabled
 *   "Use my Spotify login from this browser" on the options page (settings.ts);
 * - GET https://open.spotify.com/api/server-time without credentials.
 * It returns only the HTTP status and the JSON body. It never reads, stores or returns cookies
 * or response headers.
 */
import {
  type BridgeReply,
  type BridgeRequest,
  errorReply,
  type LoginStatus,
  MESSAGE,
  messageType,
  parseBridgeRequest,
  type RequestId,
  type SpotifyTokenParams,
} from './messages.ts'
import { rulesetSwitch } from './origins.ts'
import { RateLimiter } from './rate-limit.ts'
import type { SettingsStore } from './settings.ts'
import type { MessageListener, MessageSender, StorageArea, WebExtApi } from './webext.ts'

export const SPOTIFY_TOKEN_URL = 'https://open.spotify.com/api/token'
export const SPOTIFY_SERVER_TIME_URL = 'https://open.spotify.com/api/server-time'

/** About ten bridge requests per minute, across all FXM tabs. */
export const RATE_LIMIT = { max: 10, windowMs: 60_000 } as const

/** `storage.session` key of the rate limiter's timestamps. */
export const RATE_LIMIT_KEY = 'bridgeRequestTimes'

const DEFAULT_TIMEOUT_MS = 10_000
const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>

export interface BridgeOptions {
  runtimeId: string
  origins: readonly string[]
  /** The user's settings. Only the options page writes them; content scripts cannot reach them. */
  settings: Pick<SettingsStore, 'read'>
  /** storage.session, where the rate limiter's window survives the background being stopped. */
  session?: StorageArea | undefined
  dnr?: WebExtApi['declarativeNetRequest']
  fetch: FetchLike
  now: () => number
  timeoutMs?: number
  maxResponseBytes?: number
}

/** A trusted sender: FXM Connect's content script in the top frame of an FXM page. */
export interface SenderContext {
  /** The page's FXM origin. */
  origin: string
}

/** Everything the background answers the content script with. */
export type BackgroundReply = BridgeReply | LoginStatus

export interface Bridge {
  /** Handles a message from a trusted sender. Resolves to the reply, if any. */
  handle(message: unknown, sender: SenderContext): Promise<BackgroundReply | null>
  /** runtime.onMessage listener: checks the sender, then answers asynchronously. */
  listener: MessageListener
}

/**
 * The FXM origin of a message sender, or null unless the message comes from FXM Connect's own
 * content script in the top frame of a tab on an FXM origin.
 */
export function trustedSenderOrigin(
  sender: MessageSender,
  runtimeId: string,
  origins: readonly string[],
): string | null {
  if (sender.id !== runtimeId || sender.tab === undefined || sender.frameId !== 0) return null
  let origin = sender.origin ?? null
  if (origin === null && sender.url !== undefined) {
    try {
      origin = new URL(sender.url).origin
    } catch {
      origin = null
    }
  }
  return origin !== null && origins.includes(origin) ? origin : null
}

/** The token URL with the validated parameters, in a fixed order. */
export function spotifyTokenUrl(params: SpotifyTokenParams): string {
  const url = new URL(SPOTIFY_TOKEN_URL)
  for (const name of ['reason', 'productType', 'totp', 'totpServer', 'totpVer'] as const) {
    const value = params[name]
    if (value !== undefined) url.searchParams.set(name, value)
  }
  return url.href
}

class ResponseTooLarge extends Error {}

async function readLimited(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get('content-length') ?? 0)
  if (declared > maxBytes) throw new ResponseTooLarge()
  if (response.body === null) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > maxBytes) {
      await reader.cancel()
      throw new ResponseTooLarge()
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(bytes)
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** Creates the bridge. Only `listener` needs registering, synchronously, at startup. */
export function createBridge(options: BridgeOptions): Bridge {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES
  const session = options.session
  const limiter = new RateLimiter(RATE_LIMIT.max, RATE_LIMIT.windowMs)

  // The service worker can stop between requests; the limiter's state lives in storage.session.
  const restored = (async () => {
    try {
      const stored = (await session?.get(RATE_LIMIT_KEY))?.[RATE_LIMIT_KEY]
      if (Array.isArray(stored)) limiter.restore(stored)
    } catch {
      // Start with an empty window.
    }
  })()

  async function acquire(): Promise<boolean> {
    await restored
    if (!limiter.tryAcquire(options.now())) return false
    session?.set({ [RATE_LIMIT_KEY]: limiter.snapshot() }).catch(() => {})
    return true
  }

  async function relay(
    id: RequestId,
    url: string,
    credentials: RequestCredentials,
  ): Promise<BridgeReply> {
    try {
      const response = await options.fetch(url, {
        method: 'GET',
        credentials,
        redirect: 'error',
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      })
      const text = await readLimited(response, maxBytes)
      return { type: MESSAGE.response, id, status: response.status, json: parseJson(text) }
    } catch (error) {
      if (error instanceof ResponseTooLarge) return errorReply(id, 'too-large')
      if (error instanceof Error && error.name === 'TimeoutError') return errorReply(id, 'timeout')
      return errorReply(id, 'network-error')
    }
  }

  /** Why token requests are refused, or null when they are served. */
  async function loginRefusal(): Promise<'login-disabled' | null> {
    const settings = await options.settings.read()
    return settings.spotifyLogin ? null : 'login-disabled'
  }

  async function serve(request: BridgeRequest): Promise<BridgeReply> {
    if (request.type === MESSAGE.spotifyToken) {
      const refusal = await loginRefusal()
      if (refusal !== null) return errorReply(request.id, refusal)
      if (!(await acquire())) return errorReply(request.id, 'rate-limited')
      return relay(request.id, spotifyTokenUrl(request.params), 'include')
    }
    if (!(await acquire())) return errorReply(request.id, 'rate-limited')
    return relay(request.id, SPOTIFY_SERVER_TIME_URL, 'omit')
  }

  async function handle(message: unknown, sender: SenderContext): Promise<BackgroundReply | null> {
    const type = messageType(message)
    if (type === MESSAGE.activateOrigin) {
      const change = rulesetSwitch(sender.origin, options.origins)
      if (change !== null) await options.dnr?.updateEnabledRulesets(change)
      return null
    }
    if (type === MESSAGE.loginStatus) {
      const refusal = await loginRefusal().catch(() => 'unreadable')
      return { type: MESSAGE.loginStatus, enabled: refusal === null }
    }
    const parsed = parseBridgeRequest(message)
    return parsed.ok ? serve(parsed.value) : errorReply(parsed.id, parsed.code)
  }

  const listener: MessageListener = (message, sender, sendResponse) => {
    const origin = trustedSenderOrigin(sender, options.runtimeId, options.origins)
    if (origin === null) return false
    handle(message, { origin }).then(sendResponse, () => sendResponse(errorReply(null, 'internal')))
    return true
  }

  return { handle, listener }
}
