/**
 * What a plugin's handlers return, checked and turned into `@fxm/core`'s types. A plugin speaks
 * in its own native IDs; FXM builds every entity ID itself (`plugin.<id>:<kind>:<native ID>`),
 * so a plugin can never hand out another source's IDs. Texts are cleaned and cut, numbers
 * checked, lists cut to {@link RESULT_LIMITS}, and every URL a result carries (artwork, streams)
 * must be `https:` on one of the plugin's declared hosts, so that FXM contacts no other host on
 * its behalf; artwork elsewhere is dropped, and a stream elsewhere is too.
 *
 * A malformed item in a list is dropped; a malformed result as a whole is a `bad-result`
 * `PluginError`.
 *
 * @module
 */

import {
  type Album,
  type AlbumRef,
  type AlbumType,
  type Artist,
  type ArtistRef,
  type Artwork,
  type AudioCandidate,
  applyModeFilter,
  type CatalogMode,
  type Codec,
  type Container,
  compareStreams,
  type EntityKind,
  filterPlayable,
  formatId,
  isCodec,
  isVideoKind,
  normalizeIsrc,
  type Page,
  type Playlist,
  type PluginSourceId,
  type SearchResults,
  type SearchType,
  type StreamOption,
  type Track,
  type TrackKind,
  tierOf,
} from '@fxm/core'
import { cleanText, PluginError } from './errors'
import { isDeclaredUrl } from './manifest'

/** Limits on what a result may carry. */
export const RESULT_LIMITS = {
  /** Items in one list. */
  items: 200,
  /** Sizes of one artwork. */
  artwork: 8,
  /** Artists credited on one item. */
  artists: 20,
  /** Tags on one track. */
  tags: 10,
  /** Search suggestions. */
  suggestions: 20,
  /** A native ID, in characters. */
  id: 512,
  /** A title or name, in characters. */
  name: 300,
  /** A description, in characters. */
  description: 2000,
  /** A cursor, in characters. */
  cursor: 1024,
  /** A URL, in characters. */
  url: 4096,
  /** Streams for one candidate. */
  streams: 20,
  /** Candidates for one track. */
  candidates: 20,
} as const

/** What results are checked against: the plugin's source, hosts and name, and the mode. */
export interface ResultContext {
  /** The plugin's source ID. */
  readonly source: PluginSourceId
  /** Its declared hosts. */
  readonly hosts: readonly string[]
  /** Its name, for messages. */
  readonly name: string
  /** The catalog mode of the call. */
  readonly mode: CatalogMode
}

type Data = Record<string, unknown>

function isData(value: unknown): value is Data {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function badResult(rc: ResultContext, what: string): PluginError {
  return new PluginError('bad-result', `${rc.name} returned ${what}`)
}

/** A cleaned, non-empty text, or `undefined`. */
function text(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const cleaned = cleanText(value, max)
  return cleaned === '' ? undefined : cleaned
}

/** A native ID: text without control characters, or a whole number; `undefined` otherwise. */
export function nativeId(value: unknown): string | undefined {
  const id = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value
  if (typeof id !== 'string' || id.length === 0 || id.length > RESULT_LIMITS.id) return undefined
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are refused
  return /[\u0000-\u001f\u007f]/u.test(id) ? undefined : id
}

function positiveInt(value: unknown, max: number): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= max
    ? value
    : undefined
}

function list(value: unknown, max: number = RESULT_LIMITS.items): unknown[] {
  return Array.isArray(value) ? value.slice(0, max) : []
}

function entityId<K extends EntityKind>(rc: ResultContext, kind: K, value: unknown) {
  const id = nativeId(value)
  return id === undefined ? undefined : formatId(rc.source, kind, id)
}

/** An HTTPS URL on a declared host, or `undefined`. */
function declaredUrl(rc: ResultContext, value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > RESULT_LIMITS.url) return undefined
  return isDeclaredUrl(rc.hosts, value) ? new URL(value).href : undefined
}

