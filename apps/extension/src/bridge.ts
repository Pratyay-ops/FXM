/**
 * The background side of FXM Connect: the optional Spotify session bridge, the login status
 * behind the pong's `spotify-login` feature and, in the dev build, switching between rulesets of
 * origins that share a host.
 *
 * The bridge makes exactly two requests, both to fixed URLs:
 * - GET https://open.spotify.com/api/token with allow-listed query parameters and the browser's
 *   own open.spotify.com cookies (`credentials: 'include'`), only while the user has enabled
 *   "Use my Spotify login from this browser" on the options page (settings.ts) and, in Firefox,
 *   consents to handing on authentication information (consent.ts);
 * - GET https://open.spotify.com/api/server-time without credentials, always: it needs no
 *   setting and is served in private tabs too.
 * It returns only the HTTP status and the JSON body. It never reads, stores or returns cookies
 * or response headers.
 *
 * One background serves every tab, including private windows (manifests leave `incognito` at
 * its default, spanning), and its requests carry the cookies of the browser's normal windows.
 * The token relay therefore refuses tabs with cookies of their own: private windows and Firefox
 * container tabs. Otherwise a page there would get the account signed in elsewhere.
 */

import type { LoginConsent } from './consent.ts'
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
import { isLocalhost, rulesetSwitch } from './origins.ts'
import { RateLimiter } from './rate-limit.ts'
import type { SettingsStore } from './settings.ts'
import type {
  BrowserCookie,
  MessageListener,
  MessageSender,
  StorageArea,
  WebExtApi,
} from './webext.ts'

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
  /** Firefox's consent for the login bridge (consent.ts); without it, only the setting counts. */
  consent?: Pick<LoginConsent, 'granted'> | undefined
  /** storage.session, where the rate limiter's window survives the background being stopped. */
  session?: StorageArea | undefined
  dnr?: WebExtApi['declarativeNetRequest']
  permissions?: WebExtApi['permissions']
  cookies?: WebExtApi['cookies']
  /** Called only in the background, with a short-lived cookie header that is never returned. */
  youtubeMusicLibrary?: (cookieHeader: string) => Promise<unknown>
  fetch: FetchLike
  now: () => number
  timeoutMs?: number
  maxResponseBytes?: number
}

