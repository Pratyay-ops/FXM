/**
 * What the `ytm` and `yt` providers share: calling InnerTube through the session, the pages that
 * both read from YouTube Music (tracks, playlists, artist pages, suggestions), video
 * descriptions, paging with cursors and limits, and the catalog-mode filter on every list.
 *
 * A page is cut to its `limit` first and filtered by the catalog mode after, so it may hold fewer
 * items than the limit, or none, and still have a `nextCursor`: only a missing `nextCursor` ends
 * a list. A YouTube page that a `limit` splits is kept for a while (see {@link SplitPages}), so
 * the provider pages that slice it cost one request between them.
 *
 * @module
 */

import {
  type Album,
  type Artist,
  applyModeFilter,
  type EntityId,
  FxmError,
  formatId,
  isFxmError,
  type Page,
  type PageOptions,
  type Playlist,
  type ProviderContext,
  parseId,
  type SearchOptions,
  type SearchResults,
  type SearchType,
  type Track,
} from '@fxm/core'
import { labelsFor } from './config'
import { decodeCursor, encodeCursor } from './cursor'
import { nativeYouTubeId, PLAYLIST_BROWSE_PREFIX, type YouTubeSource } from './ids'
import type { JsonRecord } from './json'
import { type ArtistPage, parseArtistPage } from './parse/artist'
import type { Item, MapOptions, TrackRow } from './parse/items'
import type { ListPage } from './parse/lists'
import { parsePlaylistContinuation, parsePlaylistPage } from './parse/playlist'
import { parseQueue, type QueuePage } from './parse/queue'
import { parseSuggestions } from './parse/suggestions'
import { parseDescription } from './parse/web'
import type { InnerTubeEndpoint } from './request'
import {
  assertYouTubeReachable,
  localeOf,
  type YouTubeClientId,
  type YouTubeSession,
} from './session'

/** The native ID inside an FXM ID, which `parseId` never fails on for a branded ID. */
export function nativeOf(id: EntityId): string {
  return parseId(id).nativeId
}

/** How many YouTube pages that a `limit` split a catalog keeps, of each kind. */
export const SPLIT_PAGES_KEPT = 8

/** How long a split YouTube page is kept, in milliseconds, counted from when it was read. */
export const SPLIT_PAGE_TTL_MS = 10 * 60_000

/**
 * Parsed YouTube pages that a `limit` split, so that the provider pages after the first that
 * slice one cost no request and show the same items. A page is kept for
 * {@link SPLIT_PAGE_TTL_MS}, and only the {@link SPLIT_PAGES_KEPT} most recently used are; a
 * page that is gone is read again.
 */
export class SplitPages<T> {
  readonly #pages = new Map<string, { readonly page: T; readonly readAt: number }>()

  /** The page kept under `key`, if it is still fresh. */
  get(key: string): T | undefined {
    const entry = this.#pages.get(key)
    if (entry === undefined) return undefined
    this.#pages.delete(key)
    if (Date.now() - entry.readAt > SPLIT_PAGE_TTL_MS) return undefined
    this.#pages.set(key, entry)
    return entry.page
  }

