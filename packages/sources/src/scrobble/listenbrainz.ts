/**
 * Scrobbling to ListenBrainz: `POST /1/submit-listens` (single, import and playing-now listens)
 * and `GET /1/validate-token`, through the injected `fetch`.
 *
 * The user pastes the token from their ListenBrainz settings; it stays on the device and only
 * ever travels in the `Authorization` header, never in a URL. ListenBrainz answers any origin
 * (`Access-Control-Allow-Origin: *`) and its preflights allow `Authorization` and
 * `Content-Type`, so the web app reaches it on every tier, without FXM Connect. See
 * CLEAN-ROOM.md for where each fact comes from.
 *
 * @module
 */

import { APP_NAME, APP_VERSION } from '@fxm/core'
import { fetchWithTimeout } from '../shared'
import { ScrobbleError } from './errors'
import { bodyText, parseJson, RequestGate, retryAfterMs, timedOut } from './http'
import { LISTENBRAINZ_RULES } from './rules'
import type { ScrobbleTarget, SubmitReport } from './target'
import type { Scrobble, ScrobbleContext, ScrobbleTrack } from './types'

/** ListenBrainz's API root. */
export const LISTENBRAINZ_API_URL = 'https://api.listenbrainz.org/'

/** Where users find their user token. */
export const LISTENBRAINZ_SETTINGS_URL = 'https://listenbrainz.org/settings/'

/**
 * The most listens one request carries. ListenBrainz takes up to 1,000; 100 keeps each request
 * small while a queue catches up.
 */
export const LISTENBRAINZ_BATCH_SIZE = 100

/** "Never make more than ONE call per second": ListenBrainz's rate limiting section. */
export const LISTENBRAINZ_MIN_INTERVAL_MS = 1000

/** Longest `duration_ms` ListenBrainz accepts: 24 days. */
const MAX_DURATION_MS = 2_073_600_000

/**
 * Whether `value` looks like a ListenBrainz user token: 8 to 128 visible ASCII characters
 * without spaces. Today's tokens are UUIDs; the check stays loose for whatever comes next.
 */
export function isListenBrainzToken(value: unknown): value is string {
  return typeof value === 'string' && /^[!-~]{8,128}$/u.test(value)
}

/** One listen as `submit-listens` takes it. */
export interface ListenPayload {
  /** When it started, in Unix seconds. Left out of playing-now listens. */
  listened_at?: number
  /** What was played. */
  track_metadata: {
    artist_name: string
    track_name: string
    release_name?: string
    additional_info: Record<string, string | number>
  }
}

/** What FXM says about itself and the track, in `additional_info`. */
function additionalInfo(track: ScrobbleTrack, playedMs?: number): Record<string, string | number> {
  const info: Record<string, string | number> = {
    media_player: APP_NAME,
    media_player_version: APP_VERSION,
    submission_client: APP_NAME,
    submission_client_version: APP_VERSION,
  }
  const { durationMs } = track
  if (durationMs !== undefined && durationMs > 0 && durationMs <= MAX_DURATION_MS) {
    info.duration_ms = Math.round(durationMs)
  }
  if (playedMs !== undefined && playedMs >= 1000) info.duration_played = Math.round(playedMs / 1000)
  // The documentation types `tracknumber` as a string.
  if (track.trackNumber !== undefined) info.tracknumber = String(track.trackNumber)
  if (track.isrc !== undefined) info.isrc = track.isrc
  if (track.spotifyId !== undefined) {
    info.spotify_id = `https://open.spotify.com/track/${track.spotifyId}`
  }
  return info
}

/** The `track_metadata` of a track: every credited artist, joined with ", ". */
function trackMetadata(track: ScrobbleTrack, playedMs?: number): ListenPayload['track_metadata'] {
  const metadata: ListenPayload['track_metadata'] = {
    artist_name: track.artists.join(', '),
    track_name: track.title,
    additional_info: additionalInfo(track, playedMs),
  }
  if (track.album !== undefined) metadata.release_name = track.album
  return metadata
}

/** A scrobble as a ListenBrainz listen: the start in Unix seconds, and the track. */
export function listenOf(scrobble: Scrobble): ListenPayload {
  return {
    listened_at: Math.floor(scrobble.startedAt / 1000),
    track_metadata: trackMetadata(scrobble.track, scrobble.playedMs),
  }
}

