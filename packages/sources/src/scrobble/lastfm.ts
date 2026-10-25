/**
 * Scrobbling to Last.fm: its write API (`track.updateNowPlaying`, `track.scrobble`) and the
 * desktop authentication flow that gets a session key, all through the injected `fetch`.
 *
 * Last.fm signs every call with the API account's shared secret, which FXM never ships: the
 * user creates an API account of their own and enters its key and secret, which stay on the
 * device. Every request is a `POST` whose parameters, signature and session key travel in the
 * body, never in the URL, with `credentials: 'omit'` and `redirect: 'error'`, so a redirect can
 * never carry them to another address. The body is form-encoded, so the request is
 * CORS-simple: Last.fm answers any origin (`Access-Control-Allow-Origin: *`), and the web app
 * reaches it on every tier, without FXM Connect. See CLEAN-ROOM.md for where each fact comes
 * from.
 *
 * @module
 */

import { fetchWithTimeout } from '../shared'
import { ScrobbleError, type ScrobbleFailure } from './errors'
import { bodyText, parseJson, RequestGate, retryAfterMs, timedOut } from './http'
import { md5Hex } from './md5'
import { LASTFM_RULES } from './rules'
import type { ScrobbleTarget, SubmitReport } from './target'
import type { Scrobble, ScrobbleContext, ScrobbleTrack } from './types'

/** Last.fm's API root. Every call is a `POST` to it. */
export const LASTFM_API_URL = 'https://ws.audioscrobbler.com/2.0/'

/** The page where the user allows an API account to use their Last.fm profile. */
export const LASTFM_AUTHORIZE_URL = 'https://www.last.fm/api/auth/'

/** Where the user creates the API account whose key and secret FXM asks for. */
export const LASTFM_API_ACCOUNT_URL = 'https://www.last.fm/api/account/create'

/** Where the user sees, and can revoke, the applications that may use their profile. */
export const LASTFM_APPLICATIONS_URL = 'https://www.last.fm/settings/applications'

/** The most scrobbles one `track.scrobble` request carries: Last.fm's own limit. */
export const LASTFM_BATCH_SIZE = 50

/** The Last.fm error codes FXM reacts to, from its API documentation. */
export const LASTFM_ERRORS = Object.freeze({
  /** Authentication failed, or (from `auth.getSession`) an invalid token. */
  authenticationFailed: 4,
  /** A required parameter is missing or invalid. */
  invalidParameters: 6,
  /** "Operation failed - Most likely the backend service failed. Please try again." */
  operationFailed: 8,
  /** The session key is invalid: the user revoked it. Re-authenticate. */
  invalidSession: 9,
  /** The API key is invalid. */
  invalidApiKey: 10,
  /** The service is temporarily offline. */
  serviceOffline: 11,
  /** The signature is invalid: a wrong shared secret. */
  invalidSignature: 13,
  /** The user hasn't allowed the request token yet. */
  tokenNotAuthorized: 14,
  /** The request token expired (they last 60 minutes). */
  tokenExpired: 15,
  /** A temporary error. */
  temporaryError: 16,
  /** The API key is suspended. */
  suspendedApiKey: 26,
  /** Too many requests from this IP address. */
  rateLimitExceeded: 29,
})

/** What each code means, for messages. FXM never shows Last.fm's own message text. */
const ERROR_TEXT: Readonly<Record<number, string>> = {
  2: 'invalid service',
  3: 'invalid method',
  4: 'authentication failed',
  5: 'invalid format',
  6: 'invalid parameters',
  7: 'invalid resource',
  8: 'operation failed',
  9: 'invalid session key',
  10: 'invalid API key',
  11: 'service offline',
  13: 'invalid signature',
  14: 'token not authorized yet',
  15: 'token expired',
  16: 'temporary error',
  26: 'suspended API key',
  29: 'rate limit exceeded',
}

/**
 * What a Last.fm error code means for the request's scrobbles (see `ScrobbleFailure`). An
 * answer with an HTTP status of 500 or more is never `rejected` (see `LastfmScrobbleClient`).
 */
