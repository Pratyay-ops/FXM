/**
 * Guards for records that come from outside the running app: backup files today, imports
 * later. Each `sanitize…` function returns a clean copy that holds only the known fields, or
 * `null` when the value can't be used, so bad data never reaches the database (fail closed).
 *
 * Tracks, audio candidates, match signals and play contexts go through the cleaners of
 * `@fxm/core` that also restore a saved queue (`cleanTrack`, `cleanCandidate`, `cleanSignals`,
 * `cleanContext`), so FXM checks them the same way wherever it reads them back. This module
 * adds only the library's own limits on top: http(s) artwork, and bounded text and lists.
 *
 * Keys that the database derives (a like's `entityKey`, a match's cache key) are recomputed,
 * never trusted, and the built-in playlists keep their names.
 *
 * @module
 */

import {
  type ArtistRef,
  type Artwork,
  type AudioCandidate,
  type Codec,
  type Container,
  cleanCandidate,
  cleanContext,
  cleanSignals,
  cleanTrack,
  type EntityId,
  entityKey,
  isCatalogMode,
  isCodec,
  isEntityId,
  isQualityTier,
  isSourceId,
  type JsonValue,
  type MatchSignals,
  normalizeIsrc,
  type QueueContext,
  type SourceId,
  type StreamMedia,
  type Track,
} from '@fxm/core'
import { matchKey } from './match-cache'
import {
  FOLLOW_KINDS,
  type FollowKind,
  type FollowRecord,
  type HistoryEntry,
  IMPORT_STATUSES,
  type ImportProgressRecord,
  isLocalPlaylistId,
  type LikeRecord,
  MATCH_BANDS,
  MAX_DESCRIPTION_LENGTH,
  MAX_NAME_LENGTH,
  type MatchCacheRecord,
  type OrderRecord,
  type OrderUndo,
  PLAYLISTS_ORDER_ID,
  type PlaylistRecord,
  type SettingRecord,
  type StreamInfo,
  SYSTEM_PLAYLIST_NAMES,
  type SystemPlaylist,
  systemPlaylistOf,
  type TrackRecord,
} from './types'

/** Longest title, name or label kept from outside data. */
const MAX_TEXT = 1000
/** Longest artwork URL kept. */
const MAX_URL = 2048
/** Longest native ID kept, such as a release ID or another source's ID of a track. */
const MAX_NATIVE_ID = 200
/** Most items kept in a short list such as artists, artwork or evidence. */
const MAX_SHORT_LIST = 100
/** Most tracks one playlist may hold. */
export const MAX_PLAYLIST_TRACKS = 100_000
/** Most tags kept on a track, and the longest tag. */
const MAX_TAGS = 20
const MAX_TAG_LENGTH = 100
/** Latest timestamp accepted: the largest valid `Date`. */
const MAX_TIME = 8.64e15

const CONTAINERS: readonly Container[] = ['webm', 'mp4', 'm4a', 'mp3', 'ogg', 'flac', 'wav']
const STREAM_MEDIA: readonly StreamMedia[] = ['audio', 'muxed-video']

type Fields = Record<string, unknown>

function isFields(value: unknown): value is Fields {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A string of at most `max` characters, or `undefined`. */
function text(value: unknown, max = MAX_TEXT): string | undefined {
  return typeof value === 'string' && value.length <= max ? value : undefined
}

/** A non-empty string of at most `max` characters, or `undefined`. */
function nonEmpty(value: unknown, max = MAX_TEXT): string | undefined {
  const result = text(value, max)
  return result === undefined || result === '' ? undefined : result
}

/** A trimmed string cut to `max` characters, or `undefined` when nothing is left. */
function trimmed(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const result = value.trim().slice(0, max).trim()
  return result === '' ? undefined : result
}

/** A time as epoch milliseconds, or `undefined`. */
function time(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_TIME
    ? value
    : undefined
}

/** A non-negative finite number, or `undefined`. */
function amount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

/** A non-negative integer, or `undefined`. */
function count(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : undefined
}

/** A positive integer, or `undefined`. */
function ordinal(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) > 0 ? (value as number) : undefined
}

