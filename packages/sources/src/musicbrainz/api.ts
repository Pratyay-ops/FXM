/**
 * The MusicBrainz web service (`/ws/2`), called only through the injected `fetch` and always
 * through one shared {@link RequestQueue}, at most one request per second.
 *
 * MusicBrainz sends `Access-Control-Allow-Origin: *` on every answer, 404s and 503s included, so
 * a browser page reaches it directly. Its rules ask every client for a descriptive User-Agent,
 * which page scripts in Chromium cannot set: on the web FXM sends none of its own (the browser's
 * own is not one MusicBrainz throttles as anonymous), and on desktop and Android, whose native
 * HTTP sends whatever FXM sets, it sends {@link MUSICBRAINZ_USER_AGENT}. See the README.
 *
 * @module
 */

import { APP_VERSION, FxmError, normalizeIsrc, type ProviderContext } from '@fxm/core'
import { asObject, getJson, type JsonReply, retryAfterMs, statusError, text } from '../shared/json'
import { LoadCache } from '../shared/ttl-cache'
import { RequestQueue } from './queue'

/** The web service's root. */
export const MUSICBRAINZ_API = 'https://musicbrainz.org/ws/2/'

/** FXM's project page, which MusicBrainz asks clients to name. */
const PROJECT_URL = 'https://github.com/Pratyay-ops/FXM'

/**
 * The User-Agent that desktop and Android send, in the form MusicBrainz asks for:
 * `Application name/<version> ( contact-url )`.
 */
export const MUSICBRAINZ_USER_AGENT = `FXM/${APP_VERSION} ( ${PROJECT_URL} )`

/**
 * The queue that every MusicBrainz client shares unless it is given its own: one request per
 * second, start to start, for the whole app.
 */
export const musicBrainzQueue = new RequestQueue(1000)

/** The most URLs one `/url` lookup takes, and the most IDs FXM puts in one search. */
const URL_BATCH = 100
const ID_BATCH = 50

/** The shortest wait after a 503, doubled on each further one. */
const MIN_BACKOFF_MS = 1000

/** A MusicBrainz ID: a UUID. */
const MBID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu

const SERVICE = 'MusicBrainz'

/** Settings of a {@link MusicBrainzClient}. All optional. */
export interface MusicBrainzOptions {
  /** The web service's root, {@link MUSICBRAINZ_API} by default. */
  baseUrl?: string
  /**
   * The User-Agent header to send. By default none on the web, where Chromium does not let a
   * page set it, and {@link MUSICBRAINZ_USER_AGENT} on desktop and Android. A string is sent on
   * every platform, so only pass one where the platform's `fetch` can send it; `false` never
   * sends one.
   */
  userAgent?: string | false
  /** The queue to wait in. {@link musicBrainzQueue}, shared by the whole app, by default. */
  queue?: RequestQueue
  /** Abort a request after this many milliseconds. 15 seconds by default. */
  timeoutMs?: number
  /** How often to try a request that MusicBrainz answers with 503 (busy). 3 by default. */
  maxAttempts?: number
  /** How long to keep lookups (URLs, recordings, ISRCs). A day by default. */
  lookupTtlMs?: number
  /** How long to keep searches. An hour by default. */
  searchTtlMs?: number
  /** The clock for the caches. `Date.now` by default. */
  now?: () => number
}

/** One artist of a credit, as MusicBrainz lists it. */
export interface MusicBrainzCredit {
  /** The name as credited on the recording. */
  name: string
  /** The artist's MBID. */
  id?: string
  /** What joins this name to the next one, e.g. ` feat. `. Empty for the last. */
  joinPhrase: string
}

