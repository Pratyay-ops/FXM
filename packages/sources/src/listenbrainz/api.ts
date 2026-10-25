/**
 * ListenBrainz's labs API (`labs.api.listenbrainz.org`), which needs no key and answers any
 * origin (`Access-Control-Allow-Origin: *`), so it works on every tier:
 *
 * - `acr-lookup`: the MusicBrainz recording, artists and a release for an artist credit and a
 *   recording name
 * - `similar-artists`: artists whose music the same listeners play, for an artist's MBID
 *
 * ListenBrainz's main API (`api.listenbrainz.org`) is not used: its metadata lookup and LB Radio
 * need a user token. See `CLEAN-ROOM.md` for where each fact comes from.
 *
 * @module
 */

import { FxmError, type ProviderContext } from '@fxm/core'
import { RequestGate } from '../recommend/internal/gate'
import {
  field,
  getText,
  parseJson,
  rateLimited,
  retryAfterMs,
  type TextResponse,
} from '../recommend/internal/http'
import { comparable } from '../recommend/internal/text'
import { TtlCache } from '../shared/ttl-cache'

/** Where the labs API lives. */
export const LISTENBRAINZ_LABS_ORIGIN = 'https://labs.api.listenbrainz.org'

/**
 * The similar-artists data set FXM asks for by default: listening sessions over about 20 years
 * (7,500 days), as listed on the labs API's own form on 2026-10-26.
 */
export const DEFAULT_SIMILAR_ARTISTS_ALGORITHM =
  'session_based_days_7500_session_300_contribution_5_threshold_10_limit_100_filter_True_skip_30'

/** The service's name in error messages. */
const SERVICE = 'ListenBrainz'

/** What `acr-lookup` found for an artist credit and a recording name. */
export interface RecordingLookup {
  /** The recording's MusicBrainz ID. */
  recordingMbid: string
  /** The recording's name in MusicBrainz. */
  recordingName: string
  /** The artist credit in MusicBrainz, e.g. `Radiohead`. */
  artistCredit: string
  /** The MusicBrainz IDs of the credited artists, in credit order. */
  artistMbids: string[]
  /** A release the recording is on, e.g. its album, when MusicBrainz lists one. */
  releaseMbid?: string
  /** That release's name. */
  releaseName?: string
}

/** An artist ListenBrainz finds similar to another. */
export interface SimilarArtist {
  /** The artist's MusicBrainz ID. */
  mbid: string
  /** The artist's name in MusicBrainz. */
  name: string
  /** ListenBrainz's own score: higher is more similar. Comparable only within one answer. */
  score: number
  /** The score relative to the best one in the same answer, from 0 to 1. */
  similarity: number
  /** MusicBrainz's disambiguation comment, e.g. `UK rock band`, when it has one. */
  comment?: string
}

/** Options for {@link createListenBrainzClient}. All have defaults. */
export interface ListenBrainzOptions {
  /** Where the labs API lives. Default {@link LISTENBRAINZ_LABS_ORIGIN}. */
  labsOrigin?: string
  /** The similar-artists data set. Default {@link DEFAULT_SIMILAR_ARTISTS_ALGORITHM}. */
  algorithm?: string
  /** Abort a request, body included, after this many milliseconds. Default 10,000. */
  timeoutMs?: number
  /** Pause this many milliseconds between requests. Default 200. */
  minIntervalMs?: number
  /** The longest a call waits for its turn before failing with `RateLimited`. Default 10,000. */
  maxWaitMs?: number
  /** How long to keep an answer. Similar artists and lookups change slowly. Default 24 hours. */
  cacheTtlMs?: number
}

/** Options for {@link ListenBrainzClient.similarArtists}. */
export interface SimilarArtistsOptions {
  /** At most this many artists. Default 30. */
  limit?: number
}