function oneOf<T extends string>(options: readonly T[], value: unknown): T | undefined {
  return typeof value === 'string' && (options as readonly string[]).includes(value)
    ? (value as T)
    : undefined
}

/** The items of an array that `sanitize` accepts, at most `max` of them. */
function listOf<T>(value: unknown, sanitize: (item: unknown) => T | null, max: number): T[] {
  if (!Array.isArray(value)) return []
  const result: T[] = []
  for (const item of value) {
    if (result.length >= max) break
    const clean = sanitize(item)
    if (clean !== null) result.push(clean)
  }
  return result
}

/** Sets `record[key]` to `value` unless it is `undefined` (exactOptionalPropertyTypes). */
function put<T extends object, K extends keyof T>(record: T, key: K, value: T[K] | undefined) {
  if (value !== undefined) record[key] = value
}

/** Whether a URL may be used as an image source: http(s) only. */
function isImageUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > MAX_URL) return false
  try {
    const { protocol } = new URL(value)
    return protocol === 'https:' || protocol === 'http:'
  } catch {
    return false
  }
}

/** One size of artwork, or `null`. Only http(s) URLs are kept; a malformed size is dropped. */
export function sanitizeArtworkItem(value: unknown): Artwork | null {
  if (!isFields(value) || !isImageUrl(value.url)) return null
  const artwork: Artwork = { url: value.url }
  put(artwork, 'width', amount(value.width))
  put(artwork, 'height', amount(value.height))
  return artwork
}

/** The usable sizes of an artwork list (an empty list for anything else). */
export function sanitizeArtwork(value: unknown): Artwork[] {
  return listOf(value, sanitizeArtworkItem, MAX_SHORT_LIST)
}

function sanitizeArtistRef(value: unknown): ArtistRef | null {
  if (!isFields(value)) return null
  const name = text(value.name)
  if (name === undefined) return null
  const ref: ArtistRef = { name }
  if (isEntityId(value.id, 'artist')) ref.id = value.id
  return ref
}

/** The texts of a list that fit the library's limits, at most {@link MAX_SHORT_LIST}. */
function limitTexts(list: readonly string[]): string[] {
  return list.filter((line) => line.length <= MAX_TEXT).slice(0, MAX_SHORT_LIST)
}

/**
 * A core {@link Track}, as `cleanTrack` from `@fxm/core` accepts it, within the library's limits,
 * or `null`: http(s) artwork only, no absurdly long title, names or lists, and at most
 * {@link MAX_TAGS} tags, trimmed, cut to {@link MAX_TAG_LENGTH} characters and none empty.
 */
export function sanitizeTrack(value: unknown): Track | null {
  const track = cleanTrack(value)
  if (track === undefined || track.title.length > MAX_TEXT) return null
  const { album, externalIds, tags, ...rest } = track
  const limited: Track = {
    ...rest,
    artists: track.artists
      .filter((artist) => artist.name.length <= MAX_TEXT)
      .slice(0, MAX_SHORT_LIST),
    artwork: track.artwork.filter((size) => isImageUrl(size.url)).slice(0, MAX_SHORT_LIST),
  }
  if (album !== undefined && album.name.length <= MAX_TEXT) limited.album = album
  const kept: NonNullable<Track['externalIds']> = {}
  for (const [source, id] of Object.entries(externalIds ?? {}) as [SourceId, string][]) {
    if (id.length <= MAX_NATIVE_ID) kept[source] = id
  }
  if (Object.keys(kept).length > 0) limited.externalIds = kept
  const keptTags = listOf(tags, (tag) => trimmed(tag, MAX_TAG_LENGTH) ?? null, MAX_TAGS)
  if (keptTags.length > 0) limited.tags = keptTags
  return limited
}

