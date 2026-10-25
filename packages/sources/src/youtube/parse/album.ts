/**
 * YouTube Music's album pages (`browse MPREb_…`): the album, its rows, and the id of its audio
 * playlist (`OLAK5uy_…`), whose rows are the album's songs in order.
 *
 * Anonymous album pages may list a song's official video in its row (`OMV` instead of `ATV`).
 * Each row's "View song credits" item still names the song (`MPTC<videoId of the song>`), so the
 * row links its video to its song, and position i of the page is position i of the audio
 * playlist.
 *
 * @module
 */

import { type Album, FxmError } from '@fxm/core'
import { isYouTubeId } from '../ids'
import { arrayAt, at, recordAt, stringAt } from '../json'
import { musicThumbnailArtwork } from './artwork'
import { parseByline } from './byline'
import { buttonEndpoint, watchTarget } from './endpoints'
import { albumTypeOf, isExplicit, type MapOptions, mapItems, type TrackRow } from './items'
import { firstShelf, trackRows } from './lists'
import { parseCount, runsOf, textOf } from './text'

/** What an album page holds. */
export interface AlbumPage {
  /** The album, without tracks. */
  readonly album: Album
  /**
   * The page's rows in order, each with the album as its album, and the album's artists,
   * artwork and year where the row has none.
   */
  readonly rows: TrackRow[]
  /** The album's audio playlist, e.g. `OLAK5uy_…`, if the page names it. */
  readonly audioPlaylistId?: string
}

/** The header of an album or playlist page: the newer responsive one, or the older one. */
export function pageHeader(json: unknown): Readonly<Record<string, unknown>> | undefined {
  const firstSection = at(
    json,
    'contents',
    'twoColumnBrowseResultsRenderer',
    'tabs',
    0,
    'tabRenderer',
    'content',
    'sectionListRenderer',
    'contents',
    0,
  )
  return (
    recordAt(firstSection, 'musicResponsiveHeaderRenderer') ??
    recordAt(
      firstSection,
      'musicEditablePlaylistDetailHeaderRenderer',
      'header',
      'musicResponsiveHeaderRenderer',
    ) ??
    recordAt(json, 'header', 'musicResponsiveHeaderRenderer') ??
    recordAt(json, 'header', 'musicDetailHeaderRenderer') ??
    recordAt(
      json,
      'header',
      'musicEditablePlaylistDetailHeaderRenderer',
      'header',
      'musicDetailHeaderRenderer',
    )
  )
}

/** The sections that hold an album's or playlist's rows, in the two-column or older layout. */
export function pageSections(json: unknown): readonly unknown[] {
  const twoColumn = arrayAt(
    json,
    'contents',
    'twoColumnBrowseResultsRenderer',
    'secondaryContents',
    'sectionListRenderer',
    'contents',
  )
  if (twoColumn.length > 0) return twoColumn
  return arrayAt(
    json,
    'contents',
    'singleColumnBrowseResultsRenderer',
    'tabs',
    0,
    'tabRenderer',
    'content',
    'sectionListRenderer',
    'contents',
  )
}

/** Whether a playlistId is an album's audio playlist rather than a radio. */
function isAudioPlaylist(playlistId: string | undefined): playlistId is string {
  return isYouTubeId('playlist', playlistId) && !playlistId.startsWith('RD')
}

/** The `list` parameter of a URL, e.g. the playlist of `music.youtube.com/playlist?list=…`. */
function listParameter(url: string | undefined): string | undefined {
  if (url === undefined || !URL.canParse(url)) return undefined
  return new URL(url).searchParams.get('list') ?? undefined
}

/**
 * The album's audio playlist: what the header's play button plays, else what the rows play in,
 * else the page's canonical URL. An `OLAK5uy_…` playlist wins over any other.
 */
function audioPlaylistOf(
  header: unknown,
  rows: readonly TrackRow[],
  json: unknown,
): string | undefined {
  const candidates = [
    ...arrayAt(header, 'buttons').map((button) => watchTarget(buttonEndpoint(button))?.playlistId),
    watchTarget(buttonEndpoint(at(header, 'playButton')))?.playlistId,
    ...rows.map((row) => row.playlistId),
    listParameter(stringAt(json, 'microformat', 'microformatDataRenderer', 'urlCanonical')),
  ].filter(isAudioPlaylist)
  return candidates.find((id) => id.startsWith('OLAK5uy_')) ?? candidates[0]
}

/**
 * Reads an album page.
 *
 * @param albumId The album's FXM ID, which the album and every row's album take.
 * @throws FxmError `NotFound` when the page has no content (YouTube answers an unknown album
 * with an empty page), and `Parse` when it has no title.
 */
export function parseAlbumPage(
  json: unknown,
  albumId: Album['id'],
  options: MapOptions,
): AlbumPage {
  if (at(json, 'contents') === undefined) {
    throw new FxmError('NotFound', `YouTube Music has no album ${albumId}`)
  }
  const header = pageHeader(json)
  const name =
    textOf(at(header, 'title')) ?? stringAt(json, 'microformat', 'microformatDataRenderer', 'title')
  if (name === undefined) throw new FxmError('Parse', `The album page ${albumId} has no title`)
  const { itemTypes, trackCounts } = options.config.labels
  const subtitle = parseByline(runsOf(at(header, 'subtitle')), options.source, itemTypes)
  const strapline = parseByline(runsOf(at(header, 'straplineTextOne')), options.source, itemTypes)
  const artists = strapline.artists.length > 0 ? strapline.artists : subtitle.artists
  const artwork = musicThumbnailArtwork(at(header, 'thumbnail'))
  const type = albumTypeOf(subtitle.words, options.config)
  const trackCount = runsOf(at(header, 'secondSubtitle'))
    .map((run) => parseCount(run.text, trackCounts))
    .find((count) => count !== undefined)
  const album: Album = {
    id: albumId,
    source: options.source,
    name,
    artists,
    artwork,
    ...(type === undefined ? {} : { type }),
    ...(subtitle.year === undefined ? {} : { releaseDate: String(subtitle.year) }),
    ...(trackCount === undefined ? {} : { trackCount }),
    ...(isExplicit({ badges: at(header, 'subtitleBadge') }) ? { explicit: true } : {}),
  }
  const shelf = firstShelf(pageSections(json), 'musicShelfRenderer', 'musicPlaylistShelfRenderer')
  const rows = trackRows(mapItems(shelf?.contents ?? [], options)).map((row) => onAlbum(row, album))
  const audioPlaylistId = audioPlaylistOf(header, rows, json)
  return { album, rows, ...(audioPlaylistId === undefined ? {} : { audioPlaylistId }) }
}

/**
 * A row as a track of `album`: the album as its album, and the album's artists, artwork and year
 * where the row has none. Album rows name no artist when the album's artists sing them all.
 */
export function onAlbum(row: TrackRow, album: Album): TrackRow {
  const { track } = row
  return {
    ...row,
    track: {
      ...track,
      album: { id: album.id, name: album.name },
      artists: track.artists.length > 0 ? track.artists : album.artists,
      artwork: track.artwork.length > 0 ? track.artwork : album.artwork,
      ...(track.releaseDate === undefined && album.releaseDate !== undefined
        ? { releaseDate: album.releaseDate }
        : {}),
    },
  }
}
