/**
 * Imports from links: a Spotify playlist, album or track through the Spotify provider (stage
 * 1.5), and a YouTube or YouTube Music playlist through the YouTube adapter (`./youtube`). Each
 * becomes one playlist to create, with every track's whole metadata, so the library shows the
 * artwork straight away.
 *
 * @module
 */

import {
  type Album,
  type EntityId,
  FxmError,
  type Page,
  type Playlist,
  type ProviderContext,
  type Track,
} from '@fxm/core'
import type { SpotifyProvider } from '../spotify'
import { ImportInputError } from './errors'
import type { ImportLink } from './links'
import { cleanArtists, cleanText, dedupeCollection, MAX_IMPORT_ROWS } from './rows'
import { type ImportRow, noSkips, type ParsedImport } from './types'
import type { ImportYouTube } from './youtube'

/** What imports use of the Spotify provider. */
export type ImportSpotify = Pick<
  SpotifyProvider,
  'isAvailable' | 'getPlaylist' | 'getPlaylistTracks' | 'getAlbum' | 'getTrack' | 'getTrackDetails'
>

/** Options for the link loaders. */
export interface LoadOptions {
  /**
   * Waits between two page requests: imports pace Spotify at about one request per second.
   * Default: a timer.
   */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  /** Called after each page, with the rows read so far. */
  onProgress?: (rows: number) => void
}

/** The pause between two page requests of one import, in milliseconds. */
export const PAGE_SPACING_MS = 1000

/** How many tracks one page request asks for. */
const PAGE_LIMIT = 100

/** A timer that stops early, with the signal's reason, when the signal aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason)
      return
    }
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal?.reason)
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** The row for a catalog track, with its whole metadata. */
export function rowFromTrack(track: Track): ImportRow {
  const row: ImportRow = {
    title: cleanText(track.title) ?? track.title,
    artists: cleanArtists(track.artists.map((artist) => artist.name)),
    trackId: track.id,
    kind: track.kind,
    track,
  }
  if (track.album?.name !== undefined) row.album = track.album.name
  if (track.durationMs !== undefined) row.durationMs = track.durationMs
  if (track.explicit !== undefined) row.explicit = track.explicit
  if (track.isrc !== undefined) row.isrc = track.isrc
  if (track.releaseDate !== undefined) row.releaseDate = track.releaseDate
  if (track.songId !== undefined) row.songId = track.songId
  return row
}

/** Every track of a playlist: its first page, then the pages after it, up to the row limit. */
async function allPlaylistTracks(
  first: Playlist,
  more: (cursor: string) => Promise<Page<Track>>,
  ctx: ProviderContext,
  options: LoadOptions,
): Promise<Track[]> {
  const pause = options.sleep ?? sleep
  const tracks = [...(first.tracks?.items ?? [])]
  let cursor = first.tracks?.nextCursor
  options.onProgress?.(tracks.length)
  while (cursor !== undefined && tracks.length < MAX_IMPORT_ROWS) {
    await pause(PAGE_SPACING_MS, ctx.signal as AbortSignal | undefined)
    const page = await more(cursor)
    tracks.push(...page.items)
    options.onProgress?.(tracks.length)
    if (page.items.length === 0 || page.nextCursor === cursor) break
    cursor = page.nextCursor
  }
  return tracks
}

/** The parsed import of one list of catalog tracks. */
function importOf(
  kind: 'spotify' | 'youtube',
  name: string,
  tracks: readonly Track[],
  description?: string,
): ParsedImport {
  const skipped = noSkips()
  const rows: ImportRow[] = []
  for (const track of tracks) {
    if (track.kind === 'episode') skipped.episodes++
    else rows.push(rowFromTrack(track))
  }
  const collection = dedupeCollection(
    description === undefined ? { name, rows } : { name, description, rows },
    skipped,
  )
  if (collection.rows.length === 0) {
    throw new ImportInputError('no-tracks', 'There are no songs to import there')
  }
  return { kind, label: name, collections: [collection], plays: [], follows: [], skipped }
}

/** "Album by Artist", the description of an imported album. */
function albumDescription(album: Album): string | undefined {
  const artists = album.artists.map((artist) => artist.name).join(', ')
  return artists === '' ? undefined : `Album by ${artists}`
}

/**
 * Loads a Spotify playlist, album or track for import, through the Spotify provider: a
 * playlist page by page (about one request per second), an album with all its tracks, a track
 * as a playlist of one.
 *
 * @throws The provider's `SpotifyError`s, e.g. `Unsupported` when Spotify is off or
 * unreachable, `NotFound` for a link to nothing; `ImportInputError` `no-tracks` for an empty
 * playlist.
 */
export async function loadSpotifyImport(
  spotify: ImportSpotify,
  id: EntityId<'playlist'> | EntityId<'album'> | EntityId<'track'>,
  ctx: ProviderContext,
  options: LoadOptions = {},
): Promise<ParsedImport> {
  if (id.startsWith('spotify:album:')) {
    const album = await spotify.getAlbum(id as EntityId<'album'>, ctx)
    return importOf('spotify', album.name, album.tracks ?? [], albumDescription(album))
  }
  if (id.startsWith('spotify:track:')) {
    const track = await spotify.getTrack(id as EntityId<'track'>, ctx)
    return importOf('spotify', track.title, [track])
  }
  const playlistId = id as EntityId<'playlist'>
  const playlist = await spotify.getPlaylist(playlistId, ctx)
  const tracks = await allPlaylistTracks(
    playlist,
    (cursor) => spotify.getPlaylistTracks(playlistId, { cursor, limit: PAGE_LIMIT }, ctx),
    ctx,
    options,
  )
  return importOf('spotify', playlist.name, tracks, playlist.description)
}

/**
 * Loads a YouTube or YouTube Music playlist for import, page by page, every item kept whatever
 * the catalog mode (the import decides per row what plays in which mode).
 *
 * @throws The YouTube adapter's errors, e.g. `Unsupported` while it is not available;
 * `ImportInputError` `no-tracks` for an empty playlist.
 */
export async function loadYouTubeImport(
  youtube: ImportYouTube,
  id: EntityId<'playlist'>,
  ctx: ProviderContext,
  options: LoadOptions = {},
): Promise<ParsedImport> {
  const everything: ProviderContext = { ...ctx, mode: 'all' }
  const playlist = await youtube.getPlaylist(id, everything)
  const tracks = await allPlaylistTracks(
    playlist,
    (cursor) => youtube.getPlaylistTracks(id, { cursor, limit: PAGE_LIMIT }, everything),
    everything,
    options,
  )
  return importOf('youtube', playlist.name, tracks, playlist.description)
}

/**
 * What a link imports, loaded through the source that serves it.
 *
 * @throws An `Unsupported` `FxmError` for a Spotify link while Spotify is switched off, and
 * whatever the loader throws.
 */
export async function loadLinkImport(
  link: ImportLink,
  sources: { spotify?: ImportSpotify | undefined; youtube: ImportYouTube },
  ctx: ProviderContext,
  options: LoadOptions = {},
): Promise<ParsedImport> {
  if (link.source === 'youtube') return loadYouTubeImport(sources.youtube, link.id, ctx, options)
  if (sources.spotify === undefined) throw new FxmError('Unsupported', 'Spotify is switched off')
  return loadSpotifyImport(sources.spotify, link.id, ctx, options)
}