/** Match signals, as `cleanSignals` from `@fxm/core` accepts them, within the library's limits. */
function sanitizeSignals(value: unknown): MatchSignals | undefined {
  const signals = cleanSignals(value)
  if (signals === undefined) return undefined
  const { releaseId, releaseYear, label, ...rest } = signals
  const limited: MatchSignals = { ...rest }
  if (releaseId !== undefined && releaseId.length <= MAX_NATIVE_ID) limited.releaseId = releaseId
  if (releaseYear !== undefined && releaseYear <= 9999) limited.releaseYear = releaseYear
  put(limited, 'label', nonEmpty(label))
  return limited
}

/**
 * An audio candidate, as `cleanCandidate` from `@fxm/core` accepts it, within the library's
 * limits, or `null`.
 */
export function sanitizeCandidate(value: unknown): AudioCandidate | null {
  const candidate = cleanCandidate(value)
  if (candidate === undefined) return null
  if (candidate.ref.length > MAX_TEXT || candidate.title.length > MAX_TEXT) return null
  const { signals, ...rest } = candidate
  const limited: AudioCandidate = {
    ...rest,
    artists: limitTexts(candidate.artists),
    evidence: limitTexts(candidate.evidence),
  }
  put(limited, 'signals', sanitizeSignals(signals))
  return limited
}

/** The usable audio candidates of a list, best first (an empty list for anything else). */
export function sanitizeCandidates(value: unknown): AudioCandidate[] {
  return listOf(value, sanitizeCandidate, MAX_SHORT_LIST)
}

/** Why a match came out as it did: the strings of a list, within the library's limits. */
export function sanitizeEvidence(value: unknown): string[] {
  return listOf(value, (line) => text(line) ?? null, MAX_SHORT_LIST)
}

/** A cached track, or `null`. The record's ID is the track's own. */
export function sanitizeTrackRecord(value: unknown): TrackRecord | null {
  if (!isFields(value)) return null
  const track = sanitizeTrack(value.track)
  if (track === null) return null
  return { id: track.id, track, updatedAt: time(value.updatedAt) ?? 0 }
}

/** A like, or `null`. */
export function sanitizeLikeRecord(value: unknown): LikeRecord | null {
  if (!isFields(value) || !isEntityId(value.trackId, 'track')) return null
  return {
    key: entityKey(value.trackId),
    trackId: value.trackId,
    likedAt: time(value.likedAt) ?? 0,
  }
}

/** An undo order, or `undefined`. */
function sanitizeUndo(value: unknown): OrderUndo | undefined {
  if (!isFields(value)) return undefined
  const action = oneOf(['shuffle', 'sort'] as const, value.action)
  if (action === undefined || !Array.isArray(value.order)) return undefined
  const order = value.order.filter((key): key is string => typeof key === 'string')
  return order.length === value.order.length ? { action, order } : undefined
}

/**
 * Track IDs of a saved order: valid IDs only, each entity once (by `entityKey`), at most
 * {@link MAX_PLAYLIST_TRACKS}.
 */
export function sanitizeTrackIds(value: unknown): EntityId<'track'>[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const result: EntityId<'track'>[] = []
  for (const id of value) {
    if (result.length >= MAX_PLAYLIST_TRACKS) break
    if (!isEntityId(id, 'track')) continue
    const key = entityKey(id)
    if (seen.has(key)) continue
    seen.add(key)
    result.push(id)
  }
  return result
}

/**
 * A playlist of this library, or `null`. Only local playlist IDs are accepted. A built-in
 * playlist keeps its own name and can't lose its `system` mark; any other playlist can't claim
 * one.
 */
