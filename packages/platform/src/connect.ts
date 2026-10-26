/**
 * The web app's side of FXM Connect, the companion browser extension: detecting it (a
 * `data-fxm-connect` marker on `<html>` plus a ping/pong handshake), remembering per device that
 * it was seen so onboarding can tell when it went missing, and a client for its Spotify session
 * bridge. The message protocol is the one in `apps/extension/src/messages.ts`, documented in the
 * extension's README ("For the web app"); a contract test runs this client against the
 * extension's own content script.
 *
 * @module
 */

import { FxmError, type FxmErrorCode } from '@fxm/core'
import { type Clock, systemClock } from './clock'
import {
  browserStorage,
  type KeyValueStorage,
  memoryStorage,
  readJson,
  removeKey,
  writeJson,
} from './storage'

/** The oldest FXM Connect version this app works with. Older ones count as `outdated`. */
export const MIN_CONNECT_VERSION = '0.1.0'

/** The attribute FXM Connect's content script sets on `<html>`, holding its version. */
export const CONNECT_MARKER_ATTRIBUTE = 'data-fxm-connect'

/** How long detection waits for the pong, in milliseconds. */
export const CONNECT_PING_TIMEOUT_MS = 800

/** How long a bridge request waits for its reply, in milliseconds. FXM Connect gives up at 10 s. */
export const CONNECT_BRIDGE_TIMEOUT_MS = 15_000

/** The storage key of the "seen on this device" record. */
export const CONNECT_SEEN_KEY = 'fxm.connect.lastSeen'

/** Message types of the protocol (`MESSAGE` in `apps/extension/src/messages.ts`). */
export const CONNECT_MESSAGE = {
  ping: 'fxm-connect:ping',
  pong: 'fxm-connect:pong',
  spotifyToken: 'fxm-connect:spotify-token',
  spotifyServerTime: 'fxm-connect:spotify-server-time',
  response: 'fxm-connect:response',
  error: 'fxm-connect:error',
} as const

/**
 * Features a pong may announce:
 *
 * - `youtube`: CORS rules for InnerTube
 * - `googlevideo`: CORS rules for media bytes
 * - `spotify`: CORS rules for Spotify's web-player hosts
 * - `lastfm`: the CORS rule for Last.fm's station JSON
 * - `spotify-server-time`: the bridge relays Spotify's `/api/server-time`
 * - `spotify-login`: the user turned on the bridge's Spotify login and this tab may use it
 */
export type ConnectFeature =
  | 'youtube'
  | 'googlevideo'
  | 'spotify'
  | 'lastfm'
  | 'spotify-server-time'
  | 'spotify-login'

/**
 * Whether FXM Connect works on this page:
 *
 * - `present`: it answered the ping, at {@link MIN_CONNECT_VERSION} or later
 * - `outdated`: it answered, but its version is older (or unreadable), so the app does not use
 *   it and asks the user to update it
 * - `missing`: it does not answer, but it did on this device before: it was disabled, removed
 *   or blocked by the browser
 * - `absent`: it does not answer and was never seen on this device
 */
export type ConnectState = 'absent' | 'missing' | 'present' | 'outdated'

/** What detection found. */
export interface ConnectStatus {
  /** Whether FXM Connect works on this page. */
  readonly state: ConnectState
  /** The version FXM Connect reported, when it answered (`present` or `outdated`). */
  readonly version?: string
  /** The features it announced when it answered; empty otherwise. */
  readonly features: readonly string[]
  /** For `missing`: the version seen last on this device. */
  readonly lastSeenVersion?: string
}

/** The parts of `window` the client uses. */
export interface ConnectWindow {
  /** The page's origin, the only one messages are accepted from and posted to. */
  readonly location: { readonly origin: string }
  /**
   * The page, whose `<html>` carries the marker, and whose `visibilitychange` tells the client
   * the user came back to the tab.
   */
  readonly document: Document
  /** Posts a message to the page itself. */
  postMessage(message: unknown, targetOrigin: string): void
  /** Listens for messages. */
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void
  /** Listens for the window getting the focus back. */
  addEventListener(type: 'focus', listener: () => void): void
  /** Stops listening. */
  removeEventListener(type: 'message', listener: (event: MessageEvent) => void): void
  /** Stops listening. */
  removeEventListener(type: 'focus', listener: () => void): void
  /** Watches the marker, so detection re-runs when it appears. */
  readonly MutationObserver?: typeof MutationObserver
}