/** What `validate-token` says about a token. */
export type TokenCheck = { valid: true; userName: string } | { valid: false }

/** Settings of a {@link ListenBrainzScrobbleClient}. */
export interface ListenBrainzClientOptions {
  /** The API root. Default: {@link LISTENBRAINZ_API_URL}. */
  apiUrl?: string
  /** Abort a request, body included, after this many milliseconds. Default: 10,000. */
  timeoutMs?: number
  /** The pause between one request's end and the next one's start. Default: 1 s. */
  minIntervalMs?: number
  /** The longest a request waits out a rate limit before failing. Default: 15 s. */
  maxWaitMs?: number
}

type Json = Record<string, unknown>

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * A ListenBrainz client for one user token. One instance sends its requests one at a time, at
 * least a second apart, and waits whenever the rate-limit headers say the window is used up,
 * so share it.
 */
export class ListenBrainzScrobbleClient {
  private readonly apiUrl: string
  private readonly timeoutMs: number
  private readonly gate: RequestGate

  constructor(
    private readonly token: string,
    options: ListenBrainzClientOptions = {},
  ) {
    const apiUrl = options.apiUrl ?? LISTENBRAINZ_API_URL
    this.apiUrl = apiUrl.endsWith('/') ? apiUrl : `${apiUrl}/`
    this.timeoutMs = options.timeoutMs ?? 10_000
    this.gate = new RequestGate({
      minIntervalMs: options.minIntervalMs ?? LISTENBRAINZ_MIN_INTERVAL_MS,
      maxWaitMs: options.maxWaitMs ?? 15_000,
      tooLong: (waitMs) =>
        new ScrobbleError('listenbrainz', 'rate-limited', 'ListenBrainz asked FXM to wait', {
          retryAfterMs: waitMs,
        }),
    })
  }

  /**
   * `GET /1/validate-token`: whether ListenBrainz knows the token, and whose it is. A token it
   * refuses outright (HTTP 401) is not valid either.
   */
  async validateToken(ctx: ScrobbleContext): Promise<TokenCheck> {
    let answer: unknown
    try {
      answer = await this.request('1/validate-token', ctx)
    } catch (error) {
      if (error instanceof ScrobbleError && error.failure === 'refused') return { valid: false }
      throw error
    }
    if (!isObject(answer)) throw this.unreadable()
    const userName = typeof answer.user_name === 'string' ? answer.user_name.trim() : ''
    if (answer.valid === true && userName !== '') return { valid: true, userName }
    if (answer.valid === false) return { valid: false }
    throw this.unreadable()
  }

  /**
   * Tells ListenBrainz what is playing now (`listen_type: playing_now`, without a start). It
   * keeps it only for a while; the listen itself is submitted when the play ends.
   */
  async playingNow(track: ScrobbleTrack, ctx: ScrobbleContext): Promise<void> {
    await this.submitListens('playing_now', [{ track_metadata: trackMetadata(track) }], ctx)
  }

  /**
   * Submits listens, oldest first: one as a `single` listen, more as an `import` of listens
   * saved earlier, as the documentation describes the two.
   */
  async submit(scrobbles: readonly Scrobble[], ctx: ScrobbleContext): Promise<SubmitReport> {
    if (scrobbles.length === 0) return { accepted: 0, ignored: 0, ignoredCodes: [] }
    if (scrobbles.length > LISTENBRAINZ_BATCH_SIZE) {
      throw new RangeError(`FXM sends at most ${LISTENBRAINZ_BATCH_SIZE} listens per request`)
    }
    const type = scrobbles.length === 1 ? 'single' : 'import'
    await this.submitListens(type, scrobbles.map(listenOf), ctx)
    return { accepted: scrobbles.length, ignored: 0, ignoredCodes: [] }
  }

  private async submitListens(
    type: 'single' | 'import' | 'playing_now',
    payload: ListenPayload[],
    ctx: ScrobbleContext,
  ): Promise<void> {
    await this.request('1/submit-listens', ctx, { listen_type: type, payload })
  }

