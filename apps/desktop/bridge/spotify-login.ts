/**
 * The user's own Spotify login in the desktop app (stage 7.4), over the `fxm-spotify` plugin in
 * `src-tauri/src/spotify_login.rs`.
 *
 * `login()` opens Spotify's login page in a window of its own. Once the user is logged in, Rust
 * keeps Spotify's login cookie in the operating system's credential store and closes the window;
 * from then on {@link DesktopSpotifyLogin.session} answers the Spotify provider's token requests
 * with the token only. The cookie never reaches page JavaScript, and Spotify needs no
 * `unsafe-headers` for it. Pass the session to `createPlatform` as `spotifySession`, and Spotify
 * becomes `account` there (`capabilities.spotify`).
 *
 * @module
 */

import { FxmError } from '@fxm/core'
import {
  desktopBrowserUserAgent,
  type SessionTokenSource,
  type SpotifyTokenParams,
  type TokenEndpointResponse,
} from '@fxm/platform'
import {
  commandErrorCode,
  commandErrorMessage,
  DesktopCommandError,
  type Loadable,
  loadOnce,
} from './load-once'
import { loadShellBindings, type ShellBindings } from './shell'

/** The plugin's name: its commands are `plugin:fxm-spotify|<command>`. */
export const SPOTIFY_PLUGIN = 'fxm-spotify'

/** The plugin's commands (`src-tauri/src/spotify_login.rs`). */
export const SPOTIFY_COMMANDS = {
  status: 'status',
  login: 'login',
  logout: 'logout',
  token: 'token',
} as const

/** The event the main window gets when the login changed, with `{ loggedIn }`. */
export const SPOTIFY_LOGIN_EVENT = 'fxm-spotify-login'

/** The token parameters Rust takes, in its order: those FXM Connect's bridge forwards. */
const TOKEN_PARAMS = ['reason', 'productType', 'totp', 'totpServer', 'totpVer'] as const

/** `plugin:fxm-spotify|<name>`. */
function command(name: (typeof SPOTIFY_COMMANDS)[keyof typeof SPOTIFY_COMMANDS]): string {
  return `plugin:${SPOTIFY_PLUGIN}|${name}`
}

/**
 * A refusal of the token command as the `FxmError` a `SessionTokenSource` gives: no login kept
 * is `AuthRequired`, the rate limit `RateLimited`, a credential store that failed or is missing,
 * or a plugin that isn't there (an answer without a code), `Unsupported`, an answer too large to
 * read `Parse`, anything else `Network`.
 */
export function spotifyLoginError(error: unknown): FxmError {
  const message = commandErrorMessage(error, 'The Spotify login failed')
  const options = { cause: error }
  switch (commandErrorCode(error)) {
    case 'logged-out':
      return new FxmError('AuthRequired', message, options)
    case 'rate-limited':
      return new FxmError('RateLimited', message, options)
    case 'keychain':
    case undefined:
      return new FxmError('Unsupported', message, options)
    case 'too-large':
    case 'bad-request':
      return new FxmError('Parse', message, options)
    default:
      return new FxmError('Network', message, options)
  }
}

/** The token command's answer, checked: a status and the token's fields. */
function parseTokenAnswer(value: unknown): TokenEndpointResponse {
  const raw = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>
  const { status } = raw
  if (typeof status !== 'number' || !Number.isInteger(status) || status < 100 || status > 599) {
    throw new FxmError('Parse', 'The Spotify login answered without a status')
  }
  return { status, json: raw.json ?? null }
}

/** Whether the login is kept, from an answer `{ loggedIn }`. */
function parseLoggedIn(value: unknown): boolean {
  return (value as { loggedIn?: unknown } | null)?.loggedIn === true
}

/** Rejects with `signal`'s reason when it aborts before `promise` settles. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return promise
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason)
    if (signal.aborted) abort()
    signal.addEventListener('abort', abort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

/** Options for {@link createDesktopSpotifyLogin}. */
export interface DesktopSpotifyLoginOptions {
  /** Tauri's bindings. Default: `loadShellBindings`, on first use. */
  bindings?: Loadable<ShellBindings>
  /**
   * The browser User-Agent Spotify sees, on the login page and the token request. Default: the
   * webview's, completed to Safari's on macOS (`desktopBrowserUserAgent` from `@fxm/platform`),
   * the same as the desktop transport's.
   */
  userAgent?: string
  /** Where a failed subscription is reported. Default: `console.error`. */
  onError?: (error: unknown) => void
}

