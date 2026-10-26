/**
 * The Last.fm API (`ws.audioscrobbler.com/2.0`), for similar artists. It answers any origin
 * (`Access-Control-Allow-Origin: *`), so it works on every tier, but it needs an API key: FXM
 * ships none, so the key comes from the app's configuration or the user's settings.
 *
 * @module
 */

import { FxmError, type ProviderContext } from '@fxm/core'
import { RequestGate } from '../shared/gate'
import {
  field,
  getText,
  maxAgeMs,
  parseJson,
  rateLimited,
  retryAfterMs,
  type TextResponse,
} from '../shared/http'
import { normalizeMbid } from '../shared/mbid'
import { wholeNumber } from '../shared/numbers'
import { TtlCache } from '../shared/ttl-cache'
import { LASTFM_WEB_ORIGIN, lastfmPathSegment } from './station'

/** The Last.fm API's endpoint. */
export const LASTFM_API_URL = 'https://ws.audioscrobbler.com/2.0/'

/** The service's name in error messages. */
const SERVICE = 'The Last.fm API'

/** An artist Last.fm finds similar to another. */
export interface LastfmSimilarArtist {
  /** The artist's name on Last.fm. */
  name: string
  /** The artist's MusicBrainz ID, when Last.fm knows it. */
  mbid?: string
  /** How similar Last.fm finds the artist, from 0 (not at all) to 1 (very). */
  match: number
  /** The artist's page on Last.fm, which Last.fm asks apps that use its data to link to. */
  url: string
}

/** Options for {@link createLastfmApiClient}. */
export interface LastfmApiOptions {
  /**
   * The Last.fm API key. Required: FXM ships none (see the README), and a blank key throws a
   * `TypeError`, so that a cleared settings field never looks like "no similar artists".
   */
  apiKey: string
  /** The API's endpoint. Default {@link LASTFM_API_URL}. */
  apiUrl?: string
  /** Abort a request, body included, after this many milliseconds. Default 10,000. */
  timeoutMs?: number
  /** Pause this many milliseconds between requests. Default 250. */
  minIntervalMs?: number
  /**
   * The longest a call waits for its turn, counted from when it was made, before failing with
   * `RateLimited`. Default 10,000.
   */
  maxWaitMs?: number
  /**
   * How long to keep an answer when Last.fm's `Cache-Control` does not say. Last.fm's terms ask
   * apps to cache as its headers say. Default 6 hours.
   */
  cacheTtlMs?: number
}

/** Options for {@link LastfmApiClient.similarArtists}. */
export interface LastfmSimilarArtistsOptions {
  /** At most this many artists, from 1 to 100. Default 30. */
  limit?: number
}

/** The Last.fm API calls FXM uses. */
export interface LastfmApiClient {
  /**
   * Artists similar to `artist` (a name; Last.fm corrects misspellings), most similar first.
   * Empty when Last.fm says it does not know the artist.
   *
   * Rejects with an `FxmError`: `AuthRequired` when Last.fm refuses the API key (invalid or
   * suspended) or says the request lacks a required parameter, which for FXM's requests is the
   * key; `RateLimited` when it asks FXM to slow down; `Network`; `Unavailable` for other
   * failures and `Parse` for answers FXM cannot read.
   */
  similarArtists(
    artist: string,
    ctx: ProviderContext,
    options?: LastfmSimilarArtistsOptions,
  ): Promise<LastfmSimilarArtist[]>
}

/** The longest and shortest time FXM keeps an answer, whatever Last.fm's headers say. */
const MIN_TTL_MS = 10 * 60_000
const MAX_TTL_MS = 24 * 3_600_000
/** How long FXM remembers that Last.fm does not know an artist. */
const MISS_TTL_MS = 3_600_000

/**
 * Error 6's message for an artist Last.fm cannot find ("The artist you supplied could not be
 * found", see `CLEAN-ROOM.md`). Error 6 also means "Invalid parameters - Your request is missing
 * a required parameter", which is not about the artist.
 */
const UNKNOWN_ARTIST = /\bcould not be found\b/iu

/** Reads one artist of `similarartists.artist`, or `null` when it has no name. */
function similarArtistOf(value: unknown): LastfmSimilarArtist | null {
  const raw = field(value, 'name')
  const name = typeof raw === 'string' ? raw.replace(/\s+/gu, ' ').trim().slice(0, 300) : ''
  if (name === '') return null
  const match = Number(field(value, 'match'))
  const artist: LastfmSimilarArtist = {
    name,
    match: Number.isFinite(match) ? Math.min(1, Math.max(0, match)) : 0,
    url: `${LASTFM_WEB_ORIGIN}/music/${lastfmPathSegment(name)}`,
  }
  const url = field(value, 'url')
  if (typeof url === 'string' && /^https:\/\/www\.last\.fm\/music\/\S+$/u.test(url))
    artist.url = url
  const mbid = normalizeMbid(field(value, 'mbid'))
  if (mbid !== undefined) artist.mbid = mbid
  return artist
}

