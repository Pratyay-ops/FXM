/**
 * Where InnerTube links lead: browse pages, identified by their page type, and watch targets,
 * which carry a video's `musicVideoType`.
 *
 * @module
 */

import { asRecord, recordAt, stringAt } from '../json'

/** The page types FXM reads. */
export const PAGE_TYPES = {
  /** A YouTube Music artist. */
  artist: 'MUSIC_PAGE_TYPE_ARTIST',
  /** A channel that is not an artist, e.g. an uploader. */
  userChannel: 'MUSIC_PAGE_TYPE_USER_CHANNEL',
  /** An album, single or EP. */
  album: 'MUSIC_PAGE_TYPE_ALBUM',
  /** A playlist. */
  playlist: 'MUSIC_PAGE_TYPE_PLAYLIST',
  /** A song's credits, `MPTC<videoId>`. */
  credits: 'MUSIC_PAGE_TYPE_TRACK_CREDITS',
  /** An artist's discography, linked from its album and single shelves. */
  discography: 'MUSIC_PAGE_TYPE_ARTIST_DISCOGRAPHY',
  /** A podcast. */
  podcast: 'MUSIC_PAGE_TYPE_PODCAST_SHOW_DETAIL_PAGE',
  /** A podcast episode or other spoken audio. */
  nonMusicTrack: 'MUSIC_PAGE_TYPE_NON_MUSIC_AUDIO_TRACK_PAGE',
  /** A channel, in plain YouTube's responses. */
  webChannel: 'WEB_PAGE_TYPE_CHANNEL',
} as const

/** A browse link: the page's browseId, page type and parameters. */
export interface BrowseTarget {
  /** E.g. `MPREb_…`, `UC…` or `VLPL…`. */
  readonly browseId: string
  /** YouTube Music's page type, or plain YouTube's web page type. */
  readonly pageType?: string
  /** The browse `params`, if any. */
  readonly params?: string
}

/** The browse page a navigation endpoint leads to, if it leads to one. */
export function browseTarget(endpoint: unknown): BrowseTarget | undefined {
  const browse = recordAt(endpoint, 'browseEndpoint')
  const browseId = stringAt(browse, 'browseId')
  if (browseId === undefined) return undefined
  const pageType =
    stringAt(
      browse,
      'browseEndpointContextSupportedConfigs',
      'browseEndpointContextMusicConfig',
      'pageType',
    ) ?? stringAt(endpoint, 'commandMetadata', 'webCommandMetadata', 'webPageType')
  const params = stringAt(browse, 'params')
  return {
    browseId,
    ...(pageType === undefined ? {} : { pageType }),
    ...(params === undefined ? {} : { params }),
  }
}

/** A watch link: what it plays. */
export interface WatchTarget {
  /** The video it starts with, if it names one. */
  readonly videoId?: string
  /** The playlist or radio it plays, if any. */
  readonly playlistId?: string
  /** The watch `params`, if any. */
  readonly params?: string
  /** YouTube Music's kind of video, e.g. `MUSIC_VIDEO_TYPE_ATV`. */
  readonly musicVideoType?: string
}

/** What a watch or watch-playlist endpoint plays, if `endpoint` is one. */
export function watchTarget(endpoint: unknown): WatchTarget | undefined {
  const watch = recordAt(endpoint, 'watchEndpoint') ?? recordAt(endpoint, 'watchPlaylistEndpoint')
  if (watch === undefined) return undefined
  const videoId = stringAt(watch, 'videoId')
  const playlistId = stringAt(watch, 'playlistId')
  const params = stringAt(watch, 'params')
  const musicVideoType = stringAt(
    watch,
    'watchEndpointMusicSupportedConfigs',
    'watchEndpointMusicConfig',
    'musicVideoType',
  )
  return {
    ...(videoId === undefined ? {} : { videoId }),
    ...(playlistId === undefined ? {} : { playlistId }),
    ...(params === undefined ? {} : { params }),
    ...(musicVideoType === undefined ? {} : { musicVideoType }),
  }
}

/** Whether a page type is an artist's or a channel's. */
export function isArtistPage(pageType: string | undefined): boolean {
  return (
    pageType === PAGE_TYPES.artist ||
    pageType === PAGE_TYPES.userChannel ||
    pageType === PAGE_TYPES.webChannel
  )
}

/** The endpoint of a button, e.g. `{ buttonRenderer: { navigationEndpoint } }`. */
export function buttonEndpoint(button: unknown): unknown {
  const renderer =
    recordAt(button, 'buttonRenderer') ??
    recordAt(button, 'musicPlayButtonRenderer') ??
    asRecord(button)
  return renderer?.navigationEndpoint ?? renderer?.playNavigationEndpoint
}