/** The labs API calls FXM uses. */
export interface ListenBrainzClient {
  /**
   * Looks a recording up by its artist credit and name, which the labs API compares without
   * punctuation, accents or case. `null` when MusicBrainz has no such recording.
   */
  lookupRecording(
    artistCredit: string,
    recording: string,
    ctx: ProviderContext,
  ): Promise<RecordingLookup | null>
  /**
   * Artists similar to the one with the MusicBrainz ID `artistMbid`, most similar first. Empty
   * when ListenBrainz has no data for it, or when `artistMbid` is not an MBID.
   */
  similarArtists(
    artistMbid: string,
    ctx: ProviderContext,
    options?: SimilarArtistsOptions,
  ): Promise<SimilarArtist[]>
}

/** A lower-case MusicBrainz ID. */
const MBID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u

/** Whether `value` is a MusicBrainz ID in its canonical, lower-case form. */
export function isMbid(value: unknown): value is string {
  return typeof value === 'string' && MBID.test(value)
}

/** How long FXM remembers that the labs API had nothing. */
const MISS_TTL_MS = 3_600_000

/** A name from the labs API, tidied, or `undefined` when it is not a string or is blank. */
function nameOf(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const name = value.replace(/\s+/gu, ' ').trim().slice(0, 300)
  return name === '' ? undefined : name
}

/** The rows of a labs API answer, which is always a JSON array. */
function rowsOf(body: unknown): unknown[] {
  if (!Array.isArray(body)) {
    throw new FxmError('Parse', 'ListenBrainz sent an answer FXM does not understand')
  }
  return body
}

/** Reads `acr-lookup`'s answer: the first row, or `null` when there is none. */
export function parseRecordingLookup(body: unknown): RecordingLookup | null {
  for (const row of rowsOf(body)) {
    const recordingMbid = field(row, 'recording_mbid')
    const recordingName = nameOf(field(row, 'recording_name'))
    const artistCredit = nameOf(field(row, 'artist_credit_name'))
    const mbids = field(row, 'artist_mbids')
    if (!isMbid(recordingMbid) || recordingName === undefined || artistCredit === undefined) {
      continue
    }
    const lookup: RecordingLookup = {
      recordingMbid,
      recordingName,
      artistCredit,
      artistMbids: (Array.isArray(mbids) ? mbids : []).filter(isMbid),
    }
    const releaseMbid = field(row, 'release_mbid')
    if (isMbid(releaseMbid)) lookup.releaseMbid = releaseMbid
    const releaseName = nameOf(field(row, 'release_name'))
    if (releaseName !== undefined) lookup.releaseName = releaseName
    return lookup
  }
  return null
}

/**
 * Reads `similar-artists`' answer for `artistMbid`: rows about that artist, best score first,
 * each artist once and never the artist itself.
 */
export function parseSimilarArtists(body: unknown, artistMbid: string): SimilarArtist[] {
  const artists: SimilarArtist[] = []
  const seen = new Set<string>([artistMbid])
  for (const row of rowsOf(body)) {
    const mbid = field(row, 'artist_mbid')
    const name = nameOf(field(row, 'name'))
    const score = field(row, 'score')
    const reference = field(row, 'reference_mbid')
    if (!isMbid(mbid) || name === undefined || seen.has(mbid)) continue
    if (typeof score !== 'number' || !Number.isFinite(score) || score <= 0) continue
    if (reference !== undefined && reference !== artistMbid) continue
    seen.add(mbid)
    const artist: SimilarArtist = { mbid, name, score, similarity: 0 }
    const comment = nameOf(field(row, 'comment'))
    if (comment !== undefined) artist.comment = comment
    artists.push(artist)
  }
  artists.sort((a, b) => b.score - a.score)
  const best = artists[0]?.score ?? 1
  for (const artist of artists) artist.similarity = artist.score / best
  return artists
}

