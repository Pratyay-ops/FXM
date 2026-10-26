/**
 * What the embed's layouts render: a view model built from the controller's state, or, for the
 * share dialog's preview, from metadata the app already has. Pure functions, so the layouts
 * stay presentational and both places look the same.
 *
 * @module
 */

import { type ArtistRef, type Artwork, parseId, type Track } from '@fxm/core'
import type { PlayerStatus } from '@fxm/player'
import { RELEASED } from '../features/connect/config'
import { canAddConnect, currentDevice, type DeviceInfo } from '../features/connect/device'
import { howToGetMore } from '../features/connect/explain'
import type { EmbedAttribution, EmbedEntity } from './catalog'
import type { EmbedProblem, EmbedState, PlaybackNotice } from './controller'
import {
  appUrlFor,
  type EmbedKind,
  type EmbedLayout,
  type EmbedSource,
  type EmbedTarget,
  installUrlFor,
  isEmbedSource,
} from './target'

/** One row of an album's or playlist's track list. */
export interface EmbedRow {
  /** A key unique within the list. */
  readonly key: string
  /** The track's title. */
  readonly title: string
  /** Its artists, joined. */
  readonly artists: string
  /** Its duration in milliseconds, when known. */
  readonly durationMs?: number
}

/**
 * What the embed tells the visitor in place of, or under, the player: why its content can't
 * play here, or why the last track didn't.
 */
export type EmbedMessageKind = EmbedProblem | PlaybackNotice

/** A message with its text and what the visitor can do about it. */
export interface EmbedMessage {
  /** Which message. */
  readonly kind: EmbedMessageKind
  /** One or two sentences for the visitor. */
  readonly text: string
  /**
   * The same in a few words, for where room is short: the compact layout, and the card's
   * controls row next to the play button. Two lines at about 130 px.
   */
  readonly short: string
  /** The action that helps: get FXM (the install hint), open FXM, or try again. */
  readonly action?: 'install' | 'open' | 'retry'
}

/**
 * Credits as the embed shows them. The links are there only when they lead to the source's
 * own site or to the licence (see {@link creditLink}); the provider's name always shows.
 */
export interface EmbedCredit {
  /** Who to credit as the source, e.g. `Internet Archive`. */
  readonly provider: string
  /** The track's page at the source. */
  readonly pageUrl?: string
  /** The licence, e.g. a Creative Commons deed. */
  readonly licenseUrl?: string
}

/** The view model of one embed. */
export interface EmbedView {
  /** The layout. */
  readonly layout: EmbedLayout
  /** What the embed shows. */
  readonly kind: EmbedKind
  /** Whether the content is still loading. */
  readonly loading: boolean
  /** The track's title, or the album's or playlist's name, once known. */
  readonly title?: string
  /** The artists, or who made the playlist, once known. */
  readonly subtitle?: string
  /** "Song", "Album · 12 songs", "Playlist · 30 songs". */
  readonly kindLabel: string
  /** Cover art; may be empty. */
  readonly artwork: readonly Artwork[]
  /** A stable seed for the placeholder artwork. */
  readonly seed: string
  /** The track list of an album or playlist; empty for a track. */
  readonly rows: readonly EmbedRow[]
  /** In a preview of a collection whose tracks the app doesn't have: placeholder rows to show. */
  readonly placeholderRows?: number
  /** The current track's position in `rows`, or -1. */
  readonly currentIndex: number
  /** The current track's title and artists, for the compact layout of a collection. */
  readonly now?: { readonly title: string; readonly artists: string }
  /** What the player does. `idle` until the visitor presses play. */
  readonly status: PlayerStatus
  /** Whether playback waits for data. */
  readonly buffering: boolean
  /** How far into the current track playback is, in milliseconds. */
  readonly positionMs: number
  /** The current track's duration in milliseconds, when known. */
  readonly durationMs?: number
  /** Whether there is more than one track to skip between. */
  readonly canSkip: boolean
  /** Whether the visitor can press play. */
  readonly canPlay: boolean
  /** A message for the visitor, if any. */
  readonly message?: EmbedMessage
  /** Where "Open in FXM" and the install hint lead, on the embed's own origin. */
  readonly links: { readonly open: string; readonly install: string }
  /** Credits for the current track, when its source asks for them. */
  readonly attribution?: EmbedCredit
}

const KIND_NAMES: Readonly<Record<EmbedKind, string>> = {
  track: 'Song',
  album: 'Album',
  playlist: 'Playlist',
}

