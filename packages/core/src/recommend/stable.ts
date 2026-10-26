/**
 * Lists that stay put for their period, between builds and reloads: Discover for a week, the
 * Daily Mixes for a day. A build hands back the entries to keep (`HomeFeed.stable`), the app
 * stores them, and the next build reuses an entry while its period and catalog mode still
 * hold. What comes back from storage is untrusted: {@link sanitizeStableShelves} keeps only
 * well-formed entries and tracks.
 *
 * @module
 */

import { isEntityId, isSourceId, normalizeIsrc, parseId } from '../ids'
import { type CatalogMode, isCatalogMode } from '../mode'
import type { AlbumRef, ArtistRef, Artwork, Track, TrackKind } from '../model'
import type { DailyMix, HomeTrack } from './home'

/** Discover as it was built, kept for its week. */
export interface StableDiscover {
  readonly kind: 'discover'
  /** The catalog mode it was built in. */
  readonly mode: CatalogMode
  /** Its week (`periodKey('week', …)`). */
  readonly period: string
  /** Its tracks. */
  readonly items: readonly HomeTrack[]
}

/** The Daily Mixes as they were built, kept for their day. */
export interface StableMixes {
  readonly kind: 'mixes'
  /** The catalog mode they were built in. */
  readonly mode: CatalogMode
  /** Their day (`periodKey('day', …)`). */
  readonly period: string
  /** The mixes. */
  readonly mixes: readonly DailyMix[]
}

/** One list kept for its period. */
export type StableEntry = StableDiscover | StableMixes

/** The lists kept between builds: at most one per kind and mode. */
export interface StableShelves {
  readonly entries: readonly StableEntry[]
}

/** Nothing kept. */
export const NO_STABLE_SHELVES: StableShelves = Object.freeze({ entries: Object.freeze([]) })

const TRACK_KINDS: readonly TrackKind[] = ['song', 'music-video', 'video', 'episode']

/** Most tracks a stored list may hold, most mixes, and the longest texts kept. */
const MAX_ITEMS = 100
const MAX_MIXES = 12
const MAX_TEXT = 500
const MAX_TAGS = 20

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown, max = MAX_TEXT): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.slice(0, max) : undefined
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function sanitizeArtwork(value: unknown): Artwork[] {
  if (!Array.isArray(value)) return []
  const artwork: Artwork[] = []
  for (const item of value.slice(0, 10)) {
    if (!isRecord(item) || typeof item.url !== 'string' || !/^https?:\/\//iu.test(item.url)) {
      continue
    }
    const one: Artwork = { url: item.url }
    const width = count(item.width)
    const height = count(item.height)
    if (width !== undefined) one.width = width
    if (height !== undefined) one.height = height
    artwork.push(one)
  }
  return artwork
}

function sanitizeArtists(value: unknown): ArtistRef[] {
  if (!Array.isArray(value)) return []
  const artists: ArtistRef[] = []
  for (const item of value.slice(0, 20)) {
    const name = isRecord(item) ? text(item.name) : undefined
    if (name === undefined) continue
    artists.push(isEntityId(item?.id, 'artist') ? { id: item.id, name } : { name })
  }
  return artists
}

/**
 * A track read back from storage, or `undefined` when it isn't one: a valid track ID, a title, a
 * known kind. Optional fields that are malformed are left out; the source is the ID's.
 */
