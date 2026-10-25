/**
 * Web-player access tokens, kept in memory only and never logged.
 *
 * - **Anonymous:** `GET open.spotify.com/api/token?reason=init&productType=web-player&totp=…
 *   &totpServer=…&totpVer=…` through `ctx.fetch`. `totp` is the RFC 6238 code of the current
 *   secret over the local clock, `totpServer` the same over Spotify's clock from
 *   `/api/server-time` (the local clock when that fails), and `totpVer` the secret's version.
 * - **Account:** the same request with `reason=transport`, sent with the user's own Spotify
 *   session cookies by a pluggable {@link SessionTokenSource}: FXM Connect's session bridge on the
 *   web, a login window on desktop and Android. The cookies never reach FXM's code. The account
 *   is used only while the platform has a login source (`capabilities.spotify` is `account`) and
 *   the user has connected it; both are checked on every call, also when a token is cached.
 *
 * A token is refreshed lazily, when a call finds less than a minute left, and one refresh runs at
 * a time per kind. Such an early refresh is not retried: when it fails, the token still works, so
 * it is used and the refresh is tried again a little later. Only a token that has expired is
 * minted with retries, which pause the provider when the token endpoint keeps failing.
 *
 * If the token endpoint refuses the TOTP, the secret is fetched again, skipping a source that
 * still serves the refused one; if that is refused too, or no secret can be loaded at all,
 * minting pauses with `secret-rejected` or `secret-unavailable`, so the UI can say "Spotify is
 * paused: its secret stopped working".
 *
 * @module
 */

import { isFxmError, type ProviderContext } from '@fxm/core'
import type { SpotifyConfig } from './config'
import { isSpotifyError, messageOf, redact, SpotifyError } from './errors'
import type { SpotifyHttp } from './http'
import {
  type SpotifySecretLoadOptions,
  type SpotifySecretProvider,
  type SpotifyTotpSecret,
  sameSpotifySecret,
} from './secret'
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
  /** The secret's version, 1 to 4 digits. */
  totpVer: string
}