/** The Spotify login in the desktop app. */
export interface DesktopSpotifyLogin {
  /**
   * The token source for `createPlatform({ spotifySession })` and the Spotify provider: asks
   * Rust for a token with the kept login. Rejects with an `FxmError` ({@link spotifyLoginError}).
   */
  readonly session: SessionTokenSource
  /** Whether a login is kept. Rejects with a {@link DesktopCommandError} (`keychain`). */
  status(): Promise<boolean>
  /**
   * Opens Spotify's login window, or brings it forward, and resolves once it ends: `true` when
   * the user logged in, `false` when the window was closed. Call it from a click: it rejects with
   * a {@link DesktopCommandError} `not-focused` unless FXM's window is in front, and `keychain`
   * when the user logged in but the system's credential store couldn't keep the login (a denied
   * keychain prompt, no Secret Service on Linux).
   */
  login(): Promise<boolean>
  /**
   * Forgets the login: Rust deletes the cookie from the credential store and from its memory,
   * and clears and closes the login window if it is open. The provider's token stays in its
   * memory until it is told to forget it too.
   */
  logout(): Promise<void>
  /** Calls `listener` whenever the login changes. Returns a function that stops it. */
  onChange(listener: (loggedIn: boolean) => void): () => void
}

/** Creates the desktop app's Spotify login over the plugin (see the module notes). */
export function createDesktopSpotifyLogin(
  options: DesktopSpotifyLoginOptions = {},
): DesktopSpotifyLogin {
  const bindings = loadOnce(options.bindings ?? loadShellBindings)
  const onError = options.onError ?? ((error: unknown) => console.error(error))
  const userAgent = () =>
    options.userAgent ??
    desktopBrowserUserAgent(
      (globalThis as { navigator?: { userAgent?: string } }).navigator?.userAgent,
    )
  const call = async <T>(
    name: Parameters<typeof command>[0],
    args: Record<string, unknown> = {},
  ): Promise<T> => {
    const { invoke } = await bindings()
    try {
      return await invoke<T>(command(name), args)
    } catch (error) {
      throw new DesktopCommandError(error, 'The Spotify login failed')
    }
  }

  const session: SessionTokenSource = {
    async requestToken(params: SpotifyTokenParams, requestOptions = {}) {
      const { signal } = requestOptions
      signal?.throwIfAborted()
      const sent: Record<string, string> = {}
      for (const name of TOKEN_PARAMS) {
        const value = params[name]
        if (value !== undefined) sent[name] = value
      }
      const answer = (async () => {
        const { invoke } = await bindings()
        return invoke<unknown>(command(SPOTIFY_COMMANDS.token), {
          params: sent,
          userAgent: userAgent(),
        })
      })()
      try {
        return parseTokenAnswer(await untilAborted(answer, signal))
      } catch (error) {
        if (signal?.aborted) throw signal.reason
        if (error instanceof FxmError) throw error
        throw spotifyLoginError(error)
      }
    },
  }

  return {
    session,
    async status() {
      return parseLoggedIn(await call<unknown>(SPOTIFY_COMMANDS.status))
    },
    async login() {
      return parseLoggedIn(await call<unknown>(SPOTIFY_COMMANDS.login, { userAgent: userAgent() }))
    },
    async logout() {
      await call(SPOTIFY_COMMANDS.logout)
    },
    onChange(listener) {
      let stopped = false
      let unlisten: (() => void) | undefined
      bindings()
        .then((tauri) =>
          tauri.listen<unknown>(SPOTIFY_LOGIN_EVENT, ({ payload }) => {
            if (typeof (payload as { loggedIn?: unknown } | null)?.loggedIn === 'boolean') {
              listener(parseLoggedIn(payload))
            }
          }),
        )
        .then(
          (stop) => {
            if (stopped) stop()
            else unlisten = stop
          },
          (error: unknown) => {
            if (!stopped) onError(error)
          },
        )
      return () => {
        stopped = true
        unlisten?.()
        unlisten = undefined
      }
    },
  }
}