/** Creates a {@link ListenBrainzClient}. Share one instance, so that its pacing and cache hold. */
export function createListenBrainzClient(options: ListenBrainzOptions = {}): ListenBrainzClient {
  const origin = (options.labsOrigin ?? LISTENBRAINZ_LABS_ORIGIN).replace(/\/+$/u, '')
  const algorithm = options.algorithm ?? DEFAULT_SIMILAR_ARTISTS_ALGORITHM
  const timeoutMs = options.timeoutMs ?? 10_000
  const ttlMs = options.cacheTtlMs ?? 24 * 3_600_000
  const gate = new RequestGate({
    service: SERVICE,
    minIntervalMs: options.minIntervalMs ?? 200,
    maxWaitMs: options.maxWaitMs ?? 10_000,
  })
  const lookups = new TtlCache<RecordingLookup | null>({ maxEntries: 1_000 })
  const similar = new TtlCache<SimilarArtist[]>({ maxEntries: 500 })

  /**
   * The value cached under `key`, else one GET in its turn, read by `read` (`null` for a 404) and
   * cached inside the turn, so that a call waiting behind it finds the answer.
   */
  function cachedGet<T>(
    cache: TtlCache<T>,
    key: string,
    path: string,
    params: Record<string, string>,
    ctx: ProviderContext,
    read: (body: unknown | null) => { value: T; found: boolean },
  ): Promise<T> {
    const hit = cache.get(key)
    if (hit !== undefined) return Promise.resolve(hit)
    return gate.run(ctx.signal, async (ready) => {
      const queued = cache.get(key)
      if (queued !== undefined) return queued
      const url = new URL(`${origin}/${path}`)
      url.search = new URLSearchParams(params).toString()
      await ready()
      const response = await getText(ctx, url.href, {
        service: SERVICE,
        timeoutMs,
        maxBytes: 2_000_000,
      })
      if (response.status !== 200 && response.status !== 404) throw failure(response)
      const { value, found } = read(response.status === 404 ? null : parseJson(response, SERVICE))
      cache.set(key, value, found ? ttlMs : MISS_TTL_MS)
      return value
    })
  }

  /** The `FxmError` for an HTTP error, after any back-off it calls for. */
  function failure(response: TextResponse): FxmError {
    const { status, headers } = response
    if (status === 429) {
      // ListenBrainz's servers name the wait in X-RateLimit-Reset-In (seconds) as well.
      const resetIn = headers.get('x-ratelimit-reset-in')
      const delayMs = retryAfterMs(headers.get('retry-after') ?? resetIn, 10_000)
      return rateLimited(SERVICE, gate.backOff(delayMs, true))
    }
    if (status >= 500) gate.backOff(retryAfterMs(headers.get('retry-after'), 5_000), false)
    return new FxmError('Unavailable', `ListenBrainz answered with HTTP ${status}`)
  }

  return {
    async lookupRecording(artistCredit, recording, ctx) {
      const credit = artistCredit.replace(/\s+/gu, ' ').trim()
      const name = recording.replace(/\s+/gu, ' ').trim()
      if (credit === '' || name === '') return null
      return cachedGet(
        lookups,
        `${comparable(credit)}\u0000${comparable(name)}`,
        'acr-lookup/json',
        { artist_credit_name: credit, recording_name: name },
        ctx,
        (body) => {
          const lookup = body === null ? null : parseRecordingLookup(body)
          return { value: lookup, found: lookup !== null }
        },
      )
    },

    async similarArtists(artistMbid, ctx, { limit = 30 } = {}) {
      if (!isMbid(artistMbid)) return []
      const artists = await cachedGet(
        similar,
        artistMbid,
        'similar-artists/json',
        { artist_mbids: artistMbid, algorithm },
        ctx,
        (body) => {
          const found = body === null ? [] : parseSimilarArtists(body, artistMbid)
          return { value: found, found: found.length > 0 }
        },
      )
      return artists.slice(0, Math.max(0, Math.round(limit)))
    },
  }
}