/** What a {@link SessionTokenSource} got back from the token endpoint. */
export interface SpotifyTokenResponse {
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
 * It should reject with an `FxmError`: `AuthRequired` when the login is off (e.g. the bridge's
 * `login-disabled`), `Unsupported` when it cannot be used here (`private-tab`), `RateLimited` for
 * its rate limit, `Network` for network failures and timeouts. The provider turns each failure
 * into a {@link SpotifyError} (`login-required`, `account-unsupported`, `rate-limited`,
 * `network`; anything else counts as `network`) and keeps the original as `cause`.
 */
export interface SessionTokenSource {
  /** Requests a token with the user's own Spotify session. */
  requestToken(params: SpotifyTokenParams, ctx: ProviderContext): Promise<SpotifyTokenResponse>
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

/** Why minting is paused, and until when. */
export interface SpotifySecretPause {
  /** When minting is tried again, as epoch milliseconds. */
  readonly until: number
  /**
   * `secret-unavailable`: no secret source could be read or understood. `secret-rejected`:
   * Spotify refused the TOTP of every secret FXM found.
   */
  readonly reason: 'secret-unavailable' | 'secret-rejected'
}

/** Options for {@link TokenManager}. */
export interface TokenManagerOptions {
  /** The current config, for the endpoints. */
  config: () => SpotifyConfig
  /** The transport for the token and server-time requests. */
  http: SpotifyHttp
  /** Where the TOTP secret comes from. */
  secrets: SpotifySecretProvider
  /** The source of logged-in tokens, when the platform has one. */
  session?: SessionTokenSource
  /** Whether the user has connected their account. Default: yes. */
  isAccountEnabled?: () => boolean
  /** The clock, as epoch milliseconds. Default `Date.now`. */
  now?: () => number
  /** Refresh a token when less than this is left. Default 60 s. */
  refreshMarginMs?: number
  /** After an early refresh failed, how long the still-valid token is used before the next try. */
  refreshRetryMs?: number
  /**
   * How long minting pauses after the secret was refused, and the longest pause after secret
   * loads failed. Default 5 minutes.
   */
  secretPauseMs?: number
  /**
   * How long minting pauses after the first failed secret load; each further failure doubles it,
   * up to `secretPauseMs`. Default 1 minute.
   */
  secretRetryMs?: number
  /**
   * How long to remember that the user is not logged in, so account checks do not call the
   * session source on every request. Default 60 s.
   */
  loginRecheckMs?: number
  /** Called when minting pauses because of the secret. */
  onSecretPause?: (pause: SpotifySecretPause) => void
  /** Called when the token endpoint answers 403: it refuses this client. */
  onClientRejected?: () => void
  /**
   * Called when an account token is minted that differs from the cached one, e.g. after the
   * user switched Spotify accounts: personal answers cached for the old token must go.
   */
  onAccountChange?: () => void
}

interface TokenState {
  token: SpotifyAccessToken
  refreshAt: number
}

/** Rejects a TOTP the token endpoint refused, so the caller can fetch the secret again. */
class TotpRejected extends Error {}

const KINDS = ['anonymous', 'account'] as const

/** Mints, caches and refreshes access tokens. */
export class TokenManager {
  readonly #o: TokenManagerOptions & {
    isAccountEnabled: () => boolean
    now: () => number
    refreshMarginMs: number
    refreshRetryMs: number
    secretPauseMs: number
    secretRetryMs: number
    loginRecheckMs: number
  }
  readonly #state = new Map<TokenKind, TokenState>()
  readonly #minting = new Map<TokenKind, Promise<SpotifyAccessToken>>()
  readonly #generation: Record<TokenKind, number> = { anonymous: 0, account: 0 }
  readonly #refreshRetryAt: Record<TokenKind, number> = { anonymous: 0, account: 0 }
  #secretPause: SpotifySecretPause | undefined
  #secretFailures = 0
  #accountRefusal: { until: number; reason: 'login-required' | 'account-unsupported' } | undefined

  constructor(options: TokenManagerOptions) {
    this.#o = {
      isAccountEnabled: () => true,
      now: Date.now,
      refreshMarginMs: 60_000,
      refreshRetryMs: 15_000,
      secretPauseMs: 300_000,
      secretRetryMs: 60_000,
      loginRecheckMs: 60_000,
      ...options,
    }
  }

  /**
   * Whether the account may be used: a logged-in token source is configured, the platform
   * supports it (`capabilities.spotify` is `account`) and the user has connected it. Whether the
   * user is logged in to Spotify is up to the source.
   */
  canUseAccount(ctx: ProviderContext): boolean {
    return (
      this.#o.session !== undefined &&
      ctx.capabilities.spotify === 'account' &&
      this.#o.isAccountEnabled()
    )
  }

  /** Why and until when minting is paused, or `undefined` when it is not. */
  get secretPause(): SpotifySecretPause | undefined {
    const pause = this.#secretPause
    return pause && pause.until > this.#o.now() ? pause : undefined
  }

  /** Ends the secret pause early, e.g. after the user entered a new secret source. */
  resumeSecret(): void {
    this.#secretPause = undefined
    this.#secretFailures = 0
  }