function artwork(rc: ResultContext, value: unknown): Artwork[] {
  const result: Artwork[] = []
  for (const entry of list(value, RESULT_LIMITS.artwork)) {
    const data = isData(entry) ? entry : { url: entry }
    const url = declaredUrl(rc, data.url)
    if (url === undefined) continue
    const width = positiveInt(data.width, 20_000)
    const height = positiveInt(data.height, 20_000)
    result.push({
      url,
      ...(width === undefined ? {} : { width }),
      ...(height === undefined ? {} : { height }),
    })
  }
  return result
}

function artistRef(rc: ResultContext, value: unknown): ArtistRef | undefined {
  const data = isData(value) ? value : { name: value }
  const name = text(data.name, RESULT_LIMITS.name)
  if (name === undefined) return undefined
  const id = entityId(rc, 'artist', data.id)
  return id === undefined ? { name } : { id, name }
}

function artistRefs(rc: ResultContext, value: unknown): ArtistRef[] {
  const refs: ArtistRef[] = []
  for (const entry of list(value, RESULT_LIMITS.artists)) {
    const ref = artistRef(rc, entry)
    if (ref !== undefined) refs.push(ref)
  }
  return refs
}

function albumRef(rc: ResultContext, value: unknown): AlbumRef | undefined {
  if (value === undefined || value === null) return undefined
  const data = isData(value) ? value : { name: value }
  const name = text(data.name ?? data.title, RESULT_LIMITS.name)
  if (name === undefined) return undefined
  const id = entityId(rc, 'album', data.id)
  return id === undefined ? { name } : { id, name }
}

const TRACK_KINDS: readonly TrackKind[] = ['song', 'music-video', 'video', 'episode']

function trackKind(value: unknown): TrackKind | undefined {
  if (value === undefined) return 'song'
  return TRACK_KINDS.find((kind) => kind === value)
}

/** A duration in milliseconds: positive, at most a day. */
function duration(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 86_400_000
    ? Math.round(value)
    : undefined
}

function releaseDate(value: unknown): string | undefined {
  return typeof value === 'string' && /^\d{4}(?:-\d{2}(?:-\d{2})?)?$/u.test(value)
    ? value
    : undefined
}

function tags(value: unknown): string[] | undefined {
  const result: string[] = []
  for (const entry of list(value, RESULT_LIMITS.tags)) {
    const tag = text(entry, 50)
    if (tag !== undefined && !result.includes(tag)) result.push(tag)
  }
  return result.length === 0 ? undefined : result
}

/** One track, or `undefined` when it is malformed. */
function maybeTrack(rc: ResultContext, value: unknown): Track | undefined {
  if (!isData(value)) return undefined
  const id = entityId(rc, 'track', value.id)
  const title = text(value.title ?? value.name, RESULT_LIMITS.name)
  const kind = trackKind(value.kind)
  if (id === undefined || title === undefined || kind === undefined) return undefined
  const album = albumRef(rc, value.album)
  const durationMs = duration(value.durationMs)
  const isrc = normalizeIsrc(value.isrc)
  const trackNumber = positiveInt(value.trackNumber, 9999)
  const discNumber = positiveInt(value.discNumber, 999)
  const date = releaseDate(value.releaseDate)
  const popularity =
    typeof value.popularity === 'number' && value.popularity >= 0 && value.popularity <= 100
      ? value.popularity
      : undefined
  const trackTags = tags(value.tags)
  const songId = kind === 'music-video' ? entityId(rc, 'track', value.songId) : undefined
  return {
    id,
    source: rc.source,
    title,
    artists: artistRefs(rc, value.artists),
    ...(album === undefined ? {} : { album }),
    ...(durationMs === undefined ? {} : { durationMs }),
    artwork: artwork(rc, value.artwork),
    ...(typeof value.explicit === 'boolean' ? { explicit: value.explicit } : {}),
    ...(isrc === null ? {} : { isrc }),
    kind,
    ...(songId === undefined || songId === id ? {} : { songId }),
    ...(trackNumber === undefined ? {} : { trackNumber }),
    ...(discNumber === undefined ? {} : { discNumber }),
    ...(date === undefined ? {} : { releaseDate: date }),
    ...(popularity === undefined ? {} : { popularity }),
    ...(trackTags === undefined ? {} : { tags: trackTags }),
  }
}

