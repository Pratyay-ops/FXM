/**
 * Web-player access tokens, kept in memory only and never logged.
 *
 * - **Anonymous:** `GET open.spotify.com/api/token?reason=init&productType=web-player&totp=…
 *   &totpServer=…&totpVer=…` through `ctx.fetch`. `totp` is the RFC 6238 code of the current
 *   secret over the local clock, `totpServer` the same over Spotify's clock from
 *   `/api/server-time` (the local clock when that fails), and `totpVer` the secret's version.
 * - **Account:** the same request with `reason=transport`, sent with the user's own Spotify
 *   session cookies by a pluggable {@link SessionTokenSource}: FXM Connect's session bridge on the
 *   web, a login window on desktop and Android. The cookies never reach FXM's code.
 *
 * A token is refreshed lazily, when a call finds less than a minute left, and one refresh runs at
 * a time per kind. If the token endpoint refuses the TOTP, the secret is fetched again once; if
 * it is refused again, minting pauses (by default for 5 minutes) with `secret-rejected`, so the UI
 * can say "Spotify is paused: its secret stopped working".
 *
 * @module
 */

import { isFxmError, type ProviderContext } from '@fxm/core'
import type { SpotifyConfig } from './config'
import { isSpotifyError, SpotifyError } from './errors'
import type { SpotifyHttp } from './http'
import type { SecretProvider, TotpSecret } from './secret'
import { totp } from './totp'

/** The query parameters of a token request, exactly those FXM Connect's bridge forwards. */
export interface SpotifyTokenParams {
  /** `init` for an anonymous token, `transport` for the logged-in one. */
  reason: string
  /** Always `web-player`. */
  productType: string
  /** The TOTP over the local clock, 6 digits. */
  totp: string
  /** The TOTP over Spotify's clock, 6 digits. */
  totpServer: string
  /** The secret's version. */
  totpVer: string
}

/** What a {@link SessionTokenSource} got back from the token endpoint. */
export interface TokenEndpointResponse {
  /** The HTTP status. */
  status: number
  /** The parsed JSON body, or `null` when it was not JSON. */
  json: unknown
}

/**
 * Gets a token for the user's own Spotify login: it calls `open.spotify.com/api/token` with the
 * given query parameters and the user's Spotify session cookies, and returns the status and JSON
 * body. Implementations: FXM Connect's session bridge on the web (its `fxm-connect:spotify-token`
 * message), a Rust command on desktop, a native call on Android.
 *
 * It should reject with an `FxmError`: `AuthRequired` when the login is off or unusable (e.g. the
 * bridge's `login-disabled` or `private-tab`), `RateLimited` for its rate limit, `Network` for
 * network failures and timeouts.
 */
export interface SessionTokenSource {
  /** Requests a token with the user's own Spotify session. */
  requestToken(params: SpotifyTokenParams, ctx: ProviderContext): Promise<TokenEndpointResponse>
}

/** Which token a call needs: anonymous, or the user's own login. */
export type TokenKind = 'anonymous' | 'account'

/** An access token. */
export interface SpotifyAccessToken {
  /** The bearer token. Never log it. */
  readonly accessToken: string
  /** When it expires, as epoch milliseconds of the local clock. */
  readonly expiresAt: number
  /** Whether Spotify issued it without a login. */
  readonly isAnonymous: boolean
}

/** Options for {@link TokenManager}. */
export interface TokenManagerOptions {
  /** Endpoints. */
  config: SpotifyConfig
  /** The transport for the token and server-time requests. */
  http: SpotifyHttp
  /** Where the TOTP secret comes from. */
  secrets: SecretProvider
  /** The source of logged-in tokens, when the platform has one. */
  session?: SessionTokenSource
  /** The clock, as epoch milliseconds. Default `Date.now`. */
  now?: () => number
  /** Refresh a token when less than this is left. Default 60 s. */
  refreshMarginMs?: number
  /** How long minting stays paused after the secret was refused twice. Default 5 minutes. */
  secretPauseMs?: number
  /**
   * How long to remember that the user is not logged in, so account checks do not call the
   * session source on every request. Default 60 s.
   */
  loginRecheckMs?: number
  /** Called when minting pauses because the secret was refused, with when the pause ends. */
  onSecretPause?: (until: number) => void
}

interface TokenState {
  token: SpotifyAccessToken
  refreshAt: number
}

/** Rejects a TOTP the token endpoint refused, so the caller can fetch the secret again. */
class TotpRejected extends Error {}