export function lastfmFailureOf(code: number): ScrobbleFailure {
  switch (code) {
    case LASTFM_ERRORS.authenticationFailed:
    case LASTFM_ERRORS.invalidSession:
    case LASTFM_ERRORS.invalidApiKey:
    case LASTFM_ERRORS.invalidSignature:
    case LASTFM_ERRORS.tokenNotAuthorized:
    case LASTFM_ERRORS.tokenExpired:
    case LASTFM_ERRORS.suspendedApiKey:
      return 'refused'
    // The scrobbling guide says to retry on 11 and 16; the list of error codes also says
    // "Please try again" for 8, where "most likely the backend service failed".
    case LASTFM_ERRORS.operationFailed:
    case LASTFM_ERRORS.serviceOffline:
    case LASTFM_ERRORS.temporaryError:
      return 'temporary'
    case LASTFM_ERRORS.rateLimitExceeded:
      return 'rate-limited'
    default:
      // "All other error codes indicate the scrobble request was incorrectly formed in some
      // way and should not be retried."
      return 'rejected'
  }
}

/** Whether `value` looks like a Last.fm API key or shared secret: 32 hexadecimal digits. */
export function isLastfmKey(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{32}$/iu.test(value)
}

/** A token or session key as Last.fm hands them out: no spaces, at most 128 characters. */
const OPAQUE = /^[!-~]{1,128}$/u

/**
 * The `api_sig` of a call: every parameter but `format` and `callback`, ordered by name in
 * code-unit (ASCII) order, so `artist[10]` comes before `artist[1]`, written as name then value,
 * followed by the shared secret, and hashed with MD5 over UTF-8.
 */
export function lastfmSignature(params: Readonly<Record<string, string>>, secret: string): string {
  const names = Object.keys(params)
    .filter((name) => name !== 'format' && name !== 'callback')
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  return md5Hex(`${names.map((name) => `${name}${params[name]}`).join('')}${secret}`)
}

/** The API account FXM signs calls with: the user's own. */
export interface LastfmCredentials {
  /** The API key: 32 hexadecimal digits. */
  apiKey: string
  /** The shared secret: 32 hexadecimal digits. Never sent, only used to sign. */
  secret: string
}

/** A web service session: the user's name and the key that authorizes calls for them. */
export interface LastfmSession {
  /** The user's Last.fm name. */
  userName: string
  /** The session key. It doesn't expire; the user can revoke it on Last.fm. */
  sessionKey: string
}

/** Settings of a {@link LastfmScrobbleClient}. */
export interface LastfmClientOptions {
  /** The API root. Default: {@link LASTFM_API_URL}. */
  apiUrl?: string
  /** Abort a request, body included, after this many milliseconds. Default: 10,000. */
  timeoutMs?: number
  /** The pause between one request's end and the next one's start. Default: 250 ms. */
  minIntervalMs?: number
  /** The longest a request waits out a rate limit before failing. Default: 15 s. */
  maxWaitMs?: number
}

type Json = Record<string, unknown>

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A count from Last.fm's JSON, which writes numbers as numbers or as strings. */
function countOf(value: unknown): number | undefined {
  const number = typeof value === 'string' && /^\d+$/u.test(value) ? Number(value) : value
  return typeof number === 'number' && Number.isSafeInteger(number) && number >= 0
    ? number
    : undefined
}

/** A list from Last.fm's JSON: a lone entry may come as the object itself. */
function listOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : value === undefined ? [] : [value]
}

/** The parameters that describe a track, for scrobbles (`[i]` suffix) and now playing. */
function trackParams(track: ScrobbleTrack, suffix = ''): Record<string, string> {
  const params: Record<string, string> = {
    [`artist${suffix}`]: track.artists[0] ?? '',
    [`track${suffix}`]: track.title,
  }
  if (track.album !== undefined) params[`album${suffix}`] = track.album
  if (track.trackNumber !== undefined) params[`trackNumber${suffix}`] = String(track.trackNumber)
  const seconds = track.durationMs === undefined ? 0 : Math.round(track.durationMs / 1000)
  if (seconds > 0) params[`duration${suffix}`] = String(seconds)
  return params
}

/**
 * A Last.fm client for one API account. One instance sends its requests one at a time, at
 * least `minIntervalMs` apart, so share it.
 */
export class LastfmScrobbleClient {
  private readonly apiUrl: string
  private readonly timeoutMs: number
  private readonly gate: RequestGate

  constructor(
    private readonly credentials: LastfmCredentials,
    options: LastfmClientOptions = {},
  ) {
    this.apiUrl = options.apiUrl ?? LASTFM_API_URL
    this.timeoutMs = options.timeoutMs ?? 10_000
    this.gate = new RequestGate({
      minIntervalMs: options.minIntervalMs ?? 250,
      maxWaitMs: options.maxWaitMs ?? 15_000,
      tooLong: (waitMs) =>
        new ScrobbleError('lastfm', 'rate-limited', 'Last.fm asked FXM to wait', {
          retryAfterMs: waitMs,
        }),
    })
  }