/** A trusted sender: FXM Connect's content script in the top frame of an FXM page. */
export interface SenderContext {
  /** The page's FXM origin. */
  origin: string
  /** The page is in a tab with cookies of its own (see isPrivateTab). */
  privateTab: boolean
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

/** Firefox's cookie store of normal tabs. Private windows and containers have their own. */
export const FIREFOX_DEFAULT_COOKIE_STORE = 'firefox-default'

/**
 * True for a tab whose cookies are kept apart from those of the browser's normal windows: an
 * incognito or private window, or a Firefox container tab.
 */
export function isPrivateTab(tab: MessageSender['tab']): boolean {
  if (tab?.incognito === true) return true
  const store = tab?.cookieStoreId
  return store !== undefined && store !== FIREFOX_DEFAULT_COOKIE_STORE
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

  /** Why token requests from this sender are refused, or null when they are served. */
  async function loginRefusal(
    sender: SenderContext,
  ): Promise<'login-disabled' | 'private-tab' | null> {
    const settings = await options.settings.read()
    if (!settings.spotifyLogin) return 'login-disabled'
    // Dev build: any app on the localhost ports counts as FXM, so they need their own opt-in.
    if (isLocalhost(sender.origin) && !settings.spotifyLoginLocalhost) return 'login-disabled'
    // Firefox: the user can withdraw the consent in the add-on's settings at any time.
    if (options.consent && !(await options.consent.granted())) return 'login-disabled'
    return sender.privateTab ? 'private-tab' : null
  }

  /** Why YouTube Music account reads are refused, or null when this tab may use them. */
  async function youtubeMusicRefusal(
    sender: SenderContext,
  ): Promise<'login-disabled' | 'private-tab' | null> {
    if (sender.privateTab) return 'private-tab'
    const settings = await options.settings.read()
    if (!settings.youtubeMusicLogin) return 'login-disabled'
    if (options.cookies === undefined || options.youtubeMusicLibrary === undefined) {
      return 'login-disabled'
    }
    if (!(await options.permissions?.contains({ permissions: ['cookies'] }))) {
      return 'login-disabled'
    }
    if (options.consent && !(await options.consent.granted())) return 'login-disabled'
    return null
  }

  /** Cookie names needed to derive InnerTube's SAPISIDHASH; unrelated cookies are not read. */
  // The pinned youtubei.js HTTPClient derives SAPISIDHASH from this cookie. Do not read
  // unrelated Google session cookies (SID, LOGIN_INFO, PREF, etc.).
  const YOUTUBE_COOKIE_NAMES = new Set(['SAPISID'])

  function youtubeCookieHeader(cookies: readonly BrowserCookie[]): string {
    const selected = new Map<string, string>()
    for (const cookie of cookies) {
      if (!YOUTUBE_COOKIE_NAMES.has(cookie.name) || cookie.value === '') continue
      selected.set(cookie.name, cookie.value)
    }
    // youtubei.js derives SAPISIDHASH from SAPISID. Without it the library cannot authenticate.
    if (!selected.has('SAPISID')) return ''
    return [...selected].map(([name, value]) => `${name}=${value}`).join('; ')
  }

  async function youtubeMusicLibrary(
    id: RequestId,
    sender: SenderContext,
  ): Promise<BridgeReply> {
    const refusal = await youtubeMusicRefusal(sender)
    if (refusal !== null) return errorReply(id, refusal)
    if (!(await acquire())) return errorReply(id, 'rate-limited')

    let cookieHeader = ''
    try {
      const cookies = await options.cookies?.getAll({ url: 'https://music.youtube.com/' })
      cookieHeader = youtubeCookieHeader(cookies ?? [])
      if (cookieHeader === '') return errorReply(id, 'auth-required')
      const json = await options.youtubeMusicLibrary?.(cookieHeader)
      if (json === undefined) return errorReply(id, 'unavailable')
      // A single bridge reply is deliberately bounded; library snapshots carry their own
      // truncation flags and can be synced again after the user changes the selection.
      const bytes = new TextEncoder().encode(JSON.stringify(json)).byteLength
      if (bytes > 5 * 1024 * 1024) return errorReply(id, 'too-large')
      return { type: MESSAGE.response, id, status: 200, json }
    } catch (error) {
      if (
        error instanceof Error &&
        /not signed in|sign.?in|auth(?:entication)? required|login required/i.test(error.message)
      ) {
        return errorReply(id, 'auth-required')
      }
      return errorReply(id, 'network-error')
    } finally {
      // Do not retain the account cookie string after this one read.
      cookieHeader = ''
    }
  }

  async function serve(request: BridgeRequest, sender: SenderContext): Promise<BridgeReply> {
    if (request.type === MESSAGE.spotifyToken) {
      const refusal = await loginRefusal(sender)
      if (refusal !== null) return errorReply(request.id, refusal)
      if (!(await acquire())) return errorReply(request.id, 'rate-limited')
      return relay(request.id, spotifyTokenUrl(request.params), 'include')
    }
    if (request.type === MESSAGE.spotifyServerTime) {
      if (!(await acquire())) return errorReply(request.id, 'rate-limited')
      return relay(request.id, SPOTIFY_SERVER_TIME_URL, 'omit')
    }
    return youtubeMusicLibrary(request.id, sender)
  }

  async function handle(message: unknown, sender: SenderContext): Promise<BackgroundReply | null> {
    const type = messageType(message)
    if (type === MESSAGE.activateOrigin) {
      const change = rulesetSwitch(sender.origin, options.origins)
      if (change !== null) await options.dnr?.updateEnabledRulesets(change)
      return null
    }
    if (type === MESSAGE.loginStatus) {
      const refusal = await loginRefusal(sender).catch(() => 'unreadable')
      return { type: MESSAGE.loginStatus, enabled: refusal === null }
    }
    if (type === MESSAGE.youtubeMusicLoginStatus) {
      const refusal = await youtubeMusicRefusal(sender).catch(() => 'unreadable')
      return { type: MESSAGE.youtubeMusicLoginStatus, enabled: refusal === null }
    }
    const parsed = parseBridgeRequest(message)
    if (!parsed.ok) return errorReply(parsed.id, parsed.code)
    try {
      return await serve(parsed.value, sender)
    } catch {
      // For example, the settings database could not be opened. Answer with the request's ID,
      // so the page learns what failed instead of seeing the background as unreachable.
      return errorReply(parsed.value.id, 'internal')
    }
  }

  const listener: MessageListener = (message, sender, sendResponse) => {
    const origin = trustedSenderOrigin(sender, options.runtimeId, options.origins)
    if (origin === null) return false
    // handle() only rejects on errors outside a bridge request, such as a failed ruleset switch.
    handle(message, { origin, privateTab: isPrivateTab(sender.tab) }).then(sendResponse, () =>
      sendResponse(errorReply(null, 'internal')),
    )
    return true
  }

  return { handle, listener }
}