  /** Keeps `page` under `key`, forgetting the least recently used pages beyond the limit. */
  set(key: string, page: T): void {
    this.#pages.delete(key)
    this.#pages.set(key, { page, readAt: Date.now() })
    for (const oldest of this.#pages.keys()) {
      if (this.#pages.size <= SPLIT_PAGES_KEPT) break
      this.#pages.delete(oldest)
    }
  }
}

/** A slice of one YouTube page, and where the next page starts. */
export interface Slice<T> {
  /** The items of this page. */
  readonly items: T[]
  /**
   * Where the next page starts: the same YouTube page further on (`offset`), or the next YouTube
   * page (`continuation`), or nothing on the last page.
   */
  readonly next?: { readonly continuation?: string; readonly offset?: number }
}

/**
 * The part of a YouTube page that a provider page returns: `limit` items from `offset` on, so
 * that a page split by a small `limit` loses nothing; the next YouTube page once this one is
 * used up.
 */
export function slicePage<T>(
  items: readonly T[],
  offset: number,
  limit: number | undefined,
  continuation: string | undefined,
  thisPage: string | undefined,
): Slice<T> {
  const rest = items.slice(offset)
  if (limit !== undefined && limit > 0 && rest.length > limit) {
    return {
      items: rest.slice(0, limit),
      next: {
        offset: offset + limit,
        ...(thisPage === undefined ? {} : { continuation: thisPage }),
      },
    }
  }
  return {
    items: rest,
    ...(continuation === undefined ? {} : { next: { continuation } }),
  }
}

/** A page of search results of any type. */
export type ResultPage = Page<Track> | Page<Album> | Page<Artist> | Page<Playlist>

/** Which YouTube page of a search to read, and which part of it. */
export interface SearchPageRequest {
  /** The continuation token of the YouTube page; absent for the first page. */
  readonly continuation?: string
  /** How many items of that page earlier pages returned. */
  readonly offset?: number
  /** At most this many items. */
  readonly limit?: number
}

/** Searches one result type: a provider's own part of `search`. */
export type TypeSearch = (
  type: SearchType,
  query: string,
  ctx: ProviderContext,
  page: SearchPageRequest,
) => Promise<ResultPage>

/** The results of a search, from the page of each type. */
export function searchResults(
  pages: readonly (readonly [SearchType, ResultPage])[],
): SearchResults {
  const results: SearchResults = {}
  for (const [type, page] of pages) {
    if (type === 'track') results.tracks = page as Page<Track>
    else if (type === 'video') results.videos = page as Page<Track>
    else if (type === 'album') results.albums = page as Page<Album>
    else if (type === 'artist') results.artists = page as Page<Artist>
    else if (type === 'playlist') results.playlists = page as Page<Playlist>
  }
  return results
}

const SEARCH_TYPES: readonly SearchType[] = ['track', 'video', 'album', 'artist', 'playlist']

/** One YouTube page of a playlist's rows, with the playlist itself on its first page. */
interface PlaylistPart {
  /** The playlist, on the first YouTube page only (a continuation does not describe it). */
  readonly playlist?: Playlist
  /** The page's rows, in order. */
  readonly rows: TrackRow[]
  /** The continuation token of the next YouTube page, if there is one. */
  readonly continuation?: string
}

/** How a catalog reads YouTube. */
export interface CatalogOptions {
  /** The source of its IDs. */
  readonly source: YouTubeSource
  /** The device's session. */
  readonly session: YouTubeSession
  /** Whether every track is a video (plain YouTube). */
  readonly videosOnly: boolean
}

/** The shared half of the `ytm` and `yt` providers. */
export class YouTubeCatalog {
  readonly source: YouTubeSource
  readonly session: YouTubeSession
  /** Radio pages that a `limit` split, for the `ytm` provider's radio. */
  readonly radioPages = new SplitPages<QueuePage>()
  readonly #videosOnly: boolean
  readonly #searchPages = new SplitPages<ListPage>()
  readonly #playlistPages = new SplitPages<PlaylistPart>()

  constructor(options: CatalogOptions) {
    this.source = options.source
    this.session = options.session
    this.#videosOnly = options.videosOnly
  }

  /** How the items of a call's answers are mapped: with the labels of the call's language. */
  mapOf(ctx: ProviderContext): MapOptions {
    return {
      source: this.source,
      labels: labelsFor(this.session.config, localeOf(ctx).hl),
      videosOnly: this.#videosOnly,
    }
  }

  /** The key of a split page: what it is, in the call's language and region. */
  pageKey(ctx: ProviderContext, ...parts: readonly (string | undefined)[]): string {
    const { hl, gl } = localeOf(ctx)
    return JSON.stringify([hl, gl ?? '', ...parts.map((part) => part ?? '')])
  }

  /**
   * Runs a provider operation: fails fast with `Unsupported` where YouTube is unreachable, and
   * turns any failure that is not already an `FxmError` (or the caller's cancellation) into a
   * `Parse` error, so every rejection is an `FxmError`.
   */
  async run<T>(ctx: ProviderContext, what: string, operation: () => Promise<T>): Promise<T> {
    assertYouTubeReachable(ctx)
    try {
      return await operation()
    } catch (error) {
      if (isFxmError(error) || ctx.signal?.aborted) throw error
      throw new FxmError('Parse', `Could not read YouTube's answer to ${what}`, { cause: error })
    }
  }