const NOUNS: Readonly<Record<EmbedKind, string>> = {
  track: 'A song',
  album: 'An album',
  playlist: 'A playlist',
}

const SOURCE_NAMES: Readonly<Record<EmbedSource, string>> = {
  ytm: 'YouTube Music',
  yt: 'YouTube',
  archive: 'Internet Archive',
  jamendo: 'Jamendo',
}

/**
 * What to call content whose metadata couldn't load, e.g. without access to YouTube: "A song
 * from YouTube Music", "An album from Jamendo". Its address says that much.
 */
export function placeholderTitle(target: EmbedTarget): string {
  const { source } = parseId(target.id)
  const noun = target.kind === 'track' && source === 'yt' ? 'A video' : NOUNS[target.kind]
  return isEmbedSource(source) ? `${noun} from ${SOURCE_NAMES[source]}` : noun
}

/** What the kind is called: "Song", "Album", "Playlist". */
export function kindNameOf(kind: EmbedKind): string {
  return KIND_NAMES[kind]
}

/** "1 song", "12 songs". */
export function songCount(count: number): string {
  return `${count} ${count === 1 ? 'song' : 'songs'}`
}

/** Artist names joined for display: "A, B & C". */
export function joinArtists(artists: readonly ArtistRef[]): string {
  const names = artists.map((artist) => artist.name).filter((name) => name.trim() !== '')
  if (names.length <= 1) return names[0] ?? ''
  return `${names.slice(0, -1).join(', ')} & ${names.at(-1)}`
}

/**
 * Whether the install hint may offer the FXM app: once the desktop app (stage 7.5) or the
 * Android app (6.6) is out. Until then it names only FXM Connect.
 */
const APP_OUT: boolean = RELEASED.desktop || RELEASED.android

/** Where the player runs, for the messages that depend on it. */
export interface EmbedPlace {
  /**
   * Whether the player is in a frame, as on another site's page, rather than a page of its own.
   * FXM Connect never reaches a framed player (its content script skips frames), so a framed
   * player never suggests adding it. Default: framed, the player's usual place.
   */
  readonly framed?: boolean
  /** The visitor's device, for the advice of a player on a page of its own. Default: this one. */
  readonly device?: DeviceInfo
}

/**
 * What YouTube content needs where the player can't reach YouTube. In another site's frame,
 * FXM Connect wouldn't help, so it offers to open the content in FXM. On a page of its own, the
 * install hint, worded for the device as the app words it: FXM Connect where the browser can
 * add it, and elsewhere what the device can do instead (`howToGetMore`).
 */
function needsYouTubeMessage(kind: EmbedMessageKind, place: EmbedPlace): EmbedMessage {
  if (place.framed ?? true) {
    return {
      kind,
      text: "YouTube Music can't play in this player in this browser. Open it in FXM instead.",
      short: "YouTube Music can't play here.",
      action: 'open',
    }
  }
  const device = place.device ?? currentDevice()
  if (!canAddConnect(device)) {
    return {
      kind,
      text: howToGetMore(device, 'youtube'),
      short: "YouTube Music can't play in this browser.",
      action: 'install',
    }
  }
  return {
    kind,
    text: `FXM can't reach YouTube Music in this browser. Add the free FXM Connect extension${APP_OUT ? ', or get the FXM app' : ''}.`,
    short: APP_OUT
      ? 'Needs FXM Connect or the FXM app to play here.'
      : 'Needs FXM Connect to play here.',
    action: 'install',
  }
}

/** The texts and action for each message. */
export function messageFor(
  kind: EmbedMessageKind,
  target: EmbedKind,
  place: EmbedPlace = {},
): EmbedMessage {
  const what = target === 'track' ? 'song' : target
  switch (kind) {
    case 'needs-youtube':
      return needsYouTubeMessage(kind, place)
    case 'not-found':
      return {
        kind,
        text: `This ${what} isn't available.`,
        short: "It isn't available.",
        action: 'open',
      }
    case 'hidden-by-mode':
      return {
        kind,
        text: 'This is a video, and this player plays songs only.',
        short: 'A video: this player plays songs only.',
        action: 'open',
      }
    case 'empty':
      return {
        kind,
        text: `This ${what} has nothing this player can play.`,
        short: 'Nothing here this player can play.',
        action: 'open',
      }
    case 'unsupported':
      return {
        kind,
        text: `This player can't play this ${what} here.`,
        short: "This player can't play it here.",
        action: 'open',
      }
    case 'failed':
      return {
        kind,
        text: "Couldn't load this. Check your connection and try again.",
        short: "Couldn't load this. Try again.",
        action: 'retry',
      }
    case 'bot-check':
      return {
        kind,
        text: 'YouTube wants to check this browser. Try again later, or open it in FXM.',
        short: 'YouTube wants to check this browser.',
        action: 'open',
      }
    case 'unavailable':
      return {
        kind,
        text: "This song isn't available here.",
        short: "This song isn't available here.",
        action: 'open',
      }
  }
}

