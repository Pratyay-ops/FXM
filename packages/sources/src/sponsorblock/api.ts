/**
 * SponsorBlock's skip segments (https://sponsor.ajay.app), called only through the injected
 * `fetch`. FXM asks for one category, `music_offtopic` ("Non-Music Section": the intros, skits
 * and outros of music videos), and only by hash prefix (see `hash.ts`), so SponsorBlock never
 * learns which video plays.
 *
 * SponsorBlock answers every origin with `Access-Control-Allow-Origin: *`, and the request is a
 * plain GET without custom headers, so a browser page reaches it directly, without a preflight
 * or FXM Connect. The protocol facts, with their sources and dates, are in `CLEAN-ROOM.md`.
 *
 * @module
 */

import { FxmError, type ProviderContext } from '@fxm/core'
import { fetchWithTimeout } from '../shared'
import { hashPrefix, isVideoId, type Sha256, webCryptoSha256 } from './hash'

/** Where SponsorBlock's API lives. */
export const SPONSORBLOCK_ORIGIN = 'https://sponsor.ajay.app'

/** The one category FXM asks for: "Non-Music Section", the parts of a music video that aren't music. */
export const NON_MUSIC_CATEGORY = 'music_offtopic'

/**
 * SponsorBlock's data licence. Wherever FXM uses the data, it says so, after SponsorBlock's
 * attribution template ("Uses SponsorBlock data licensed under CC BY-NC-SA 4.0 from
 * https://sponsor.ajay.app/").
 */
export const SPONSORBLOCK_DATA_LICENSE = Object.freeze({
  name: 'CC BY-NC-SA 4.0',
  url: 'https://creativecommons.org/licenses/by-nc-sa/4.0/',
})

/** One part of a video to skip, as SponsorBlock's users marked it. */
export interface SponsorBlockSegment {
  /** Where the part starts, in milliseconds. */
  startMs: number
  /** Where it ends, in milliseconds. */
  endMs: number
  /**
   * How long the video was when the segment was submitted, in milliseconds. Absent when
   * SponsorBlock doesn't know (it sends 0). An upload edited since then has another duration, and
   * its old segments no longer fit it.
   */
  videoDurationMs?: number
  /** SponsorBlock's ID of the segment. */
  uuid?: string
}

/** Settings of {@link createSponsorBlockClient}; every one has a default. */
export interface SponsorBlockOptions {
  /** The SponsorBlock server, e.g. a mirror. Default: {@link SPONSORBLOCK_ORIGIN}. */
  baseUrl?: string
  /** Abort a request, body included, after this many milliseconds. Default: 10 s. */
  timeoutMs?: number
  /** How long an answer is kept for every video of its prefix. Default: an hour. */
  cacheTtlMs?: number
  /** How many prefixes' answers are kept; the least recently used go first. Default: 256. */
  maxCachedPrefixes?: number
  /** SHA-256. Default: Web Crypto's (`webCryptoSha256`). */
  sha256?: Sha256
  /** The clock, in epoch milliseconds. Default: `Date.now`. */
  now?: () => number
}

/** The defaults behind {@link SponsorBlockOptions}. */
export const SPONSORBLOCK_DEFAULTS = Object.freeze({
  baseUrl: SPONSORBLOCK_ORIGIN,
  timeoutMs: 10_000,
  cacheTtlMs: 3_600_000,
  maxCachedPrefixes: 256,
})

/** Looks up the non-music parts of videos. */
export interface SponsorBlockClient {
  /**
   * The non-music parts of the video `videoId`, in order of their start, or an empty list when
   * SponsorBlock has none (or `videoId` is no videoId). Only the hash prefix leaves the device,
   * and one answer serves every video of its prefix for `cacheTtlMs`. Rejects with an `FxmError`
   * (see the README), or with the signal's reason when `ctx.signal` aborts.
   */
  nonMusicSegments(videoId: string, ctx: ProviderContext): Promise<SponsorBlockSegment[]>
}

/** The longest video FXM takes a segment of at its word: a day. */
const MAX_SECONDS = 86_400

/** The most segments FXM keeps for one video; real videos have a handful. */
const MAX_SEGMENTS_PER_VIDEO = 64

/** The longest UUID FXM keeps. SponsorBlock's have 65 characters. */
const MAX_UUID_LENGTH = 128

/** How long FXM waits after a 429 when SponsorBlock gives no `Retry-After`: a minute. */
const DEFAULT_RETRY_AFTER_MS = 60_000

/** The longest `Retry-After` FXM takes at its word: an hour. */
const MAX_RETRY_AFTER_MS = 3_600_000

