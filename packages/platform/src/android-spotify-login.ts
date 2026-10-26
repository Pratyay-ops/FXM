/**
 * The Android app's Spotify login (stage 6.5): a {@link SessionTokenSource} over
 * `FxmSpotifyLogin`, FXM's own Capacitor plugin in `apps/mobile/android/fxm-spotify`, and the
 * login window that gives it a login.
 *
 * The user signs in on Spotify's own login page, in a window of the app: an Activity with a
 * WebView in a WebView profile of its own, apart from the app's WebView and its cookies. Native
 * code reads Spotify's `sp_dc` login cookie from that profile, keeps it encrypted with an Android
 * Keystore key in the app's private storage, and sends it only on the token call
 * (`open.spotify.com/api/token`), through fxm-http's OkHttp client with a cookie jar of its own.
 * JavaScript never sees the cookie, nor the password: it gets the token endpoint's answer, as
 * from FXM Connect's bridge on the web, and the token stays in the Spotify provider's memory.
 *
 * `createPlatform` uses it by itself on Android when the app has the plugin
 * ({@link androidSpotifyLoginIfAvailable}), so `capabilities.spotify` is `account` there and the
 * Spotify provider takes it as its `session`. Settings opens the login window and logs out
 * through {@link SpotifyLoginWindow} ({@link spotifyLoginWindowOf}).
 *
 * @module
 */

import { FxmError, type FxmErrorCode } from '@fxm/core'
import { SPOTIFY_TOKEN_PARAM_FORMS, type SpotifyTokenParams } from './connect'
import type {
  SessionTokenOptions,
  SessionTokenSource,
  TokenEndpointResponse,
} from './spotify-session'

/** The plugin's name on the Capacitor bridge (`Capacitor.Plugins.FxmSpotifyLogin`). */
export const FXM_SPOTIFY_LOGIN_PLUGIN = 'FxmSpotifyLogin'

/**
 * Every code the plugin rejects with (the `code` of the bridge's error):
 *
 * - `BAD_REQUEST`: a token parameter outside the allow-list, or a malformed message
 * - `LOGGED_OUT`: no Spotify login is kept on this device (never logged in, logged out, or a
 *   kept login that never opens again, its key gone or the file damaged, which the plugin then
 *   deletes)
 * - `BUSY`: the login window is open already
 * - `NO_ACTIVITY`: there is no screen to open the login window on
 * - `RATE_LIMITED`: more token requests in a minute than the plugin allows
 *   ({@link FXM_SPOTIFY_LOGIN_RATE_LIMIT}); `data.retryAfterMs` says how long to wait
 * - `NETWORK`: Spotify's token endpoint could not be reached, or it redirected
 * - `TIMEOUT`: the token request took longer than {@link FXM_SPOTIFY_TOKEN_TIMEOUT_MS}
 * - `TOO_LARGE`: the token endpoint's answer was over {@link FXM_SPOTIFY_TOKEN_MAX_BYTES}
 * - `STORAGE`: the keystore or the file failed: the login window's login could not be kept, the
 *   kept login could not be opened just now (it stays kept), or logging out could not delete it
 */
export const FXM_SPOTIFY_LOGIN_ERROR_CODES = [
  'BAD_REQUEST',
  'LOGGED_OUT',
  'BUSY',
  'NO_ACTIVITY',
  'RATE_LIMITED',
  'NETWORK',
  'TIMEOUT',
  'TOO_LARGE',
  'STORAGE',
] as const

/** One of {@link FXM_SPOTIFY_LOGIN_ERROR_CODES}. */
export type FxmSpotifyLoginErrorCode = (typeof FXM_SPOTIFY_LOGIN_ERROR_CODES)[number]

/**
 * How many token requests the plugin sends in a rolling window: about ten a minute, as FXM
 * Connect's bridge allows on the web. The provider asks about once an hour.
 */
export const FXM_SPOTIFY_LOGIN_RATE_LIMIT = { max: 10, windowMs: 60_000 } as const

/** The largest token endpoint answer the plugin reads: 64 KiB, as FXM Connect's bridge. */
export const FXM_SPOTIFY_TOKEN_MAX_BYTES = 64 * 1024

