/**
 * The LRCLIB lyrics provider. See the README for the lookup order and what is sent.
 *
 * @module
 */

import {
  type Lyrics,
  type LyricsMetadata,
  type LyricsProvider,
  type ProviderContext,
  parseLrc,
  type Track,
} from '@fxm/core'
import { DEFAULT_LRCLIB_CLIENT, LRCLIB_ORIGIN, LrclibApi, type LrclibRecord } from './api'
import { bestMatch, hasLines, hasText, type LyricsQuery, queryFor, syncedFits } from './match'

/** The provider's ID, which is also the `source` of the lyrics it returns. */
export const LRCLIB_PROVIDER_ID = 'lrclib'

/** Options for {@link createLrclibProvider}. All have defaults. */
export interface LrclibOptions {
  /** The LRCLIB server, e.g. a self-hosted instance. Default {@link LRCLIB_ORIGIN}. */
  baseUrl?: string
  /**
   * How the app identifies itself in the `Lrclib-Client` header: name, version and a link.
   * Default {@link DEFAULT_LRCLIB_CLIENT}. A fork should name itself here.
   */
  client?: string
  /** Abort a request, body included, after this many milliseconds. Default 10,000. */
  timeoutMs?: number
  /**
   * Requests go one at a time, as LRCLIB asks; pause this many milliseconds between the end of
   * one and the start of the next (LRCLIB suggests 200-500 ms). Default 250.
   */
  minIntervalMs?: number
  /**
   * Wait at most this long for a `Retry-After` from a 503; fail with `RateLimited` instead when
   * LRCLIB asks for longer. Default 5,000.
   */
  maxWaitMs?: number
}

/** What the lyrics say about the record they came from. */
function metadataOf(record: LrclibRecord): LyricsMetadata {
  const metadata: LyricsMetadata = { title: record.trackName }
  if (record.artistName.trim() !== '') metadata.artist = record.artistName
  if (record.albumName !== undefined) metadata.album = record.albumName
  if (record.duration !== undefined) metadata.lengthMs = Math.round(record.duration * 1000)
  return metadata
}

/**
 * The lyrics in `record`: synced when `synced` allows it and the record has LRC that reads as
 * synced, else plain: `plainLyrics`, or else the LRC, with every line kept and any timestamps
 * dropped. `null` for an instrumental record or one without text.
 */
export function lyricsOf(record: LrclibRecord, synced: boolean): Lyrics | null {
  if (record.instrumental) return null
  let lyrics: Lyrics | null = null
  if (synced && hasText(record.syncedLyrics)) {
    // parseLrc reads LRC whose untimed text outnumbers its timed lines as plain.
    const parsed = parseLrc(record.syncedLyrics, LRCLIB_PROVIDER_ID)
    if (parsed.synced && hasLines(parsed)) lyrics = parsed
  }
  if (lyrics === null) {
    const text = hasText(record.plainLyrics) ? record.plainLyrics : (record.syncedLyrics ?? '')
    // These lyrics are not known to keep time with the track, so any timestamps go.
    lyrics = parseLrc(text, LRCLIB_PROVIDER_ID, { plain: true })
  }
  if (!hasLines(lyrics)) return null
  return { ...lyrics, metadata: { ...lyrics.metadata, ...metadataOf(record) } }
}

/**
 * A search for synced lyrics to replace plain ones. A failure keeps the plain lyrics, unless
 * the call was cancelled.
 */
async function syncedAlternative(
  api: LrclibApi,
  query: LyricsQuery,
  ctx: ProviderContext,
): Promise<Lyrics | null> {
  try {
    const best = bestMatch(query, await api.search(searchText(query), ctx))
    const lyrics = best?.content === 3 ? lyricsOf(best.record, true) : null
    return lyrics?.synced ? lyrics : null
  } catch (error) {
    if (ctx.signal?.aborted) throw error
    return null
  }
}

/** The `q` of a search: the main artist and the core title, which finds the most variants. */
function searchText(query: LyricsQuery): string {
  return `${query.artists[0] ?? ''} ${query.core}`.trim()
}

/**
 * Creates the LRCLIB {@link LyricsProvider}. It works on every platform without FXM Connect,
 * because LRCLIB allows any origin, and it uses only `ctx.fetch`.
 *
 * `getLyrics` looks a track up in up to three requests, preferring synced lyrics:
 *
 * 1. `GET /api/get` with the title, the artists, the album and the duration in seconds. An
 *    instrumental record means no lyrics (`null`). Synced lyrics are returned as they are;
 *    when the record only has plain lyrics, a search looks for synced ones of the same
 *    recording first.
 * 2. On a miss, `GET /api/search?q=<main artist> <core title>`, whose results are scored on
 *    title, artist and duration with the core text helpers (see `match.ts`). Synced lyrics are only
 *    used when the record's duration is within 2.5 s of the track's; otherwise its text comes
 *    back as plain lyrics, because the times would be off.
 * 3. `GET /api/get/<id>`, only when a search result comes without its lyrics. LRCLIB's search
 *    results carry them today (checked on 2026-10-25), so this is a fallback.
 *
 * One provider sends its requests one at a time, as LRCLIB asks, so concurrent calls queue up
 * in order; a call's `ctx.signal` takes it out of the queue.
 *
 * It returns `null` for a track without a title or an artist (without a request), when nothing
 * fits, and for instrumentals. It rejects with an `FxmError`: `RateLimited` (with
 * `retryAfterMs`) when LRCLIB asks to slow down, `Network` when it cannot be reached, breaks off
 * or times out, `Unavailable` for other HTTP errors and `Parse` for answers it cannot read. A
 * cancelled call rejects with the signal's reason.
 */
export function createLrclibProvider(options: LrclibOptions = {}): LyricsProvider {
  const api = new LrclibApi({
    baseUrl: options.baseUrl ?? LRCLIB_ORIGIN,
    client: options.client ?? DEFAULT_LRCLIB_CLIENT,
    timeoutMs: options.timeoutMs ?? 10_000,
    minIntervalMs: options.minIntervalMs ?? 250,
    maxWaitMs: options.maxWaitMs ?? 5_000,
  })
  return {
    id: LRCLIB_PROVIDER_ID,
    async getLyrics(track: Track, ctx: ProviderContext): Promise<Lyrics | null> {
      const query = queryFor(track)
      if (query === null) return null
      const exact = await api.get(
        {
          trackName: query.title,
          artistName: query.artists.join(', '),
          ...(query.album === undefined ? {} : { albumName: query.album }),
          ...(query.duration === undefined ? {} : { duration: query.duration }),
        },
        ctx,
      )
      if (exact !== null) {
        if (exact.instrumental) return null
        const fits = syncedFits(query, exact)
        if (fits && hasText(exact.syncedLyrics)) {
          const lyrics = lyricsOf(exact, true)
          if (lyrics?.synced) return lyrics
        }
        return (await syncedAlternative(api, query, ctx)) ?? lyricsOf(exact, fits)
      }
      const best = bestMatch(query, await api.search(searchText(query), ctx))
      if (best === null || best.content === 0) return null
      const record = best.content === 1 ? await api.getById(best.record.id, ctx) : best.record
      if (record === null) return null
      return lyricsOf(record, syncedFits(query, record))
    },
  }
}
