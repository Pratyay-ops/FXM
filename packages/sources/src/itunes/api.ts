/**
 * Apple's iTunes Search API (`itunes.apple.com/search`), used only to fill artwork gaps. It needs
 * no key and answers any origin (`Access-Control-Allow-Origin: *`), so it works on every tier.
 * Apple limits it to about 20 calls a minute and asks heavy users to cache; this client does
 * both. See `CLEAN-ROOM.md` for where each fact comes from, and the README for Apple's terms.
 *
 * @module
 */

import { type Artwork, FxmError, type ProviderContext } from '@fxm/core'
import { RequestGate } from '../recommend/internal/gate'
import {
  field,
  getText,
  maxAgeMs,
  parseJson,
  rateLimited,
  retryAfterMs,
} from '../recommend/internal/http'
import { TtlCache } from '../shared/ttl-cache'

/** The search endpoint. */
export const ITUNES_SEARCH_URL = 'https://itunes.apple.com/search'

/** The store FXM searches when the context names no region: Apple's own default. */
export const DEFAULT_ITUNES_COUNTRY = 'US'

/** The service's name in error messages. */
const SERVICE = 'iTunes Search'

/** A song in the iTunes Store. */
export interface ItunesSong {
  /** The store's ID of the song. */
  trackId: number
  /** The song's title. */
  title: string
  /** The artist credit, e.g. `Daft Punk, Pharrell Williams & Nile Rodgers`. */
  artist: string
  /** The album it is on. */
  album?: string
  /** Its duration in milliseconds. */
  durationMs?: number
  /** The album's cover, 100 pixels square (see {@link itunesArtwork} for larger sizes). */
  artworkUrl?: string
}

/** An album in the iTunes Store. */
export interface ItunesAlbum {
  /** The store's ID of the album. */
  collectionId: number
  /** The album's name, e.g. `Random Access Memories`, or `Creep - EP`. */
  name: string
  /** The artist credit. */
  artist: string
  /** The album's cover, 100 pixels square. */
  artworkUrl?: string
}

/** Options for {@link createItunesClient}. All have defaults. */
export interface ItunesOptions {
  /** The search endpoint. Default {@link ITUNES_SEARCH_URL}. */
  searchUrl?: string
  /** Abort a request, body included, after this many milliseconds. Default 10,000. */
  timeoutMs?: number
  /** At most this many searches in any minute: Apple allows about 20. Default 20. */
  maxPerMinute?: number
  /**
   * The longest a call waits for a free slot before failing with `RateLimited`. Artwork is never
   * urgent, so a call waits rather than fails. Default 60,000.
   */
  maxWaitMs?: number
  /** How long to keep an answer when its `Cache-Control` does not say. Default 24 hours. */
  cacheTtlMs?: number
}

/** Options for one search. */
export interface ItunesSearchOptions {
  /** At most this many results, from 1 to 200. Default 10. */
  limit?: number
  /**
   * The store to search, as an ISO 3166-1 alpha-2 code. Default: the context's `region`, else
   * {@link DEFAULT_ITUNES_COUNTRY}.
   */
  country?: string
}

/** Searches the iTunes Store's music. */
export interface ItunesClient {
  /**
   * Songs matching `term`, in Apple's order.
   *
   * Rejects with an `FxmError`: `RateLimited` when the per-minute limit is used up beyond
   * `maxWaitMs` or Apple refuses with 403 or 429, `Network`, `Unavailable` for other HTTP errors
   * and `Parse` for answers FXM cannot read.
   */
  searchSongs(
    term: string,
    ctx: ProviderContext,
    options?: ItunesSearchOptions,
  ): Promise<ItunesSong[]>
  /** Albums matching `term`, in Apple's order. Fails like {@link searchSongs}. */
  searchAlbums(
    term: string,
    ctx: ProviderContext,
    options?: ItunesSearchOptions,
  ): Promise<ItunesAlbum[]>
}

/** The sizes FXM offers of an iTunes cover, in pixels square. */
export const ITUNES_ARTWORK_SIZES = [100, 300, 600] as const

/** The size part at the end of an image URL on Apple's image servers: `/100x100bb.jpg`. */
const SIZED_IMAGE = /\/\d{2,4}x\d{2,4}bb\.(jpg|png|webp)$/u

/**
 * The sizes of an iTunes cover from its `artworkUrl100`, smallest first: Apple's image servers
 * (`*.mzstatic.com`) scale an image to the size its URL names (`/600x600bb.jpg`). Empty for a URL
 * on any other host; just the URL itself when it has no size part.
 */
export function itunesArtwork(artworkUrl: string): Artwork[] {
  let url: URL
  try {
    url = new URL(artworkUrl)
  } catch {
    return []
  }
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.mzstatic.com')) return []
  if (url.username !== '' || url.password !== '' || url.port !== '') return []
  if (!SIZED_IMAGE.test(url.pathname)) return [{ url: url.href }]
  return ITUNES_ARTWORK_SIZES.map((size) => {
    const sized = new URL(url.href)
    sized.pathname = url.pathname.replace(SIZED_IMAGE, `/${size}x${size}bb.$1`)
    return { url: sized.href, width: size, height: size }
  })
}

/** A name from Apple, tidied, or `undefined` when it is not a string or is blank. */
function nameOf(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const name = value.replace(/\s+/gu, ' ').trim().slice(0, 300)
  return name === '' ? undefined : name
}