/** How long one token request may take, the response included. */
export const FXM_SPOTIFY_TOKEN_TIMEOUT_MS = 15_000

/**
 * The token request's query parameters, in the order the plugin sends them, with the form each
 * must have: the same allow-list as FXM Connect's bridge (`SPOTIFY_TOKEN_PARAM_FORMS`). The
 * plugin checks them again in native code, which also fixes the URL they go to.
 */
export const FXM_SPOTIFY_LOGIN_TOKEN_PARAMS: readonly (readonly [
  keyof SpotifyTokenParams,
  RegExp,
])[] = (['reason', 'productType', 'totp', 'totpServer', 'totpVer'] as const).map(
  (name) => [name, SPOTIFY_TOKEN_PARAM_FORMS[name]] as const,
)

/** Where the login window's login stands. */
export interface SpotifyLoginState {
  /** Whether a Spotify login is kept on this device. */
  readonly loggedIn: boolean
  /**
   * Whether the login window can open here. On Android it needs a WebView with profiles
   * (androidx.webkit's `MULTI_PROFILE`), which keeps Spotify's cookies apart from the app's own
   * WebView; an older WebView has none, and Android System WebView's update brings them.
   */
  readonly available: boolean
}

/**
 * A Spotify login the app keeps itself, made in a login window of its own: the Android app's
 * (stage 6.5). The desktop app's login window (stage 7.4) can offer the same. On the web there is
 * none: the browser's own login is FXM Connect's to use.
 */
export interface SpotifyLoginWindow {
  /** Where the login stands. */
  loginState(): Promise<SpotifyLoginState>
  /**
   * Opens the login window, where the user signs in on Spotify's own page, and resolves once it
   * closes, with where the login stands then: closing it without signing in keeps an earlier
   * login. Where the window can't open (`available: false`), it resolves at once. Rejects with
   * an `Unavailable` `FxmError` when the window is open already (`BUSY`), there is no screen to
   * open it on (`NO_ACTIVITY`) or the login could not be kept (`STORAGE`).
   */
  openLogin(): Promise<SpotifyLoginState>
  /**
   * Logs out on this device: deletes the kept login and its key, and wipes the login window's
   * cookies (Spotify's among them), storage and cache. Resolves with where the login stands then.
   * Rejects with an `Unavailable` `FxmError` (`STORAGE`) when the kept login could not be deleted.
   * The Spotify session itself stays valid elsewhere.
   */
  logout(): Promise<SpotifyLoginState>
}

/**
 * The login window of a login source, when it has one ({@link SpotifyLoginWindow}): the Android
 * app's, not FXM Connect's bridge.
 */
export function spotifyLoginWindowOf(source: unknown): SpotifyLoginWindow | undefined {
  if (typeof source !== 'object' || source === null) return undefined
  const methods = source as Record<string, unknown>
  return ['loginState', 'openLogin', 'logout'].every((name) => typeof methods[name] === 'function')
    ? (source as SpotifyLoginWindow)
    : undefined
}

/** What `FxmSpotifyLogin.requestToken` takes: the token request's query parameters. */
export interface FxmSpotifyTokenRequest {
  /** Only {@link FXM_SPOTIFY_LOGIN_TOKEN_PARAMS}, each in its form. */
  readonly params: Readonly<Record<string, string>>
}

/**
 * The `FxmSpotifyLogin` plugin as the Capacitor bridge exposes it. It rejects with an error
 * whose `code` is one of {@link FXM_SPOTIFY_LOGIN_ERROR_CODES}.
 */
export interface FxmSpotifyLoginPlugin {
  /** Where the login stands. */
  status(): Promise<SpotifyLoginState>
  /** Opens the login window; resolves once it closes (see {@link SpotifyLoginWindow.openLogin}). */
  login(): Promise<SpotifyLoginState>
  /** Logs out on this device (see {@link SpotifyLoginWindow.logout}); resolves with the state. */
  logout(): Promise<SpotifyLoginState>
  /**
   * Sends `open.spotify.com/api/token` with the given query parameters and the kept login, and
   * resolves with Spotify's status and JSON body (`null` when the body is not JSON).
   */
  requestToken(request: FxmSpotifyTokenRequest): Promise<TokenEndpointResponse>
}

