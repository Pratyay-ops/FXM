/**
 * The LRCLIB HTTP API (https://lrclib.net/docs), called only through the injected `fetch`.
 *
 * LRCLIB sends `Access-Control-Allow-Origin: *`, so a browser page reaches it directly, without
 * FXM Connect. It asks clients to identify themselves, and browsers cannot set `User-Agent`
 * (LRCLIB's CORS preflight does not allow it either), so every request carries a
 * `Lrclib-Client` header instead, which LRCLIB accepts for this purpose and its preflight
 * allows. See the README for the full request policy.
 *
 * @module
 */

import { APP_NAME, APP_VERSION, FxmError, type ProviderContext } from '@fxm/core'
import { fetchWithTimeout } from '../shared'

/** Where LRCLIB lives. */
export const LRCLIB_ORIGIN = 'https://lrclib.net'

/** FXM's project page, which LRCLIB asks clients to name. */
const PROJECT_URL = 'https://github.com/Pratyay-ops/FXM'

/** How FXM introduces itself to LRCLIB: name, version and project page. */
export const DEFAULT_LRCLIB_CLIENT = `${APP_NAME} v${APP_VERSION} (${PROJECT_URL})`

/** One lyrics record as LRCLIB returns it, checked, with the fields FXM uses. */
export interface LrclibRecord {
  /** LRCLIB's ID of the record. */
  id: number
  /** Title, as whoever published the record wrote it. */
  trackName: string
  /** Artist credit, e.g. `Calvin Harris, Dua Lipa`. Empty when the record has none. */
  artistName: string
  /** Album, when the record names one. */
  albumName?: string
  /** Duration in seconds, when the record has a positive one. */
  duration?: number
  /** Whether the record says the track has no lyrics. */
  instrumental: boolean
  /** Plain lyrics: `null` when the record has none, absent when the response left them out. */
  plainLyrics?: string | null
  /** LRC lyrics: `null` when the record has none, absent when the response left them out. */
  syncedLyrics?: string | null
}

/** What `/api/get` looks a track up by. */
export interface LrclibSignature {
  /** Title. */
  trackName: string
  /** Artist credit. */
  artistName: string
  /** Album, which LRCLIB uses to choose between records. */
  albumName?: string
  /** Duration in seconds. LRCLIB matches records within ±2 s of it. */
  duration?: number
}

/** Settings of an {@link LrclibApi}. */
export interface LrclibApiOptions {
  /** The LRCLIB server, e.g. {@link LRCLIB_ORIGIN} or a self-hosted instance. */
  baseUrl: string
  /** The `Lrclib-Client` header. */
  client: string
  /** Abort a request after this many milliseconds. */
  timeoutMs: number
  /** Start requests at least this many milliseconds apart. */
  minIntervalMs: number
  /** Wait at most this long for a turn; fail with `RateLimited` when LRCLIB asks for longer. */
  maxWaitMs: number
}

/** LRCLIB's own answer to one request, once it is not an error FXM throws. */
type Answer =
  | { kind: 'ok'; body: unknown }
  | { kind: 'not-found' }
  | { kind: 'busy'; retryAfterMs: number }

/** Resolves after `ms`, or rejects with the signal's reason when it aborts first. */
function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
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

function rateLimited(retryAfterMs: number): FxmError {
  return new FxmError('RateLimited', 'LRCLIB asked FXM to wait before the next request', {
    retryAfterMs,
  })
}

/**
 * Spaces requests out and honours LRCLIB's `Retry-After`, per provider instance. LRCLIB asks
 * for one request at a time with a short pause in between, and for clients to wait out a 429
 * (plus some jitter) or risk a temporary ban.
 */
class RequestGate {
  /** The earliest start of the next request, in epoch milliseconds. */
  private nextAt = 0
  /** After a 429: requests before this fail at once, without reaching LRCLIB. */
  private blockedUntil = 0

  constructor(
    private readonly minIntervalMs: number,
    private readonly maxWaitMs: number,
  ) {}

  /** Waits for this request's turn, or fails with `RateLimited` when that would take too long. */
  async enter(signal: AbortSignal | undefined): Promise<void> {
    signal?.throwIfAborted()
    const now = Date.now()
    if (now < this.blockedUntil) throw rateLimited(this.blockedUntil - now)
    const at = Math.max(now, this.nextAt)
    if (at - now > this.maxWaitMs) throw rateLimited(at - now)
    this.nextAt = at + this.minIntervalMs
    if (at > now) await sleep(at - now, signal)
  }

  /**
   * Holds every request back for `delayMs` plus up to 30 % jitter, as LRCLIB asks. With
   * `block`, requests in that time fail at once instead of waiting.
   */
  backOff(delayMs: number, block: boolean): void {
    const until = Date.now() + Math.round(delayMs * (1 + Math.random() * 0.3))
    this.nextAt = Math.max(this.nextAt, until)
    if (block) this.blockedUntil = Math.max(this.blockedUntil, until)
  }
}

/** The longest `Retry-After` FXM takes at its word: an hour. */
const MAX_RETRY_AFTER_MS = 3_600_000

/** Milliseconds from a `Retry-After` header (seconds or an HTTP date), or `fallbackMs`. */
export function retryAfterMs(header: string | null, fallbackMs: number, now = Date.now()): number {
  const value = header?.trim() ?? ''
  const seconds = /^\d+(?:\.\d+)?$/u.test(value)
  // An HTTP date names its weekday and month; Date.parse alone also takes strings such as "-1".
  const date = !seconds && /[a-z]/iu.test(value)
  const ms = seconds ? Number(value) * 1000 : date ? Date.parse(value) - now : Number.NaN
  return Number.isFinite(ms)
    ? Math.min(Math.max(0, Math.round(ms)), MAX_RETRY_AFTER_MS)
    : fallbackMs
}

