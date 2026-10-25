/**
 * YouTube Music's artist and channel pages (`browse UC…`): an artist's top songs, albums,
 * singles and EPs, videos and related artists, or a channel's videos.
 *
 * Shelves are told apart by what they hold, not by their titles, which come in the user's
 * language: a shelf of songs gives the top songs, cards of the artist's own releases give the
 * albums, cards of other artists give the related artists, and cards of videos give the
 * videos.
 *
 * @module
 */

import { type Album, type Artist, type ArtistRef, FxmError, type Track } from '@fxm/core'
import { arrayAt, at, recordAt, stringAt } from '../json'
import { musicThumbnailArtwork } from './artwork'
import { buttonEndpoint, type WatchTarget, watchTarget } from './endpoints'
import { albumTypeOf, type Item, type MapOptions, mapItems } from './items'
import { textOf } from './text'

/** What an artist or channel page holds. */
export interface ArtistPage {
  /**
   * The artist with its top songs (`topTracks`), own releases (`albums`) and related artists,
   * before any mode filtering. Fields the page has nothing for are left out.
   */
  readonly artist: Artist
  /** The tracks of the page's video shelves, in order: official videos or uploads. */
  readonly videos: Track[]
  /** What the page's Mix button plays: the artist's radio. */
  readonly radio?: WatchTarget
}

function headerOf(json: unknown): Readonly<Record<string, unknown>> | undefined {
  return (
    recordAt(json, 'header', 'musicImmersiveHeaderRenderer') ??
    recordAt(json, 'header', 'musicVisualHeaderRenderer') ??
    recordAt(json, 'header', 'musicHeaderRenderer') ??
    recordAt(json, 'header', 'musicResponsiveHeaderRenderer')
  )
}

/** The artists an album card links to. Unlinked words may be labels in another language. */
function linkedArtists(album: Album): ArtistRef[] {
  return album.artists.filter((artist) => artist.id !== undefined)
}

/** Whether an album card is the artist's own: it links no artist, or links this one. */
function isOwnRelease(album: Album, self: ArtistRef): boolean {
  const linked = linkedArtists(album)
  return linked.length === 0 || linked.some((artist) => artist.id === self.id)
}

/**
 * Reads an artist or channel page.
 *
 * @param artistId The artist's FXM ID.
 * @throws FxmError `NotFound` when the page has no content, and `Parse` when it has no name.
 */
export function parseArtistPage(
  json: unknown,
  artistId: Artist['id'],
  options: MapOptions,
): ArtistPage {
  if (at(json, 'contents') === undefined) {
    throw new FxmError('NotFound', `YouTube has no artist or channel ${artistId}`)
  }
  const header = headerOf(json)
  const name =
    textOf(at(header, 'title')) ?? stringAt(json, 'microformat', 'microformatDataRenderer', 'title')
  if (name === undefined) throw new FxmError('Parse', `The artist page ${artistId} has no name`)
  const self: ArtistRef = { id: artistId, name }
  const sections = arrayAt(
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
  let topTracks: Track[] | undefined
  const videos: Track[] = []
  const albums: Album[] = []
  const related: Artist[] = []
  for (const section of sections) {
    const songShelf = recordAt(section, 'musicShelfRenderer')
    const carousel = recordAt(section, 'musicCarouselShelfRenderer')
    const items: Item[] = mapItems(arrayAt(songShelf ?? carousel, 'contents'), options)
    if (songShelf !== undefined) {
      topTracks ??= items.flatMap((item) => (item.type === 'track' ? [item.row.track] : []))
      continue
    }
    for (const item of items) {
      if (item.type === 'track') videos.push(item.row.track)
      else if (item.type === 'artist' && item.artist.id !== artistId) related.push(item.artist)
      else if (item.type === 'album' && isOwnRelease(item.album, self)) {
        const type =
          item.album.type ??
          albumTypeOf(item.words, options.config) ??
          (item.words.length === 0 ? 'album' : undefined)
        const linked = linkedArtists(item.album)
        albums.push({
          ...item.album,
          artists: linked.length > 0 ? linked : [self],
          ...(type === undefined ? {} : { type }),
        })
      }
    }
  }
  const description = textOf(at(header, 'description'))
  const artwork = musicThumbnailArtwork(at(header, 'thumbnail'))
  const radio = watchTarget(buttonEndpoint(at(header, 'startRadioButton')))
  const artist: Artist = {
    id: artistId,
    source: options.source,
    name,
    artwork:
      artwork.length > 0 ? artwork : musicThumbnailArtwork(at(header, 'foregroundThumbnail')),
    ...(description === undefined ? {} : { description }),
    ...(topTracks === undefined ? {} : { topTracks }),
    ...(albums.length === 0 ? {} : { albums }),
    ...(related.length === 0 ? {} : { related }),
  }
  return {
    artist,
    videos,
    ...(radio?.playlistId === undefined ? {} : { radio }),
  }
}
