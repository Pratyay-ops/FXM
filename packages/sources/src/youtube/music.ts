/**
 * The `ytm` provider: YouTube Music's catalog (search, suggestions, tracks, albums, artists and
 * playlists) and its radio, through InnerTube's `WEB_REMIX` client.
 *
 * @module
 */

import {
  type Album,
  type Artist,
  applyModeFilter,
  type CatalogMode,
  type EntityId,
  FxmError,
  filterPlayable,
  formatId,
  isFxmError,
  isTrackSeed,
  isVideoKind,
  type MetadataProvider,
  type Page,
  type PageOptions,
  type Playlist,
  type ProviderContext,
  parseId,
  type RadioSeed,
  type RecommendationProvider,
  type SearchOptions,
  type SearchType,
  songForVideo,
  type Track,
} from '@fxm/core'
import { nativeOf, type TypeSearch, YouTubeCatalog } from './catalog'
import type { MusicSearchFilter } from './config'
import { decodeCursor, encodeCursor, seenField, seenIds } from './cursor'
import { isYouTubeId, nativeYouTubeId, PLAYLIST_BROWSE_PREFIX } from './ids'
import { onAlbum, parseAlbumPage } from './parse/album'
import type { Item, TrackRow } from './parse/items'
import { parsePlaylistContinuation, parsePlaylistPage } from './parse/playlist'
import { parseQueue, parseQueueContinuation, type QueuePage } from './parse/queue'
import { parseMusicSearch } from './parse/search'
import { createYouTubeSession, type YouTubeProviderOptions, type YouTubeSession } from './session'

/** YouTube Music as a metadata and recommendation provider. */
export interface YouTubeMusicProvider extends MetadataProvider, RecommendationProvider {
  /** Always `ytm`. */
  readonly id: 'ytm'
  /** The session it calls YouTube through. */
  readonly session: YouTubeSession
  suggest(query: string, ctx: ProviderContext): Promise<string[]>
  getPlaylistTracks(
    id: EntityId<'playlist'>,
    options: PageOptions,
    ctx: ProviderContext,
  ): Promise<Page<Track>>
  /**
   * The radio one page at a time (see `RecommendationProvider.radioPage`). A page holds what
   * one YouTube page brings (about 50 tracks on the first), or `limit` of them; the next page
   * goes on with the rest. Pages never return the seed, nor a track of the last 200 they
   * returned. A cursor belongs to its seed and catalog mode.
   */
  radioPage(seed: RadioSeed, options: PageOptions, ctx: ProviderContext): Promise<Page<Track>>
}

/** The search filter of each result type. */
const FILTERS: Readonly<Record<SearchType, MusicSearchFilter>> = {
  track: 'songs',
  video: 'videos',
  album: 'albums',
  artist: 'artists',
  playlist: 'playlists',
}

/** The cursor key of a track radio: this prefix and the seed's videoId. */
const TRACK_KEY = 'track:'

/** At most this many pages of an album's audio playlist are read (100 rows each). */
const MAX_AUDIO_PLAYLIST_PAGES = 5

/** What the radio starts from. */
interface RadioStart {
  /** `track:<videoId>` or `artist:<channelId>`, for the cursor. */
  readonly key: string
  /** The `next` payload of the first page. */
  readonly payload: Readonly<Record<string, string>>
}

/**
 * Creates the `ytm` provider. Pass the device's `session` to share one visitorData with the
 * other YouTube providers (see `createYouTubeProviders`).
 *
 * - **Search** asks YouTube Music for one filtered search per type: songs (`ATV` only) go to
 *   `tracks`, official videos and other videos to `videos`, which is empty in Music mode.
 * - **Albums**, in Music mode, take their tracks from the album's audio playlist (`browse
 *   VL` + `OLAK5uy_…`), so they are the album's songs even where the album page lists official
 *   videos; anonymous `next` over that playlist would return the videos. In Music + Video mode
 *   the album page's own rows are the tracks, and its official videos link their songs
 *   (`songId`), read from each row's "View song credits" item (`MPTC<videoId>`) and, failing
 *   that, from the same position of the audio playlist. When the audio playlist cannot be read,
 *   the album page's rows stand in for it.
 * - **Radio** is `next` with `RDAMVM<videoId>`, paged and without repeats. In Music mode it starts
 *   from a song (an official video's linked song) and keeps only songs.
 *
 * Every list goes through the catalog-mode filter, and every failure is an `FxmError`.
 */
