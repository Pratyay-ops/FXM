/**
 * YouTube Music's playlist pages (`browse VL<playlistId>`) and their continuation pages. An
 * album's audio playlist (`OLAK5uy_…`) is one too, with no header of its own.
 *
 * @module
 */

import { FxmError, type Playlist, type PlaylistOwner } from '@fxm/core'
import { arrayAt, at, recordAt, stringAt } from '../json'
import { pageHeader, pageSections } from './album'
import { musicThumbnailArtwork } from './artwork'
import { parseByline } from './byline'
import { type MapOptions, mapItems, ownerOf, type TrackRow } from './items'
import { appendedItems, continuationOf, firstShelf, trackRows } from './lists'
import { parseCount, runsOf, textOf } from './text'

/** What a playlist page holds. */
export interface PlaylistPage {
  /** The playlist, without tracks. */
  readonly playlist: Playlist
  /** The first page of rows. */
  readonly rows: TrackRow[]
  /** The continuation token of the next page of rows, if there is one. */
  readonly continuation?: string
}

/** A page of a playlist's rows after the first. */
export interface PlaylistRows {
  /** The rows, in order. */
  readonly rows: TrackRow[]
  /** The continuation token of the next page, if there is one. */
  readonly continuation?: string
}

function ownerFrom(header: unknown, options: MapOptions): PlaylistOwner | undefined {
  const { itemTypes } = options.labels
  const strapline = ownerOf(
    parseByline(runsOf(at(header, 'straplineTextOne')), options.source, itemTypes),
  )
  if (strapline !== undefined) return strapline
  const facepile = stringAt(header, 'facepile', 'avatarStackViewModel', 'text', 'content')?.trim()
  if (facepile !== undefined && facepile !== '') return { name: facepile }
  const subtitle = parseByline(runsOf(at(header, 'subtitle')), options.source, itemTypes)
  return subtitle.artists.some((artist) => artist.id !== undefined) ? ownerOf(subtitle) : undefined
}

function descriptionOf(header: unknown): string | undefined {
  return (
    textOf(at(header, 'description', 'musicDescriptionShelfRenderer', 'description')) ??
    textOf(at(header, 'description'))
  )
}

/**
 * Reads the first page of a playlist.
 *
 * @param playlistId The playlist's FXM ID.
 * @throws FxmError `NotFound` when the page has no content (YouTube's answer to an unknown or
 * private playlist).
 */
export function parsePlaylistPage(
  json: unknown,
  playlistId: Playlist['id'],
  options: MapOptions,
): PlaylistPage {
  if (at(json, 'contents') === undefined) {
    throw new FxmError('NotFound', `YouTube has no playlist ${playlistId}`)
  }
  const header = pageHeader(json)
  const shelf = firstShelf(pageSections(json), 'musicPlaylistShelfRenderer', 'musicShelfRenderer')
  const contents = shelf?.contents ?? []
  const rows = trackRows(mapItems(contents, options))
  const continuation = continuationOf(contents, shelf?.shelf)
  const name =
    textOf(at(header, 'title')) ??
    stringAt(json, 'microformat', 'microformatDataRenderer', 'title') ??
    rows.find((row) => row.track.album !== undefined)?.track.album?.name ??
    playlistId.slice(playlistId.lastIndexOf(':') + 1)
  const owner = ownerFrom(header, options)
  const description = descriptionOf(header)
  const counted = runsOf(at(header, 'secondSubtitle'))
    .map((run) => parseCount(run.text, options.labels.trackCounts))
    .find((count) => count !== undefined)
  const trackCount = counted ?? (continuation === undefined ? rows.length : undefined)
  const playlist: Playlist = {
    id: playlistId,
    source: options.source,
    name,
    ...(owner === undefined ? {} : { owner }),
    ...(description === undefined ? {} : { description }),
    artwork: musicThumbnailArtwork(at(header, 'thumbnail')),
    ...(trackCount === undefined ? {} : { trackCount }),
  }
  return { playlist, rows, ...(continuation === undefined ? {} : { continuation }) }
}

/**
 * Reads a continuation page of a playlist's rows: the appended items of the newer responses, or
 * the `musicPlaylistShelfContinuation` of the older ones.
 *
 * @throws FxmError `Parse` when the response is neither.
 */
export function parsePlaylistContinuation(json: unknown, options: MapOptions): PlaylistRows {
  const appended = appendedItems(json)
  const continued = recordAt(json, 'continuationContents', 'musicPlaylistShelfContinuation')
  const contents = appended ?? arrayAt(continued, 'contents')
  if (appended === undefined && continued === undefined) {
    throw new FxmError('Parse', 'The playlist continuation has no rows')
  }
  const continuation = continuationOf(contents, continued)
  return {
    rows: trackRows(mapItems(contents, options)),
    ...(continuation === undefined ? {} : { continuation }),
  }
}