/** A recording: one specific recorded performance, which can appear on many releases. */
export interface MusicBrainzRecording {
  /** Its MBID. */
  id: string
  /** Its title. */
  title: string
  /** The artist credit, in order. Empty when the answer did not include it. */
  credits: MusicBrainzCredit[]
  /** The credited names, in order. */
  artists: string[]
  /** Its length in milliseconds, when MusicBrainz knows it. */
  lengthMs?: number
  /** The comment that tells it from same-titled recordings, e.g. `live, 1993-06-30: …`. */
  disambiguation?: string
  /**
   * Its ISRCs in canonical form (see `normalizeIsrc`). Empty when it has none, or when the
   * answer did not include them (URL lookups don't).
   */
  isrcs: string[]
  /** The date of its first release, possibly partial (`1992`, `1992-09-21`). */
  firstReleaseDate?: string
  /** Whether it is a video. */
  video: boolean
}

/** A release that a recording appears on, as search results summarize it. */
export interface MusicBrainzReleaseSummary {
  /** The release's MBID. */
  id: string
  /** Its title. */
  title: string
  /** `Official`, `Promotion`, `Bootleg` or `Pseudo-Release`, when set. */
  status?: string
  /** Its release group's primary type: `Album`, `Single`, `EP`, `Broadcast` or `Other`. */
  primaryType?: string
  /** Its release group's secondary types, e.g. `Live`, `Compilation`, `Soundtrack`. */
  secondaryTypes: string[]
}

/** A recording found by a search, with MusicBrainz's score and the releases it is on. */
export interface MusicBrainzSearchHit extends MusicBrainzRecording {
  /** How well it fits the query, 0 to 100. Many recordings tie at 100. */
  score: number
  /** The releases it appears on. */
  releases: MusicBrainzReleaseSummary[]
}

/** What {@link MusicBrainzClient.searchRecordings} looks for. */
export interface RecordingQuery {
  /** The title, best without version qualifiers (see `splitTitle`). */
  title: string
  /** The main artist's name. */
  artist: string
  /** The track's duration. With it, only recordings within `windowMs` of it are returned. */
  durationMs?: number
  /** How far the length may be off, in milliseconds. max(10 s, 5 %) by default. */
  windowMs?: number
  /** How many recordings to return, at most 100. 25 by default. */
  limit?: number
}

/** A positive whole number of milliseconds, or `undefined`. */
function milliseconds(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : undefined
}

/** The artist credit of a recording object. */
function credits(value: unknown): MusicBrainzCredit[] {
  if (!Array.isArray(value)) return []
  const result: MusicBrainzCredit[] = []
  for (const item of value) {
    const credit = asObject(item)
    const artist = asObject(credit?.artist)
    const name = text(credit?.name) ?? text(artist?.name)
    if (name === undefined) continue
    const entry: MusicBrainzCredit = {
      name,
      joinPhrase: typeof credit?.joinphrase === 'string' ? credit.joinphrase : '',
    }
    const id = text(artist?.id)
    if (id !== undefined) entry.id = id
    result.push(entry)
  }
  return result
}

/** The canonical ISRCs of a recording object, each once. */
function isrcs(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const found = value.map(normalizeIsrc).filter((isrc) => isrc !== null)
  return [...new Set(found)]
}

/** A recording from a MusicBrainz recording object, or `null` without an ID and title. */
export function toRecording(value: unknown): MusicBrainzRecording | null {
  const object = asObject(value)
  const id = text(object?.id)
  const title = typeof object?.title === 'string' ? object.title : undefined
  if (object === undefined || id === undefined || title === undefined) return null
  const credit = credits(object['artist-credit'])
  const recording: MusicBrainzRecording = {
    id,
    title,
    credits: credit,
    artists: credit.map((entry) => entry.name),
    isrcs: isrcs(object.isrcs),
    video: object.video === true,
  }
  const lengthMs = milliseconds(object.length)
  if (lengthMs !== undefined) recording.lengthMs = lengthMs
  const disambiguation = text(object.disambiguation)
  if (disambiguation !== undefined) recording.disambiguation = disambiguation
  const firstReleaseDate = text(object['first-release-date'])
  if (firstReleaseDate !== undefined) recording.firstReleaseDate = firstReleaseDate
  return recording
}