/** Options for {@link createConnectClient}. */
export interface ConnectClientOptions {
  /** The page. Default: the global `window`. */
  window?: ConnectWindow
  /**
   * Where "seen on this device" is remembered. Default: the window's `localStorage`, else memory.
   */
  storage?: KeyValueStorage
  /** How long detection waits for the pong. Default {@link CONNECT_PING_TIMEOUT_MS}. */
  pingTimeoutMs?: number
  /** How long a bridge request waits. Default {@link CONNECT_BRIDGE_TIMEOUT_MS}. */
  bridgeTimeoutMs?: number
  /** The oldest version the app works with. Default {@link MIN_CONNECT_VERSION}. */
  minVersion?: string
  /** The clock, for tests. */
  clock?: Clock
}

/**
 * The query parameters the bridge forwards to `open.spotify.com/api/token`, each a string of
 * the form FXM Connect accepts (`SPOTIFY_TOKEN_PARAMS` in `apps/extension/src/messages.ts`).
 */
export interface SpotifyTokenParams {
  /** E.g. `init` or `transport`: a letter, then up to 31 letters, digits, `_` or `-`. */
  readonly reason?: string
  /** E.g. `web-player`, in the same form as `reason`. */
  readonly productType?: string
  /** The TOTP for the local time: 6 to 10 digits. */
  readonly totp?: string
  /** The TOTP for the server time: 6 to 10 digits. */
  readonly totpServer?: string
  /** The TOTP secret's version: 1 to 4 digits. */
  readonly totpVer?: string
}

/** The forms FXM Connect accepts for each token parameter. */
export const SPOTIFY_TOKEN_PARAM_FORMS: Readonly<Record<keyof SpotifyTokenParams, RegExp>> = {
  reason: /^[A-Za-z][A-Za-z0-9_-]{0,31}$/,
  productType: /^[A-Za-z][A-Za-z0-9_-]{0,31}$/,
  totp: /^[0-9]{6,10}$/,
  totpServer: /^[0-9]{6,10}$/,
  totpVer: /^[0-9]{1,4}$/,
}

/** A response FXM Connect relayed: the HTTP status and the parsed JSON body (`null` if not JSON). */
export interface BridgeResponse {
  /** The HTTP status of Spotify's response. */
  readonly status: number
  /** The response body, parsed. Never logged: it holds a token. */
  readonly json: unknown
}

/** Options for a bridge request. */
export interface BridgeRequestOptions {
  /** Stops waiting; the request then rejects with the signal's reason. */
  signal?: AbortSignal
}

/** The web app's handle on FXM Connect. */
export interface ConnectClient {
  /** What the last detection found, or `undefined` before the first one finished. */
  readonly status: ConnectStatus | undefined
  /**
   * Detects FXM Connect: without the marker it answers at once; with it, it pings and waits up to
   * the ping timeout. Calls made while a detection runs share one more run after it, so a marker
   * change in between is never missed. The client also re-detects by itself whenever the marker
   * appears, changes or goes away, when the page gets the focus back or becomes visible (the
   * user may have changed FXM Connect's options in another tab, and FXM Connect never announces
   * that on its own), and after the bridge said the Spotify login is off.
   */
  detect(): Promise<ConnectStatus>
  /** Calls `listener` with every new status. Returns a function that removes it. */
  subscribe(listener: (status: ConnectStatus) => void): () => void
  /**
   * Forgets that FXM Connect was seen on this device, e.g. after the user said they removed it on
   * purpose, so `missing` becomes `absent`.
   */
  forget(): void
  /**
   * Asks the bridge for a token from `open.spotify.com/api/token` with the browser's own Spotify
   * login. Rejects with an `Unsupported` `FxmError` when FXM Connect is not `present` or a
   * parameter is outside the allow-list, with a {@link ConnectBridgeError} when FXM Connect refuses
   * (`AuthRequired` for `login-disabled`, until the user turns the login on, and for
   * `private-tab`), and with a `Network` one on timeout.
   */
  spotifyToken(params: SpotifyTokenParams, options?: BridgeRequestOptions): Promise<BridgeResponse>
  /** Asks the bridge for `open.spotify.com/api/server-time`, without credentials. */
  spotifyServerTime(options?: BridgeRequestOptions): Promise<BridgeResponse>
  /** Stops listening and watching. Pending requests reject with an `Unsupported` `FxmError`. */
  dispose(): void
}

/** Every error code FXM Connect's bridge answers with (`ErrorCode` in the extension). */
export const CONNECT_ERROR_CODES = [
  'bad-request',
  'unsupported',
  'login-disabled',
  'private-tab',
  'rate-limited',
  'network-error',
  'timeout',
  'too-large',
  'unavailable',
  'internal',
] as const