/** The playback notices' texts differ from the load problems' where both exist. */
function noticeMessage(notice: PlaybackNotice, target: EmbedKind, place: EmbedPlace): EmbedMessage {
  if (notice === 'failed') {
    const text = "Couldn't play this. Try again."
    return { kind: notice, text, short: text }
  }
  return messageFor(notice, target, place)
}

/**
 * The sites credits may link to, each with its subdomains: the free sources and the licences
 * they use.
 */
export const CREDIT_HOSTS: readonly string[] = ['archive.org', 'jamendo.com', 'creativecommons.org']

/**
 * `url` as a credit's link, or `undefined` when a credit may not link to it. A source's URLs
 * come from whoever uploaded the item (an Internet Archive item's licence URL, say), so only
 * HTTPS links without a user name, a password or a port, to one of the {@link CREDIT_HOSTS},
 * count; plain HTTP to them is upgraded, as each of them serves HTTPS. Anything else, such as
 * another site, `javascript:` or an app's own scheme, gets no link.
 */
export function creditLink(url: string | undefined): string | undefined {
  if (url === undefined || url.length > 2048) return undefined
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return undefined
  }
  if (parsed.protocol === 'http:') parsed.protocol = 'https:'
  if (parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== '') {
    return undefined
  }
  if (parsed.port !== '') return undefined
  const host = parsed.hostname
  const known = CREDIT_HOSTS.some((site) => host === site || host.endsWith(`.${site}`))
  return known ? parsed.href : undefined
}

/** The credits as the embed shows them: the provider's name, with only links it may follow. */
export function creditOf(attribution: EmbedAttribution): EmbedCredit {
  const pageUrl = creditLink(attribution.pageUrl)
  const licenseUrl = creditLink(attribution.licenseUrl)
  return {
    provider: attribution.provider,
    ...(pageUrl === undefined ? {} : { pageUrl }),
    ...(licenseUrl === undefined ? {} : { licenseUrl }),
  }
}

/** Rows for a list of tracks. */
function rowsOf(tracks: readonly Track[]): EmbedRow[] {
  return tracks.map((track, index) => ({
    key: `${index}:${track.id}`,
    title: track.title,
    artists: joinArtists(track.artists),
    ...(track.durationMs === undefined ? {} : { durationMs: track.durationMs }),
  }))
}

/** The subtitle of a loaded entity: its artists, or the playlist's owner. */
function subtitleOf(entity: EmbedEntity): string {
  return entity.target.kind === 'playlist' ? (entity.owner ?? '') : joinArtists(entity.artists)
}

/** "Song", or the kind with its number of tracks. */
function kindLabelOf(kind: EmbedKind, count: number | undefined): string {
  if (kind === 'track' || count === undefined || count === 0) return KIND_NAMES[kind]
  return `${KIND_NAMES[kind]} · ${songCount(count)}`
}

/** Options for {@link embedView}. */
export interface EmbedViewOptions extends EmbedPlace {
  /** The layout from the address. */
  readonly layout: EmbedLayout
  /** What the address named. */
  readonly target: EmbedTarget
  /** The embed's own origin, for its links. */
  readonly origin: string
  /** Credits for a track, from the catalog. */
  readonly attribution?: (track: Track) => EmbedAttribution | undefined
}