  /** The API key the client signs with. */
  get apiKey(): string {
    return this.credentials.apiKey
  }

  /**
   * Step 1 of the authentication: a request token, which the user then allows on Last.fm's
   * page ({@link authorizeUrl}). It lasts 60 minutes and works once.
   */
  async getToken(ctx: ScrobbleContext): Promise<string> {
    const answer = await this.call({ method: 'auth.getToken' }, ctx)
    const token = isObject(answer) ? answer.token : undefined
    if (typeof token !== 'string' || !OPAQUE.test(token)) throw this.unreadable()
    return token
  }

  /**
   * Step 2: the page where the user allows this API account to use their profile, for
   * `token`. Open it in the user's browser. The token is in its address, as Last.fm's
   * protocol requires; it is useless once the session exists, and expires in an hour.
   */
  authorizeUrl(token: string): string {
    const url = new URL(LASTFM_AUTHORIZE_URL)
    url.searchParams.set('api_key', this.credentials.apiKey)
    url.searchParams.set('token', token)
    return url.href
  }

  /**
   * Step 3: the session for a token the user allowed. Until they do, it rejects with a
   * `refused` ScrobbleError whose `serviceCode` is 14 (`tokenNotAuthorized`); an expired token
   * gives 15. The token is used up once a session exists.
   */
  async getSession(token: string, ctx: ScrobbleContext): Promise<LastfmSession> {
    const answer = await this.call({ method: 'auth.getSession', token }, ctx)
    const session = isObject(answer) ? answer.session : undefined
    const name = isObject(session) ? session.name : undefined
    const key = isObject(session) ? session.key : undefined
    if (typeof name !== 'string' || name.trim() === '' || typeof key !== 'string') {
      throw this.unreadable()
    }
    if (!OPAQUE.test(key)) throw this.unreadable()
    return { userName: name.trim(), sessionKey: key }
  }

  /** `track.updateNowPlaying`: shows the track on the user's profile as playing now. */
  async updateNowPlaying(
    sessionKey: string,
    track: ScrobbleTrack,
    ctx: ScrobbleContext,
  ): Promise<void> {
    await this.call(
      { method: 'track.updateNowPlaying', sk: sessionKey, ...trackParams(track) },
      ctx,
    )
  }

  /**
   * `track.scrobble`: adds up to {@link LASTFM_BATCH_SIZE} listens to the user's profile, oldest
   * first. Each is `accepted` or `ignored` by Last.fm's filters (an unknown artist, a timestamp
   * too old or too new, the daily limit), which Last.fm doesn't count as an error.
   */
  async scrobble(
    sessionKey: string,
    scrobbles: readonly Scrobble[],
    ctx: ScrobbleContext,
  ): Promise<SubmitReport> {
    if (scrobbles.length === 0) return { accepted: 0, ignored: 0, ignoredCodes: [] }
    if (scrobbles.length > LASTFM_BATCH_SIZE) {
      throw new RangeError(`Last.fm takes at most ${LASTFM_BATCH_SIZE} scrobbles per request`)
    }
    const params: Record<string, string> = { method: 'track.scrobble', sk: sessionKey }
    scrobbles.forEach((scrobble, index) => {
      Object.assign(params, trackParams(scrobble.track, `[${index}]`))
      params[`timestamp[${index}]`] = String(Math.floor(scrobble.startedAt / 1000))
      if (scrobble.chosenByUser === false) params[`chosenByUser[${index}]`] = '0'
    })
    const answer = await this.call(params, ctx)
    return scrobbleReport(answer, scrobbles.length)
  }

  /** One signed `POST`: the parsed answer, or a `ScrobbleError`. */
  private call(params: Record<string, string>, ctx: ScrobbleContext): Promise<unknown> {
    const signed = { ...params, api_key: this.credentials.apiKey }
    const body = new URLSearchParams(signed)
    body.set('api_sig', lastfmSignature(signed, this.credentials.secret))
    body.set('format', 'json')
    return this.gate.run(() => this.send(body, ctx), ctx.signal)
  }