/** One prefix's answer: the segments of every video in it that has any. */
interface Bucket {
  /** Segments by videoId. */
  readonly videos: ReadonlyMap<string, readonly SponsorBlockSegment[]>
  /** When it was fetched, in epoch milliseconds. */
  readonly fetchedAt: number
}

type UnknownRecord = Record<string, unknown>

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A time in seconds from SponsorBlock: finite and within a day. */
function isSeconds(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_SECONDS
}

/**
 * Checks one segment from SponsorBlock. Returns `null` for anything but a `music_offtopic`
 * segment to skip with a valid time range: another category, another action (`mute`, `full`,
 * `poi`, `chapter`), or times that are missing, negative, reversed or longer than a day.
 */
export function toSegment(value: unknown): SponsorBlockSegment | null {
  if (!isRecord(value) || value.category !== NON_MUSIC_CATEGORY) return null
  if (value.actionType !== undefined && value.actionType !== 'skip') return null
  const range = value.segment
  if (!Array.isArray(range) || range.length !== 2) return null
  const [start, end] = range as unknown[]
  if (!isSeconds(start) || !isSeconds(end) || end <= start) return null
  const segment: SponsorBlockSegment = {
    startMs: Math.round(start * 1000),
    endMs: Math.round(end * 1000),
  }
  const { videoDuration, UUID } = value
  if (isSeconds(videoDuration) && videoDuration > 0) {
    segment.videoDurationMs = Math.round(videoDuration * 1000)
  }
  if (typeof UUID === 'string' && UUID !== '' && UUID.length <= MAX_UUID_LENGTH) segment.uuid = UUID
  return segment
}

/**
 * The segments of every video in an answer to `/api/skipSegments/<prefix>`: an array of
 * `{ videoID, segments }`. Invalid entries and segments are skipped; a body that is not an array
 * is a `Parse` error.
 */
export function parseBucket(body: unknown): Map<string, SponsorBlockSegment[]> {
  if (!Array.isArray(body)) {
    throw new FxmError('Parse', 'SponsorBlock sent segments FXM does not understand')
  }
  const videos = new Map<string, SponsorBlockSegment[]>()
  for (const entry of body) {
    if (!isRecord(entry) || !isVideoId(entry.videoID) || !Array.isArray(entry.segments)) continue
    if (videos.has(entry.videoID)) continue
    const segments = entry.segments
      .map(toSegment)
      .filter((segment) => segment !== null)
      .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs)
      .slice(0, MAX_SEGMENTS_PER_VIDEO)
    videos.set(entry.videoID, segments)
  }
  return videos
}

/** Milliseconds from a `Retry-After` header in seconds, or the default, at most an hour. */
function retryAfterMs(header: string | null): number {
  const value = header?.trim() ?? ''
  if (!/^\d+(?:\.\d+)?$/u.test(value)) return DEFAULT_RETRY_AFTER_MS
  return Math.min(Math.round(Number(value) * 1000), MAX_RETRY_AFTER_MS)
}

function rateLimited(retryAfter: number): FxmError {
  return new FxmError('RateLimited', 'SponsorBlock asked FXM to wait before the next lookup', {
    retryAfterMs: retryAfter,
  })
}

/** Settles with `promise`, or rejects with the signal's reason as soon as it aborts. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return promise
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

/** A positive number, else `fallback`. */
function positive(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback
}

class Client implements SponsorBlockClient {
  readonly #baseUrl: string
  readonly #timeoutMs: number
  readonly #cacheTtlMs: number
  readonly #maxCachedPrefixes: number
  readonly #sha256: Sha256
  readonly #now: () => number
  /** Answers by prefix, least recently used first. */
  readonly #buckets = new Map<string, Bucket>()
  /** Lookups in flight, by prefix, shared by every caller. */
  readonly #pending = new Map<string, Promise<Bucket>>()
  /** Until this time, set by a 429, lookups fail at once. */
  #blockedUntil = 0