export function sanitizePlaylistRecord(value: unknown): PlaylistRecord | null {
  if (!isFields(value) || !isLocalPlaylistId(value.id)) return null
  const system: SystemPlaylist | undefined = systemPlaylistOf(value.id)
  const name =
    system === undefined
      ? (trimmed(value.name, MAX_NAME_LENGTH) ?? 'Untitled playlist')
      : SYSTEM_PLAYLIST_NAMES[system]
  const trackIds = sanitizeTrackIds(value.trackIds)
  const addedAt: Record<string, number> = {}
  if (isFields(value.addedAt)) {
    for (const id of trackIds) {
      const at = Object.hasOwn(value.addedAt, id) ? time(value.addedAt[id]) : undefined
      if (at !== undefined) addedAt[id] = at
    }
  }
  const createdAt = time(value.createdAt) ?? 0
  const record: PlaylistRecord = {
    id: value.id,
    name,
    createdAt,
    updatedAt: time(value.updatedAt) ?? createdAt,
    trackIds,
    addedAt,
  }
  put(record, 'system', system)
  put(record, 'description', trimmed(value.description, MAX_DESCRIPTION_LENGTH))
  const artwork = sanitizeArtwork(value.artwork)
  if (artwork.length > 0) record.artwork = artwork
  put(record, 'undo', sanitizeUndo(value.undo))
  return record
}

/** The order of the playlists list, or `null`. */
export function sanitizeOrderRecord(value: unknown): OrderRecord | null {
  if (!isFields(value) || value.id !== PLAYLISTS_ORDER_ID || !Array.isArray(value.order)) {
    return null
  }
  const order = [
    ...new Set(value.order.filter((id): id is EntityId<'playlist'> => isEntityId(id, 'playlist'))),
  ]
  const record: OrderRecord = {
    id: PLAYLISTS_ORDER_ID,
    order,
    updatedAt: time(value.updatedAt) ?? 0,
  }
  put(record, 'undo', sanitizeUndo(value.undo))
  return record
}

/** A follow, or `null`. */
export function sanitizeFollowRecord(value: unknown): FollowRecord | null {
  if (!isFields(value)) return null
  const kind = oneOf<FollowKind>(FOLLOW_KINDS, value.kind)
  if (kind === undefined || !isEntityId(value.id, kind)) return null
  const name = text(value.name)
  if (name === undefined) return null
  const record: FollowRecord = {
    key: entityKey(value.id),
    id: value.id,
    kind,
    name,
    artwork: sanitizeArtwork(value.artwork),
    followedAt: time(value.followedAt) ?? 0,
  }
  if (kind === 'album' && Array.isArray(value.artists)) {
    record.artists = listOf(value.artists, sanitizeArtistRef, MAX_SHORT_LIST)
  }
  if (kind === 'playlist') put(record, 'owner', text(value.owner))
  return record
}

/**
 * Where a play started: a queue context, as `cleanContext` from `@fxm/core` accepts it (only the
 * fields of its type), with a title, query or library key of a sensible length.
 */
function sanitizeContext(value: unknown): QueueContext | undefined {
  const context = cleanContext(value)
  if (context === undefined || context.title.length > MAX_TEXT) return undefined
  if (context.type === 'search' && context.query.length > MAX_TEXT) return undefined
  if (context.type === 'library' && context.id.length > MAX_TEXT) return undefined
  return context
}

function sanitizeStream(value: unknown): StreamInfo | undefined {
  if (!isFields(value) || !isSourceId(value.source)) return undefined
  const stream: StreamInfo = { source: value.source }
  if (isEntityId(value.audioId, 'track')) stream.audioId = value.audioId
  if (isCodec(value.codec)) stream.codec = value.codec as Codec
  put(stream, 'container', oneOf(CONTAINERS, value.container))
  put(stream, 'bitrateKbps', amount(value.bitrateKbps))
  if (isQualityTier(value.tier)) stream.tier = value.tier
  put(stream, 'media', oneOf(STREAM_MEDIA, value.media))
  if (typeof value.offline === 'boolean') stream.offline = value.offline
  return stream
}