/** The Android app's Spotify login: a token source for the provider, and its login window. */
export interface AndroidSpotifyLogin extends SessionTokenSource, SpotifyLoginWindow {}

/**
 * A failure of the plugin, as an `FxmError` the Spotify provider understands
 * (`LOGGED_OUT` is `AuthRequired`, so the provider reports `login-required`), with the plugin's
 * own code as `loginCode` when it gave one.
 */
export class SpotifyLoginError extends FxmError {
  /** The plugin's code, when it gave one. */
  readonly loginCode: FxmSpotifyLoginErrorCode | undefined

  constructor(
    code: FxmErrorCode,
    message: string,
    loginCode: FxmSpotifyLoginErrorCode | undefined,
    options: { cause?: unknown; retryAfterMs?: number } = {},
  ) {
    super(code, message, options)
    this.loginCode = loginCode
  }
}

/** The `FxmError` code each plugin code becomes. */
const ERROR_CODES: Readonly<Record<FxmSpotifyLoginErrorCode, FxmErrorCode>> = {
  BAD_REQUEST: 'Unsupported',
  LOGGED_OUT: 'AuthRequired',
  BUSY: 'Unavailable',
  NO_ACTIVITY: 'Unavailable',
  RATE_LIMITED: 'RateLimited',
  NETWORK: 'Network',
  TIMEOUT: 'Network',
  TOO_LARGE: 'Parse',
  STORAGE: 'Unavailable',
}

/** The bridge error's `code`, when it is one of {@link FXM_SPOTIFY_LOGIN_ERROR_CODES}. */
export function fxmSpotifyLoginErrorCode(error: unknown): FxmSpotifyLoginErrorCode | undefined {
  const code = (error as { code?: unknown } | null)?.code
  return (FXM_SPOTIFY_LOGIN_ERROR_CODES as readonly unknown[]).includes(code)
    ? (code as FxmSpotifyLoginErrorCode)
    : undefined
}

/** The error a plugin rejection becomes: anything without a known code counts as `Network`. */
function loginError(error: unknown, what: string): SpotifyLoginError {
  const loginCode = fxmSpotifyLoginErrorCode(error)
  const message = (error as { message?: unknown } | null)?.message
  const detail = typeof message === 'string' && message !== '' ? message : 'it failed'
  const data = (error as { data?: unknown } | null)?.data
  const retryAfter = (data as { retryAfterMs?: unknown } | null | undefined)?.retryAfterMs
  return new SpotifyLoginError(
    loginCode === undefined ? 'Network' : ERROR_CODES[loginCode],
    `${what}: ${detail}`,
    loginCode,
    {
      cause: error,
      ...(typeof retryAfter === 'number' && Number.isFinite(retryAfter) && retryAfter > 0
        ? { retryAfterMs: retryAfter }
        : {}),
    },
  )
}

/** The plugin's state, read defensively. */
function stateOf(value: unknown): SpotifyLoginState {
  const state = (value ?? {}) as { loggedIn?: unknown; available?: unknown }
  return { loggedIn: state.loggedIn === true, available: state.available === true }
}

/**
 * The token parameters in the plugin's order, or an `Unsupported` error naming the first one
 * outside the allow-list. Checked before anything is sent, as FXM Connect's client does.
 */
function tokenParams(params: SpotifyTokenParams): Record<string, string> {
  const forms = new Map<string, RegExp>(FXM_SPOTIFY_LOGIN_TOKEN_PARAMS)
  for (const [name, value] of Object.entries(params) as [string, unknown][]) {
    if (value === undefined) continue
    const form = forms.get(name)
    if (form === undefined || typeof value !== 'string' || !form.test(value)) {
      throw new SpotifyLoginError(
        'Unsupported',
        `FXM's Spotify login does not send the token parameter ${name} in this form`,
        'BAD_REQUEST',
      )
    }
  }
  const ordered: Record<string, string> = {}
  for (const [name] of FXM_SPOTIFY_LOGIN_TOKEN_PARAMS) {
    const value = params[name]
    if (value !== undefined) ordered[name] = value
  }
  return ordered
}

