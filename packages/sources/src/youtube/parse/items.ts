/**
 * YouTube Music's list items as FXM entities: the rows of search results, albums, playlists and
 * artist pages (`musicResponsiveListItemRenderer`), the cards of carousels
 * (`musicTwoRowItemRenderer`) and the items of a queue or radio (`playlistPanelVideoRenderer`).
 *
 * Every track is classified by its `musicVideoType` (see `classify.ts`) and its byline is read
 * by page type (see `byline.ts`).
 *
 * @module
 */

import {
  type Album,
  type AlbumType,
  type Artist,
  type Artwork,
  type Playlist,
  type PlaylistOwner,
  parseId,
  type Track,
  type TrackKind,
} from '@fxm/core'
import type { YouTubeConfig } from '../config'
import {
  CREDITS_BROWSE_PREFIX,
  isYouTubeId,
  playlistIdOf,
  type YouTubeSource,
  youTubeEntityId,
} from '../ids'
import { arrayAt, asString, at, type JsonRecord, recordAt, stringAt, unwrap } from '../json'
import { artworkOf, musicThumbnailArtwork } from './artwork'
import { type Byline, parseByline } from './byline'
import { kindOfMusicVideoType } from './classify'
import { browseTarget, isArtistPage, PAGE_TYPES, watchTarget } from './endpoints'
import { parseDuration, runsOf, textOf } from './text'

/** How items are mapped. */
export interface MapOptions {
  /** The source of every ID: `ytm`, or `yt` for plain YouTube. */
  readonly source: YouTubeSource
  /** The config, for its labels. */
  readonly config: YouTubeConfig
  /**
   * Whether every track is a video, whatever its `musicVideoType`: plain YouTube's view of the
   * catalog. Tracks then carry no album, since plain YouTube has none.
   */
  readonly videosOnly?: boolean
}

/** A track as a list row shows it, with what the row says beyond the track itself. */
export interface TrackRow {
  /** The track. */
  readonly track: Track
  /**
   * The videoId that the row's "View song credits" item names (`MPTC<videoId>`). On an album
   * page it is the song (`ATV`) of the row, also when the row is the song's official video.
   */
  readonly credits?: string
  /** The row's number, from an album page's index column. */
  readonly index?: number
  /** The playlist the row plays in, e.g. an album's audio playlist (`OLAK5uy_…`). */
  readonly playlistId?: string
}

/** One mapped list item. */
export type Item =
  | { readonly type: 'track'; readonly row: TrackRow }
  | {
      readonly type: 'album'
      readonly album: Album
      /** The byline's unlinked words, e.g. `['Single']`: none means only a year was shown. */
      readonly words: readonly string[]
    }
  | { readonly type: 'artist'; readonly artist: Artist }
  | { readonly type: 'playlist'; readonly playlist: Playlist }

/** The release type that one of `words` names, through the config's labels. */
export function albumTypeOf(
  words: readonly string[],
  config: YouTubeConfig,
): AlbumType | undefined {
  for (const word of words) {
    const label = word.toLowerCase()
    if (Object.hasOwn(config.labels.albumTypes, label)) return config.labels.albumTypes[label]
  }
  return undefined
}

/** Whether a renderer carries YouTube Music's explicit badge. */
export function isExplicit(renderer: unknown): boolean {
  return arrayAt(renderer, 'badges').some(
    (badge) =>
      stringAt(badge, 'musicInlineBadgeRenderer', 'icon', 'iconType') === 'MUSIC_EXPLICIT_BADGE',
  )
}

/** The videoId of a row's "View song credits" menu item (`MPTC<videoId>`), if it has one. */
export function creditsOf(menu: unknown): string | undefined {
  for (const item of arrayAt(menu, 'menuRenderer', 'items')) {
    const target = browseTarget(at(item, 'menuNavigationItemRenderer', 'navigationEndpoint'))
    if (target?.pageType !== PAGE_TYPES.credits) continue
    if (!target.browseId.startsWith(CREDITS_BROWSE_PREFIX)) continue
    const videoId = target.browseId.slice(CREDITS_BROWSE_PREFIX.length)
    if (isYouTubeId('track', videoId)) return videoId
  }
  return undefined
}

/** The parts a track is made of. */
interface TrackParts {
  videoId: string | undefined
  title: string | undefined
  musicVideoType: string | undefined
  /** Whether a link marks it as spoken audio (a podcast episode). */
  episode: boolean
  byline: Byline
  durationMs: number | undefined
  artwork: Artwork[]
  explicit: boolean
}