/** Tracks of a list, malformed ones dropped, filtered for the mode's lists. */
function tracks(rc: ResultContext, value: unknown): Track[] {
  const result: Track[] = []
  for (const entry of list(value)) {
    const track = maybeTrack(rc, entry)
    if (track !== undefined) result.push(track)
  }
  return applyModeFilter(result, rc.mode)
}

const ALBUM_TYPES: readonly AlbumType[] = ['album', 'single', 'ep', 'compilation']

function maybeAlbum(rc: ResultContext, value: unknown, withTracks: boolean): Album | undefined {
  if (!isData(value)) return undefined
  const id = entityId(rc, 'album', value.id)
  const name = text(value.name ?? value.title, RESULT_LIMITS.name)
  if (id === undefined || name === undefined) return undefined
  const type = ALBUM_TYPES.find((candidate) => candidate === value.type)
  const date = releaseDate(value.releaseDate)
  const trackCount = positiveInt(value.trackCount, 100_000)
  return {
    id,
    source: rc.source,
    name,
    artists: artistRefs(rc, value.artists),
    artwork: artwork(rc, value.artwork),
    ...(type === undefined ? {} : { type }),
    ...(date === undefined ? {} : { releaseDate: date }),
    ...(trackCount === undefined ? {} : { trackCount }),
    ...(typeof value.explicit === 'boolean' ? { explicit: value.explicit } : {}),
    ...(withTracks && Array.isArray(value.tracks) ? { tracks: tracks(rc, value.tracks) } : {}),
  }
}

function albums(rc: ResultContext, value: unknown): Album[] {
  const result: Album[] = []
  for (const entry of list(value)) {
    const album = maybeAlbum(rc, entry, false)
    if (album !== undefined) result.push(album)
  }
  return result
}

function maybeArtist(rc: ResultContext, value: unknown, full: boolean): Artist | undefined {
  if (!isData(value)) return undefined
  const id = entityId(rc, 'artist', value.id)
  const name = text(value.name, RESULT_LIMITS.name)
  if (id === undefined || name === undefined) return undefined
  const description = text(value.description, RESULT_LIMITS.description)
  return {
    id,
    source: rc.source,
    name,
    artwork: artwork(rc, value.artwork),
    ...(description === undefined ? {} : { description }),
    ...(full && Array.isArray(value.topTracks) ? { topTracks: tracks(rc, value.topTracks) } : {}),
    ...(full && Array.isArray(value.albums) ? { albums: albums(rc, value.albums) } : {}),
    ...(full && Array.isArray(value.related) ? { related: artists(rc, value.related) } : {}),
  }
}

function artists(rc: ResultContext, value: unknown): Artist[] {
  const result: Artist[] = []
  for (const entry of list(value)) {
    const artist = maybeArtist(rc, entry, false)
    if (artist !== undefined) result.push(artist)
  }
  return result
}

function maybePlaylist(
  rc: ResultContext,
  value: unknown,
  withTracks: boolean,
): Playlist | undefined {
  if (!isData(value)) return undefined
  const id = entityId(rc, 'playlist', value.id)
  const name = text(value.name ?? value.title, RESULT_LIMITS.name)
  if (id === undefined || name === undefined) return undefined
  const ownerData = isData(value.owner) ? value.owner : { name: value.owner }
  const ownerName = text(ownerData.name, RESULT_LIMITS.name)
  const ownerId = nativeId(ownerData.id)
  const description = text(value.description, RESULT_LIMITS.description)
  const trackCount = positiveInt(value.trackCount, 1_000_000)
  return {
    id,
    source: rc.source,
    name,
    ...(ownerName === undefined
      ? {}
      : { owner: ownerId === undefined ? { name: ownerName } : { name: ownerName, id: ownerId } }),
    ...(description === undefined ? {} : { description }),
    artwork: artwork(rc, value.artwork),
    ...(trackCount === undefined ? {} : { trackCount }),
    ...(withTracks && value.tracks !== undefined
      ? { tracks: page(rc, value.tracks, (items) => tracks(rc, items)) }
      : {}),
  }
}

function playlists(rc: ResultContext, value: unknown): Playlist[] {
  const result: Playlist[] = []
  for (const entry of list(value)) {
    const playlist = maybePlaylist(rc, entry, false)
    if (playlist !== undefined) result.push(playlist)
  }
  return result
}

