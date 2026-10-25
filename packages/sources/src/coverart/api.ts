/**
 * The Cover Art Archive (`coverartarchive.org`), MusicBrainz's and the Internet Archive's
 * database of cover art, looked up by MusicBrainz release. It needs no key and
 * answers any origin (`Access-Control-Allow-Origin: *`), through redirects to `archive.org`, so it
 * works on every tier. See `CLEAN-ROOM.md` for where each fact comes from.
 *
 * @module
 */

import { type Artwork, FxmError, type ProviderContext } from '@fxm/core'
import { type PacedCallOptions, RequestGate } from '../shared/gate'
import { field, getText, parseJson, rateLimited, retryAfterMs } from '../shared/http'
import { requireMbid } from '../shared/mbid'
import { TtlCache } from '../shared/ttl-cache'

/** Where the Cover Art Archive lives. */
export const COVER_ART_ARCHIVE_ORIGIN = 'https://coverartarchive.org'

/** The thumbnail sizes the Cover Art Archive serves, in pixels along the longer side. */
export const COVER_ART_SIZES = [250, 500, 1200] as const

/** The service's name in error messages. */
const SERVICE = 'The Cover Art Archive'

/** Options for {@link createCoverArtClient}. All have defaults. */
export interface CoverArtOptions {
  /** Where the Cover Art Archive lives. Default {@link COVER_ART_ARCHIVE_ORIGIN}. */
  origin?: string
  /** Abort a request, body and redirects included, after this many milliseconds. Default 10,000. */
  timeoutMs?: number
  /**
   * The longest a call waits for its turn, counted from when it was made, before failing with
   * `RateLimited`. Default 10,000.
   */
  maxWaitMs?: number
  /** How long to keep the art found for a release. Default 24 hours. */
  cacheTtlMs?: number
  /** How long to remember that a release has no front cover. Default 6 hours. */
  missTtlMs?: number
}

/**
 * What a lookup takes besides the release: a `priority`, so that background work (`bulk`, such
 * as filling a list's artwork) never holds up the cover the user is looking at.
 */
export type CoverArtCallOptions = PacedCallOptions

/** Cover art lookups. */
export interface CoverArtClient {
  /**
   * The front cover of a MusicBrainz release (`mbid`, in any case), in the
   * {@link COVER_ART_SIZES}, smallest first. Empty when the release has no front cover.
   *
   * Rejects with a `RangeError`, without a request, when `mbid` is not a MusicBrainz ID, and with
   * an `FxmError`: `RateLimited` when the archive asks FXM to slow down or the call would wait
   * too long for its turn, `Network`, `Unavailable` for other HTTP errors and `Parse` for
   * answers FXM cannot read.
   */
  releaseArtwork(
    mbid: string,
    ctx: ProviderContext,
    options?: CoverArtCallOptions,
  ): Promise<Artwork[]>
}

/**
 * An image URL from the archive, on `https:`, or `undefined` when it points anywhere but the
 * archive's own hosts. The archive lists its images as `http://coverartarchive.org/…`, which
 * also answers on `https:`.
 */
export function coverArtUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return undefined
  }
  const host = url.hostname
  const archive =
    host === 'coverartarchive.org' || host === 'archive.org' || host.endsWith('.archive.org')
  if (!archive || (url.protocol !== 'http:' && url.protocol !== 'https:')) return undefined
  if (url.username !== '' || url.password !== '' || url.port !== '') return undefined
  url.protocol = 'https:'
  return url.href
}

/** Whether an image of the archive's listing is a front cover. */
function isFront(image: unknown): boolean {
  if (field(image, 'front') === true) return true
  const types = field(image, 'types')
  return Array.isArray(types) && types.includes('Front')
}

/**
 * Reads the archive's listing of a release (`{ images: [...] }`): the thumbnails of its front
 * cover, smallest first, preferring an approved image. Empty when there is no front cover.
 */
export function parseCoverArt(body: unknown): Artwork[] {
  const images = field(body, 'images')
  if (!Array.isArray(images)) {
    throw new FxmError('Parse', 'The Cover Art Archive sent a listing FXM does not understand')
  }
  const fronts = images.filter(isFront)
  const front = fronts.find((image) => field(image, 'approved') === true) ?? fronts[0]
  const thumbnails = field(front, 'thumbnails')
  const artwork: Artwork[] = []
  for (const size of COVER_ART_SIZES) {
    const alias = size === 250 ? 'small' : size === 500 ? 'large' : undefined
    const url =
      coverArtUrl(field(thumbnails, String(size))) ??
      (alias === undefined ? undefined : coverArtUrl(field(thumbnails, alias)))
    if (url !== undefined && !artwork.some((art) => art.url === url)) {
      artwork.push({ url, width: size })
    }
  }
  return artwork
}

/** Creates a {@link CoverArtClient}. Share one instance, so that its pacing and cache hold. */
export function createCoverArtClient(options: CoverArtOptions = {}): CoverArtClient {
  const origin = (options.origin ?? COVER_ART_ARCHIVE_ORIGIN).replace(/\/+$/u, '')
  const timeoutMs = options.timeoutMs ?? 10_000
  const ttlMs = options.cacheTtlMs ?? 24 * 3_600_000
  const missTtlMs = options.missTtlMs ?? 6 * 3_600_000
  // The archive publishes no rate limit; one request at a time keeps FXM a light client.
  const gate = new RequestGate({
    service: SERVICE,
    minIntervalMs: 0,
    maxWaitMs: options.maxWaitMs ?? 10_000,
  })
  const cache = new TtlCache<Artwork[]>({ maxEntries: 1_000 })

  async function releaseArtwork(
    release: string,
    ctx: ProviderContext,
    options: CoverArtCallOptions = {},
  ): Promise<Artwork[]> {
    const key = `release/${requireMbid(release)}`
    const hit = cache.get(key)
    if (hit !== undefined) return hit
    return gate.run(
      async (ready) => {
        const queued = cache.get(key)
        if (queued !== undefined) return queued
        await ready()
        const response = await getText(ctx, `${origin}/${key}`, {
          service: SERVICE,
          timeoutMs,
          maxBytes: 1_000_000,
        })
        const { status, headers } = response
        // 404: no art for this MBID. 400: the archive does not take the MBID.
        if (status === 404 || status === 400) {
          cache.set(key, [], missTtlMs)
          return []
        }
        if (status === 429 || status === 503) {
          const delayMs = retryAfterMs(headers.get('retry-after'), 10_000)
          throw rateLimited(SERVICE, gate.backOff(delayMs, true))
        }
        if (status !== 200) {
          throw new FxmError('Unavailable', `The Cover Art Archive answered with HTTP ${status}`)
        }
        const artwork = parseCoverArt(parseJson(response, SERVICE))
        cache.set(key, artwork, artwork.length === 0 ? missTtlMs : ttlMs)
        return artwork
      },
      { signal: ctx.signal, priority: options.priority },
    )
  }

  return { releaseArtwork }
}