  /** Calls an endpoint as `client`. */
  call(
    ctx: ProviderContext,
    client: YouTubeClientId,
    endpoint: InnerTubeEndpoint,
    payload: JsonRecord,
  ): Promise<JsonRecord> {
    return this.session.call(ctx, client, endpoint, payload)
  }

  /** A YouTube Music browse page. */
  browse(ctx: ProviderContext, payload: JsonRecord): Promise<JsonRecord> {
    return this.call(ctx, 'music', 'browse', payload)
  }

  /** One track, from YouTube Music's `next` for its video. */
  async track(id: EntityId<'track'>, ctx: ProviderContext): Promise<Track> {
    const videoId = nativeYouTubeId(id, 'track')
    const json = await this.call(ctx, 'music', 'next', { videoId })
    const track = parseQueue(json, this.mapOf(ctx)).tracks.find(
      (item) => nativeOf(item.id) === videoId,
    )
    if (track === undefined) throw new FxmError('NotFound', `YouTube has no video ${videoId}`)
    return track
  }

  /**
   * The description under a video (see `parseDescription`), from plain YouTube's watch page:
   * one `next` request with the `WEB` client. `undefined` when it has none.
   */
  async description(id: EntityId<'track'>, ctx: ProviderContext): Promise<string | undefined> {
    const videoId = nativeYouTubeId(id, 'track')
    return parseDescription(await this.call(ctx, 'web', 'next', { videoId }))
  }

  /** An artist or channel page. */
  async artistPage(id: EntityId<'artist'>, ctx: ProviderContext): Promise<ArtistPage> {
    const channelId = nativeYouTubeId(id, 'artist')
    const json = await this.browse(ctx, { browseId: channelId })
    return parseArtistPage(json, formatId(this.source, 'artist', channelId), this.mapOf(ctx))
  }

  /** The tracks of rows, in the context's mode. */
  tracksOf(rows: readonly TrackRow[], ctx: ProviderContext): Track[] {
    return applyModeFilter(
      rows.map((row) => row.track),
      ctx.mode,
    )
  }

  /** A playlist with its first page of tracks. */
  async playlist(id: EntityId<'playlist'>, ctx: ProviderContext): Promise<Playlist> {
    const playlistId = nativeYouTubeId(id, 'playlist')
    const { playlist, tracks } = await this.playlistPage(playlistId, {}, ctx)
    if (playlist === undefined)
      throw new FxmError('Parse', `The playlist ${playlistId} has no page`)
    return { ...playlist, tracks }
  }

  /** A further page of a playlist's tracks; the first page without a cursor. */
  async playlistTracks(
    id: EntityId<'playlist'>,
    options: PageOptions,
    ctx: ProviderContext,
  ): Promise<Page<Track>> {
    return (await this.playlistPage(nativeYouTubeId(id, 'playlist'), options, ctx)).tracks
  }

  /** Reads one YouTube page of a playlist: the first without a continuation. */
  async #readPlaylist(
    playlistId: string,
    continuation: string | undefined,
    ctx: ProviderContext,
  ): Promise<PlaylistPart> {
    if (continuation === undefined) {
      const json = await this.browse(ctx, { browseId: `${PLAYLIST_BROWSE_PREFIX}${playlistId}` })
      const fxmId = formatId(this.source, 'playlist', playlistId)
      return parsePlaylistPage(json, fxmId, this.mapOf(ctx))
    }
    return parsePlaylistContinuation(await this.browse(ctx, { continuation }), this.mapOf(ctx))
  }