/** The releases of a search hit. */
function releases(value: unknown): MusicBrainzReleaseSummary[] {
  if (!Array.isArray(value)) return []
  const result: MusicBrainzReleaseSummary[] = []
  for (const item of value) {
    const release = asObject(item)
    const id = text(release?.id)
    if (release === undefined || id === undefined) continue
    const group = asObject(release['release-group'])
    const secondary = group?.['secondary-types']
    const summary: MusicBrainzReleaseSummary = {
      id,
      title: typeof release.title === 'string' ? release.title : '',
      secondaryTypes: Array.isArray(secondary)
        ? secondary.filter((type): type is string => typeof type === 'string')
        : [],
    }
    const status = text(release.status)
    if (status !== undefined) summary.status = status
    const primaryType = text(group?.['primary-type'])
    if (primaryType !== undefined) summary.primaryType = primaryType
    result.push(summary)
  }
  return result
}

/** A search hit from a recording object of a search answer, or `null`. */
function toSearchHit(value: unknown): MusicBrainzSearchHit | null {
  const recording = toRecording(value)
  if (recording === null) return null
  const object = asObject(value)
  const score = typeof object?.score === 'number' ? object.score : 0
  return { ...recording, score, releases: releases(object?.releases) }
}

/** The recordings a URL entity relates to, each once. */
function relatedRecordings(value: unknown): MusicBrainzRecording[] {
  const relations = asObject(value)?.relations
  if (!Array.isArray(relations)) return []
  const found = new Map<string, MusicBrainzRecording>()
  for (const item of relations) {
    const relation = asObject(item)
    if (relation?.['target-type'] !== 'recording') continue
    const recording = toRecording(relation.recording)
    if (recording !== null && !found.has(recording.id)) found.set(recording.id, recording)
  }
  return [...found.values()]
}

/** A phrase for a Lucene query: in quotes, with quotes and backslashes escaped. */
export function phrase(value: string): string {
  return `"${value.replace(/[\\"]/gu, (character) => `\\${character}`)}"`
}

/** The query for {@link MusicBrainzClient.searchRecordings}. */
export function recordingQuery({ title, artist, durationMs, windowMs }: RecordingQuery): string {
  const parts = [`recording:${phrase(title)}`, `artist:${phrase(artist)}`]
  if (durationMs !== undefined && Number.isFinite(durationMs) && durationMs > 0) {
    const window = windowMs ?? Math.max(10_000, durationMs * 0.05)
    const from = Math.max(0, Math.round(durationMs - window))
    parts.push(`dur:[${from} TO ${Math.round(durationMs + window)}]`)
  }
  return parts.join(' AND ')
}

/** Splits `items` into lists of at most `size`. */
function chunks<T>(items: readonly T[], size: number): T[][] {
  const result: T[][] = []
  for (let start = 0; start < items.length; start += size) {
    result.push(items.slice(start, start + size))
  }
  return result
}

/**
 * A client for the MusicBrainz lookups FXM needs: URL relationships, recordings, ISRCs and
 * recording search. Every request waits its turn in the shared queue, and answers are kept in
 * memory for a while (see {@link MusicBrainzOptions}).
 */
export class MusicBrainzClient {
  private readonly baseUrl: string
  private readonly queue: RequestQueue
  private readonly timeoutMs: number
  private readonly maxAttempts: number
  private readonly lookupTtlMs: number
  private readonly searchTtlMs: number
  private readonly cache: LoadCache<unknown>

  constructor(private readonly options: MusicBrainzOptions = {}) {
    const base = options.baseUrl ?? MUSICBRAINZ_API
    this.baseUrl = base.endsWith('/') ? base : `${base}/`
    this.queue = options.queue ?? musicBrainzQueue
    this.timeoutMs = options.timeoutMs ?? 15_000
    this.maxAttempts = Math.max(1, options.maxAttempts ?? 3)
    this.lookupTtlMs = options.lookupTtlMs ?? 86_400_000
    this.searchTtlMs = options.searchTtlMs ?? 3_600_000
    this.cache = new LoadCache({
      maxEntries: 500,
      ...(options.now === undefined ? {} : { now: options.now }),
    })
  }