/** Mints, caches and refreshes access tokens. */
export class TokenManager {
  readonly #o: TokenManagerOptions & {
    now: () => number
    refreshMarginMs: number
    secretPauseMs: number
    loginRecheckMs: number
  }
  readonly #state = new Map<TokenKind, TokenState>()
  readonly #minting = new Map<TokenKind, Promise<SpotifyAccessToken>>()
  #secretPausedUntil = 0
  #notLoggedInUntil = 0
  #generation = 0

  constructor(options: TokenManagerOptions) {
    this.#o = {
      now: Date.now,
      refreshMarginMs: 60_000,
      secretPauseMs: 300_000,
      loginRecheckMs: 60_000,
      ...options,
    }
  }

  /** Whether a logged-in token source is configured and the platform supports it. */
  hasSession(ctx: ProviderContext): boolean {
    return this.#o.session !== undefined && ctx.capabilities.spotify === 'account'
  }

  /** When the secret pause ends, or `undefined` when minting is not paused. */
  get secretPausedUntil(): number | undefined {
    return this.#secretPausedUntil > this.#o.now() ? this.#secretPausedUntil : undefined
  }

  /** Ends the secret pause early, e.g. after the user entered a new secret source. */
  resumeSecret(): void {
    this.#secretPausedUntil = 0
  }

  /**
   * A valid token of `kind`: the cached one while more than the refresh margin is left, else a
   * newly minted one. When a refresh fails but the cached token has not expired yet, the cached
   * token is returned.
   *
   * @throws SpotifyError: `Unsupported` (`account-unavailable`) for `account` without a session
   * source, `AuthRequired` (`login-required`) when the user is not logged in, `Unavailable`
   * (`secret-unavailable` or `secret-rejected`) when no TOTP is accepted, and the transport's
   * errors.
   */
  async get(kind: TokenKind, ctx: ProviderContext): Promise<SpotifyAccessToken> {
    const state = this.#state.get(kind)
    const now = this.#o.now()
    if (state && now < state.refreshAt) return state.token
    try {
      return await this.#mint(kind, ctx)
    } catch (error) {
      if (state && this.#o.now() < state.token.expiresAt && !isAuthFailure(error)) {
        if (!ctx.signal?.aborted) return state.token
      }
      throw error
    }
  }

  /**
   * Forgets the cached token of `kind`, e.g. after a 401, so the next {@link TokenManager.get}
   * mints a new one. With `accessToken`, only if it is still the cached one: a request that
   * failed with an old token does not discard a newer token another request already got.
   */
  invalidate(kind: TokenKind, accessToken?: string): void {
    const state = this.#state.get(kind)
    if (state && (accessToken === undefined || state.token.accessToken === accessToken)) {
      this.#state.delete(kind)
    }
  }

  /** Forgets tokens (both kinds by default) and the remembered login state. */
  clear(kind?: TokenKind): void {
    this.#generation += 1
    for (const k of kind ? [kind] : (['anonymous', 'account'] as const)) {
      this.#state.delete(k)
      this.#minting.delete(k)
    }
    if (kind !== 'anonymous') this.#notLoggedInUntil = 0
  }

  async #mint(kind: TokenKind, ctx: ProviderContext): Promise<SpotifyAccessToken> {
    const running = this.#minting.get(kind)
    if (running) {
      try {
        return await running
      } catch (error) {
        // Every failure of a mint is an FxmError, except the abort of the caller that started
        // it. That abort is not ours: mint again for this caller.
        if (isFxmError(error) || ctx.signal?.aborted) throw error
      }
    }
    return this.#startMint(kind, ctx)
  }

  #startMint(kind: TokenKind, ctx: ProviderContext): Promise<SpotifyAccessToken> {
    const generation = this.#generation
    const promise = this.#mintWithSecret(kind, ctx).then((state) => {
      if (generation === this.#generation) this.#state.set(kind, state)
      return state.token
    })
    this.#minting.set(kind, promise)
    const settle = () => {
      if (this.#minting.get(kind) === promise) this.#minting.delete(kind)
    }
    promise.then(settle, settle)
    return promise
  }

  async #mintWithSecret(kind: TokenKind, ctx: ProviderContext): Promise<TokenState> {
    if (kind === 'account') this.#checkAccount(ctx)
    const pausedFor = this.#secretPausedUntil - this.#o.now()
    if (pausedFor > 0) {
      throw new SpotifyError(
        'Unavailable',
        'secret-rejected',
        `Spotify is paused for ${Math.ceil(pausedFor / 1000)} s: its TOTP secret stopped working`,
      )
    }
    const { secrets } = this.#o
    try {
      return await this.#request(kind, await secrets.get(ctx), ctx)
    } catch (error) {
      if (!(error instanceof TotpRejected)) throw error
    }
    try {
      return await this.#request(kind, await secrets.get(ctx, { refresh: true }), ctx)
    } catch (error) {
      if (!(error instanceof TotpRejected)) throw error
      this.#secretPausedUntil = this.#o.now() + this.#o.secretPauseMs
      this.#o.onSecretPause?.(this.#secretPausedUntil)
      throw new SpotifyError(
        'Unavailable',
        'secret-rejected',
        `Spotify refused the TOTP twice (${error.message}): its secret stopped working`,
      )
    }
  }

  #checkAccount(ctx: ProviderContext): void {
    if (!this.hasSession(ctx)) {
      throw new SpotifyError(
        'Unsupported',
        'account-unavailable',
        'This platform has no Spotify login to use',
      )
    }
    if (this.#notLoggedInUntil > this.#o.now()) {
      throw new SpotifyError('AuthRequired', 'login-required', 'Not logged in to Spotify')
    }
  }

  async #request(kind: TokenKind, secret: TotpSecret, ctx: ProviderContext): Promise<TokenState> {
    const { now } = this.#o
    const serverTime = await this.#serverTime(ctx)
    const localNow = now()
    const params: SpotifyTokenParams = {
      reason: kind === 'anonymous' ? 'init' : 'transport',
      productType: 'web-player',
      totp: await totp(secret.key, localNow),
      totpServer: await totp(secret.key, serverTime ?? localNow),
      totpVer: String(secret.version),
    }
    const answer = await this.#send(kind, params, ctx)
    const offset = serverTime === undefined ? 0 : serverTime - localNow
    return this.#interpret(kind, answer.status, answer.json, offset)
  }

  async #send(
    kind: TokenKind,
    params: SpotifyTokenParams,
    ctx: ProviderContext,
  ): Promise<TokenEndpointResponse> {
    const { session, http, config } = this.#o
    if (kind === 'account') {
      if (!session) throw new SpotifyError('Unsupported', 'account-unavailable', 'No Spotify login')
      try {
        return await session.requestToken(params, ctx)
      } catch (error) {
        // A login that is off or unusable (e.g. the bridge's `login-disabled`) stays so for a
        // while: remember it, so frequent checks do not use up the source's rate limit.
        if (isFxmError(error, 'AuthRequired')) {
          this.#notLoggedInUntil = this.#o.now() + this.#o.loginRecheckMs
        }
        throw error
      }
    }
    const url = new URL(config.endpoints.token)
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)
    const response = await http.request(
      { url: url.href, headers: { Accept: 'application/json' }, what: 'The token endpoint' },
      ctx,
    )
    const json: unknown = await response.json().catch(() => null)
    return { status: response.status, json }
  }

  async #serverTime(ctx: ProviderContext): Promise<number | undefined> {
    try {
      const response = await this.#o.http.request(
        {
          url: this.#o.config.endpoints.serverTime,
          headers: { Accept: 'application/json' },
          what: 'The server-time endpoint',
          // The local clock is a fine fallback: never retry or pause Spotify for this call.
          retry: false,
        },
        ctx,
      )
      if (!response.ok) return undefined
      const json: unknown = await response.json()
      const seconds = (json as { serverTime?: unknown } | null)?.serverTime
      return typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0
        ? seconds * 1000
        : undefined
    } catch (error) {
      // The local clock is the fallback, except when the caller gave up or Spotify is paused.
      if (ctx.signal?.aborted) throw ctx.signal.reason
      if (isSpotifyError(error, 'paused')) throw error
      return undefined
    }
  }

  #interpret(kind: TokenKind, status: number, json: unknown, offsetMs: number): TokenState {
    const body = (typeof json === 'object' && json !== null ? json : {}) as Record<string, unknown>
    if (status === 400) {
      throw new TotpRejected(
        body.totpVerExpired !== undefined ? 'the secret version expired' : 'HTTP 400',
      )
    }
    if (status === 401) {
      if (kind === 'account') this.#notLoggedInUntil = this.#o.now() + this.#o.loginRecheckMs
      throw new SpotifyError('AuthRequired', 'login-required', 'The token endpoint answered 401')
    }
    if (status === 403) {
      throw new SpotifyError('Unsupported', 'client-rejected', 'The token endpoint answered 403')
    }
    if (status === 429) {
      throw new SpotifyError('RateLimited', 'rate-limited', 'The token endpoint answered 429')
    }
    if (status < 200 || status > 299) {
      throw new SpotifyError('Unavailable', 'http', `The token endpoint answered HTTP ${status}`)
    }
    const { accessToken, accessTokenExpirationTimestampMs: expiry, isAnonymous } = body
    if (typeof accessToken !== 'string' || accessToken === '' || typeof expiry !== 'number') {
      throw new SpotifyError('Parse', 'bad-response', 'The token endpoint sent no usable token')
    }
    if (kind === 'account' && isAnonymous !== false) {
      this.#notLoggedInUntil = this.#o.now() + this.#o.loginRecheckMs
      throw new SpotifyError('AuthRequired', 'login-required', 'Not logged in to Spotify')
    }
    const now = this.#o.now()
    const expiresAt = expiry - offsetMs
    if (!(expiresAt > now)) {
      throw new SpotifyError('Parse', 'bad-response', 'The token endpoint sent an expired token')
    }
    // Spotify reuses an anonymous token until it expires, so a fresh one may already be inside
    // the refresh margin. Use it until it expires instead of refreshing on every call.
    const early = expiresAt - this.#o.refreshMarginMs
    return {
      token: { accessToken, expiresAt, isAnonymous: isAnonymous !== false },
      refreshAt: early > now ? early : expiresAt,
    }
  }
}

function isAuthFailure(error: unknown): boolean {
  return (
    isSpotifyError(error, 'login-required') ||
    isSpotifyError(error, 'account-unavailable') ||
    isSpotifyError(error, 'token-rejected')
  )
}
