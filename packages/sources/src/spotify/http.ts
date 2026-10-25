/**
 * How the provider talks HTTP: every request goes through the injected `ctx.fetch`, with a
 * timeout, without credentials, and with a browser User-Agent only on native transports (a web
 * page must not set one: it would trigger a CORS preflight that FXM Connect does not allow).
 *
 * HTTP 429 and 5xx answers are retried after `Retry-After`, or with exponential backoff and
 * jitter, up to `maxRetries` times. If they persist, the whole provider pauses (by default for
 * 5 minutes): until then every request fails at once with `RateLimited` (`paused`), so FXM backs
 * off instead of hammering Spotify. Other statuses are returned for the caller to interpret.
 *
 * @module
 */

import type { ProviderContext } from '@fxm/core'
import { redact, SpotifyError } from './errors'
import { eitherSignal } from './signals'

/** Options for {@link SpotifyHttp}. */
export interface SpotifyHttpOptions {
  /** The browser User-Agent to send from native transports. */
  userAgent: string
  /**
   * Whether to send `userAgent` for a call. Default: on native transports only
   * (`ctx.platform` is not `web`).
   */
  sendUserAgent?: (ctx: ProviderContext) => boolean
  /** Per-request timeout. Default 15 s. */
  timeoutMs?: number
  /** Retries after a 429 or 5xx answer before pausing. Default 3. */
  maxRetries?: number
  /** The first backoff delay; each retry doubles it. Default 500 ms. */
  baseDelayMs?: number
  /**
   * The longest wait inside one call. A `Retry-After` beyond it pauses the provider at once
   * instead of keeping the call waiting. Default 10 s.
   */
  maxDelayMs?: number
  /** How long the provider pauses after persistent 429 or 5xx answers. Default 5 minutes. */
  pauseMs?: number
  /** The clock, as epoch milliseconds. Default `Date.now`. */
  now?: () => number
  /** Waits, rejecting with the signal's reason when it aborts. Default: a timer. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  /** A random number in [0, 1), for jitter. Default `Math.random`. */
  random?: () => number
  /** Called when the provider pauses, with when the pause ends. */
  onPause?: (until: number) => void
}

/** A request for {@link SpotifyHttp.request}. */
export interface SpotifyRequest {
  /** The URL. */
  url: string
  /** HTTP method. Default GET. */
  method?: 'GET' | 'POST'
  /** Request headers. */
  headers?: Record<string, string>
  /** A request body. */
  body?: string
  /** What is being called, for messages, e.g. `the token endpoint`. Never a URL with a query. */
  what: string
  /**
   * Whether 429 and 5xx answers are retried and, if they persist, pause the provider. Default
   * true. With false they are returned like any other answer, for optional calls such as the
   * server time, which has a fallback.
   */
  retry?: boolean
}

/** Waits `ms`, rejecting with the signal's reason when it aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason)
      return
    }
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal?.reason)
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * The wait a `Retry-After` header asks for, in milliseconds: delay-seconds or an HTTP date.
 * `undefined` when it is absent or malformed; never negative.
 */
export function parseRetryAfter(value: string | null, now: number): number | undefined {
  if (value === null) return undefined
  const text = value.trim()
  if (/^\d+$/u.test(text)) return Number(text) * 1000
  const date = Date.parse(text)
  return Number.isNaN(date) ? undefined : Math.max(0, date - now)
}

/** The HTTP transport of one Spotify provider, with its pause state. */
export class SpotifyHttp {
  readonly #options: Required<Omit<SpotifyHttpOptions, 'onPause'>> &
    Pick<SpotifyHttpOptions, 'onPause'>
  #pausedUntil = 0