/** The view model of the embed in `state`. */
export function embedView(state: EmbedState, options: EmbedViewOptions): EmbedView {
  const { layout, target, origin } = options
  const entity = state.entity
  const player = state.player
  const items = player?.queue.items ?? []
  const index = player?.queue.index ?? -1
  // Nothing is current until playback starts: the list and the compact layout show the album.
  const current = state.started === true ? items[index]?.track : undefined
  const tracks = items.map((item) => item.track)
  const message =
    state.phase === 'unavailable' && state.problem !== undefined
      ? messageFor(state.problem, target.kind, options)
      : state.notice === undefined
        ? undefined
        : noticeMessage(state.notice, target.kind, options)
  const credits = current === undefined ? undefined : options.attribution?.(current)
  const attribution = credits === undefined ? undefined : creditOf(credits)
  const durationMs = player?.durationMs ?? current?.durationMs ?? items[index]?.track.durationMs
  // A track has no app page: its link searches the app for it, once its title is known.
  const artist = entity?.artists[0]?.name
  const hint =
    entity === undefined ? {} : { title: entity.title, ...(artist === undefined ? {} : { artist }) }
  return {
    layout,
    kind: target.kind,
    loading: state.phase === 'loading',
    ...(entity !== undefined
      ? { title: entity.title, subtitle: subtitleOf(entity) }
      : state.phase === 'unavailable'
        ? { title: placeholderTitle(target) }
        : {}),
    kindLabel: kindLabelOf(target.kind, entity === undefined ? undefined : entity.trackCount),
    artwork: entity?.artwork ?? [],
    seed: target.id,
    rows: target.kind === 'track' ? [] : rowsOf(tracks),
    currentIndex: current === undefined ? -1 : index,
    ...(current === undefined
      ? {}
      : { now: { title: current.title, artists: joinArtists(current.artists) } }),
    status: state.started === true ? (player?.status ?? 'idle') : 'idle',
    buffering: player?.buffering ?? false,
    positionMs: player?.positionMs ?? 0,
    ...(durationMs === undefined ? {} : { durationMs }),
    canSkip: items.length > 1,
    canPlay: state.phase === 'ready',
    ...(message === undefined ? {} : { message }),
    links: { open: appUrlFor(origin, target, hint), install: installUrlFor(origin) },
    ...(attribution === undefined ? {} : { attribution }),
  }
}

/** What the share dialog knows about the item it shares. */
export interface PreviewInfo {
  /** The track's title, or the album's or playlist's name. */
  readonly title: string
  /** The artists, or who made the playlist. */
  readonly subtitle?: string
  /** Cover art, when the app has it. */
  readonly artwork?: readonly Artwork[]
  /** The tracks of an album or playlist, when the app has them. */
  readonly tracks?: readonly Track[]
  /** How many tracks it has, when known without them. */
  readonly trackCount?: number
}

/**
 * The view model of an embed that hasn't started: what the share dialog previews, built from
 * what the app knows about the item.
 */
export function previewView(
  target: EmbedTarget,
  layout: EmbedLayout,
  info: PreviewInfo,
  origin: string,
): EmbedView {
  const tracks = info.tracks ?? []
  const count = info.trackCount ?? (tracks.length > 0 ? tracks.length : undefined)
  const first = tracks[0]
  const artist = first?.artists[0]?.name ?? (info.subtitle || undefined)
  const hint = { title: info.title, ...(artist === undefined ? {} : { artist }) }
  return {
    layout,
    kind: target.kind,
    loading: false,
    title: info.title,
    subtitle: info.subtitle ?? '',
    kindLabel: kindLabelOf(target.kind, count),
    artwork: info.artwork ?? [],
    seed: target.id,
    rows: target.kind === 'track' ? [] : rowsOf(tracks),
    ...(target.kind !== 'track' && tracks.length === 0 ? { placeholderRows: 4 } : {}),
    currentIndex: first === undefined ? -1 : 0,
    ...(first === undefined
      ? {}
      : { now: { title: first.title, artists: joinArtists(first.artists) } }),
    status: 'idle',
    buffering: false,
    positionMs: 0,
    ...(first?.durationMs === undefined ? {} : { durationMs: first.durationMs }),
    canSkip: tracks.length > 1,
    canPlay: true,
    links: { open: appUrlFor(origin, target, hint), install: installUrlFor(origin) },
  }
}

/**
 * The URL of the artwork size that best fills `pixels` CSS pixels on this screen: the smallest
 * one at least that wide, else the largest. Only `https:` images count, which is all a
 * provider returns and all the embed's policy allows.
 */
export function pickArtwork(
  artwork: readonly Artwork[],
  pixels: number,
  density = 1,
): string | undefined {
  const usable = artwork.filter((image) => image.url.startsWith('https://'))
  if (usable.length === 0) return undefined
  const needed = pixels * density
  const sized = [...usable].sort((a, b) => (a.width ?? 0) - (b.width ?? 0))
  const fit = sized.find((image) => (image.width ?? 0) >= needed)
  return (fit ?? sized.at(-1))?.url
}