function buildTrack(options: MapOptions, parts: TrackParts): Track | undefined {
  const id = youTubeEntityId(options.source, 'track', parts.videoId)
  if (id === undefined || parts.title === undefined) return undefined
  const kind: TrackKind = options.videosOnly
    ? 'video'
    : parts.episode
      ? 'episode'
      : kindOfMusicVideoType(parts.musicVideoType)
  const { album, year } = parts.byline
  return {
    id,
    source: options.source,
    title: parts.title,
    artists: parts.byline.artists,
    ...(album === undefined || options.videosOnly ? {} : { album }),
    ...(parts.durationMs === undefined ? {} : { durationMs: parts.durationMs }),
    artwork: parts.artwork,
    ...(parts.explicit ? { explicit: true } : {}),
    kind,
    ...(year === undefined ? {} : { releaseDate: String(year) }),
  }
}

function albumItem(
  options: MapOptions,
  browseId: string,
  name: string | undefined,
  byline: Byline,
  artwork: Artwork[],
  explicit: boolean,
): Item | undefined {
  const id = youTubeEntityId(options.source, 'album', browseId)
  if (id === undefined || name === undefined) return undefined
  const type = albumTypeOf(byline.words, options.config)
  const album: Album = {
    id,
    source: options.source,
    name,
    artists: byline.artists,
    artwork,
    ...(type === undefined ? {} : { type }),
    ...(byline.year === undefined ? {} : { releaseDate: String(byline.year) }),
    ...(explicit ? { explicit: true } : {}),
  }
  return { type: 'album', album, words: byline.words }
}

function artistItem(
  options: MapOptions,
  browseId: string,
  name: string | undefined,
  artwork: Artwork[],
): Item | undefined {
  const id = youTubeEntityId(options.source, 'artist', browseId)
  if (id === undefined || name === undefined) return undefined
  return { type: 'artist', artist: { id, source: options.source, name, artwork } }
}

function playlistItem(
  options: MapOptions,
  browseId: string,
  name: string | undefined,
  byline: Byline,
  artwork: Artwork[],
): Item | undefined {
  const id = youTubeEntityId(options.source, 'playlist', playlistIdOf(browseId))
  if (id === undefined || name === undefined) return undefined
  const owner = ownerOf(byline)
  return {
    type: 'playlist',
    playlist: {
      id,
      source: options.source,
      name,
      ...(owner === undefined ? {} : { owner }),
      artwork,
    },
  }
}

/** A playlist's owner, from the first artist or channel of its byline. */
export function ownerOf(byline: Byline): PlaylistOwner | undefined {
  const [first] = byline.artists
  if (first === undefined) return undefined
  return first.id === undefined
    ? { name: first.name }
    : { name: first.name, id: parseId(first.id).nativeId }
}

/** A `musicResponsiveListItemRenderer`: a row of search results, an album or a playlist. */
export function mapResponsiveItem(renderer: JsonRecord, options: MapOptions): Item | undefined {
  const columns = arrayAt(renderer, 'flexColumns').map((column) =>
    at(column, 'musicResponsiveListItemFlexColumnRenderer', 'text'),
  )
  const titleRuns = runsOf(columns[0])
  const title = textOf(columns[0])
  const byline = parseByline(
    columns.slice(1).flatMap(runsOf),
    options.source,
    options.config.labels.itemTypes,
  )
  const artwork = musicThumbnailArtwork(renderer.thumbnail)
  const explicit = isExplicit(renderer)
  const navigation = browseTarget(renderer.navigationEndpoint)
  const episode =
    navigation?.pageType === PAGE_TYPES.nonMusicTrack ||
    titleRuns.some((run) => browseTarget(run.endpoint)?.pageType === PAGE_TYPES.nonMusicTrack)
  if (navigation !== undefined && !episode) {
    if (navigation.pageType === PAGE_TYPES.album) {
      return albumItem(options, navigation.browseId, title, byline, artwork, explicit)
    }
    if (isArtistPage(navigation.pageType)) {
      return artistItem(options, navigation.browseId, title, artwork)
    }
    if (navigation.pageType === PAGE_TYPES.playlist) {
      return playlistItem(options, navigation.browseId, title, byline, artwork)
    }
    return undefined
  }
  const play = watchTarget(
    at(
      renderer,
      'overlay',
      'musicItemThumbnailOverlayRenderer',
      'content',
      'musicPlayButtonRenderer',
      'playNavigationEndpoint',
    ),
  )
  const titleWatch = watchTarget(titleRuns[0]?.endpoint)
  const rowWatch = watchTarget(renderer.navigationEndpoint)
  const fixed = textOf(
    at(renderer, 'fixedColumns', 0, 'musicResponsiveListItemFixedColumnRenderer', 'text'),
  )
  const track = buildTrack(options, {
    videoId:
      stringAt(renderer, 'playlistItemData', 'videoId') ??
      play?.videoId ??
      titleWatch?.videoId ??
      rowWatch?.videoId,
    title,
    musicVideoType: play?.musicVideoType ?? titleWatch?.musicVideoType ?? rowWatch?.musicVideoType,
    episode,
    byline,
    durationMs: byline.durationMs ?? parseDuration(fixed),
    artwork,
    explicit,
  })
  if (track === undefined) return undefined
  const credits = creditsOf(renderer.menu)
  const index = Number(textOf(renderer.index))
  const playlistId = play?.playlistId ?? titleWatch?.playlistId
  return {
    type: 'track',
    row: {
      track,
      ...(credits === undefined ? {} : { credits }),
      ...(Number.isSafeInteger(index) && index > 0 ? { index } : {}),
      ...(playlistId === undefined ? {} : { playlistId }),
    },
  }
}

