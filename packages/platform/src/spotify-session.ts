/**
 * One way to get a token for the user's own Spotify login, the same on every platform: the
 * Spotify provider (stage 1.5) takes a {@link SessionTokenSource} and never needs to know where
 * it runs.
 *
 * - **Web:** FXM Connect's session bridge ({@link connectSessionSource}). It works while FXM
 *   Connect announces `spotify-login`. With FXM Connect but without the login it rejects with
 *   `AuthRequired`, and without FXM Connect with `Unsupported`.
 * - **Desktop and Android:** the login window's token command (stages 7.4 and 6.5), passed to
 *   `createPlatform` as `spotifySession`; on Android `createPlatform` picks up the app's own
 *   (`androidSpotifyLoginIfAvailable`). It is the only place the login's cookies are used: never
 *   the transport's native HTTP.
 *
 * `capabilities.spotify` is `account` exactly when the source can serve a token.
 *
 * @module
 */

import type { BridgeRequestOptions, ConnectClient, SpotifyTokenParams } from './connect'

/** What the token endpoint answered: the HTTP status and the parsed JSON body (`null` if none). */
export interface TokenEndpointResponse {
  /** The HTTP status of Spotify's response. */
  readonly status: number
  /** The response body, parsed. Never logged: it holds a token. */
  readonly json: unknown
}

/** Options for {@link SessionTokenSource.requestToken}; a provider's `ProviderContext` fits. */
export interface SessionTokenOptions {
  /** Cancels the request. */
  readonly signal?: AbortSignal
}

/**
 * Gets a token for the user's own Spotify login: `open.spotify.com/api/token` with the given
 * query parameters and the user's Spotify session, answered with the status and JSON body. The
 * shape matches the Spotify provider's `SessionTokenSource`, so a platform's source can be passed
 * to it as it is.
 *
 * It rejects with an `FxmError`: `AuthRequired` when the login is off or unusable (FXM Connect's
 * `login-disabled` and `private-tab`), `RateLimited` for its rate limit, `Network` for network
 * failures and timeouts, and `Unsupported` when the platform has no way to reach the login (no
 * FXM Connect on the page).
 */
export interface SessionTokenSource {
  /** Requests a token with the user's own Spotify session. */
  requestToken(
    params: SpotifyTokenParams,
    options?: SessionTokenOptions,
  ): Promise<TokenEndpointResponse>
}

/** The web's {@link SessionTokenSource}: FXM Connect's session bridge. */
export function connectSessionSource(
  connect: Pick<ConnectClient, 'spotifyToken'>,
): SessionTokenSource {
  return {
    requestToken(params, options = {}) {
      const bridgeOptions: BridgeRequestOptions =
        options.signal === undefined ? {} : { signal: options.signal }
      return connect.spotifyToken(params, bridgeOptions)
    },
  }
}
