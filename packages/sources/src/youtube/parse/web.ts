/**
 * Plain YouTube's search results (the `WEB` client): videos (`videoRenderer`), channels
 * (`channelRenderer`) and playlists (`lockupViewModel`). Every video is a `video`, whatever it
 * is: plain YouTube does not classify its results.
 *
 * @module
 */

import { FxmError, type Track } from '@fxm/core'
import { youTubeEntityId } from '../ids'
import { arrayAt, asString, at, type JsonRecord, stringAt, unwrap } from '../json'
import { artworkOf } from './artwork'
import { parseByline } from './byline'
import { browseTarget, isArtistPage } from './endpoints'
import { type Item, type MapOptions, ownerOf } from './items'
import { appendedItems, continuationOf, type ListPage, listPage } from './lists'
import { parseCount, parseDuration, runsOf, textOf } from './text'

function videoItem(renderer: JsonRecord, options: MapOptions): Item | undefined {
  const id = youTubeEntityId('yt', 'track', renderer.videoId)
  const title = textOf(renderer.title)
  if (id === undefined || title === undefined) return undefined
  const { itemTypes } = options.labels
  const owner = runsOf(renderer.ownerText)
  const byline = parseByline(
    owner.length > 0 ? owner : runsOf(renderer.longBylineText),
    'yt',
    itemTypes,
  )
  const durationMs = parseDuration(textOf(renderer.lengthText))
  const track: Track = {
    id,
    source: 'yt',
    title,
    artists: byline.artists,
    ...(durationMs === undefined ? {} : { durationMs }),
    artwork: artworkOf(at(renderer, 'thumbnail', 'thumbnails')),
    kind: 'video',
  }
  return { type: 'track', row: { track } }
}

function channelItem(renderer: JsonRecord): Item | undefined {
  const id = youTubeEntityId('yt', 'artist', renderer.channelId)
  const name = textOf(renderer.title)
  if (id === undefined || name === undefined) return undefined
  const description = textOf(renderer.descriptionSnippet)
  return {
    type: 'artist',
    artist: {
      id,
      source: 'yt',
      name,
      artwork: artworkOf(at(renderer, 'thumbnail', 'thumbnails')),
      ...(description === undefined ? {} : { description }),
    },
  }
}

/** A `lockupViewModel` of a playlist: its title, owner, thumbnail and video count. */
function playlistItem(model: JsonRecord, options: MapOptions): Item | undefined {
  if (model.contentType !== 'LOCKUP_CONTENT_TYPE_PLAYLIST') return undefined
  const id = youTubeEntityId('yt', 'playlist', model.contentId)
  const metadata = at(model, 'metadata', 'lockupMetadataViewModel')
  const name = textOf(at(metadata, 'title'))
  if (id === undefined || name === undefined) return undefined
  const byline = arrayAt(
    metadata,
    'metadata',
    'contentMetadataViewModel',
    'metadataRows',
    0,
    'metadataParts',
  )
    .map((part) => at(part, 'text'))
    .flatMap((text) => {
      const content = stringAt(text, 'content')
      const endpoint = at(text, 'commandRuns', 0, 'onTap', 'innertubeCommand')
      if (content === undefined) return []
      return isArtistPage(browseTarget(endpoint)?.pageType)
        ? [{ text: content, endpoint: endpoint as JsonRecord }]
        : [{ text: content }]
    })
  const owner = ownerOf(parseByline(byline, 'yt', options.labels.itemTypes))
  const thumbnail = at(
    model,
    'contentImage',
    'collectionThumbnailViewModel',
    'primaryThumbnail',
    'thumbnailViewModel',
  )
  const trackCount = arrayAt(thumbnail, 'overlays')
    .flatMap((overlay) => arrayAt(overlay, 'thumbnailOverlayBadgeViewModel', 'thumbnailBadges'))
    .map((badge) => asString(at(badge, 'thumbnailBadgeViewModel', 'text')))
    .map((text) => (text === undefined ? undefined : parseCount(text, options.labels.trackCounts)))
    .find((count) => count !== undefined)
  return {
    type: 'playlist',
    playlist: {
      id,
      source: 'yt',
      name,
      ...(owner === undefined ? {} : { owner }),
      artwork: artworkOf(at(thumbnail, 'image', 'sources')),
      ...(trackCount === undefined ? {} : { trackCount }),
    },
  }
}

function webItem(wrapper: unknown, options: MapOptions): Item | undefined {
  const unwrapped = unwrap(wrapper)
  switch (unwrapped?.name) {
    case 'videoRenderer':
      return videoItem(unwrapped.renderer, options)
    case 'channelRenderer':
      return channelItem(unwrapped.renderer)
    case 'lockupViewModel':
      return playlistItem(unwrapped.renderer, options)
    default:
      return undefined
  }
}

/**
 * One page of a plain YouTube search: the first page (`twoColumnSearchResultsRenderer`) or a
 * continuation (appended items). Shorts, ads and shelves of other kinds are left out.
 *
 * @throws FxmError `Parse` when the response is neither.
 */
export function parseWebSearch(json: unknown, options: MapOptions): ListPage {
  const appended = appendedItems(json)
  const results = at(json, 'contents', 'twoColumnSearchResultsRenderer')
  if (appended === undefined && results === undefined) {
    throw new FxmError('Parse', 'The search response has no results')
  }
  const sections =
    appended ?? arrayAt(results, 'primaryContents', 'sectionListRenderer', 'contents')
  const items: Item[] = []
  for (const section of sections) {
    for (const wrapper of arrayAt(section, 'itemSectionRenderer', 'contents')) {
      const item = webItem(wrapper, options)
      if (item !== undefined) items.push(item)
    }
  }
  return listPage(items, continuationOf(sections))
}