export function sanitizeTrack(value: unknown): Track | undefined {
  if (!isRecord(value) || !isEntityId(value.id, 'track')) return undefined
  const title = text(value.title)
  const kind = TRACK_KINDS.find((one) => one === value.kind)
  if (title === undefined || kind === undefined) return undefined
  const track: Track = {
    id: value.id,
    source: parseId(value.id).source,
    title,
    artists: sanitizeArtists(value.artists),
    artwork: sanitizeArtwork(value.artwork),
    kind,
  }
  if (isRecord(value.album)) {
    const name = text(value.album.name)
    if (name !== undefined) {
      const album: AlbumRef = { name }
      if (isEntityId(value.album.id, 'album')) album.id = value.album.id
      track.album = album
    }
  }
  const durationMs = count(value.durationMs)
  if (durationMs !== undefined) track.durationMs = durationMs
  if (typeof value.explicit === 'boolean') track.explicit = value.explicit
  const isrc = normalizeIsrc(value.isrc)
  if (isrc !== null) track.isrc = isrc
  if (isEntityId(value.songId, 'track')) track.songId = value.songId
  for (const field of ['trackNumber', 'discNumber'] as const) {
    const number = value[field]
    if (typeof number === 'number' && Number.isInteger(number) && number > 0) track[field] = number
  }
  const releaseDate = text(value.releaseDate, 32)
  if (releaseDate !== undefined) track.releaseDate = releaseDate
  const popularity = count(value.popularity)
  if (popularity !== undefined && popularity <= 100) track.popularity = popularity
  if (isRecord(value.externalIds)) {
    const externalIds: Track['externalIds'] = {}
    for (const [source, id] of Object.entries(value.externalIds)) {
      const native = text(id, 200)
      if (isSourceId(source) && native !== undefined) externalIds[source] = native
    }
    if (Object.keys(externalIds).length > 0) track.externalIds = externalIds
  }
  if (Array.isArray(value.tags)) {
    const tags = value.tags
      .map((tag) => text(tag, 64))
      .filter((tag) => tag !== undefined)
      .slice(0, MAX_TAGS)
    if (tags.length > 0) track.tags = tags
  }
  return track
}

function sanitizeHomeTracks(value: unknown): HomeTrack[] {
  if (!Array.isArray(value)) return []
  const items: HomeTrack[] = []
  for (const item of value.slice(0, MAX_ITEMS)) {
    if (!isRecord(item)) continue
    const track = sanitizeTrack(item.track)
    if (track === undefined) continue
    const score = typeof item.score === 'number' && Number.isFinite(item.score) ? item.score : 0
    items.push({ track, score, familiar: item.familiar === true })
  }
  return items
}

function sanitizeMix(value: unknown): DailyMix | undefined {
  if (!isRecord(value)) return undefined
  const id = text(value.id, 64)
  const title = text(value.title, 100)
  if (id === undefined || title === undefined) return undefined
  const artists = Array.isArray(value.artists)
    ? value.artists
        .map((name) => text(name, 200))
        .filter((name) => name !== undefined)
        .slice(0, 10)
    : []
  const tracks = sanitizeHomeTracks(value.tracks)
  return tracks.length === 0 ? undefined : { id, title, artists, tracks }
}

function sanitizeEntry(value: unknown): StableEntry | undefined {
  if (!isRecord(value) || !isCatalogMode(value.mode)) return undefined
  const period = text(value.period, 16)
  if (period === undefined) return undefined
  if (value.kind === 'discover') {
    const items = sanitizeHomeTracks(value.items)
    return items.length === 0 ? undefined : { kind: 'discover', mode: value.mode, period, items }
  }
  if (value.kind === 'mixes' && Array.isArray(value.mixes)) {
    const mixes = value.mixes
      .slice(0, MAX_MIXES)
      .map(sanitizeMix)
      .filter((mix) => mix !== undefined)
    return mixes.length === 0 ? undefined : { kind: 'mixes', mode: value.mode, period, mixes }
  }
  return undefined
}

/**
 * Stable lists read back from storage, keeping only the well-formed entries, one per kind and
 * mode (the first). Anything else reads as nothing kept.
 */
export function sanitizeStableShelves(value: unknown): StableShelves {
  if (!isRecord(value) || !Array.isArray(value.entries)) return NO_STABLE_SHELVES
  const entries: StableEntry[] = []
  for (const raw of value.entries.slice(0, 8)) {
    const entry = sanitizeEntry(raw)
    if (entry === undefined) continue
    if (entries.some((kept) => kept.kind === entry.kind && kept.mode === entry.mode)) continue
    entries.push(entry)
  }
  return { entries }
}