/** A history entry, keeping its ID when it has a valid one, or `null`. */
export function sanitizeHistoryRecord(value: unknown): HistoryEntry | null {
  if (!isFields(value) || !isEntityId(value.trackId, 'track')) return null
  const playedAt = time(value.playedAt)
  if (playedAt === undefined) return null
  const record: HistoryEntry = {
    trackId: value.trackId,
    playedAt,
    playedMs: amount(value.playedMs) ?? 0,
    completed: value.completed === true,
    skipped: value.skipped === true,
  }
  put(record, 'id', ordinal(value.id))
  const durationMs = amount(value.durationMs)
  if (durationMs !== undefined && durationMs > 0) record.durationMs = durationMs
  put(record, 'context', sanitizeContext(value.context))
  put(record, 'stream', sanitizeStream(value.stream))
  put(record, 'importId', nonEmpty(value.importId, 100))
  return record
}

/**
 * Whether a parsed value is JSON data no deeper than `depth`: what `JSON.parse` returns, so
 * anything read from a backup file passes unless it nests absurdly deep.
 */
function isJson(value: unknown, depth = 32): value is JsonValue {
  if (depth < 0) return false
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.every((item) => isJson(item, depth - 1))
  return isFields(value) && Object.values(value).every((item) => isJson(item, depth - 1))
}

/** A reserved setting, or `null`. */
export function sanitizeSettingRecord(value: unknown): SettingRecord | null {
  if (!isFields(value) || !isJson(value.value)) return null
  const key = nonEmpty(value.key, 200)
  if (key === undefined) return null
  return { key, value: value.value, updatedAt: time(value.updatedAt) ?? 0 }
}

/** A match-cache decision, or `null`. A pin needs a candidate. */
export function sanitizeMatchRecord(value: unknown): MatchCacheRecord | null {
  if (!isFields(value) || !isEntityId(value.sourceTrackId, 'track')) return null
  const band = oneOf(MATCH_BANDS, value.band)
  if (!isCatalogMode(value.mode) || band === undefined) return null
  const candidate = value.candidate === undefined ? undefined : sanitizeCandidate(value.candidate)
  if (candidate === null) return null
  const record: MatchCacheRecord = {
    key: matchKey(value.sourceTrackId, value.mode),
    sourceKey: entityKey(value.sourceTrackId),
    sourceTrackId: value.sourceTrackId,
    mode: value.mode,
    band,
    alternatives: sanitizeCandidates(value.alternatives),
    evidence: sanitizeEvidence(value.evidence),
    userPinned: value.userPinned === true && candidate !== undefined,
    decidedAt: time(value.decidedAt) ?? 0,
  }
  put(record, 'isrc', normalizeIsrc(value.isrc) ?? undefined)
  put(record, 'candidate', candidate)
  put(record, 'signals', sanitizeSignals(value.signals))
  return record
}

/** The progress of an import, or `null`. */
export function sanitizeImportProgress(value: unknown): ImportProgressRecord | null {
  if (!isFields(value)) return null
  const id = nonEmpty(value.id, 100)
  const kind = nonEmpty(value.kind, 64)
  const status = oneOf(IMPORT_STATUSES, value.status)
  if (id === undefined || kind === undefined || status === undefined) return null
  const createdAt = time(value.createdAt) ?? 0
  const record: ImportProgressRecord = {
    id,
    kind,
    label: text(value.label) ?? '',
    status,
    total: count(value.total) ?? 0,
    done: count(value.done) ?? 0,
    matched: count(value.matched) ?? 0,
    needsReview: count(value.needsReview) ?? 0,
    failed: count(value.failed) ?? 0,
    createdAt,
    updatedAt: time(value.updatedAt) ?? createdAt,
  }
  if (isEntityId(value.playlistId, 'playlist')) record.playlistId = value.playlistId
  if (value.state !== undefined && isJson(value.state)) record.state = value.state
  put(record, 'error', text(value.error))
  return record
}