  /**
   * A page of a playlist's tracks, and the playlist itself when the page is its first YouTube
   * page (a continuation page does not describe the playlist).
   */
  async playlistPage(
    playlistId: string,
    options: PageOptions,
    ctx: ProviderContext,
  ): Promise<{ playlist?: Playlist; tracks: Page<Track> }> {
    const cursor =
      options.cursor === undefined ? undefined : decodeCursor(options.cursor, 'playlist')
    if (cursor !== undefined && cursor.p !== playlistId) {
      throw new FxmError('NotFound', 'The cursor belongs to another playlist')
    }
    const offset = cursor?.o ?? 0
    const key = this.pageKey(ctx, 'playlist', playlistId, cursor?.c)
    const part =
      (offset > 0 ? this.#playlistPages.get(key) : undefined) ??
      (await this.#readPlaylist(playlistId, cursor?.c, ctx))
    const { playlist } = part
    const slice = slicePage(part.rows, offset, options.limit, part.continuation, cursor?.c)
    const next = slice.next
    if (next?.offset !== undefined) this.#playlistPages.set(key, part)
    const tracks: Page<Track> = {
      items: this.tracksOf(slice.items, ctx),
      ...(next === undefined
        ? {}
        : {
            nextCursor: encodeCursor({
              k: 'playlist',
              p: playlistId,
              ...(next.continuation === undefined ? {} : { c: next.continuation }),
              ...(next.offset === undefined ? {} : { o: next.offset }),
            }),
          }),
      ...(playlist?.trackCount === undefined ? {} : { total: playlist.trackCount }),
    }
    return playlist === undefined ? { tracks } : { playlist, tracks }
  }

  /**
   * `MetadataProvider.search`: one page per requested type, the types searched in parallel. With
   * a cursor it continues the one type and query the cursor belongs to.
   *
   * @throws FxmError `NotFound` for a cursor of another search, or a cursor with several types.
   */
  async search(
    query: string,
    options: SearchOptions,
    ctx: ProviderContext,
    searchType: TypeSearch,
  ): Promise<SearchResults> {
    const types = SEARCH_TYPES.filter((type) => options.types.includes(type))
    const trimmed = query.trim()
    const limit = options.limit === undefined ? {} : { limit: options.limit }
    if (options.cursor === undefined) {
      const pages = await Promise.all(
        types.map(async (type) => [type, await searchType(type, trimmed, ctx, limit)] as const),
      )
      return searchResults(pages)
    }
    const cursor = decodeCursor(options.cursor, 'search')
    if (types.length !== 1 || types[0] !== cursor.t || cursor.q !== trimmed) {
      throw new FxmError('NotFound', 'The cursor belongs to another search')
    }
    const page = await searchType(cursor.t, cursor.q, ctx, {
      ...(cursor.c === undefined ? {} : { continuation: cursor.c }),
      ...(cursor.o === undefined ? {} : { offset: cursor.o }),
      ...limit,
    })
    return searchResults([[cursor.t, page]])
  }

  /** Query completions from YouTube Music. */
  async suggestions(query: string, ctx: ProviderContext): Promise<string[]> {
    const input = query.trim()
    if (input === '') return []
    const json = await this.call(ctx, 'music', 'music/get_search_suggestions', { input })
    return parseSuggestions(json)
  }

  /**
   * One page of search results of one type: the YouTube page that `continuation` names (the
   * first page without one), sliced by `offset` and `limit`, with the items `select` keeps. A
   * YouTube page that the `limit` splits is kept, so its next slices cost no request.
   */
  async searchPage<T>(
    read: (continuation: string | undefined) => Promise<ListPage>,
    select: (items: readonly Item[]) => T[],
    request: SearchPageRequest & { readonly type: SearchType; readonly query: string },
    ctx: ProviderContext,
  ): Promise<Page<T>> {
    const offset = request.offset ?? 0
    const key = this.pageKey(ctx, 'search', request.type, request.query, request.continuation)
    const page =
      (offset > 0 ? this.#searchPages.get(key) : undefined) ?? (await read(request.continuation))
    const slice = slicePage(
      page.items,
      offset,
      request.limit,
      page.continuation,
      request.continuation,
    )
    const next = slice.next
    if (next?.offset !== undefined) this.#searchPages.set(key, page)
    return {
      items: select(slice.items),
      ...(next === undefined
        ? {}
        : {
            nextCursor: encodeCursor({
              k: 'search',
              t: request.type,
              q: request.query,
              ...(next.continuation === undefined ? {} : { c: next.continuation }),
              ...(next.offset === undefined ? {} : { o: next.offset }),
            }),
          }),
    }
  }
}
