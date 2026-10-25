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
  type EntityId,
  FxmError,
  filterPlayable,
  formatId,
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
import { createYouTubeSession, type YouTubeSession, type YouTubeSessionOptions } from './session'

/** Options for {@link createYouTubeMusicProvider}. */
export interface YouTubeProviderOptions extends YouTubeSessionOptions {
  /**
   * The device's YouTube session, to share one visitorData with the other YouTube provider.
   * When absent, the provider creates its own from the other options.
   */
  session?: YouTubeSession
}

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

/** At most this many pages of an album's audio playlist are read (100 rows each). */
const MAX_AUDIO_PLAYLIST_PAGES = 5

/** What the radio starts from. */
interface RadioStart {
  /** `track:<videoId>` or `artist:<channelId>`, for the cursor. */
  readonly key: string
  /** The `next` payload of the first page. */
  readonly payload: Readonly<Record<string, string>>
  /** The videoIds never to return: the seed's. */
  readonly seen: readonly string[]
}

/**
 * Creates the `ytm` provider.
 *
 * - **Search** asks YouTube Music for one filtered search per type: songs (`ATV` only) go to
 *   `tracks`, official videos and other videos to `videos`, which is empty in Music mode.
 * - **Albums**, in Music mode, take their tracks from the album's audio playlist (`browse
 *   VL` + `OLAK5uy_…`), so they are the album's songs even where the album page lists official
 *   videos; anonymous `next` over that playlist would return the videos. In Music + Video mode
 *   the album page's own rows are the tracks, and its official videos link their songs
 *   (`songId`), read from each row's "View song credits" item (`MPTC<videoId>`) and, failing
 *   that, from the same position of the audio playlist.
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
      return parseMusicSearch(await catalog.call(ctx, 'music', 'search', payload), catalog.map)
    }
    const request = { type, query, ...page }
    switch (type) {
      case 'track':
      case 'video':
        return catalog.searchPage(read, (items) => searchTracks(items, type, ctx), request)
      case 'album':
        return catalog.searchPage(read, (items) => pick(items, 'album'), request)
      case 'artist':
        return catalog.searchPage(read, (items) => pick(items, 'artist'), request)
      case 'playlist':
        return catalog.searchPage(read, (items) => pick(items, 'playlist'), request)
    }
  }

  async function audioPlaylistRows(playlistId: string, ctx: ProviderContext): Promise<TrackRow[]> {
    const id = formatId('ytm', 'playlist', playlistId)
    const first = parsePlaylistPage(
      await catalog.browse(ctx, { browseId: `${PLAYLIST_BROWSE_PREFIX}${playlistId}` }),
      id,
      catalog.map,
    )
    const rows = [...first.rows]
    let continuation = first.continuation
    for (let page = 1; continuation !== undefined && page < MAX_AUDIO_PLAYLIST_PAGES; page++) {
      const next = parsePlaylistContinuation(
        await catalog.browse(ctx, { continuation }),
        catalog.map,
      )
      rows.push(...next.rows)
      continuation = next.continuation
    }
    return rows
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
        seen: [],
      }
    }
    const videoId = seedVideoId(seed, ctx)
    return {
      key: `track:${videoId}`,
      payload: { videoId, playlistId: `RDAMVM${videoId}`, params: config.radio.params },
      seen: [videoId],
    }
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
          catalog.map,
        )
        const unlinked = page.rows.some(
          (row) => row.track.kind === 'music-video' && creditedSong(row) === undefined,
        )
        const needsSongs = ctx.mode === 'music' || unlinked || page.rows.length === 0
        const songs =
          page.audioPlaylistId !== undefined && needsSongs
            ? (await audioPlaylistRows(page.audioPlaylistId, ctx))
                .filter((row) => row.track.kind === 'song')
                .map((row) => onAlbum(row, page.album))
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
        let queue: QueuePage
        let key: string
        let seen: Set<string>
        if (pageOptions.cursor === undefined) {
          const start = await radioStart(seed, ctx)
          queue = parseQueue(await catalog.call(ctx, 'music', 'next', start.payload), catalog.map)
          key = start.key
          seen = new Set(start.seen)
        } else {
          const cursor = decodeCursor(pageOptions.cursor, 'radio')
          if (cursor.s !== radioKey(seed, ctx)) {
            throw new FxmError('NotFound', 'The cursor belongs to another radio')
          }
          queue = parseQueueContinuation(
            await catalog.call(ctx, 'music', 'next', { continuation: cursor.c }),
            catalog.map,
          )
          key = cursor.s
          seen = new Set(seenIds(cursor))
        }
        const fresh: Track[] = []
        for (const track of filterPlayable(queue.tracks, ctx.mode)) {
          const videoId = nativeOf(track.id)
          if (seen.has(videoId)) continue
          seen.add(videoId)
          fresh.push(track)
        }
        const limit = pageOptions.limit
        const items = limit !== undefined && limit > 0 ? fresh.slice(0, limit) : fresh
        return {
          items,
          ...(queue.continuation === undefined
            ? {}
            : {
                nextCursor: encodeCursor({
                  k: 'radio',
                  s: key,
                  c: queue.continuation,
                  seen: seenField(seen),
                }),
              }),
        }
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

/** The videoId of a track seed in YouTube's ID space: its own, or its external ID. */
function youTubeVideoId(seed: Track): string | undefined {
  const own = parseId(seed.id)
  if (own.source === 'ytm' || own.source === 'yt') return own.nativeId
  return seed.externalIds?.ytm ?? seed.externalIds?.yt
}

/**
 * The videoId a track radio starts from. In Music mode it must be a song: an official video
 * starts from the song it links (`songForVideo`), and anything else is refused, because radio
 * from a video plays videos (measured: 50 of 50).
 *
 * @throws FxmError `Unsupported` for an episode, a seed with no YouTube ID, and in Music mode for
 * a music video without a song link or any other video.
 */
function seedVideoId(seed: Track, ctx: ProviderContext): string {
  if (seed.kind === 'episode') {
    throw new FxmError('Unsupported', 'A radio cannot start from a podcast episode')
  }
  let videoId: string | undefined
  if (ctx.mode === 'music' && seed.kind !== 'song') {
    const song = songForVideo(seed)
    const parts = song === undefined ? undefined : parseId(song)
    if (parts === undefined || (parts.source !== 'ytm' && parts.source !== 'yt')) {
      throw new FxmError(
        'Unsupported',
        `In Music mode a radio starts from a song: map "${seed.title}" to its song first`,
      )
    }
    videoId = parts.nativeId
  } else {
    videoId = youTubeVideoId(seed)
  }
  if (!isYouTubeId('track', videoId)) {
    throw new FxmError('Unsupported', `"${seed.title}" has no YouTube video to start a radio from`)
  }
  return videoId
}

/** The cursor key of a seed, without any request. */
function radioKey(seed: RadioSeed, ctx: ProviderContext): string {
  if (isTrackSeed(seed)) return `track:${seedVideoId(seed, ctx)}`
  const own = seed.id === undefined ? undefined : parseId(seed.id)
  return `artist:${own?.nativeId ?? ''}`
}
