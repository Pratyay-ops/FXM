/**
 * What the `ytm` and `yt` providers share: calling InnerTube through the session, the pages that
 * both read from YouTube Music (tracks, playlists, artist pages, suggestions), paging with
 * cursors and limits, and the catalog-mode filter on every list.
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
import { decodeCursor, encodeCursor } from './cursor'
import { isAbort } from './errors'
import { nativeYouTubeId, PLAYLIST_BROWSE_PREFIX, type YouTubeSource } from './ids'
import type { JsonRecord } from './json'
import { type ArtistPage, parseArtistPage } from './parse/artist'
import type { Item, MapOptions, TrackRow } from './parse/items'
import type { ListPage } from './parse/lists'
import { parsePlaylistContinuation, parsePlaylistPage } from './parse/playlist'
import { parseQueue } from './parse/queue'
import { parseSuggestions } from './parse/suggestions'
import type { InnerTubeEndpoint } from './request'
import { assertYouTubeReachable, type YouTubeClientId, type YouTubeSession } from './session'

/** The native ID inside an FXM ID, which `parseId` never fails on for a branded ID. */
export function nativeOf(id: EntityId): string {
  return parseId(id).nativeId
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
  readonly map: MapOptions

  constructor(options: CatalogOptions) {
    this.source = options.source
    this.session = options.session
    this.map = {
      source: options.source,
      config: options.session.config,
      videosOnly: options.videosOnly,
    }
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
      if (isFxmError(error) || isAbort(error, ctx.signal)) throw error
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
    const track = parseQueue(json, this.map).tracks.find((item) => nativeOf(item.id) === videoId)
    if (track === undefined) throw new FxmError('NotFound', `YouTube has no video ${videoId}`)
    return track
  }

  /** An artist or channel page. */
  async artistPage(id: EntityId<'artist'>, ctx: ProviderContext): Promise<ArtistPage> {
    const channelId = nativeYouTubeId(id, 'artist')
    const json = await this.browse(ctx, { browseId: channelId })
    return parseArtistPage(json, formatId(this.source, 'artist', channelId), this.map)
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

  /**
   * A page of a playlist's tracks, and the playlist itself when the page is its first YouTube
   * page (a continuation page does not describe the playlist).
   */
  async playlistPage(
    playlistId: string,
    options: PageOptions,
    ctx: ProviderContext,
  ): Promise<{ playlist?: Playlist; tracks: Page<Track> }> {
    const fxmId = formatId(this.source, 'playlist', playlistId)
    const cursor =
      options.cursor === undefined ? undefined : decodeCursor(options.cursor, 'playlist')
    if (cursor !== undefined && cursor.p !== playlistId) {
      throw new FxmError('NotFound', 'The cursor belongs to another playlist')
    }
    let playlist: Playlist | undefined
    let rows: TrackRow[]
    let continuation: string | undefined
    if (cursor?.c === undefined) {
      const json = await this.browse(ctx, { browseId: `${PLAYLIST_BROWSE_PREFIX}${playlistId}` })
      const page = parsePlaylistPage(json, fxmId, this.map)
      playlist = page.playlist
      rows = page.rows
      continuation = page.continuation
    } else {
      const json = await this.browse(ctx, { continuation: cursor.c })
      const page = parsePlaylistContinuation(json, this.map)
      rows = page.rows
      continuation = page.continuation
    }
    const slice = slicePage(rows, cursor?.o ?? 0, options.limit, continuation, cursor?.c)
    const next = slice.next
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
   * first page without one), sliced by `offset` and `limit`, with the items `select` keeps.
   */
  async searchPage<T>(
    read: (continuation: string | undefined) => Promise<ListPage>,
    select: (items: readonly Item[]) => T[],
    request: SearchPageRequest & { readonly type: SearchType; readonly query: string },
  ): Promise<Page<T>> {
    const page = await read(request.continuation)
    const slice = slicePage(
      page.items,
      request.offset ?? 0,
      request.limit,
      page.continuation,
      request.continuation,
    )
    const next = slice.next
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
