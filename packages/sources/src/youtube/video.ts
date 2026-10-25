/**
 * The `yt` provider: plain YouTube, for Music + Video mode. Every track it lists is a `video`,
 * so Music mode hides them all.
 *
 * - **Search:** videos, channels (as artists) and playlists, through InnerTube's `WEB` client.
 *   Plain YouTube has no songs or albums, so those types are empty pages.
 * - **Suggestions:** YouTube Music's, from InnerTube; YouTube's own come from a host outside
 *   InnerTube that no FXM transport reaches.
 * - **Tracks, channels and playlists:** read through YouTube Music's client, which serves every
 *   public video, channel and playlist, with plain YouTube's view on top: all videos, no albums.
 *
 * @module
 */

import {
  type Artist,
  applyModeFilter,
  type EntityId,
  FxmError,
  isVideoKind,
  type MetadataProvider,
  type Page,
  type PageOptions,
  type Playlist,
  type ProviderContext,
  type SearchOptions,
  type SearchType,
  type Track,
} from '@fxm/core'
import { type TypeSearch, YouTubeCatalog } from './catalog'
import type { WebSearchFilter } from './config'
import type { YouTubeProviderOptions } from './music'
import type { Item } from './parse/items'
import { parseWebSearch } from './parse/web'
import { createYouTubeSession, type YouTubeSession } from './session'

/** Plain YouTube as a metadata provider. */
export interface YouTubeVideoProvider extends MetadataProvider {
  /** Always `yt`. */
  readonly id: 'yt'
  /** The session it calls YouTube through. */
  readonly session: YouTubeSession
  suggest(query: string, ctx: ProviderContext): Promise<string[]>
  getPlaylistTracks(
    id: EntityId<'playlist'>,
    options: PageOptions,
    ctx: ProviderContext,
  ): Promise<Page<Track>>
}

/** The plain YouTube search filter of each type it has. */
const FILTERS: Readonly<Partial<Record<SearchType, WebSearchFilter>>> = {
  video: 'videos',
  artist: 'channels',
  playlist: 'playlists',
}

/** Creates the `yt` provider. Pass a shared `session` to use one visitorData for both. */
export function createYouTubeProvider(options: YouTubeProviderOptions = {}): YouTubeVideoProvider {
  const session = options.session ?? createYouTubeSession(options)
  const catalog = new YouTubeCatalog({ source: 'yt', session, videosOnly: true })
  const { config } = session

  const searchType: TypeSearch = (type, query, ctx, page) => {
    const filter = FILTERS[type]
    const nothing = filter === undefined || (type === 'video' && ctx.mode === 'music')
    if (nothing || (query === '' && page.continuation === undefined)) {
      return Promise.resolve({ items: [] })
    }
    const read = async (continuation: string | undefined) => {
      const payload =
        continuation === undefined ? { query, params: config.search.web[filter] } : { continuation }
      return parseWebSearch(await catalog.call(ctx, 'web', 'search', payload), catalog.map)
    }
    const request = { type, query, ...page }
    if (type === 'artist') return catalog.searchPage(read, (items) => artistsOf(items), request)
    if (type === 'playlist') return catalog.searchPage(read, (items) => playlistsOf(items), request)
    return catalog.searchPage(read, (items) => videosOf(items, ctx), request)
  }

  return {
    id: 'yt',
    session,

    search(query: string, searchOptions: SearchOptions, ctx: ProviderContext) {
      return catalog.run(ctx, `the search "${query}"`, () =>
        catalog.search(query, searchOptions, ctx, searchType),
      )
    },

    suggest(query, ctx) {
      return catalog.run(ctx, `suggestions for "${query}"`, () => catalog.suggestions(query, ctx))
    },

    getTrack(id, ctx) {
      return catalog.run(ctx, id, () => catalog.track(id, ctx))
    },

    getAlbum(id, ctx) {
      return catalog.run(ctx, id, async () => {
        throw new FxmError('NotFound', `Plain YouTube has no albums: ${id}`)
      })
    },

    getArtist(id, ctx) {
      return catalog.run(ctx, id, async () => {
        const { artist, videos } = await catalog.artistPage(id, ctx)
        const { albums: _albums, topTracks, ...channel } = artist
        const top = videos.length > 0 ? videos : topTracks
        return {
          ...channel,
          ...(top === undefined ? {} : { topTracks: applyModeFilter(top, ctx.mode) }),
        }
      })
    },

    getPlaylist(id, ctx) {
      return catalog.run(ctx, id, () => catalog.playlist(id, ctx))
    },

    getPlaylistTracks(id, pageOptions, ctx) {
      return catalog.run(ctx, id, () => catalog.playlistTracks(id, pageOptions, ctx))
    },
  }
}

function videosOf(items: readonly Item[], ctx: ProviderContext): Track[] {
  const videos = items.flatMap((item) =>
    item.type === 'track' && isVideoKind(item.row.track.kind) ? [item.row.track] : [],
  )
  return applyModeFilter(videos, ctx.mode)
}

function artistsOf(items: readonly Item[]): Artist[] {
  return items.flatMap((item) => (item.type === 'artist' ? [item.artist] : []))
}

function playlistsOf(items: readonly Item[]): Playlist[] {
  return items.flatMap((item) => (item.type === 'playlist' ? [item.playlist] : []))
}