/** A non-blank string, or `undefined`. */
function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

/** Checks one record from LRCLIB. Returns `null` when it lacks an ID or a title. */
export function toRecord(value: unknown): LrclibRecord | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const fields = value as Record<string, unknown>
  const { id, duration } = fields
  const trackName = text(fields.trackName) ?? text(fields.name)
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0 || trackName === undefined) {
    return null
  }
  const record: LrclibRecord = {
    id,
    trackName,
    artistName: typeof fields.artistName === 'string' ? fields.artistName : '',
    instrumental: fields.instrumental === true,
  }
  const albumName = text(fields.albumName)
  if (albumName !== undefined) record.albumName = albumName
  if (typeof duration === 'number' && Number.isFinite(duration) && duration > 0) {
    record.duration = duration
  }
  for (const key of ['plainLyrics', 'syncedLyrics'] as const) {
    const lyrics = fields[key]
    if (typeof lyrics === 'string') record[key] = lyrics
    else if (key in fields) record[key] = null
  }
  return record
}

/** The record in an answer, or a `Parse` error. */
function recordIn(answer: { body: unknown }): LrclibRecord {
  const record = toRecord(answer.body)
  if (record === null) throw new FxmError('Parse', 'LRCLIB sent a record FXM does not understand')
  return record
}

/**
 * A client for LRCLIB's read endpoints. One instance spaces out all of its requests, so share
 * it (the provider does).
 */
export class LrclibApi {
  private readonly gate: RequestGate
  private readonly baseUrl: string

  constructor(private readonly options: LrclibApiOptions) {
    this.gate = new RequestGate(options.minIntervalMs, options.maxWaitMs)
    this.baseUrl = options.baseUrl.endsWith('/') ? options.baseUrl : `${options.baseUrl}/`
  }

  /**
   * `GET /api/get`: the record LRCLIB picks for a track's signature, or `null` when it has none.
   * LRCLIB answers a miss with 404, or today with `503 ServerOverloaded` after about 1.5 s; both
   * count as a miss, and the 503's `Retry-After` delays the next request.
   */
  async get(signature: LrclibSignature, ctx: ProviderContext): Promise<LrclibRecord | null> {
    const params: Record<string, string> = {
      track_name: signature.trackName,
      artist_name: signature.artistName,
    }
    if (signature.albumName !== undefined) params.album_name = signature.albumName
    const seconds = signature.duration === undefined ? Number.NaN : Math.round(signature.duration)
    // LRCLIB rejects durations outside 1-3,600 s with 400 ValidationError.
    if (seconds >= 1 && seconds <= 3600) params.duration = String(seconds)
    const answer = await this.request('api/get', params, ctx)
    return answer.kind === 'ok' ? recordIn(answer) : null
  }

  /** `GET /api/search?q=`: up to 20 records, in LRCLIB's order. Invalid entries are skipped. */
  async search(query: string, ctx: ProviderContext): Promise<LrclibRecord[]> {
    const answer = await this.request('api/search', { q: query }, ctx)
    if (answer.kind === 'not-found') return []
    if (answer.kind === 'busy') throw rateLimited(answer.retryAfterMs)
    if (!Array.isArray(answer.body)) {
      throw new FxmError('Parse', 'LRCLIB sent search results FXM does not understand')
    }
    return answer.body.map(toRecord).filter((record) => record !== null)
  }

  /** `GET /api/get/{id}`: one record, or `null` when it no longer exists. */
  async getById(id: number, ctx: ProviderContext): Promise<LrclibRecord | null> {
    const answer = await this.request(`api/get/${id}`, {}, ctx)
    if (answer.kind === 'not-found') return null
    if (answer.kind === 'busy') throw rateLimited(answer.retryAfterMs)
    return recordIn(answer)
  }

  /** One GET, in turn, mapped to an {@link Answer} or an `FxmError`. */
  private async request(
    path: string,
    params: Record<string, string>,
    ctx: ProviderContext,
  ): Promise<Answer> {
    const { signal } = ctx
    await this.gate.enter(signal)
    const url = new URL(path, this.baseUrl)
    for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value)
    let response: Response
    try {
      response = await fetchWithTimeout(ctx.fetch, url.href, {
        headers: { 'Lrclib-Client': this.options.client },
        credentials: 'omit',
        timeoutMs: this.options.timeoutMs,
        ...(signal === undefined ? {} : { signal }),
      })
    } catch (error) {
      if (signal?.aborted) throw signal.reason
      const timedOut = (error as { name?: unknown } | null)?.name === 'TimeoutError'
      const message = timedOut
        ? `LRCLIB did not answer within ${this.options.timeoutMs} ms`
        : 'LRCLIB could not be reached'
      throw new FxmError('Network', message, { cause: error })
    }
    const { status } = response
    if (status === 200) {
      try {
        return { kind: 'ok', body: await response.json() }
      } catch (error) {
        if (signal?.aborted) throw signal.reason
        throw new FxmError('Parse', 'LRCLIB answered with invalid JSON', { cause: error })
      }
    }
    // Error bodies are small and not always JSON; nothing in them changes what FXM does.
    await response.body?.cancel().catch(() => undefined)
    if (status === 404) return { kind: 'not-found' }
    if (status === 429 || status === 503) {
      const delayMs = retryAfterMs(
        response.headers.get('retry-after'),
        status === 429 ? 60_000 : 1_000,
      )
      this.gate.backOff(delayMs, status === 429)
      if (status === 429) throw rateLimited(delayMs)
      return { kind: 'busy', retryAfterMs: delayMs }
    }
    throw new FxmError('Unavailable', `LRCLIB answered ${path} with HTTP ${status}`)
  }
}