  /**
   * A valid token of `kind`: the cached one while more than the refresh margin is left, else a
   * newly minted one. When an early refresh fails but the cached token has not expired yet, the
   * cached token is returned (unless the failure says the account is gone).
   *
   * @throws SpotifyError: for `account`, `account-unsupported` without a usable login source,
   * `account-disabled` when the user has not connected the account, `login-required` when the
   * user is not logged in; `secret-unavailable` or `secret-rejected` while no TOTP is accepted;
   * and the transport's errors. A caller's abort rejects with its signal's reason.
   */
  async get(kind: TokenKind, ctx: ProviderContext): Promise<SpotifyAccessToken> {
    if (kind === 'account') this.#checkAccount(ctx)
    const state = this.#state.get(kind)
    const now = this.#o.now()
    if (state && now < state.refreshAt) return state.token
    const valid = state !== undefined && now < state.token.expiresAt
    if (valid && now < this.#refreshRetryAt[kind]) return state.token
    try {
      return await this.#mint(kind, ctx, valid)
    } catch (error) {
      // An account failure has already dropped the account token, so `current` is gone then.
      const current = this.#state.get(kind)
      if (
        current &&
        this.#o.now() < current.token.expiresAt &&
        !isAuthFailure(error) &&
        !ctx.signal?.aborted
      ) {
        // The token still works: use it, and try the refresh again a little later.
        this.#refreshRetryAt[kind] = this.#o.now() + this.#o.refreshRetryMs
        return current.token
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

  /** Forgets tokens (both kinds by default) and, for the account, the remembered login state. */
  clear(kind?: TokenKind): void {
    for (const k of kind ? [kind] : KINDS) {
      this.#generation[k] += 1
      this.#state.delete(k)
      this.#minting.delete(k)
      this.#refreshRetryAt[k] = 0
    }
    if (kind !== 'anonymous') this.#accountRefusal = undefined
  }

  async #mint(kind: TokenKind, ctx: ProviderContext, early: boolean): Promise<SpotifyAccessToken> {
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
    return this.#startMint(kind, ctx, early)
  }

  #startMint(kind: TokenKind, ctx: ProviderContext, early: boolean): Promise<SpotifyAccessToken> {
    const generation = this.#generation[kind]
    const promise = this.#mintWithSecret(kind, ctx, early).then((state) => {
      if (generation === this.#generation[kind]) {
        const previous = this.#state.get(kind)?.token.accessToken
        this.#state.set(kind, state)
        this.#refreshRetryAt[kind] = 0
        if (kind === 'account' && state.token.accessToken !== previous) {
          this.#o.onAccountChange?.()
        }
      }
      return state.token
    })
    this.#minting.set(kind, promise)
    const settle = () => {
      if (this.#minting.get(kind) === promise) this.#minting.delete(kind)
    }
    promise.then(settle, settle)
    return promise
  }

  async #mintWithSecret(
    kind: TokenKind,
    ctx: ProviderContext,
    early: boolean,
  ): Promise<TokenState> {
    if (kind === 'account') this.#checkAccount(ctx)
    this.#assertSecretNotPaused()
    const secret = await this.#loadSecret(ctx)
    let state: TokenState | undefined
    try {
      state = await this.#request(kind, secret, ctx, early)
    } catch (error) {
      if (!(error instanceof TotpRejected)) throw error
    }
    if (!state) {
      const next = await this.#loadSecret(ctx, { refresh: true, refused: secret })
      if (sameSpotifySecret(next, secret)) {
        throw this.#pauseSecret(
          'secret-rejected',
          'Spotify refused the TOTP, and no source has another secret',
        )
      }
      try {
        state = await this.#request(kind, next, ctx, early)
      } catch (error) {
        if (!(error instanceof TotpRejected)) throw error
        throw this.#pauseSecret(
          'secret-rejected',
          `Spotify refused the TOTP twice (${error.message}): its secret stopped working`,
        )
      }
    }
    this.#secretFailures = 0
    return state
  }

  /** The secret, or the pause its failure causes. */
  async #loadSecret(
    ctx: ProviderContext,
    options?: SpotifySecretLoadOptions,
  ): Promise<SpotifyTotpSecret> {
    try {
      return await this.#o.secrets.get(ctx, options)
    } catch (error) {
      if (ctx.signal?.aborted) throw ctx.signal.reason
      if (isSpotifyError(error, 'secret-rejected')) {
        throw this.#pauseSecret('secret-rejected', error.message, error)
      }
      const message = isSpotifyError(error, 'secret-unavailable')
        ? error.message
        : `Could not load the Spotify TOTP secret: ${redact(messageOf(error))}`
      throw this.#pauseSecret('secret-unavailable', message, error)
    }
  }

  /** Pauses minting and returns the error to throw. */
  #pauseSecret(
    reason: SpotifySecretPause['reason'],
    message: string,
    cause?: unknown,
  ): SpotifyError {
    const { secretPauseMs, secretRetryMs } = this.#o
    let ms = secretPauseMs
    if (reason === 'secret-unavailable') {
      this.#secretFailures += 1
      ms = Math.min(secretPauseMs, secretRetryMs * 2 ** (this.#secretFailures - 1))
    }
    const pause = { until: this.#o.now() + ms, reason }
    this.#secretPause = pause
    this.#o.onSecretPause?.(pause)
    return new SpotifyError(
      reason,
      `${message}. Spotify is paused for ${Math.ceil(ms / 1000)} s`,
      cause === undefined ? {} : { cause },
    )
  }

  #assertSecretNotPaused(): void {
    const pause = this.secretPause
    if (!pause) return
    const seconds = Math.ceil((pause.until - this.#o.now()) / 1000)
    const why =
      pause.reason === 'secret-rejected'
        ? 'its TOTP secret stopped working'
        : 'its TOTP secret could not be loaded'
    throw new SpotifyError(pause.reason, `Spotify is paused for ${seconds} s: ${why}`)
  }

  #checkAccount(ctx: ProviderContext): void {
    if (this.#o.session === undefined || ctx.capabilities.spotify !== 'account') {
      this.#forgetAccount()
      throw new SpotifyError('account-unsupported', 'This platform has no Spotify login to use')
    }
    if (!this.#o.isAccountEnabled()) {
      this.#forgetAccount()
      throw new SpotifyError('account-disabled', 'The Spotify account is not connected in FXM')
    }
    const refusal = this.#accountRefusal
    if (refusal && refusal.until > this.#o.now()) {
      throw new SpotifyError(
        refusal.reason,
        refusal.reason === 'login-required'
          ? 'Not logged in to Spotify'
          : 'The Spotify login cannot be used here',
      )
    }
  }

  /** Drops the account token: the account must not be used any more. */
  #forgetAccount(): void {
    if (!this.#state.has('account') && !this.#minting.has('account')) return
    this.#generation.account += 1
    this.#state.delete('account')
    this.#minting.delete('account')
  }

  /** Remembers for a while that the login is off or unusable, sparing the login source. */
  #rememberRefusal(reason: 'login-required' | 'account-unsupported'): void {
    this.#accountRefusal = { until: this.#o.now() + this.#o.loginRecheckMs, reason }
    this.#forgetAccount()
  }

  async #request(
    kind: TokenKind,
    secret: SpotifyTotpSecret,
    ctx: ProviderContext,
    early: boolean,
  ): Promise<TokenState> {
    const { now } = this.#o
    const serverTime = await this.#serverTime(ctx)
    const localNow = now()
    let codes: [string, string]
    try {
      codes = [await totp(secret.key, localNow), await totp(secret.key, serverTime ?? localNow)]
    } catch (error) {
      // E.g. no WebCrypto outside a secure context.
      throw new SpotifyError(
        'secret-unavailable',
        `The TOTP could not be computed: ${redact(messageOf(error))}`,
        { cause: error },
      )
    }
    const params: SpotifyTokenParams = {
      reason: kind === 'anonymous' ? 'init' : 'transport',
      productType: 'web-player',
      totp: codes[0],
      totpServer: codes[1],
      totpVer: String(secret.version),
    }
    const answer = await this.#send(kind, params, ctx, early)
    const offset = serverTime === undefined ? 0 : serverTime - localNow
    return this.#interpret(kind, answer.status, answer.json, offset)
  }

  async #send(
    kind: TokenKind,
    params: SpotifyTokenParams,
    ctx: ProviderContext,
    early: boolean,
  ): Promise<SpotifyTokenResponse> {
    const { session, http, config } = this.#o
    if (kind === 'account') {
      if (!session) throw new SpotifyError('account-unsupported', 'No Spotify login')
      try {
        return await session.requestToken(params, ctx)
      } catch (error) {
        if (ctx.signal?.aborted) throw ctx.signal.reason
        const failure = sessionFailure(error)
        // A login that is off or unusable (e.g. the bridge's `login-disabled`) stays so for a
        // while: remember it, so frequent checks do not use up the source's rate limit.
        if (failure.reason === 'login-required' || failure.reason === 'account-unsupported') {
          this.#rememberRefusal(failure.reason)
        }
        throw failure
      }
    }
    const url = new URL(config().endpoints.token)
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)
    const response = await http.request(
      {
        url: url.href,
        headers: { Accept: 'application/json' },
        what: 'The token endpoint',
        // A refresh while the token still works must not pause the whole provider.
        retry: !early,
      },
      ctx,
    )
    let text: string
    try {
      text = await response.text()
    } catch {
      if (ctx.signal?.aborted) throw ctx.signal.reason
      throw new SpotifyError('network', 'The token endpoint: the answer could not be read')
    }
    let json: unknown = null
    try {
      json = JSON.parse(text)
    } catch {
      // Not JSON: the status decides.
    }
    return { status: response.status, json }
  }

  async #serverTime(ctx: ProviderContext): Promise<number | undefined> {
    try {
      const response = await this.#o.http.request(
        {
          url: this.#o.config().endpoints.serverTime,
          headers: { Accept: 'application/json' },
          what: 'The server-time endpoint',
          // The local clock is a fine fallback: never retry or pause Spotify for this call.
          retry: false,
        },
        ctx,
      )
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined)
        return undefined
      }
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
      if (kind === 'account') this.#rememberRefusal('login-required')
      throw new SpotifyError('login-required', 'The token endpoint answered 401')
    }
    if (status === 403) {
      this.#o.onClientRejected?.()
      throw new SpotifyError('client-rejected', 'The token endpoint answered 403')
    }
    if (status === 429) {
      throw new SpotifyError('rate-limited', 'The token endpoint answered 429')
    }
    if (status < 200 || status > 299) {
      throw new SpotifyError('http', `The token endpoint answered HTTP ${status}`)
    }
    const { accessToken, accessTokenExpirationTimestampMs: expiry, isAnonymous } = body
    if (typeof accessToken !== 'string' || accessToken === '' || typeof expiry !== 'number') {
      throw new SpotifyError('bad-response', 'The token endpoint sent no usable token')
    }
    if (kind === 'account' && isAnonymous !== false) {
      this.#rememberRefusal('login-required')
      throw new SpotifyError('login-required', 'Not logged in to Spotify')
    }
    const now = this.#o.now()
    const expiresAt = expiry - offsetMs
    if (!(expiresAt > now)) {
      throw new SpotifyError('bad-response', 'The token endpoint sent an expired token')
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

/** The typed error for a failure of a {@link SessionTokenSource}, keeping it as the cause. */
function sessionFailure(error: unknown): SpotifyError {
  if (isSpotifyError(error)) return error
  const detail = redact(messageOf(error))
  if (isFxmError(error, 'AuthRequired')) {
    return new SpotifyError('login-required', `The Spotify login source refused: ${detail}`, {
      cause: error,
    })
  }
  if (isFxmError(error, 'RateLimited')) {
    return new SpotifyError('rate-limited', `The Spotify login source is rate limited: ${detail}`, {
      cause: error,
      ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
    })
  }
  if (isFxmError(error, 'Unsupported')) {
    return new SpotifyError('account-unsupported', `The Spotify login cannot be used: ${detail}`, {
      cause: error,
    })
  }
  if (isFxmError(error, 'Parse')) {
    return new SpotifyError('bad-response', `The Spotify login source sent no answer: ${detail}`, {
      cause: error,
    })
  }
  return new SpotifyError('network', `The Spotify login source failed: ${detail}`, { cause: error })
}

/** Whether a failure says the account cannot be used, so a cached token must not be either. */
function isAuthFailure(error: unknown): boolean {
  return (
    isFxmError(error, 'AuthRequired') ||
    isSpotifyError(error, 'account-unsupported') ||
    isSpotifyError(error, 'account-disabled')
  )
}