  private async send(body: URLSearchParams, ctx: ScrobbleContext): Promise<unknown> {
    const { signal } = ctx
    let response: Response
    try {
      response = await fetchWithTimeout(ctx.fetch, this.apiUrl, {
        method: 'POST',
        body,
        credentials: 'omit',
        // Last.fm never redirects its API; a redirect must not resend the body elsewhere.
        redirect: 'error',
        timeoutMs: this.timeoutMs,
        ...(signal === undefined ? {} : { signal }),
      })
    } catch (error) {
      if (signal?.aborted) throw signal.reason
      throw new ScrobbleError(
        'lastfm',
        'temporary',
        timedOut(error)
          ? `Last.fm did not answer within ${this.timeoutMs} ms`
          : 'Last.fm could not be reached',
        { code: 'Network', cause: error },
      )
    }
    const text = await bodyText(response)
    signal?.throwIfAborted()
    const answer = parseJson(text)
    // "No matter what the HTTP status code is, you must inspect the content of the response."
    const code = isObject(answer) ? countOf(answer.error) : undefined
    if (code !== undefined) throw this.failed(code, response)
    if (response.status === 429) {
      const waitMs = retryAfterMs(response.headers)
      if (waitMs !== undefined) this.gate.holdUntil(Date.now() + waitMs)
      throw new ScrobbleError('lastfm', 'rate-limited', 'Last.fm answered HTTP 429', {
        serviceCode: 429,
        ...(waitMs === undefined ? {} : { retryAfterMs: waitMs }),
      })
    }
    if (!response.ok) {
      throw new ScrobbleError('lastfm', 'temporary', `Last.fm answered HTTP ${response.status}`, {
        serviceCode: response.status,
      })
    }
    return answer
  }

  /**
   * The error for Last.fm's `error` code. A server error (HTTP 500 or more) is the server's,
   * whatever the code: unless it refuses the credentials or asks FXM to wait, the scrobbles stay
   * for a later try.
   */
  private failed(code: number, response: Response): ScrobbleError {
    const coded = lastfmFailureOf(code)
    const failure = coded === 'rejected' && response.status >= 500 ? 'temporary' : coded
    const waitMs = failure === 'rate-limited' ? retryAfterMs(response.headers) : undefined
    if (waitMs !== undefined) this.gate.holdUntil(Date.now() + waitMs)
    return new ScrobbleError(
      'lastfm',
      failure,
      `Last.fm answered with error ${code} (${ERROR_TEXT[code] ?? 'unknown error'})`,
      { serviceCode: code, ...(waitMs === undefined ? {} : { retryAfterMs: waitMs }) },
    )
  }

  private unreadable(): ScrobbleError {
    return new ScrobbleError(
      'lastfm',
      'temporary',
      'Last.fm sent an answer FXM does not understand',
      {
        code: 'Parse',
      },
    )
  }
}

/**
 * What Last.fm did with a batch, from its answer. Last.fm took the batch when it answered
 * without an error, so an answer FXM can't read counts every scrobble as accepted rather than
 * sending them twice.
 */
export function scrobbleReport(answer: unknown, sent: number): SubmitReport {
  const scrobbles = isObject(answer) ? answer.scrobbles : undefined
  if (!isObject(scrobbles)) return { accepted: sent, ignored: 0, ignoredCodes: [] }
  const ignoredCodes = listOf(scrobbles.scrobble)
    .map((entry) => {
      const message = isObject(entry) ? entry.ignoredMessage : undefined
      return countOf(isObject(message) ? message.code : undefined) ?? 0
    })
    .filter((code) => code > 0)
  const attributes = isObject(scrobbles['@attr']) ? scrobbles['@attr'] : {}
  const ignored = Math.min(sent, countOf(attributes.ignored) ?? ignoredCodes.length)
  const accepted = Math.min(sent - ignored, countOf(attributes.accepted) ?? sent - ignored)
  return { accepted, ignored, ignoredCodes }
}

/** Options for {@link lastfmTarget}. */
export interface LastfmTargetOptions {
  /** Hold scrobbles without sending them (see `ScrobbleTarget.paused`). */
  paused?: boolean
  /** Which credentials these are, as the app identifies them (see `ScrobbleTarget.account`). */
  account?: string
  /** The Last.fm user the session belongs to (see `ScrobbleTarget.user`). */
  user?: string
}

/** Last.fm as a scrobbler target, for the session `sessionKey` of `client`'s API account. */
export function lastfmTarget(
  client: LastfmScrobbleClient,
  sessionKey: string,
  options: LastfmTargetOptions = {},
): ScrobbleTarget {
  return {
    service: 'lastfm',
    rules: LASTFM_RULES,
    batchSize: LASTFM_BATCH_SIZE,
    paused: options.paused === true,
    ...(options.account === undefined ? {} : { account: options.account }),
    ...(options.user === undefined ? {} : { user: options.user }),
    nowPlaying: (track, ctx) => client.updateNowPlaying(sessionKey, track, ctx),
    submit: (scrobbles, ctx) => client.scrobble(sessionKey, scrobbles, ctx),
  }
}