/** An error code from FXM Connect's bridge. */
export type ConnectErrorCode = (typeof CONNECT_ERROR_CODES)[number]

/** How each bridge error maps to an `FxmError` code, and what it means. */
const BRIDGE_ERRORS: Record<ConnectErrorCode, { code: FxmErrorCode; message: string }> = {
  'bad-request': { code: 'Unsupported', message: 'FXM Connect refused a malformed request' },
  unsupported: { code: 'Unsupported', message: 'FXM Connect does not know this request' },
  'login-disabled': {
    code: 'AuthRequired',
    message: 'Turn on "Use my Spotify login from this browser" in FXM Connect’s options',
  },
  'private-tab': {
    code: 'AuthRequired',
    message: 'The Spotify login is not available in private windows and container tabs',
  },
  'rate-limited': { code: 'RateLimited', message: 'Too many FXM Connect bridge requests' },
  'network-error': { code: 'Network', message: 'FXM Connect could not reach Spotify' },
  timeout: { code: 'Network', message: 'Spotify did not answer FXM Connect in time' },
  'too-large': { code: 'Parse', message: 'Spotify sent FXM Connect an oversized response' },
  unavailable: {
    code: 'Network',
    message: 'FXM Connect’s background is unavailable; reloading the page may help',
  },
  internal: { code: 'Network', message: 'FXM Connect failed unexpectedly; try again later' },
}

/** FXM Connect limits the bridge to 10 requests a minute. */
const BRIDGE_RATE_WINDOW_MS = 60_000

function isConnectErrorCode(code: string): code is ConnectErrorCode {
  return (CONNECT_ERROR_CODES as readonly string[]).includes(code)
}

/** An error FXM Connect's bridge answered with, mapped to an `FxmError` code. */
export class ConnectBridgeError extends FxmError {
  /** The code FXM Connect sent, e.g. `login-disabled`; may be one this app does not know. */
  readonly connectCode: string

  /** @param connectCode The `code` of FXM Connect's `fxm-connect:error` reply. */
  constructor(connectCode: string) {
    const known = isConnectErrorCode(connectCode) ? BRIDGE_ERRORS[connectCode] : undefined
    super(
      known?.code ?? 'Network',
      known?.message ?? `FXM Connect refused the request (${connectCode})`,
      connectCode === 'rate-limited' ? { retryAfterMs: BRIDGE_RATE_WINDOW_MS } : {},
    )
    this.connectCode = connectCode
  }
}

/**
 * Compares dotted version numbers such as `0.1.0`: negative when `a` is older, positive when
 * newer, 0 when equal. Missing parts count as 0. Returns `undefined` when either is not made of
 * one to four dot-separated numbers.
 */
export function compareVersions(a: string, b: string): number | undefined {
  const parse = (version: string) =>
    /^\d{1,9}(?:\.\d{1,9}){0,3}$/.test(version) ? version.split('.').map(Number) : undefined
  const left = parse(a)
  const right = parse(b)
  if (left === undefined || right === undefined) return undefined
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}

/** Whether a status says FXM Connect works and announced `feature`. */
export function hasConnectFeature(
  status: ConnectStatus | undefined,
  feature: ConnectFeature,
): boolean {
  return status?.state === 'present' && status.features.includes(feature)
}

/** Plain-object check that also accepts objects from another realm. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return Object.prototype.toString.call(value) === '[object Object]'
}

const MAX_FEATURES = 32
const MAX_FEATURE_LENGTH = 64
const MAX_VERSION_LENGTH = 64

/** A pong's version and features, or `undefined` when the message is not a valid pong. */
function readPong(
  data: Record<string, unknown>,
): { version: string; features: string[] } | undefined {
  const { version, features } = data
  if (
    typeof version !== 'string' ||
    version.length === 0 ||
    version.length > MAX_VERSION_LENGTH ||
    !Array.isArray(features) ||
    features.length > MAX_FEATURES ||
    !features.every(
      (feature) => typeof feature === 'string' && feature.length <= MAX_FEATURE_LENGTH,
    )
  ) {
    return undefined
  }
  return { version, features: [...(features as string[])] }
}

function sameStatus(a: ConnectStatus | undefined, b: ConnectStatus): boolean {
  return (
    a !== undefined &&
    a.state === b.state &&
    a.version === b.version &&
    a.lastSeenVersion === b.lastSeenVersion &&
    a.features.length === b.features.length &&
    a.features.every((feature, index) => feature === b.features[index])
  )
}