  /**
   * One request in its turn: a `GET`, or a `POST` of `json` when there is a body. The token
   * goes in the `Authorization` header.
   */
  private request(path: string, ctx: ScrobbleContext, json?: unknown): Promise<unknown> {
    const url = new URL(path, this.apiUrl).href
    const headers: Record<string, string> = { Authorization: `Token ${this.token}` }
    const init: RequestInit =
      json === undefined
        ? { method: 'GET', headers }
        : {
            method: 'POST',
            headers: { ...headers, 'Content-Type': 'application/json' },
            body: JSON.stringify(json),
          }
    return this.gate.run(() => this.send(url, init, ctx), ctx.signal)
  }

  private async send(url: string, init: RequestInit, ctx: ScrobbleContext): Promise<unknown> {
    const { signal } = ctx
    let response: Response
    try {
      response = await fetchWithTimeout(ctx.fetch, url, {
        ...init,
        credentials: 'omit',
        timeoutMs: this.timeoutMs,
        ...(signal === undefined ? {} : { signal }),
      })
    } catch (error) {
      if (signal?.aborted) throw signal.reason
      throw new ScrobbleError(
        'listenbrainz',
        'temporary',
        timedOut(error)
          ? `ListenBrainz did not answer within ${this.timeoutMs} ms`
          : 'ListenBrainz could not be reached',
        { code: 'Network', cause: error },
      )
    }
    this.followRateLimit(response)
    const text = await bodyText(response)
    signal?.throwIfAborted()
    const { status } = response
    if (response.ok) return parseJson(text)
    if (status === 429) {
      const waitMs = retryAfterMs(response.headers)
      if (waitMs !== undefined) this.gate.holdUntil(Date.now() + waitMs)
      throw new ScrobbleError('listenbrainz', 'rate-limited', 'ListenBrainz answered HTTP 429', {
        serviceCode: 429,
        ...(waitMs === undefined ? {} : { retryAfterMs: waitMs }),
      })
    }
    if (status === 401) {
      throw new ScrobbleError('listenbrainz', 'refused', 'ListenBrainz refused the user token', {
        serviceCode: 401,
      })
    }
    // A listen ListenBrainz can't take (400), or a request too large for it (413).
    if (status === 400 || status === 413) {
      throw new ScrobbleError('listenbrainz', 'rejected', `ListenBrainz answered HTTP ${status}`, {
        serviceCode: status,
      })
    }
    throw new ScrobbleError('listenbrainz', 'temporary', `ListenBrainz answered HTTP ${status}`, {
      serviceCode: status,
    })
  }

  /** Holds the next request until the window resets when this answer used it up. */
  private followRateLimit(response: Response): void {
    if (response.headers.get('x-ratelimit-remaining')?.trim() !== '0') return
    const resetIn = response.headers.get('x-ratelimit-reset-in')?.trim() ?? ''
    if (/^\d+(?:\.\d+)?$/u.test(resetIn)) {
      this.gate.holdUntil(Date.now() + Math.min(Number(resetIn) * 1000, 3_600_000))
    }
  }

  private unreadable(): ScrobbleError {
    return new ScrobbleError(
      'listenbrainz',
      'temporary',
      'ListenBrainz sent an answer FXM does not understand',
      { code: 'Parse' },
    )
  }
}

/** Options for {@link listenBrainzTarget}. */
export interface ListenBrainzTargetOptions {
  /** Hold scrobbles without sending them (see `ScrobbleTarget.paused`). */
  paused?: boolean
  /** Which credentials these are, as the app identifies them (see `ScrobbleTarget.account`). */
  account?: string
}

/** ListenBrainz as a scrobbler target. */
export function listenBrainzTarget(
  client: ListenBrainzScrobbleClient,
  options: ListenBrainzTargetOptions = {},
): ScrobbleTarget {
  return {
    service: 'listenbrainz',
    rules: LISTENBRAINZ_RULES,
    batchSize: LISTENBRAINZ_BATCH_SIZE,
    paused: options.paused === true,
    ...(options.account === undefined ? {} : { account: options.account }),
    nowPlaying: (track, ctx) => client.playingNow(track, ctx),
    submit: (scrobbles, ctx) => client.submit(scrobbles, ctx),
  }
}
