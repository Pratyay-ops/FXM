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

/**
 * The most UTF-16 code units FXM keeps of a title, artist or album from LRCLIB. Records are
 * user-submitted: a longer name is junk, and the cap keeps every later pattern on short input.
 */
export const MAX_NAME_LENGTH = 500

/** One lyrics record as LRCLIB returns it, checked, with the fields FXM uses. */
export interface LrclibRecord {
  /** LRCLIB's ID of the record. */
  id: number
  /** Title, as whoever published the record wrote it, cleaned by {@link toRecord}. */
  trackName: string
  /** Artist credit, e.g. `Calvin Harris, Dua Lipa`, cleaned. Empty when the record has none. */
  artistName: string
  /** Album, cleaned, when the record names one. */
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
  /** Abort a request, body included, after this many milliseconds. */
  timeoutMs: number
  /** Pause this many milliseconds between the end of one request and the start of the next. */
  minIntervalMs: number
  /** Wait at most this long for a `Retry-After`; fail with `RateLimited` when LRCLIB asks more. */
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

function rateLimited(retryAfterMs: number): FxmError {
  return new FxmError('RateLimited', 'LRCLIB asked FXM to wait before the next request', {
    retryAfterMs,
  })
}

/**
 * Runs the requests of one provider instance one at a time, as LRCLIB asks: each starts once the
 * request before it has finished, body read or cancelled, and `minIntervalMs` more have passed.
 * Calls wait their turn in order, however long the queue; a cancelled call leaves it.
 *
 * It also honours `Retry-After`, plus up to 30 % jitter, which LRCLIB requires on pain of a
 * temporary ban. After a 429, calls fail at once with `RateLimited` until the wait is over. After
 * a 503, they wait, unless LRCLIB asked for longer than `maxWaitMs`.
 */
class RequestGate {
  /** Whether a call holds the gate: waiting for its start, or with its request in flight. */
  private busy = false
  /** Wakes each call waiting for the gate, in order. */
  private readonly waiting: Array<() => void> = []
  /** When the last request finished, in epoch milliseconds. */
  private lastEndAt = Number.NEGATIVE_INFINITY
  /** No request starts before this time, which LRCLIB's `Retry-After` set. */
  private retryAt = 0
  /** Until this time, set by a 429, calls fail at once instead of waiting. */
  private blockedUntil = 0

  constructor(
    private readonly minIntervalMs: number,
    private readonly maxWaitMs: number,
  ) {}

  /** Sends `request` in its turn and holds the gate until it settles. */
  async run<T>(signal: AbortSignal | undefined, request: () => Promise<T>): Promise<T> {
    signal?.throwIfAborted()
    this.checkRetryAfter()
    await this.acquire(signal)
    let sent = false
    try {
      // The request before this one may have been told to wait.
      this.checkRetryAfter()
      const waitMs = Math.max(this.lastEndAt + this.minIntervalMs, this.retryAt) - Date.now()
      if (waitMs > 0) await sleep(waitMs, signal)
      sent = true
      return await request()
    } finally {
      if (sent) this.lastEndAt = Date.now()
      this.release()
    }
  }

  /**
   * Holds every request back for `delayMs` plus up to 30 % jitter. With `block` (a 429), calls
   * fail at once until then instead of waiting. Returns how long requests are now held back.
   */
  backOff(delayMs: number, block: boolean): number {
    const now = Date.now()
    const until = now + Math.round(delayMs * (1 + Math.random() * 0.3))
    this.retryAt = Math.max(this.retryAt, until)
    if (block) this.blockedUntil = Math.max(this.blockedUntil, until)
    return this.retryAt - now
  }

  /** Fails while a 429 blocks calls, or when LRCLIB asked for a wait longer than `maxWaitMs`. */
  private checkRetryAfter(): void {
    const now = Date.now()
    const waitMs = this.retryAt - now
    if (now < this.blockedUntil || waitMs > this.maxWaitMs) throw rateLimited(waitMs)
  }

  /** Takes the gate, after the calls already waiting for it. */
  private acquire(signal: AbortSignal | undefined): Promise<void> {
    if (!this.busy) {
      this.busy = true
      return Promise.resolve()
    }
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        const index = this.waiting.indexOf(wake)
        if (index !== -1) this.waiting.splice(index, 1)
        reject(signal?.reason)
      }
      const wake = () => {
        signal?.removeEventListener('abort', onAbort)
        resolve()
      }
      this.waiting.push(wake)
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }

  /** Hands the gate to the next waiting call, or frees it. */
  private release(): void {
    const next = this.waiting.shift()
    if (next === undefined) this.busy = false
    else next()
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

/**
 * A name from LRCLIB, cleaned: runs of whitespace fold into one space, the ends are trimmed, and
 * it is cut to {@link MAX_NAME_LENGTH} code units, never inside a character. `undefined` for a
 * value that is not a string, or is blank.
 */
function cleanName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const folded = value.replace(/\s+/gu, ' ').trim()
  if (folded === '') return undefined
  if (folded.length <= MAX_NAME_LENGTH) return folded
  const cut = folded.slice(0, MAX_NAME_LENGTH)
  const last = cut.charCodeAt(cut.length - 1)
  // A high surrogate at the end is half of a character that the cut split.
  return (last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut).trimEnd()
}

/**
 * Checks one record from LRCLIB, and cleans its title, artist and album (see `cleanName`).
 * Returns `null` when it lacks an ID or a title.
 */
export function toRecord(value: unknown): LrclibRecord | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const fields = value as Record<string, unknown>
  const { id, duration } = fields
  const trackName = cleanName(fields.trackName) ?? cleanName(fields.name)
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0 || trackName === undefined) {
    return null
  }
  const record: LrclibRecord = {
    id,
    trackName,
    artistName: cleanName(fields.artistName) ?? '',
    instrumental: fields.instrumental === true,
  }
  const albumName = cleanName(fields.albumName)
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
 * A client for LRCLIB's read endpoints. One instance sends all of its requests one at a time, so
 * share it (the provider does).
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
   * LRCLIB answers a miss after about 1.5 s with 404, or, as on 2026-10-25, with
   * `503 ServerOverloaded`. Both count as a miss, and the 503's `Retry-After` delays the next
   * request.
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

  /** One GET, in its turn, mapped to an {@link Answer} or an `FxmError`. */
  private request(
    path: string,
    params: Record<string, string>,
    ctx: ProviderContext,
  ): Promise<Answer> {
    const url = new URL(path, this.baseUrl)
    for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value)
    return this.gate.run(ctx.signal, () => this.send(url, path, ctx))
  }

  /** Sends one GET. It settles only once the body is read or cancelled, so the gate can open. */
  private async send(url: URL, path: string, ctx: ProviderContext): Promise<Answer> {
    const { signal } = ctx
    const response = await fetchWithTimeout(ctx.fetch, url.href, {
      headers: { 'Lrclib-Client': this.options.client },
      credentials: 'omit',
      timeoutMs: this.options.timeoutMs,
      ...(signal === undefined ? {} : { signal }),
    }).catch((error: unknown) => this.failed(error, signal, 'LRCLIB could not be reached'))
    const { status } = response
    if (status === 200) return { kind: 'ok', body: await this.json(response, signal) }
    // Error bodies are small and not always JSON; nothing in them changes what FXM does.
    await response.body?.cancel().catch(() => undefined)
    if (status === 404) return { kind: 'not-found' }
    if (status === 429 || status === 503) {
      const fallbackMs = status === 429 ? 60_000 : 1_000
      const delayMs = retryAfterMs(response.headers.get('retry-after'), fallbackMs)
      // The wait with its jitter: a caller that retries after it is not refused again.
      const waitMs = this.gate.backOff(delayMs, status === 429)
      if (status === 429) throw rateLimited(waitMs)
      return { kind: 'busy', retryAfterMs: waitMs }
    }
    throw new FxmError('Unavailable', `LRCLIB answered ${path} with HTTP ${status}`)
  }

  /** A response's JSON body: `Network` when reading it fails, `Parse` when it is not JSON. */
  private async json(response: Response, signal: AbortSignal | undefined): Promise<unknown> {
    const text = await response
      .text()
      .catch((error: unknown) => this.failed(error, signal, 'The answer from LRCLIB broke off'))
    signal?.throwIfAborted()
    try {
      return JSON.parse(text)
    } catch (error) {
      throw new FxmError('Parse', 'LRCLIB answered with invalid JSON', { cause: error })
    }
  }

  /**
   * Rethrows a request that failed: as the signal's reason when the caller cancelled it, else as
   * a `Network` error, which names the timeout when that is what stopped it.
   */
  private failed(error: unknown, signal: AbortSignal | undefined, message: string): never {
    if (signal?.aborted) throw signal.reason
    const timedOut = (error as { name?: unknown } | null)?.name === 'TimeoutError'
    throw new FxmError(
      'Network',
      timedOut ? `LRCLIB did not answer within ${this.options.timeoutMs} ms` : message,
      { cause: error },
    )
  }
}