interface PendingRequest {
  /** Ends the request with a reply record (resolves) or anything else (rejects with it). */
  settle(reply: unknown): void
}

/** A random prefix for request IDs, so two clients on one page never share an ID. */
function randomPrefix(): string {
  const bytes = new Uint8Array(6)
  globalThis.crypto.getRandomValues(bytes)
  return Array.from(bytes, (byte) => byte.toString(36).padStart(2, '0')).join('')
}

/**
 * Creates the client and starts watching the marker. Call {@link ConnectClient.detect} once at
 * start-up; later changes arrive through {@link ConnectClient.subscribe}.
 */
export function createConnectClient(options: ConnectClientOptions = {}): ConnectClient {
  const page = options.window ?? (globalThis as { window?: ConnectWindow }).window
  if (page === undefined) {
    throw new FxmError('Unsupported', 'FXM Connect can only be detected in a browser page')
  }
  const window: ConnectWindow = page
  const clock = options.clock ?? systemClock
  const storage =
    options.storage ??
    browserStorage(window as { localStorage?: KeyValueStorage }) ??
    memoryStorage()
  const pingTimeoutMs = options.pingTimeoutMs ?? CONNECT_PING_TIMEOUT_MS
  const bridgeTimeoutMs = options.bridgeTimeoutMs ?? CONNECT_BRIDGE_TIMEOUT_MS
  const minVersion = options.minVersion ?? MIN_CONNECT_VERSION
  const origin = window.location.origin
  const idPrefix = randomPrefix()

  const listeners = new Set<(status: ConnectStatus) => void>()
  const pongWaiters = new Set<(pong: { version: string; features: string[] }) => void>()
  const pending = new Map<string, PendingRequest>()
  let status: ConnectStatus | undefined
  let running: Promise<ConnectStatus> | undefined
  let rerun: Promise<ConnectStatus> | undefined
  let nextId = 0
  let disposed = false

  function onMessage(event: MessageEvent): void {
    // Only the page itself (where FXM Connect's content script posts from) is trusted.
    if (event.source !== window || event.origin !== origin) return
    const data: unknown = event.data
    if (!isRecord(data)) return
    if (data.type === CONNECT_MESSAGE.pong) {
      const pong = readPong(data)
      if (pong === undefined) return
      // A pong nobody waits for, e.g. one that came after the timeout, still says Connect works.
      if (pongWaiters.size === 0) update(answered(pong))
      for (const waiter of [...pongWaiters]) waiter(pong)
      return
    }
    if (data.type !== CONNECT_MESSAGE.response && data.type !== CONNECT_MESSAGE.error) return
    if (typeof data.id !== 'string') return
    const request = pending.get(data.id)
    if (request === undefined) return
    if (data.type === CONNECT_MESSAGE.response) {
      if (typeof data.status === 'number' && Number.isInteger(data.status) && 'json' in data) {
        request.settle(data)
      }
    } else if (typeof data.code === 'string') {
      request.settle(new ConnectBridgeError(data.code))
      // The announced features are out of date: the login was turned off, or never applied here.
      if (data.code === 'login-disabled' || data.code === 'private-tab') void detect()
    }
  }
  window.addEventListener('message', onMessage)

  // FXM Connect announces nothing when the user changes its options, often in another tab, so
  // detect again when the user comes back to this one.
  const onFocus = () => {
    void detect()
  }
  const onVisibilityChange = () => {
    if (window.document.visibilityState === 'visible') void detect()
  }
  window.addEventListener('focus', onFocus)
  window.document.addEventListener('visibilitychange', onVisibilityChange)

  const Observer = window.MutationObserver
  const observer =
    Observer === undefined
      ? undefined
      : new Observer(() => {
          void detect()
        })
  const root = window.document.documentElement
  if (observer !== undefined && root !== null) {
    observer.observe(root, { attributes: true, attributeFilter: [CONNECT_MARKER_ATTRIBUTE] })
  }

  function marker(): string | undefined {
    return window.document.documentElement?.getAttribute(CONNECT_MARKER_ATTRIBUTE) || undefined
  }

  function ping(): Promise<{ version: string; features: string[] } | undefined> {
    return new Promise((resolve) => {
      const finish = (pong: { version: string; features: string[] } | undefined) => {
        clock.clearTimeout(timer)
        pongWaiters.delete(finish)
        resolve(pong)
      }
      const timer = clock.setTimeout(() => finish(undefined), pingTimeoutMs)
      pongWaiters.add(finish)
      window.postMessage({ type: CONNECT_MESSAGE.ping }, origin)
    })
  }

  function seenBefore(): string | undefined {
    const seen = readJson(storage, CONNECT_SEEN_KEY)
    return isRecord(seen) && typeof seen.version === 'string' && seen.version !== ''
      ? seen.version
      : undefined
  }

  /** The status for a pong, remembering on this device that FXM Connect was seen. */
  function answered(pong: { version: string; features: string[] }): ConnectStatus {
    writeJson(storage, CONNECT_SEEN_KEY, { version: pong.version, at: clock.now() })
    const comparison = compareVersions(pong.version, minVersion)
    return {
      state: comparison !== undefined && comparison >= 0 ? 'present' : 'outdated',
      version: pong.version,
      features: pong.features,
    }
  }

  async function runDetection(): Promise<ConnectStatus> {
    const pong = marker() === undefined ? undefined : await ping()
    let next: ConnectStatus
    if (pong === undefined) {
      const lastSeenVersion = seenBefore()
      next =
        lastSeenVersion === undefined
          ? { state: 'absent', features: [] }
          : { state: 'missing', features: [], lastSeenVersion }
    } else {
      next = answered(pong)
    }
    update(next)
    return next
  }

  function update(next: ConnectStatus): void {
    if (disposed) return
    const changed = !sameStatus(status, next)
    status = next
    if (!changed) return
    for (const listener of [...listeners]) {
      try {
        listener(next)
      } catch {
        // A failing listener must not stop the others.
      }
    }
  }

  function detect(): Promise<ConnectStatus> {
    if (running === undefined) {
      running = runDetection().finally(() => {
        running = undefined
      })
      return running
    }
    // The running detection may have read the marker before whatever prompted this call.
    rerun ??= running.then(() => {
      rerun = undefined
      return detect()
    })
    return rerun
  }

  async function bridge(
    message: Record<string, unknown>,
    requestOptions: BridgeRequestOptions,
  ): Promise<BridgeResponse> {
    const { signal } = requestOptions
    signal?.throwIfAborted()
    const current = status ?? (await detect())
    signal?.throwIfAborted()
    if (disposed || current.state !== 'present') {
      throw new FxmError('Unsupported', 'FXM Connect is not available on this page')
    }
    nextId += 1
    const id = `${idPrefix}.${nextId}`
    return new Promise<BridgeResponse>((resolve, reject) => {
      const onAbort = () => settle(signal?.reason)
      const timer = clock.setTimeout(
        () => settle(new FxmError('Network', 'FXM Connect did not answer in time')),
        bridgeTimeoutMs,
      )
      function settle(reply: unknown): void {
        clock.clearTimeout(timer)
        pending.delete(id)
        signal?.removeEventListener('abort', onAbort)
        if (isRecord(reply) && reply.type === CONNECT_MESSAGE.response) {
          resolve({ status: reply.status as number, json: reply.json })
        } else {
          reject(reply)
        }
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      pending.set(id, { settle })
      window.postMessage({ ...message, id }, origin)
    })
  }

  return {
    get status() {
      return status
    },
    detect,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    forget() {
      removeKey(storage, CONNECT_SEEN_KEY)
      if (status?.state === 'missing') update({ state: 'absent', features: [] })
    },
    async spotifyToken(params, requestOptions = {}) {
      const forwarded: Record<string, string> = {}
      for (const [name, value] of Object.entries(params) as [string, unknown][]) {
        if (value === undefined) continue
        const form = Object.hasOwn(SPOTIFY_TOKEN_PARAM_FORMS, name)
          ? SPOTIFY_TOKEN_PARAM_FORMS[name as keyof SpotifyTokenParams]
          : undefined
        if (form === undefined || typeof value !== 'string' || !form.test(value)) {
          throw new FxmError(
            'Unsupported',
            `FXM Connect does not forward the token parameter ${name} in this form`,
          )
        }
        forwarded[name] = value
      }
      return bridge({ type: CONNECT_MESSAGE.spotifyToken, params: forwarded }, requestOptions)
    },
    async spotifyServerTime(requestOptions = {}) {
      return bridge({ type: CONNECT_MESSAGE.spotifyServerTime }, requestOptions)
    },
    dispose() {
      if (disposed) return
      disposed = true
      window.removeEventListener('message', onMessage)
      window.removeEventListener('focus', onFocus)
      window.document.removeEventListener('visibilitychange', onVisibilityChange)
      observer?.disconnect()
      listeners.clear()
      for (const request of [...pending.values()]) {
        request.settle(new FxmError('Unsupported', 'The FXM Connect client was disposed'))
      }
    },
  }
}