  constructor(options: SpotifyHttpOptions) {
    this.#options = {
      sendUserAgent: (ctx) => ctx.platform !== 'web',
      timeoutMs: 15_000,
      maxRetries: 3,
      baseDelayMs: 500,
      maxDelayMs: 10_000,
      pauseMs: 300_000,
      now: Date.now,
      sleep,
      random: Math.random,
      ...options,
    }
  }

  /** When the current pause ends, as epoch milliseconds, or `undefined` when not paused. */
  get pausedUntil(): number | undefined {
    return this.#pausedUntil > this.#options.now() ? this.#pausedUntil : undefined
  }

  /** Ends a pause early, e.g. when the user retries from the UI. */
  resume(): void {
    this.#pausedUntil = 0
  }

  /** Pauses every request for `ms`, or longer if a pause is already running. */
  pause(ms: number): void {
    const until = Math.max(this.#pausedUntil, this.#options.now() + ms)
    if (until === this.#pausedUntil) return
    this.#pausedUntil = until
    this.#options.onPause?.(until)
  }

  /** Throws `RateLimited` (`paused`) while the provider is paused. */
  assertNotPaused(): void {
    const remaining = this.#pausedUntil - this.#options.now()
    if (remaining > 0) {
      throw new SpotifyError(
        'RateLimited',
        'paused',
        `Spotify is paused for ${Math.ceil(remaining / 1000)} s after repeated rate limits ` +
          'or server errors',
        { retryAfterMs: remaining },
      )
    }
  }

  /**
   * Sends a request through `ctx.fetch` and returns the response, retrying 429 and 5xx answers.
   *
   * @throws SpotifyError `RateLimited` (`paused`) while paused or once retries run out,
   * `Network` (`network`) when the request fails or times out. A caller's abort rejects with
   * its signal's reason.
   */
  async request(request: SpotifyRequest, ctx: ProviderContext): Promise<Response> {
    const o = this.#options
    for (let attempt = 0; ; attempt++) {
      this.assertNotPaused()
      const response = await this.#send(request, ctx)
      if (request.retry === false) return response
      if (response.status !== 429 && response.status < 500) return response
      const retryAfter = parseRetryAfter(response.headers.get('retry-after'), o.now())
      const backoff = o.baseDelayMs * 2 ** attempt
      const wait =
        retryAfter !== undefined
          ? retryAfter + o.random() * o.baseDelayMs
          : backoff / 2 + (o.random() * backoff) / 2
      await discard(response)
      if (attempt >= o.maxRetries || wait > o.maxDelayMs) {
        this.pause(Math.max(o.pauseMs, retryAfter ?? 0))
        const remaining = Math.max(0, this.#pausedUntil - o.now())
        throw new SpotifyError(
          'RateLimited',
          'paused',
          `${request.what} answered HTTP ${response.status}; ` +
            `Spotify is paused for ${Math.ceil(remaining / 1000)} s`,
          { retryAfterMs: remaining },
        )
      }
      await o.sleep(wait, ctx.signal)
    }
  }

  async #send(request: SpotifyRequest, ctx: ProviderContext): Promise<Response> {
    const o = this.#options
    const headers: Record<string, string> = { ...request.headers }
    if (o.sendUserAgent(ctx)) headers['User-Agent'] = o.userAgent
    const timeout = AbortSignal.timeout(o.timeoutMs)
    const signal = eitherSignal(ctx.signal, timeout)
    try {
      return await ctx.fetch(request.url, {
        method: request.method ?? 'GET',
        headers,
        ...(request.body === undefined ? {} : { body: request.body }),
        credentials: 'omit',
        signal,
      })
    } catch (error) {
      if (ctx.signal?.aborted) throw ctx.signal.reason
      if (timeout.aborted) {
        throw new SpotifyError(
          'Network',
          'network',
          `${request.what} timed out after ${o.timeoutMs} ms`,
        )
      }
      const detail = redact(error instanceof Error ? error.message : String(error))
      throw new SpotifyError('Network', 'network', `${request.what} failed: ${detail}`)
    }
  }
}

/** Releases a response body that will not be read. */
async function discard(response: Response): Promise<void> {
  try {
    await response.body?.cancel()
  } catch {
    // Nothing to release.
  }
}
