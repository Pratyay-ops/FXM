/**
 * The import's one touch-point with the YouTube Music and YouTube providers of stage 1.3, which
 * had not merged when imports were written: reading YouTube playlists and tracks, and fetching
 * the YouTube Music searches the matching engine asks for.
 *
 * Everything else talks to {@link ImportYouTube}. Until 1.3 merges, the app passes
 * {@link YOUTUBE_IMPORT_UNAVAILABLE}, whose calls fail with `Unsupported`, so imports keep their
 * rows and wait; tests pass the fake in `./testing`. Once 1.3 has merged, the swap is:
 *
 * ```ts
 * import { createYouTubeProviders } from '@fxm/sources/youtube'
 *
 * const { music, video } = createYouTubeProviders({ session })
 * const youtube = createYouTubeImport({ music, video, topResult, releaseFacts })
 * ```
 *
 * where `topResult` and `releaseFacts` wrap 1.3's top-result card and description reads.
 *
 * @module
 */

import {
  type EntityId,
  FxmError,
  type MatchRequest,
  type MatchResponse,
  type MetadataProvider,
  type Page,
  type PageOptions,
  type Playlist,
  type ProviderContext,
  parseId,
  type ReleaseFacts,
  type ReleaseFactsKey,
  type Track,
} from '@fxm/core'

/** What imports need from YouTube Music and YouTube. */
export interface ImportYouTube {
  /** Loads a YouTube (`yt:`) or YouTube Music (`ytm:`) playlist with its first page of tracks. */
  getPlaylist(id: EntityId<'playlist'>, ctx: ProviderContext): Promise<Playlist>
  /** Loads a further page of a playlist's tracks, from the cursor of the page before. */
  getPlaylistTracks(
    id: EntityId<'playlist'>,
    options: PageOptions,
    ctx: ProviderContext,
  ): Promise<Page<Track>>
  /** Loads one track, e.g. a video link in an M3U file. */
  getTrack(id: EntityId<'track'>, ctx: ProviderContext): Promise<Track>
  /**
   * Fetches one page the matching engine asks for (see `runMatch` in `@fxm/core`): a response
   * of the request's kind, or `null` when this source cannot fetch that kind of page.
   */
  fetchMatchPage(request: MatchRequest, ctx: ProviderContext): Promise<MatchResponse | null>
}

/** A YouTube metadata provider, as far as imports use it. */
export type YouTubeImportProvider = Pick<MetadataProvider, 'search' | 'getPlaylist' | 'getTrack'> &
  Partial<Pick<MetadataProvider, 'getPlaylistTracks'>>

/** What {@link createYouTubeImport} builds on. */
export interface YouTubeImportProviders {
  /** YouTube Music (`ytm`): song and video searches, its playlists and tracks. */
  music: YouTubeImportProvider
  /** Plain YouTube (`yt`): its video search (Music + Video mode), playlists and videos. */
  video?: YouTubeImportProvider
  /** The top-result card of an unfiltered YouTube Music search, or `null` when there is none. */
  topResult?(query: string, ctx: ProviderContext): Promise<Track | null>
  /** What the descriptions of these candidates say about their releases. */
  releaseFacts?(
    trackIds: readonly EntityId<'track'>[],
    ctx: ProviderContext,
  ): Promise<Readonly<Record<ReleaseFactsKey, ReleaseFacts>>>
}

/** How many results a matching search reads: the engine scores about one page (ARCHITECTURE §12). */
export const MATCH_SEARCH_LIMIT = 20

/**
 * An {@link ImportYouTube} over core metadata providers: playlists and tracks from the provider
 * of their source (`ytm` or `yt`), song searches from YouTube Music in Music mode, the videos
 * filter and plain YouTube search in Music + Video mode. A page kind the providers cannot fetch
 * (no `topResult`, `releaseFacts` or `video` given) answers `null`, which the engine records as
 * skipped.
 */
export function createYouTubeImport(providers: YouTubeImportProviders): ImportYouTube {
  const { music, video } = providers
  const providerOf = (id: EntityId): YouTubeImportProvider => {
    if (parseId(id).source !== 'yt') return music
    if (video === undefined) {
      throw new FxmError('Unsupported', 'Plain YouTube is not available to imports')
    }
    return video
  }
  const songs = async (query: string, ctx: ProviderContext): Promise<readonly Track[]> => {
    const results = await music.search(
      query,
      { types: ['track'], limit: MATCH_SEARCH_LIMIT },
      { ...ctx, mode: 'music' },
    )
    return results.tracks?.items ?? []
  }
  const videos = async (
    provider: YouTubeImportProvider,
    query: string,
    ctx: ProviderContext,
  ): Promise<readonly Track[]> => {
    const results = await provider.search(
      query,
      { types: ['video'], limit: MATCH_SEARCH_LIMIT },
      { ...ctx, mode: 'all' },
    )
    return results.videos?.items ?? []
  }
  return {
    async getPlaylist(id, ctx) {
      return providerOf(id).getPlaylist(id, ctx)
    },
    async getPlaylistTracks(id, options, ctx) {
      const provider = providerOf(id)
      if (provider.getPlaylistTracks === undefined) return { items: [] }
      return provider.getPlaylistTracks(id, options, ctx)
    },
    async getTrack(id, ctx) {
      return providerOf(id).getTrack(id, ctx)
    },
    async fetchMatchPage(request, ctx) {
      switch (request.kind) {
        case 'isrc-songs':
        case 'text-songs':
        case 'album-songs':
          return { kind: request.kind, tracks: await songs(request.query, ctx) }
        case 'isrc-top-card':
          if (providers.topResult === undefined) return null
          return { kind: request.kind, card: await providers.topResult(request.query, ctx) }
        case 'release-facts':
          if (providers.releaseFacts === undefined) return null
          return { kind: request.kind, facts: await providers.releaseFacts(request.trackIds, ctx) }
        case 'videos':
          return { kind: request.kind, tracks: await videos(music, request.query, ctx) }
        case 'youtube':
          if (video === undefined) return null
          return { kind: request.kind, tracks: await videos(video, request.query, ctx) }
      }
    },
  }
}

/** Why {@link YOUTUBE_IMPORT_UNAVAILABLE} refuses. */
export const YOUTUBE_UNAVAILABLE_MESSAGE =
  'Finding songs on YouTube Music is not available in this version of FXM yet'

function unavailable(): never {
  throw new FxmError('Unsupported', YOUTUBE_UNAVAILABLE_MESSAGE)
}

/**
 * The stand-in until the YouTube providers (stage 1.3) are wired in: every call fails with an
 * `Unsupported` `FxmError`. Imports keep their rows and pause; nothing is lost.
 */
export const YOUTUBE_IMPORT_UNAVAILABLE: ImportYouTube = Object.freeze({
  getPlaylist: async () => unavailable(),
  getPlaylistTracks: async () => unavailable(),
  getTrack: async () => unavailable(),
  fetchMatchPage: async () => unavailable(),
})