  /** The User-Agent header for `ctx`'s platform, if any (see {@link MusicBrainzOptions}). */
  userAgentFor(ctx: Pick<ProviderContext, 'platform'>): string | undefined {
    const { userAgent } = this.options
    if (userAgent === false) return undefined
    if (typeof userAgent === 'string') return userAgent
    return ctx.platform === 'web' ? undefined : MUSICBRAINZ_USER_AGENT
  }

  /**
   * The recordings that MusicBrainz links to `url`, e.g. a Spotify track's
   * `https://open.spotify.com/track/<id>`, without their ISRCs. Empty when it knows no such URL.
   */
  async lookupUrl(url: string, ctx: ProviderContext): Promise<MusicBrainzRecording[]> {
    const answer = await this.lookup(['url'], { resource: [url], inc: ['recording-rels'] }, ctx)
    return answer === null ? [] : relatedRecordings(answer)
  }

  /**
   * {@link lookupUrl} for many URLs at once, up to 100 per request. The map holds every URL
   * that MusicBrainz knows, with its recordings.
   */
  async lookupUrls(
    urls: readonly string[],
    ctx: ProviderContext,
  ): Promise<Map<string, MusicBrainzRecording[]>> {
    const found = new Map<string, MusicBrainzRecording[]>()
    for (const batch of chunks([...new Set(urls)], URL_BATCH)) {
      const answer = await this.lookup(['url'], { resource: batch, inc: ['recording-rels'] }, ctx)
      const object = asObject(answer)
      // One resource returns the URL entity itself; several return a list.
      const entities = Array.isArray(object?.urls) ? object.urls : object ? [object] : []
      for (const entity of entities) {
        const resource = text(asObject(entity)?.resource)
        if (resource !== undefined) found.set(resource, relatedRecordings(entity))
      }
    }
    return found
  }

  /**
   * One recording with its ISRCs and artist credit. Rejects with `NotFound` when unknown, and
   * with a `RangeError`, without a request, when `id` is not an MBID.
   */
  async getRecording(id: string, ctx: ProviderContext): Promise<MusicBrainzRecording> {
    if (!MBID.test(id)) throw new RangeError(`Not a MusicBrainz ID: ${id}`)
    const answer = await this.lookup(['recording', id], { inc: ['isrcs', 'artist-credits'] }, ctx)
    const recording = answer === null ? null : toRecording(answer)
    if (recording === null) {
      throw new FxmError('NotFound', `MusicBrainz has no recording ${id}`)
    }
    return recording
  }

  /**
   * Many recordings with their ISRCs and artist credits: up to 50 per request, through a search
   * by MBID, then one lookup each for any recording the search index does not have yet. The map
   * holds every recording that exists; a value that is not an MBID is left out.
   */
  async getRecordings(
    ids: readonly string[],
    ctx: ProviderContext,
  ): Promise<Map<string, MusicBrainzRecording>> {
    const found = new Map<string, MusicBrainzRecording>()
    const unique = [...new Set(ids)].filter((id) => MBID.test(id))
    for (const batch of chunks(unique, ID_BATCH)) {
      const query = batch.map((id) => `rid:${phrase(id)}`).join(' OR ')
      for (const hit of await this.search(query, batch.length, ctx)) {
        if (batch.includes(hit.id)) found.set(hit.id, stripSearchFields(hit))
      }
    }
    for (const id of unique) {
      if (found.has(id)) continue
      try {
        found.set(id, await this.getRecording(id, ctx))
      } catch (error) {
        if (!(error instanceof FxmError && error.code === 'NotFound')) throw error
      }
    }
    return found
  }

  /**
   * The recordings that carry `isrc`, with their artist credits and ISRCs. Empty when no
   * recording has it. Rejects with a `RangeError` when `isrc` is not a valid ISRC.
   */
  async lookupIsrc(isrc: string, ctx: ProviderContext): Promise<MusicBrainzRecording[]> {
    const canonical = normalizeIsrc(isrc)
    if (canonical === null) throw new RangeError(`Not an ISRC: ${isrc}`)
    const answer = await this.lookup(['isrc', canonical], { inc: ['artist-credits', 'isrcs'] }, ctx)
    const list = asObject(answer)?.recordings
    if (!Array.isArray(list)) return []
    return list.map(toRecording).filter((recording) => recording !== null)
  }

