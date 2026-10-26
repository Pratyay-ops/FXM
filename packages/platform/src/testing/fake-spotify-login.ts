/**
 * A fake `FxmSpotifyLogin` plugin (the Android app's Spotify login, stage 6.5) for tests. It
 * speaks the bridge protocol of `android-spotify-login.ts` the way the native plugin does: a
 * login kept or not, a login window that a test answers, logout, and token requests that need a
 * kept login (`LOGGED_OUT` otherwise), check their parameters (`BAD_REQUEST`) and are rate
 * limited (`RATE_LIMITED` with `data.retryAfterMs`). Answers come from a handler. No cookie ever
 * exists here: the native plugin keeps it, and JavaScript never sees it.
 *
 * @module
 */

import {
  FXM_SPOTIFY_LOGIN_RATE_LIMIT,
  FXM_SPOTIFY_LOGIN_TOKEN_PARAMS,
  type FxmSpotifyLoginErrorCode,
  type FxmSpotifyLoginPlugin,
  type FxmSpotifyTokenRequest,
  type SpotifyLoginState,
} from '../android-spotify-login'
import type { TokenEndpointResponse } from '../spotify-session'

/**
 * An error as the bridge delivers the plugin's rejections: a message, a `code` and, for
 * `RATE_LIMITED`, `data.retryAfterMs`.
 */
export function fxmSpotifyLoginError(
  code: FxmSpotifyLoginErrorCode,
  message: string = code,
  data?: Readonly<Record<string, unknown>>,
): Error & { code: string; data?: Readonly<Record<string, unknown>> } {
  return Object.assign(new Error(message), { code }, data === undefined ? {} : { data })
}

/** Options for {@link createFakeFxmSpotifyLogin}. */
export interface FakeFxmSpotifyLoginOptions {
  /** Whether a login is kept when the test starts. Default: no. */
  loggedIn?: boolean
  /** Whether the login window can open (a WebView with profiles). Default: yes. */
  available?: boolean
  /**
   * What the user does in the login window: `true` signs in, `false` closes it, a thrown error
   * (e.g. {@link fxmSpotifyLoginError} `STORAGE`) makes `login` reject. Default: they sign in.
   */
  window?: () => boolean | Promise<boolean>
  /**
   * Spotify's answer to a token request with the kept login, or a thrown error (e.g.
   * `NETWORK`). Default: 200 with a logged-in token that expires in an hour.
   */
  answer?: (
    params: Readonly<Record<string, string>>,
  ) => TokenEndpointResponse | Promise<TokenEndpointResponse>
  /** The clock for the rate limit, as epoch milliseconds. Default `Date.now`. */
  now?: () => number
}

/** A fake plugin that records what it was asked. */
export interface FakeFxmSpotifyLogin extends FxmSpotifyLoginPlugin {
  /** Whether a login is kept now. A test may change it, as a login made earlier would. */
  loggedIn: boolean
  /** Whether the login window can open. */
  available: boolean
  /** Every call by method name, in order: `status`, `login`, `logout`, `requestToken`. */
  readonly calls: readonly string[]
  /** The parameters of every token request that reached Spotify, in order. */
  readonly tokenRequests: readonly Readonly<Record<string, string>>[]
}

/** Creates a fake `FxmSpotifyLogin` plugin. */
export function createFakeFxmSpotifyLogin(
  options: FakeFxmSpotifyLoginOptions = {},
): FakeFxmSpotifyLogin {
  const now = options.now ?? Date.now
  const calls: string[] = []
  const tokenRequests: Readonly<Record<string, string>>[] = []
  const sent: number[] = []
  let windowOpen = false
  const forms = new Map<string, RegExp>(FXM_SPOTIFY_LOGIN_TOKEN_PARAMS)

  const fake: FakeFxmSpotifyLogin = {
    loggedIn: options.loggedIn ?? false,
    available: options.available ?? true,
    get calls() {
      return calls
    },
    get tokenRequests() {
      return tokenRequests
    },
    async status() {
      calls.push('status')
      return state()
    },
    async login() {
      calls.push('login')
      if (!fake.available) return state()
      if (windowOpen) throw fxmSpotifyLoginError('BUSY', 'The Spotify login window is open already')
      windowOpen = true
      try {
        if (await (options.window?.() ?? true)) fake.loggedIn = true
      } finally {
        windowOpen = false
      }
      return state()
    },
    async logout() {
      calls.push('logout')
      fake.loggedIn = false
      return state()
    },
    async requestToken({ params }: FxmSpotifyTokenRequest) {
      calls.push('requestToken')
      for (const [name, value] of Object.entries(params)) {
        const form = forms.get(name)
        if (form === undefined || typeof value !== 'string' || !form.test(value)) {
          throw fxmSpotifyLoginError('BAD_REQUEST', `FXM doesn't send the token parameter ${name}`)
        }
      }
      if (!fake.loggedIn) {
        throw fxmSpotifyLoginError('LOGGED_OUT', 'No Spotify login is kept on this device')
      }
      const time = now()
      while (sent.length > 0 && (sent[0] ?? 0) <= time - FXM_SPOTIFY_LOGIN_RATE_LIMIT.windowMs) {
        sent.shift()
      }
      if (sent.length >= FXM_SPOTIFY_LOGIN_RATE_LIMIT.max) {
        const retryAfterMs = (sent[0] ?? time) + FXM_SPOTIFY_LOGIN_RATE_LIMIT.windowMs - time
        throw fxmSpotifyLoginError('RATE_LIMITED', 'Too many Spotify token requests', {
          retryAfterMs,
        })
      }
      sent.push(time)
      tokenRequests.push({ ...params })
      return (
        options.answer?.(params) ?? {
          status: 200,
          json: {
            accessToken: 'fake-account-token',
            accessTokenExpirationTimestampMs: time + 3_600_000,
            isAnonymous: false,
            clientId: 'fake-client',
          },
        }
      )
    },
  }

  function state(): SpotifyLoginState {
    return { loggedIn: fake.loggedIn, available: fake.available }
  }

  return fake
}