/** A `musicTwoRowItemRenderer`: a card of a carousel, e.g. an album on an artist page. */
export function mapTwoRowItem(renderer: JsonRecord, options: MapOptions): Item | undefined {
  const title = textOf(renderer.title)
  const byline = parseByline(
    runsOf(renderer.subtitle),
    options.source,
    options.config.labels.itemTypes,
  )
  const artwork = musicThumbnailArtwork(renderer.thumbnailRenderer)
  const explicit = isExplicit({ badges: renderer.subtitleBadges })
  const navigation = browseTarget(renderer.navigationEndpoint)
  if (navigation !== undefined) {
    if (navigation.pageType === PAGE_TYPES.album) {
      return albumItem(options, navigation.browseId, title, byline, artwork, explicit)
    }
    if (isArtistPage(navigation.pageType)) {
      return artistItem(options, navigation.browseId, title, artwork)
    }
    if (navigation.pageType === PAGE_TYPES.playlist) {
      return playlistItem(options, navigation.browseId, title, byline, artwork)
    }
    return undefined
  }
  const watch = watchTarget(renderer.navigationEndpoint)
  const track = buildTrack(options, {
    videoId: watch?.videoId,
    title,
    musicVideoType: watch?.musicVideoType,
    episode: false,
    byline,
    durationMs: byline.durationMs,
    artwork,
    explicit,
  })
  if (track === undefined) return undefined
  return {
    type: 'track',
    row: { track, ...(watch?.playlistId === undefined ? {} : { playlistId: watch.playlistId }) },
  }
}

/** A list item of any kind that search results, pages and carousels hold. */
export function mapItem(wrapper: unknown, options: MapOptions): Item | undefined {
  const unwrapped = unwrap(wrapper)
  if (unwrapped === undefined) return undefined
  switch (unwrapped.name) {
    case 'musicResponsiveListItemRenderer':
      return mapResponsiveItem(unwrapped.renderer, options)
    case 'musicTwoRowItemRenderer':
      return mapTwoRowItem(unwrapped.renderer, options)
    default:
      return undefined
  }
}

/** Every item of a list that maps, in order. */
export function mapItems(items: readonly unknown[], options: MapOptions): Item[] {
  const mapped: Item[] = []
  for (const wrapper of items) {
    const item = mapItem(wrapper, options)
    if (item !== undefined) mapped.push(item)
  }
  return mapped
}

/**
 * An item of a queue or radio (`playlistPanelVideoRenderer`, possibly inside a
 * `playlistPanelVideoWrapperRenderer`), as a track. Its byline is `longBylineText`; when that
 * links no artist, `shortBylineText` names them.
 */
export function mapPanelVideo(wrapper: unknown, options: MapOptions): Track | undefined {
  const renderer =
    recordAt(wrapper, 'playlistPanelVideoRenderer') ??
    recordAt(
      wrapper,
      'playlistPanelVideoWrapperRenderer',
      'primaryRenderer',
      'playlistPanelVideoRenderer',
    )
  if (renderer === undefined) return undefined
  const watch = watchTarget(renderer.navigationEndpoint)
  const { itemTypes } = options.config.labels
  let byline = parseByline(runsOf(renderer.longBylineText), options.source, itemTypes)
  if (!byline.artists.some((artist) => artist.id !== undefined)) {
    const short = parseByline(runsOf(renderer.shortBylineText), options.source, itemTypes)
    if (short.artists.length > 0) byline = { ...byline, artists: short.artists }
  }
  return buildTrack(options, {
    videoId: asString(renderer.videoId) ?? watch?.videoId,
    title: textOf(renderer.title),
    musicVideoType: watch?.musicVideoType,
    episode: false,
    byline,
    durationMs: parseDuration(textOf(renderer.lengthText)) ?? byline.durationMs,
    artwork: artworkOf(at(renderer, 'thumbnail', 'thumbnails')),
    explicit: isExplicit(renderer),
  })
}