/** Settles with `promise`, or rejects with the signal's reason as soon as it aborts. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return promise
  if (signal.aborted) return Promise.reject(signal.reason)
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

/** Options for {@link createAndroidSpotifyLogin}. */
export interface AndroidSpotifyLoginOptions {
  /** The plugin. Default: the one the Capacitor bridge exposes ({@link findFxmSpotifyLoginPlugin}). */
  plugin?: FxmSpotifyLoginPlugin
}

/**
 * The Android app's Spotify login over the plugin: `requestToken` is the Spotify provider's
 * logged-in token source (it rejects with `AuthRequired` while no login is kept), and
 * `loginState`, `openLogin` and `logout` serve Settings. Throws an `Unsupported` `FxmError`
 * outside the Android app, when no plugin is given or found.
 */
export function createAndroidSpotifyLogin(
  options: AndroidSpotifyLoginOptions = {},
): AndroidSpotifyLogin {
  const plugin = options.plugin ?? findFxmSpotifyLoginPlugin()
  if (plugin === undefined) {
    throw new FxmError(
      'Unsupported',
      "This app has no Spotify login window (FXM's Android app has)",
    )
  }
  return {
    async requestToken(params: SpotifyTokenParams, requestOptions: SessionTokenOptions = {}) {
      const { signal } = requestOptions
      signal?.throwIfAborted()
      const ordered = tokenParams(params)
      let answer: TokenEndpointResponse
      try {
        answer = await untilAborted(plugin.requestToken({ params: ordered }), signal)
      } catch (error) {
        if (signal?.aborted) throw signal.reason
        throw loginError(error, "Spotify's token request through the Android login")
      }
      const status = (answer as { status?: unknown } | null)?.status
      if (typeof status !== 'number' || !Number.isInteger(status)) {
        throw new SpotifyLoginError('Parse', 'The Android login sent no status', undefined)
      }
      return { status, json: (answer as { json?: unknown }).json ?? null }
    },
    async loginState() {
      try {
        return stateOf(await plugin.status())
      } catch (error) {
        throw loginError(error, "The Android Spotify login's state")
      }
    },
    async openLogin() {
      try {
        return stateOf(await plugin.login())
      } catch (error) {
        throw loginError(error, 'The Spotify login window')
      }
    },
    async logout() {
      try {
        return stateOf(await plugin.logout())
      } catch (error) {
        throw loginError(error, 'Logging out of Spotify on this device')
      }
    },
  }
}

/** The parts of the WebView's global object the plugin lookup reads. */
interface CapacitorGlobal {
  Capacitor?: {
    isNativePlatform?: () => boolean
    Plugins?: Readonly<Record<string, unknown>>
  }
}

const PLUGIN_METHODS = ['status', 'login', 'logout', 'requestToken']

/**
 * The `FxmSpotifyLogin` plugin of the Android app, or `undefined` outside it: only on a native
 * Capacitor platform whose bridge has the plugin with all its methods.
 */
export function findFxmSpotifyLoginPlugin(
  global: object = globalThis,
): FxmSpotifyLoginPlugin | undefined {
  const capacitor = (global as CapacitorGlobal).Capacitor
  if (typeof capacitor?.isNativePlatform !== 'function' || !capacitor.isNativePlatform()) {
    return undefined
  }
  const plugin = capacitor.Plugins?.[FXM_SPOTIFY_LOGIN_PLUGIN]
  if (typeof plugin !== 'object' || plugin === null) return undefined
  const methods = plugin as Record<string, unknown>
  return PLUGIN_METHODS.every((name) => typeof methods[name] === 'function')
    ? (plugin as FxmSpotifyLoginPlugin)
    : undefined
}

/**
 * {@link createAndroidSpotifyLogin} over the bridge's plugin, or `undefined` outside the Android
 * app. `createPlatform` passes it as the Android platform's `spotifySession`.
 */
export function androidSpotifyLoginIfAvailable(
  global: object = globalThis,
): AndroidSpotifyLogin | undefined {
  const plugin = findFxmSpotifyLoginPlugin(global)
  return plugin === undefined ? undefined : createAndroidSpotifyLogin({ plugin })
}