/** A page: `{ items, nextCursor, total }`, or a plain list for a page without more. */
function page<T>(rc: ResultContext, value: unknown, items: (raw: unknown) => T[]): Page<T> {
  if (Array.isArray(value)) return { items: items(value) }
  if (!isData(value)) throw badResult(rc, 'a page that is neither a list nor { items }')
  const cursor =
    typeof value.nextCursor === 'string' &&
    value.nextCursor !== '' &&
    value.nextCursor.length <= RESULT_LIMITS.cursor
      ? value.nextCursor
      : undefined
  const total =
    typeof value.total === 'number' && Number.isInteger(value.total) && value.total >= 0
      ? value.total
      : undefined
  return {
    items: items(value.items),
    ...(cursor === undefined ? {} : { nextCursor: cursor }),
    ...(total === undefined ? {} : { total }),
  }
}

/**
 * Search results, one page per requested type. Songs go to `tracks` and videos to `videos`,
 * whichever list the plugin put them in; `videos` stays empty in Music mode, and episodes are
 * dropped. A requested type the plugin left out is an empty page.
 */
export function toSearchResults(
  rc: ResultContext,
  value: unknown,
  types: readonly SearchType[],
): SearchResults {
  if (!isData(value)) throw badResult(rc, 'search results that are not an object')
  const results: SearchResults = {}
  const wantsTracks = types.includes('track')
  const wantsVideos = types.includes('video')
  if (wantsTracks || wantsVideos) {
    const songs = page(rc, value.tracks ?? [], (items) => tracks(rc, items))
    const videos = page(rc, value.videos ?? [], (items) => tracks(rc, items))
    const all = [...songs.items, ...videos.items]
    if (wantsTracks) {
      results.tracks = { ...songs, items: all.filter((track) => track.kind === 'song') }
    }
    if (wantsVideos) {
      results.videos =
        rc.mode === 'all'
          ? { ...videos, items: all.filter((track) => isVideoKind(track.kind)) }
          : { items: [] }
    }
  }
  if (types.includes('album')) results.albums = page(rc, value.albums ?? [], (i) => albums(rc, i))
  if (types.includes('artist')) {
    results.artists = page(rc, value.artists ?? [], (i) => artists(rc, i))
  }
  if (types.includes('playlist')) {
    results.playlists = page(rc, value.playlists ?? [], (i) => playlists(rc, i))
  }
  return results
}

/** Search suggestions: cleaned, de-duplicated, at most 20. */
export function toSuggestions(rc: ResultContext, value: unknown): string[] {
  if (!Array.isArray(value)) throw badResult(rc, 'suggestions that are not a list')
  const result: string[] = []
  for (const entry of value) {
    const suggestion = text(entry, 200)
    if (suggestion !== undefined && !result.includes(suggestion)) result.push(suggestion)
    if (result.length >= RESULT_LIMITS.suggestions) break
  }
  return result
}

/** One track. */
export function toTrack(rc: ResultContext, value: unknown): Track {
  const track = maybeTrack(rc, value)
  if (track === undefined) throw badResult(rc, 'a track without an id or a title')
  return track
}

/** Tracks of a list (radio, say), filtered for the mode's lists. */
export function toTracks(rc: ResultContext, value: unknown): Track[] {
  if (!Array.isArray(value)) throw badResult(rc, 'tracks that are not a list')
  return tracks(rc, value)
}

/** One album with its tracks. */
export function toAlbum(rc: ResultContext, value: unknown): Album {
  const album = maybeAlbum(rc, value, true)
  if (album === undefined) throw badResult(rc, 'an album without an id or a name')
  return album
}

/** One artist with its page. */
export function toArtist(rc: ResultContext, value: unknown): Artist {
  const artist = maybeArtist(rc, value, true)
  if (artist === undefined) throw badResult(rc, 'an artist without an id or a name')
  return artist
}

/** One playlist with a page of its tracks. */
export function toPlaylist(rc: ResultContext, value: unknown): Playlist {
  const playlist = maybePlaylist(rc, value, true)
  if (playlist === undefined) throw badResult(rc, 'a playlist without an id or a name')
  return playlist
}