  constructor(options: SponsorBlockOptions) {
    const baseUrl = options.baseUrl ?? SPONSORBLOCK_DEFAULTS.baseUrl
    this.#baseUrl = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`
    this.#timeoutMs = positive(options.timeoutMs, SPONSORBLOCK_DEFAULTS.timeoutMs)
    this.#cacheTtlMs = positive(options.cacheTtlMs, SPONSORBLOCK_DEFAULTS.cacheTtlMs)
    this.#maxCachedPrefixes = Math.floor(
      positive(options.maxCachedPrefixes, SPONSORBLOCK_DEFAULTS.maxCachedPrefixes),
    )
    this.#sha256 = options.sha256 ?? webCryptoSha256
    this.#now = options.now ?? Date.now
  }

  async nonMusicSegments(videoId: string, ctx: ProviderContext): Promise<SponsorBlockSegment[]> {
    const { signal } = ctx
    signal?.throwIfAborted()
    if (!isVideoId(videoId)) return []
    const prefix = await abortable(hashPrefix(videoId, this.#sha256), signal)
    const bucket = await abortable(this.#bucket(prefix, ctx), signal)
    return (bucket.videos.get(videoId) ?? []).map((segment) => ({ ...segment }))
  }

  /** The answer for `prefix`: from the cache while it is fresh, else from SponsorBlock. */
  #bucket(prefix: string, ctx: ProviderContext): Promise<Bucket> {
    const now = this.#now()
    const cached = this.#buckets.get(prefix)
    if (cached !== undefined) {
      this.#buckets.delete(prefix)
      if (now - cached.fetchedAt < this.#cacheTtlMs) {
        // Most recently used last.
        this.#buckets.set(prefix, cached)
        return Promise.resolve(cached)
      }
    }
    const pending = this.#pending.get(prefix)
    if (pending !== undefined) return pending
    if (now < this.#blockedUntil) return Promise.reject(rateLimited(this.#blockedUntil - now))
    // Not tied to the caller's signal: other callers may wait for the same prefix, and an answer
    // nobody waits for any more still fills the cache.
    const request = this.#fetch(prefix, ctx)
      .then((bucket) => {
        this.#store(prefix, bucket)
        return bucket
      })
      .finally(() => this.#pending.delete(prefix))
    this.#pending.set(prefix, request)
    return request
  }

  #store(prefix: string, bucket: Bucket): void {
    this.#buckets.delete(prefix)
    this.#buckets.set(prefix, bucket)
    for (const oldest of this.#buckets.keys()) {
      if (this.#buckets.size <= this.#maxCachedPrefixes) break
      this.#buckets.delete(oldest)
    }
  }

  /** `GET /api/skipSegments/<prefix>?category=music_offtopic`, mapped to a bucket or an error. */
  async #fetch(prefix: string, ctx: ProviderContext): Promise<Bucket> {
    const url = new URL(`api/skipSegments/${prefix}`, this.#baseUrl)
    url.searchParams.set('category', NON_MUSIC_CATEGORY)
    const response = await fetchWithTimeout(ctx.fetch, url.href, {
      credentials: 'omit',
      timeoutMs: this.#timeoutMs,
    }).catch((error: unknown) => this.#failed(error, 'SponsorBlock could not be reached'))
    const { status } = response
    if (status === 200) {
      const body = await this.#json(response)
      return { videos: parseBucket(body), fetchedAt: this.#now() }
    }
    // Error bodies are small (`[]` for a 404, a sentence for a 400), and none changes what FXM does.
    await response.body?.cancel().catch(() => undefined)
    // No video of this prefix has segments of the category.
    if (status === 404) return { videos: new Map(), fetchedAt: this.#now() }
    if (status === 429) {
      const waitMs = retryAfterMs(response.headers.get('retry-after'))
      this.#blockedUntil = Math.max(this.#blockedUntil, this.#now() + waitMs)
      throw rateLimited(waitMs)
    }
    throw new FxmError('Unavailable', `SponsorBlock answered HTTP ${status}`)
  }

  /** A response's JSON body: `Network` when reading it fails, `Parse` when it is not JSON. */
  async #json(response: Response): Promise<unknown> {
    const text = await response
      .text()
      .catch((error: unknown) => this.#failed(error, 'The answer from SponsorBlock broke off'))
    try {
      return JSON.parse(text)
    } catch (error) {
      throw new FxmError('Parse', 'SponsorBlock answered with invalid JSON', { cause: error })
    }
  }

  /** Rethrows a failed request as a `Network` error, which names the timeout when it was one. */
  #failed(error: unknown, message: string): never {
    const timedOut = (error as { name?: unknown } | null)?.name === 'TimeoutError'
    throw new FxmError(
      'Network',
      timedOut ? `SponsorBlock did not answer within ${this.#timeoutMs} ms` : message,
      { cause: error },
    )
  }
}

/**
 * A SponsorBlock client. One instance shares its cache and its lookups in flight between every
 * caller, so the app keeps one.
 */
export function createSponsorBlockClient(options: SponsorBlockOptions = {}): SponsorBlockClient {
  return new Client(options)
}