/**
 * Reads `artist.getSimilar`'s JSON. Like Last.fm's other JSON answers, a list of one may come as
 * the object itself instead of an array.
 */
export function parseLastfmSimilarArtists(body: unknown): LastfmSimilarArtist[] {
  const similar = field(body, 'similarartists')
  if (similar === undefined) {
    throw new FxmError('Parse', 'Last.fm sent similar artists FXM does not understand')
  }
  const list = field(similar, 'artist')
  const items = Array.isArray(list) ? list : list === undefined ? [] : [list]
  return items.map(similarArtistOf).filter((artist) => artist !== null)
}

/** The error in a Last.fm API answer (`{"error": 6, "message": …}`), if it has one. */
function errorOf(body: unknown): { code: number; message: string } | undefined {
  const code = field(body, 'error')
  if (typeof code !== 'number' || !Number.isInteger(code)) return undefined
  const message = field(body, 'message')
  return { code, message: typeof message === 'string' ? message : '' }
}

/** Creates a {@link LastfmApiClient}. Share one instance, so that its pacing and cache hold. */
export function createLastfmApiClient(options: LastfmApiOptions): LastfmApiClient {
  const apiKey = typeof options.apiKey === 'string' ? options.apiKey.trim() : ''
  if (apiKey === '') throw new TypeError('The Last.fm API needs an API key')
  const apiUrl = options.apiUrl ?? LASTFM_API_URL
  const timeoutMs = options.timeoutMs ?? 10_000
  const defaultTtlMs = options.cacheTtlMs ?? 6 * 3_600_000
  const gate = new RequestGate({
    service: SERVICE,
    minIntervalMs: options.minIntervalMs ?? 250,
    maxWaitMs: options.maxWaitMs ?? 10_000,
  })
  const cache = new TtlCache<LastfmSimilarArtist[]>({ maxEntries: 500 })

  /**
   * The `FxmError` for an answer that holds no similar artists, after any back-off it calls for.
   * An unknown artist is not an error: the caller handles that first.
   */
  function failure(response: TextResponse, code: number | undefined): FxmError {
    if (code === 6 || code === 10 || code === 26) {
      const reason =
        code === 6 ? 'says the request lacks a required parameter' : 'refused the API key'
      return new FxmError('AuthRequired', `${SERVICE} ${reason} (error ${code})`)
    }
    if (code === 29 || response.status === 429) {
      const delayMs = retryAfterMs(response.headers.get('retry-after'), 60_000)
      return rateLimited(SERVICE, gate.backOff(delayMs, true))
    }
    if (code === 11 || code === 16 || response.status >= 500) gate.backOff(5_000, false)
    const reason = code === undefined ? `HTTP ${response.status}` : `error ${code}`
    return new FxmError('Unavailable', `${SERVICE} answered with ${reason}`)
  }

  return {
    async similarArtists(artist, ctx, { limit } = {}) {
      const name = artist.replace(/\s+/gu, ' ').trim()
      if (name === '') return []
      const count = wholeNumber(limit, 30, 1, 100)
      // Keyed on what is sent: names that differ only in punctuation are different artists.
      const key = `${name}\u0000${count}`
      const cached = cache.get(key)
      if (cached !== undefined) return cached
      return gate.run(
        async (ready) => {
          const queued = cache.get(key)
          if (queued !== undefined) return queued
          const url = new URL(apiUrl)
          url.search = new URLSearchParams({
            method: 'artist.getsimilar',
            artist: name,
            autocorrect: '1',
            limit: String(count),
            api_key: apiKey,
            format: 'json',
          }).toString()
          await ready()
          const response = await getText(ctx, url.href, {
            service: SERVICE,
            timeoutMs,
            maxBytes: 2_000_000,
          })
          let body: unknown
          try {
            body = parseJson(response, SERVICE)
          } catch (error) {
            if (response.status === 200) throw error
            throw failure(response, undefined)
          }
          const error = errorOf(body)
          if (error?.code === 6 && UNKNOWN_ARTIST.test(error.message)) {
            cache.set(key, [], MISS_TTL_MS)
            return []
          }
          if (response.status !== 200 || error !== undefined) throw failure(response, error?.code)
          const artists = parseLastfmSimilarArtists(body)
          const ttlMs = maxAgeMs(response.headers.get('cache-control')) ?? defaultTtlMs
          cache.set(key, artists, Math.min(MAX_TTL_MS, Math.max(MIN_TTL_MS, ttlMs)))
          return artists
        },
        { signal: ctx.signal },
      )
    },
  }
}