  /**
   * A recording search by title and artist, within a window around the duration when one is
   * given, in MusicBrainz's order (best score first; many recordings tie at 100, with live,
   * compilation and soundtrack versions often first).
   */
  async searchRecordings(
    query: RecordingQuery,
    ctx: ProviderContext,
  ): Promise<MusicBrainzSearchHit[]> {
    const limit = Math.min(Math.max(1, Math.round(query.limit ?? 25)), 100)
    return this.search(recordingQuery(query), limit, ctx)
  }

  /** A recording search with a raw Lucene query. */
  private async search(
    query: string,
    limit: number,
    ctx: ProviderContext,
  ): Promise<MusicBrainzSearchHit[]> {
    const answer = await this.request(
      ['recording'],
      { query: [query], limit: [String(limit)] },
      this.searchTtlMs,
      ctx,
    )
    const list = asObject(answer)?.recordings
    if (answer === null || !Array.isArray(list)) {
      throw new FxmError('Parse', 'MusicBrainz sent search results FXM does not understand')
    }
    return list.map(toSearchHit).filter((hit) => hit !== null)
  }

  /** A lookup: the answer, or `null` when MusicBrainz has no such entity (404). */
  private lookup(
    path: readonly string[],
    params: Record<string, readonly string[]>,
    ctx: ProviderContext,
  ): Promise<unknown> {
    return this.request(path, params, this.lookupTtlMs, ctx)
  }

  /** One GET through the cache and the queue: the JSON answer, or `null` for a 404. */
  private request(
    path: readonly string[],
    params: Record<string, readonly string[]>,
    ttlMs: number,
    ctx: ProviderContext,
  ): Promise<unknown> {
    const url = new URL(path.map(encodeURIComponent).join('/'), this.baseUrl)
    for (const [name, values] of Object.entries(params)) {
      if (name === 'inc') url.searchParams.set(name, values.join('+'))
      else for (const value of values) url.searchParams.append(name, value)
    }
    url.searchParams.set('fmt', 'json')
    // `inc` joins its values with a literal `+`, which URLSearchParams would encode.
    const href = url.href.replace(/([?&]inc=[^&]*)/u, (match) => match.replaceAll('%2B', '+'))
    return this.cache.get(href, ttlMs, () => this.fetchAnswer(href, ctx), ctx.signal)
  }

  /** Fetches `href` in turn, waiting and retrying after a 503, and maps the status. */
  private async fetchAnswer(href: string, ctx: ProviderContext): Promise<unknown> {
    const userAgent = this.userAgentFor(ctx)
    const options = {
      service: SERVICE,
      timeoutMs: this.timeoutMs,
      ...(userAgent === undefined ? {} : { headers: { 'User-Agent': userAgent } }),
    }
    for (let attempt = 1; ; attempt++) {
      const reply: JsonReply = await this.queue.run(() => getJson(ctx, href, options), ctx.signal)
      if (reply.status === 200) return reply.body
      if (reply.status === 404) return null
      if (reply.status !== 503) throw statusError(SERVICE, 'a request', reply)
      const waitMs = Math.max(
        retryAfterMs(reply.headers.get('retry-after'), 0),
        MIN_BACKOFF_MS * 2 ** (attempt - 1),
      )
      this.queue.pause(waitMs)
      if (attempt >= this.maxAttempts) {
        throw new FxmError('RateLimited', `MusicBrainz stayed busy after ${attempt} tries`, {
          retryAfterMs: waitMs,
        })
      }
    }
  }
}

/** A search hit as a plain recording. */
function stripSearchFields(hit: MusicBrainzSearchHit): MusicBrainzRecording {
  const { score: _score, releases: _releases, ...recording } = hit
  return recording
}