export function createYouTubeMusicProvider(
  options: YouTubeProviderOptions = {},
): YouTubeMusicProvider {
  const session = options.session ?? createYouTubeSession(options)
  const catalog = new YouTubeCatalog({ source: 'ytm', session, videosOnly: false })
  const { config } = session

  const searchType: TypeSearch = (type, query, ctx, page) => {
    if (type === 'video' && ctx.mode === 'music') return Promise.resolve({ items: [] })
    if (query === '' && page.continuation === undefined) return Promise.resolve({ items: [] })
    const read = async (continuation: string | undefined) => {
      const payload =
        continuation === undefined
          ? { query, params: config.search.music[FILTERS[type]] }
          : { continuation }
      return parseMusicSearch(
        await catalog.call(ctx, 'music', 'search', payload),
        catalog.mapOf(ctx),
      )
    }
    const request = { type, query, ...page }
    switch (type) {
      case 'track':
      case 'video':
        return catalog.searchPage(read, (items) => searchTracks(items, type, ctx), request, ctx)
      case 'album':
        return catalog.searchPage(read, (items) => pick(items, 'album'), request, ctx)
      case 'artist':
        return catalog.searchPage(read, (items) => pick(items, 'artist'), request, ctx)
      case 'playlist':
        return catalog.searchPage(read, (items) => pick(items, 'playlist'), request, ctx)
    }
  }

  async function audioPlaylistRows(playlistId: string, ctx: ProviderContext): Promise<TrackRow[]> {
    const id = formatId('ytm', 'playlist', playlistId)
    const map = catalog.mapOf(ctx)
    const first = parsePlaylistPage(
      await catalog.browse(ctx, { browseId: `${PLAYLIST_BROWSE_PREFIX}${playlistId}` }),
      id,
      map,
    )
    const rows = [...first.rows]
    let continuation = first.continuation
    for (let page = 1; continuation !== undefined && page < MAX_AUDIO_PLAYLIST_PAGES; page++) {
      const next = parsePlaylistContinuation(await catalog.browse(ctx, { continuation }), map)
      rows.push(...next.rows)
      continuation = next.continuation
    }
    return rows
  }

  /**
   * The album's songs from its audio playlist, or none when the playlist cannot be read: the
   * album page's rows then stand in for it. The caller's cancellation, a bot check and a rate
   * limit still end the whole call, since every further request would meet them too.
   */
  async function albumSongs(
    playlistId: string,
    album: Album,
    ctx: ProviderContext,
  ): Promise<TrackRow[]> {
    try {
      const rows = await audioPlaylistRows(playlistId, ctx)
      return rows.filter((row) => row.track.kind === 'song').map((row) => onAlbum(row, album))
    } catch (error) {
      if (
        ctx.signal?.aborted ||
        isFxmError(error, 'BotCheck') ||
        isFxmError(error, 'RateLimited')
      ) {
        throw error
      }
      return []
    }
  }

  async function radioStart(seed: RadioSeed, ctx: ProviderContext): Promise<RadioStart> {
    if (!isTrackSeed(seed)) {
      const own = seed.id === undefined ? undefined : parseId(seed.id)
      if (own?.source !== 'ytm' && own?.source !== 'yt') {
        throw new FxmError(
          'Unsupported',
          `YouTube Music radio needs a YouTube artist: ${seed.name}`,
        )
      }
      const page = await catalog.artistPage(formatId('ytm', 'artist', own.nativeId), ctx)
      const playlistId = page.radio?.playlistId
      if (playlistId === undefined) {
        throw new FxmError('NotFound', `YouTube Music has no radio for ${seed.name}`)
      }
      return {
        key: `artist:${own.nativeId}`,
        payload: {
          playlistId,
          ...(page.radio?.videoId === undefined ? {} : { videoId: page.radio.videoId }),
          params: page.radio?.params ?? config.radio.params,
        },
      }
    }
    const videoId = seedVideoId(seed, ctx)
    return {
      key: `${TRACK_KEY}${videoId}`,
      payload: { videoId, playlistId: `RDAMVM${videoId}`, params: config.radio.params },
    }
  }

  /**
   * The YouTube page of a radio that a cursor names: a page a `limit` split, if it is still
   * kept; else the continuation; else the first page again, from the seed.
   */
  async function radioQueue(
    seed: RadioSeed,
    key: string,
    continuation: string | undefined,
    ctx: ProviderContext,
  ): Promise<QueuePage> {
    const kept = catalog.radioPages.get(catalog.pageKey(ctx, 'radio', key, continuation))
    if (kept !== undefined) return kept
    if (continuation !== undefined) {
      const json = await catalog.call(ctx, 'music', 'next', { continuation })
      return parseQueueContinuation(json, catalog.mapOf(ctx))
    }
    const start = await radioStart(seed, ctx)
    return parseQueue(await catalog.call(ctx, 'music', 'next', start.payload), catalog.mapOf(ctx))
  }

  const provider: YouTubeMusicProvider = {
    id: 'ytm',
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
        const browseId = nativeYouTubeId(id, 'album')
        const page = parseAlbumPage(
          await catalog.browse(ctx, { browseId }),
          formatId('ytm', 'album', browseId),
          catalog.mapOf(ctx),
        )
        const unlinked = page.rows.some(
          (row) => row.track.kind === 'music-video' && creditedSong(row) === undefined,
        )
        const needsSongs = ctx.mode === 'music' || unlinked || page.rows.length === 0
        const songs =
          page.audioPlaylistId !== undefined && needsSongs
            ? await albumSongs(page.audioPlaylistId, page.album, ctx)
            : []
        const useSongs = songs.length > 0 && (ctx.mode === 'music' || page.rows.length === 0)
        const tracks = useSongs
          ? numbered(songs, page.rows)
          : numbered(linkSongs(page.rows, songs), page.rows)
        return {
          ...page.album,
          trackCount: page.album.trackCount ?? Math.max(page.rows.length, songs.length),
          tracks: applyModeFilter(tracks, ctx.mode),
        }
      })
    },

    getArtist(id, ctx) {
      return catalog.run(ctx, id, async () => {
        const { artist, videos } = await catalog.artistPage(id, ctx)
        const top = artist.topTracks ?? (videos.length > 0 ? videos : undefined)
        return {
          ...artist,
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

    async radio(seed, ctx) {
      return (await provider.radioPage(seed, {}, ctx)).items
    },

    radioPage(seed, pageOptions, ctx) {
      const what = isTrackSeed(seed) ? seed.id : (seed.id ?? seed.name)
      return catalog.run(ctx, `the radio for ${what}`, async () => {
        let key: string
        let seen: string[]
        let continuation: string | undefined
        let queue: QueuePage
        if (pageOptions.cursor === undefined) {
          const start = await radioStart(seed, ctx)
          key = start.key
          seen = []
          continuation = undefined
          const json = await catalog.call(ctx, 'music', 'next', start.payload)
          queue = parseQueue(json, catalog.mapOf(ctx))
        } else {
          const cursor = decodeCursor(pageOptions.cursor, 'radio')
          if (cursor.s !== radioKey(seed, ctx)) {
            throw new FxmError('NotFound', 'The cursor belongs to another radio')
          }
          key = cursor.s
          seen = seenIds(cursor)
          continuation = cursor.c
          queue = await radioQueue(seed, key, continuation, ctx)
        }
        // The page's tracks that are not the seed and that no earlier page returned, once each.
        const taken = new Set(seen)
        if (key.startsWith(TRACK_KEY)) taken.add(key.slice(TRACK_KEY.length))
        const fresh: Track[] = []
        for (const track of filterPlayable(queue.tracks, ctx.mode)) {
          const videoId = nativeOf(track.id)
          if (taken.has(videoId)) continue
          taken.add(videoId)
          fresh.push(track)
        }
        const limit = pageOptions.limit
        const items = limit !== undefined && limit > 0 ? fresh.slice(0, limit) : fresh
        const returned = seenField([...seen, ...items.map((track) => nativeOf(track.id))])
        let nextCursor: string | undefined
        if (items.length < fresh.length) {
          // The limit split the page: the next page reads it again and goes on with the rest.
          catalog.radioPages.set(catalog.pageKey(ctx, 'radio', key, continuation), queue)
          nextCursor = encodeCursor({
            k: 'radio',
            s: key,
            ...(continuation === undefined ? {} : { c: continuation }),
            seen: returned,
          })
        } else if (queue.continuation !== undefined) {
          nextCursor = encodeCursor({ k: 'radio', s: key, c: queue.continuation, seen: returned })
        }
        return { items, ...(nextCursor === undefined ? {} : { nextCursor }) }
      })
    },
  }
  return provider
}

/** The songs (for `track`) or the videos (for `video`) among search items, in the mode. */
function searchTracks(
  items: readonly Item[],
  type: 'track' | 'video',
  ctx: ProviderContext,
): Track[] {
  const tracks = items.flatMap((item) => (item.type === 'track' ? [item.row.track] : []))
  const wanted = tracks.filter((track) =>
    type === 'track' ? track.kind === 'song' : isVideoKind(track.kind),
  )
  return applyModeFilter(wanted, ctx.mode)
}

function pick(items: readonly Item[], type: 'album'): Album[]
function pick(items: readonly Item[], type: 'artist'): Artist[]
function pick(items: readonly Item[], type: 'playlist'): Playlist[]
function pick(items: readonly Item[], type: 'album' | 'artist' | 'playlist'): unknown[] {
  const picked: unknown[] = []
  for (const item of items) {
    if (item.type !== type) continue
    if (item.type === 'album') picked.push(item.album)
    else if (item.type === 'artist') picked.push(item.artist)
    else if (item.type === 'playlist') picked.push(item.playlist)
  }
  return picked
}

/** The song an album row's "View song credits" item names, unless it is the row itself. */
function creditedSong(row: TrackRow): string | undefined {
  const own = nativeOf(row.track.id)
  return row.credits !== undefined && row.credits !== own ? row.credits : undefined
}

/**
 * The album page's rows, each official video linked to its song (`songId`): the song its
 * credits item names, else the song at the same position of the audio playlist when both lists
 * have the same length. Never a link to the video itself.
 */
export function linkSongs(rows: readonly TrackRow[], songs: readonly TrackRow[]): TrackRow[] {
  const aligned = songs.length === rows.length
  return rows.map((row, index) => {
    if (row.track.kind !== 'music-video') return row
    const own = nativeOf(row.track.id)
    const positional = aligned ? songs[index]?.track : undefined
    const song =
      creditedSong(row) ??
      (positional?.kind === 'song' && nativeOf(positional.id) !== own
        ? nativeOf(positional.id)
        : undefined)
    if (song === undefined || !isYouTubeId('track', song)) return row
    return { ...row, track: { ...row.track, songId: formatId('ytm', 'track', song) } }
  })
}

/**
 * The tracks of rows with their track numbers: the album page's index column at the same
 * position when the lists line up, else the position.
 */
function numbered(rows: readonly TrackRow[], pageRows: readonly TrackRow[]): Track[] {
  const aligned = pageRows.length === rows.length
  return rows.map((row, index) => {
    const number = row.index ?? (aligned ? pageRows[index]?.index : undefined) ?? index + 1
    return { ...row.track, trackNumber: number }
  })
}

/**
 * The videoId of a track seed in YouTube's ID space: its own, or for a track of another source
 * its external ID. In Music mode only its YouTube Music song (`externalIds.ytm`) counts, since a
 * radio from a plain YouTube video plays videos.
 */
function youTubeVideoId(seed: Track, mode: CatalogMode): string | undefined {
  const own = parseId(seed.id)
  if (own.source === 'ytm' || own.source === 'yt') return own.nativeId
  return mode === 'music' ? seed.externalIds?.ytm : (seed.externalIds?.ytm ?? seed.externalIds?.yt)
}

/**
 * The videoId a track radio starts from. In Music mode it must be a song: an official video
 * starts from the song it links (`songForVideo`), a track of another source from its YouTube
 * Music song, and anything else is refused, because radio from a video plays videos (measured:
 * 50 of 50).
 *
 * @throws FxmError `Unsupported` for an episode, a seed with no YouTube ID, and in Music mode for
 * a music video without a song link, any other video, and a track of another source that names
 * only a plain YouTube video.
 */
function seedVideoId(seed: Track, ctx: ProviderContext): string {
  if (seed.kind === 'episode') {
    throw new FxmError('Unsupported', 'A radio cannot start from a podcast episode')
  }
  const songFirst = `In Music mode a radio starts from a song: map "${seed.title}" to its song first`
  let videoId: string | undefined
  if (ctx.mode === 'music' && seed.kind !== 'song') {
    const song = songForVideo(seed)
    const parts = song === undefined ? undefined : parseId(song)
    if (parts === undefined || (parts.source !== 'ytm' && parts.source !== 'yt')) {
      throw new FxmError('Unsupported', songFirst)
    }
    videoId = parts.nativeId
  } else {
    videoId = youTubeVideoId(seed, ctx.mode)
    if (videoId === undefined && ctx.mode === 'music' && seed.externalIds?.yt !== undefined) {
      throw new FxmError('Unsupported', songFirst)
    }
  }
  if (!isYouTubeId('track', videoId)) {
    throw new FxmError('Unsupported', `"${seed.title}" has no YouTube video to start a radio from`)
  }
  return videoId
}

/** The cursor key of a seed, without any request. */
function radioKey(seed: RadioSeed, ctx: ProviderContext): string {
  if (isTrackSeed(seed)) return `${TRACK_KEY}${seedVideoId(seed, ctx)}`
  const own = seed.id === undefined ? undefined : parseId(seed.id)
  return `artist:${own?.nativeId ?? ''}`
}