/** The results of a search answer (`{ resultCount, results }`). */
function resultsOf(body: unknown): unknown[] {
  const results = field(body, 'results')
  if (!Array.isArray(results)) {
    throw new FxmError('Parse', 'iTunes Search sent results FXM does not understand')
  }
  return results
}

/** The `artworkUrl100` of a result, when it is an https URL on Apple's image servers. */
function artworkUrlOf(result: unknown): string | undefined {
  const url = field(result, 'artworkUrl100')
  return typeof url === 'string' && itunesArtwork(url).length > 0 ? url : undefined
}

/** Reads a song search's answer, keeping only songs. */
export function parseSongs(body: unknown): ItunesSong[] {
  const songs: ItunesSong[] = []
  for (const result of resultsOf(body)) {
    const trackId = field(result, 'trackId')
    const title = nameOf(field(result, 'trackName'))
    const artist = nameOf(field(result, 'artistName'))
    if (field(result, 'kind') !== 'song' || typeof trackId !== 'number') continue
    if (title === undefined || artist === undefined) continue
    const song: ItunesSong = { trackId, title, artist }
    const album = nameOf(field(result, 'collectionName'))
    if (album !== undefined) song.album = album
    const ms = field(result, 'trackTimeMillis')
    if (typeof ms === 'number' && Number.isFinite(ms) && ms > 0) song.durationMs = Math.round(ms)
    const artworkUrl = artworkUrlOf(result)
    if (artworkUrl !== undefined) song.artworkUrl = artworkUrl
    songs.push(song)
  }
  return songs
}

/** Reads an album search's answer, keeping only albums. */
export function parseAlbums(body: unknown): ItunesAlbum[] {
  const albums: ItunesAlbum[] = []
  for (const result of resultsOf(body)) {
    const collectionId = field(result, 'collectionId')
    const name = nameOf(field(result, 'collectionName'))
    const artist = nameOf(field(result, 'artistName'))
    if (field(result, 'wrapperType') !== 'collection' || typeof collectionId !== 'number') continue
    if (name === undefined || artist === undefined) continue
    const album: ItunesAlbum = { collectionId, name, artist }
    const artworkUrl = artworkUrlOf(result)
    if (artworkUrl !== undefined) album.artworkUrl = artworkUrl
    albums.push(album)
  }
  return albums
}

/** The longest and shortest time FXM keeps an answer, whatever Apple's headers say. */
const MIN_TTL_MS = 3_600_000
const MAX_TTL_MS = 24 * 3_600_000

/** Creates an {@link ItunesClient}. Share one instance, so that its pacing and cache hold. */
export function createItunesClient(options: ItunesOptions = {}): ItunesClient {
  const searchUrl = options.searchUrl ?? ITUNES_SEARCH_URL
  const timeoutMs = options.timeoutMs ?? 10_000
  const defaultTtlMs = options.cacheTtlMs ?? 24 * 3_600_000
  const gate = new RequestGate({
    service: SERVICE,
    minIntervalMs: 0,
    window: { max: options.maxPerMinute ?? 20, ms: 60_000 },
    maxWaitMs: options.maxWaitMs ?? 60_000,
  })
  const cache = new TtlCache<unknown>({ maxEntries: 500 })

  /** The answer to one search, from the cache or in its turn. */
  async function search(
    entity: 'song' | 'album',
    term: string,
    ctx: ProviderContext,
    { limit = 10, country }: ItunesSearchOptions,
  ): Promise<unknown> {
    const store = [country, ctx.region, DEFAULT_ITUNES_COUNTRY].find(
      (code) => code !== undefined && /^[a-z]{2}$/iu.test(code),
    )
    const params = new URLSearchParams({
      term: term.replace(/\s+/gu, ' ').trim(),
      country: (store ?? DEFAULT_ITUNES_COUNTRY).toUpperCase(),
      media: 'music',
      entity,
      limit: String(Math.min(200, Math.max(1, Math.round(limit)))),
    })
    const url = new URL(searchUrl)
    url.search = params.toString()
    const key = url.href
    const hit = cache.get(key)
    if (hit !== undefined) return hit
    return gate.run(ctx.signal, async (ready) => {
      const queued = cache.get(key)
      if (queued !== undefined) return queued
      await ready()
      const response = await getText(ctx, key, { service: SERVICE, timeoutMs, maxBytes: 2_000_000 })
      const { status, headers } = response
      // Apple documents no error for its limit; 403 and 429 are both taken as "slow down".
      if (status === 403 || status === 429) {
        const delayMs = retryAfterMs(headers.get('retry-after'), 60_000)
        throw rateLimited(SERVICE, gate.backOff(delayMs, true))
      }
      if (status !== 200) {
        throw new FxmError('Unavailable', `iTunes Search answered with HTTP ${status}`)
      }
      const body = parseJson(response, SERVICE)
      resultsOf(body)
      const ttlMs = maxAgeMs(headers.get('cache-control')) ?? defaultTtlMs
      cache.set(key, body, Math.min(MAX_TTL_MS, Math.max(MIN_TTL_MS, ttlMs)))
      return body
    })
  }

  return {
    async searchSongs(term, ctx, options = {}) {
      if (term.trim() === '') return []
      return parseSongs(await search('song', term, ctx, options))
    },
    async searchAlbums(term, ctx, options = {}) {
      if (term.trim() === '') return []
      return parseAlbums(await search('album', term, ctx, options))
    },
  }
}