/** A page of a playlist's tracks, from a playlist or a page. */
export function toTrackPage(rc: ResultContext, value: unknown): Page<Track> {
  const raw = isData(value) && 'tracks' in value && !('items' in value) ? value.tracks : value
  return page(rc, raw, (items) => tracks(rc, items))
}

/**
 * Audio candidates, best first, each playable in the mode as it is. A plugin's confidence is
 * its own claim, from 0 to 1, and the evidence names the plugin; the matching engine weighs
 * candidates itself.
 */
export function toCandidates(rc: ResultContext, value: unknown): AudioCandidate[] {
  if (!Array.isArray(value)) throw badResult(rc, 'candidates that are not a list')
  const result: AudioCandidate[] = []
  for (const entry of value.slice(0, RESULT_LIMITS.candidates)) {
    if (!isData(entry)) continue
    const ref = nativeId(entry.id)
    const title = text(entry.title, RESULT_LIMITS.name)
    const kind = trackKind(entry.kind)
    if (ref === undefined || title === undefined || kind === undefined) continue
    const names = artistRefs(rc, entry.artists).map((artist) => artist.name)
    const durationMs = duration(entry.durationMs)
    const confidence =
      typeof entry.confidence === 'number' && Number.isFinite(entry.confidence)
        ? Math.min(1, Math.max(0, entry.confidence))
        : 0
    const evidence = [`plugin ${rc.source.slice('plugin.'.length)}`]
    for (const note of list(entry.evidence, 5)) {
      const line = text(note, 80)
      if (line !== undefined) evidence.push(line)
    }
    result.push({
      source: rc.source,
      ref,
      kind,
      title,
      artists: names,
      ...(durationMs === undefined ? {} : { durationMs }),
      confidence,
      evidence,
    })
  }
  return filterPlayable(result, rc.mode)
}

const CONTAINERS: readonly Container[] = ['webm', 'mp4', 'm4a', 'mp3', 'ogg', 'flac', 'wav']

/**
 * Stream options, best first. Only progressive streams on a declared host count. FXM can't
 * check a plugin's URL, so every option is `unverified` unless the plugin says it is `capped`;
 * the player's first request is the probe. No option carries request headers.
 */
export function toStreams(rc: ResultContext, value: unknown): StreamOption[] {
  if (!Array.isArray(value)) throw badResult(rc, 'streams that are not a list')
  const result: StreamOption[] = []
  for (const entry of value.slice(0, RESULT_LIMITS.streams)) {
    if (!isData(entry)) continue
    const url = declaredUrl(rc, entry.url)
    const codec = isCodec(entry.codec) ? (entry.codec as Codec) : undefined
    const container = CONTAINERS.find((candidate) => candidate === entry.container)
    if (url === undefined || codec === undefined || container === undefined) continue
    if (entry.protocol !== undefined && entry.protocol !== 'progressive') continue
    const bitrateKbps =
      typeof entry.bitrateKbps === 'number' &&
      Number.isFinite(entry.bitrateKbps) &&
      entry.bitrateKbps > 0 &&
      entry.bitrateKbps <= 10_000
        ? entry.bitrateKbps
        : undefined
    const sampleRateHz = positiveInt(entry.sampleRateHz, 768_000)
    const bitDepth = positiveInt(entry.bitDepth, 64)
    const expiresAt =
      typeof entry.expiresAt === 'number' && Number.isFinite(entry.expiresAt) && entry.expiresAt > 0
        ? entry.expiresAt
        : undefined
    result.push({
      url,
      codec,
      container,
      media: entry.media === 'muxed-video' ? 'muxed-video' : 'audio',
      ...(bitrateKbps === undefined ? {} : { bitrateKbps }),
      ...(sampleRateHz === undefined ? {} : { sampleRateHz }),
      ...(bitDepth === undefined ? {} : { bitDepth }),
      tier: tierOf({ codec, ...(bitrateKbps === undefined ? {} : { bitrateKbps }) }),
      protocol: 'progressive',
      ...(expiresAt === undefined ? {} : { expiresAt }),
      ipBound: entry.ipBound === true,
      fullLength: entry.capped === true ? 'capped' : 'unverified',
      ...(entry.downloadAllowed === false ? { downloadAllowed: false } : {}),
    })
  }
  return result.sort(compareStreams)
}
