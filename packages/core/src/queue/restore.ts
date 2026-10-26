/**
 * Restoring a queue saved as JSON, e.g. from IndexedDB or a backup, without trusting it.
 *
 * Everything is rebuilt from the fields FXM knows, so a corrupted or edited backup can't smuggle
 * wrong-typed values or extra keys to code that trusts the types.
 *
 * @module
 */

import {
  type EntityId,
  isEntityId,
  isSourceId,
  normalizeIsrc,
  parseId,
  type SourceId,
} from '../ids'
import { type CatalogMode, isCatalogMode, isPlayable, modePolicy } from '../mode'
import type { AlbumRef, ArtistRef, Artwork, Track, TrackKind } from '../model'
import type { AudioCandidate, MatchSignals } from '../providers'
import { isRepeatMode, type QueueContext, type QueueItem, type QueueState } from './queue'

type UnknownRecord = Record<string, unknown>

/** Every track kind; a record so the compiler notices a new one. */
const TRACK_KINDS: Readonly<Record<TrackKind, true>> = {
  song: true,
  'music-video': true,
  video: true,
  episode: true,
}

/** An ISO 8601 date, possibly partial: `2013`, `2013-05` or `2013-05-17`. */
const RELEASE_DATE = /^\d{4}(?:-(?:0[1-9]|1[0-2])(?:-(?:0[1-9]|[12]\d|3[01]))?)?$/u

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isTrackKind(value: unknown): value is TrackKind {
  return typeof value === 'string' && Object.hasOwn(TRACK_KINDS, value)
}

function isUid(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

function isString(value: unknown): value is string {
  return typeof value === 'string'
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value !== ''
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean'
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1
}

function isPopularity(value: unknown): value is number {
  return isNonNegativeNumber(value) && value <= 100
}

function isConfidence(value: unknown): value is number {
  return isNonNegativeNumber(value) && value <= 1
}

function isReleaseDate(value: unknown): value is string {
  return typeof value === 'string' && RELEASE_DATE.test(value)
}

function isTrackId(value: unknown): value is EntityId<'track'> {
  return isEntityId(value, 'track')
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isString)
}

/** `{ [key]: value }` when `value` passes `guard`, else nothing: an optional field, or none. */
function field<K extends string, T>(
  key: K,
  value: unknown,
  guard: (value: unknown) => value is T,
): { [P in K]?: T } {
  return guard(value) ? ({ [key]: value } as { [P in K]?: T }) : {}
}

/** A clean copy of every entry, or `undefined` when `value` is not a list or an entry is bad. */
function cleanList<T>(value: unknown, clean: (entry: unknown) => T | undefined): T[] | undefined {
  if (!Array.isArray(value)) return undefined
  const result: T[] = []
  for (const entry of value) {
    const cleaned = clean(entry)
    if (cleaned === undefined) return undefined
    result.push(cleaned)
  }
  return result
}

/** An artist reference: the name is required, a malformed ID is dropped. */
function cleanArtistRef(value: unknown): ArtistRef | undefined {
  if (!isRecord(value) || !isString(value.name)) return undefined
  return isEntityId(value.id, 'artist') ? { id: value.id, name: value.name } : { name: value.name }
}

/** An album reference: the name is required, a malformed ID is dropped. */
function cleanAlbumRef(value: unknown): AlbumRef | undefined {
  if (!isRecord(value) || !isString(value.name)) return undefined
  return isEntityId(value.id, 'album') ? { id: value.id, name: value.name } : { name: value.name }
}

/** One artwork size: the URL is required, a malformed size is dropped. */
function cleanArtwork(value: unknown): Artwork | undefined {
  if (!isRecord(value) || !isString(value.url)) return undefined
  return {
    url: value.url,
    ...field('width', value.width, isNonNegativeNumber),
    ...field('height', value.height, isNonNegativeNumber),
  }
}

/** The entries with a known source and a non-empty native ID, or `undefined` when none. */
function cleanExternalIds(value: unknown): Partial<Record<SourceId, string>> | undefined {
  if (!isRecord(value)) return undefined
  const entries = Object.entries(value).filter(
    (entry): entry is [SourceId, string] => isSourceId(entry[0]) && isNonEmptyString(entry[1]),
  )
  return entries.length === 0 ? undefined : Object.fromEntries(entries)
}

/**
 * A clean {@link Track}, or `undefined` when a required field is missing or malformed: the ID
 * (whose source must be `source`), the title, the artists, the artwork and the kind. A malformed
 * optional field is dropped on its own; unknown fields are never copied.
 *
 * {@link restoreQueue} uses it for every item; other stores of tracks, such as the library's
 * backups, use it too, so a track is checked the same way wherever it is read back.
 */
export function cleanTrack(value: unknown): Track | undefined {
  if (!isRecord(value) || !isTrackId(value.id) || !isSourceId(value.source)) return undefined
  if (parseId(value.id).source !== value.source) return undefined
  if (!isString(value.title) || !isTrackKind(value.kind)) return undefined
  const artists = cleanList(value.artists, cleanArtistRef)
  const artwork = cleanList(value.artwork, cleanArtwork)
  if (artists === undefined || artwork === undefined) return undefined
  const album = cleanAlbumRef(value.album)
  const isrc = normalizeIsrc(value.isrc)
  const externalIds = cleanExternalIds(value.externalIds)
  return {
    id: value.id,
    source: value.source,
    title: value.title,
    artists,
    ...(album === undefined ? {} : { album }),
    ...field('durationMs', value.durationMs, isNonNegativeNumber),
    artwork,
    ...field('explicit', value.explicit, isBoolean),
    ...(isrc === null ? {} : { isrc }),
    kind: value.kind,
    ...field('songId', value.songId, isTrackId),
    ...field('trackNumber', value.trackNumber, isPositiveInteger),
    ...field('discNumber', value.discNumber, isPositiveInteger),
    ...field('releaseDate', value.releaseDate, isReleaseDate),
    ...field('popularity', value.popularity, isPopularity),
    ...(externalIds === undefined ? {} : { externalIds }),
  }
}

/** Clean {@link MatchSignals}, or `undefined` when the two required flags are missing. */
export function cleanSignals(value: unknown): MatchSignals | undefined {
  if (!isRecord(value) || !isBoolean(value.isrcVerified) || !isBoolean(value.sourceAlbumMatch)) {
    return undefined
  }
  return {
    isrcVerified: value.isrcVerified,
    ...field('releaseId', value.releaseId, isNonEmptyString),
    ...field('releaseYear', value.releaseYear, isPositiveInteger),
    ...field('label', value.label, isString),
    sourceAlbumMatch: value.sourceAlbumMatch,
  }
}

/**
 * A clean {@link AudioCandidate}, or `undefined` when a required field is missing or malformed
 * (the confidence must be between 0 and 1). Malformed optional fields are dropped on their own.
 */
export function cleanCandidate(value: unknown): AudioCandidate | undefined {
  if (!isRecord(value) || !isSourceId(value.source) || !isNonEmptyString(value.ref)) {
    return undefined
  }
  if (!isTrackKind(value.kind) || !isString(value.title) || !isConfidence(value.confidence)) {
    return undefined
  }
  if (!isStringArray(value.artists) || !isStringArray(value.evidence)) return undefined
  const signals = cleanSignals(value.signals)
  return {
    source: value.source,
    ref: value.ref,
    kind: value.kind,
    title: value.title,
    artists: [...value.artists],
    ...field('durationMs', value.durationMs, isNonNegativeNumber),
    confidence: value.confidence,
    evidence: [...value.evidence],
    ...(signals === undefined ? {} : { signals }),
  }
}

/**
 * A clean copy of a {@link QueueContext} with only that type's fields, or `undefined` when
 * `value` is not a valid one.
 */
export function cleanContext(value: unknown): QueueContext | undefined {
  if (!isRecord(value) || !isString(value.title)) return undefined
  const { title } = value
  switch (value.type) {
    case 'album':
      return isEntityId(value.id, 'album') ? { type: 'album', id: value.id, title } : undefined
    case 'playlist':
      return isEntityId(value.id, 'playlist')
        ? { type: 'playlist', id: value.id, title }
        : undefined
    case 'artist':
      return isEntityId(value.id, 'artist') ? { type: 'artist', id: value.id, title } : undefined
    case 'radio': {
      const { seed } = value
      return isEntityId(seed, 'track') || isEntityId(seed, 'artist')
        ? { type: 'radio', seed, title }
        : undefined
    }
    case 'search':
      return isString(value.query) ? { type: 'search', query: value.query, title } : undefined
    case 'library':
      return isNonEmptyString(value.id) ? { type: 'library', id: value.id, title } : undefined
    default:
      return undefined
  }
}

/**
 * Whether `value` is a valid {@link QueueContext}: a known type with that type's fields, the
 * catalog IDs checked with `isEntityId`.
 */
export function isQueueContext(value: unknown): value is QueueContext {
  return cleanContext(value) !== undefined
}

/**
 * A clean copy of a stored item, or `undefined` when it is malformed. A malformed candidate only
 * costs the candidate: the item stays and is matched again.
 */
function toQueueItem(value: unknown): QueueItem | undefined {
  if (!isRecord(value) || !isUid(value.uid)) return undefined
  const track = cleanTrack(value.track)
  if (track === undefined) return undefined
  const candidate = cleanCandidate(value.candidate)
  return candidate === undefined ? { uid: value.uid, track } : { uid: value.uid, track, candidate }
}

/** Unique uids from a stored list that are in `known`, in their stored order. */
function knownUids(value: unknown, known: ReadonlySet<number>): number[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value.filter((uid): uid is number => isUid(uid) && known.has(uid)))]
}

/**
 * Rebuilds a queue from untrusted data, such as a {@link QueueState} saved with
 * `JSON.stringify` and read back from storage or a backup. It fails closed, keeping only what
 * is valid, and copies only known fields:
 *
 * - malformed items and duplicate uids are dropped, and so are items `mode` hides. A malformed
 *   optional field of a track is dropped on its own, and so is a malformed candidate, whose item
 *   is then matched again
 * - when the saved current item is gone, the next surviving item becomes current (or the last
 *   one before it)
 * - the played items, the original order of a shuffled queue and the uid counter are repaired
 *   to match the surviving items; an invalid context is dropped, an invalid repeat mode is `off`
 * - a candidate that `mode` does not let play is dropped, so the item is matched again
 *
 * Returns `null` when `value` is not a saved queue at all.
 *
 * @param mode The catalog mode to restore into, normally the current setting. Default: the
 * saved mode, or `music` when that is invalid too.
 */
export function restoreQueue(value: unknown, mode?: CatalogMode): QueueState | null {
  if (!isRecord(value) || !Array.isArray(value.items)) return null
  let target: CatalogMode = 'music'
  if (isCatalogMode(mode)) target = mode
  else if (isCatalogMode(value.mode)) target = value.mode

  const seen = new Set<number>()
  const stored: (QueueItem | undefined)[] = value.items.map((raw) => {
    const item = toQueueItem(raw)
    if (item === undefined || seen.has(item.uid)) return undefined
    seen.add(item.uid)
    if (modePolicy(item.track, target) === 'hidden') return undefined
    if (item.candidate !== undefined && !isPlayable(item.candidate, target)) {
      return { uid: item.uid, track: item.track }
    }
    return item
  })
  const items = stored.filter((item): item is QueueItem => item !== undefined)

  const savedIndex = Number.isSafeInteger(value.index) ? (value.index as number) : 0
  let current = stored.findIndex((item, index) => item !== undefined && index >= savedIndex)
  if (current < 0) current = stored.findLastIndex((item) => item !== undefined)
  const currentItem = stored[current]
  const index = currentItem === undefined ? -1 : items.indexOf(currentItem)

  const uids = new Set(items.map((item) => item.uid))
  const playedUids = knownUids(value.playedUids, uids).filter((uid) => uid !== currentItem?.uid)
  const shuffle = value.shuffle === true
  let unshuffled: number[] | undefined
  if (shuffle) {
    unshuffled = knownUids(value.unshuffled, uids)
    const listed = new Set(unshuffled)
    unshuffled.push(...items.map((item) => item.uid).filter((uid) => !listed.has(uid)))
  }
  const highestUid = items.reduce((highest, item) => Math.max(highest, item.uid), -1)
  const savedNextUid = isUid(value.nextUid) ? value.nextUid : 0
  const context = cleanContext(value.context)

  return {
    items,
    index,
    playedUids,
    ...(context === undefined ? {} : { context }),
    mode: target,
    repeat: isRepeatMode(value.repeat) ? value.repeat : 'off',
    shuffle,
    ...(unshuffled === undefined ? {} : { unshuffled }),
    nextUid: Math.max(savedNextUid, highestUid + 1),
  }
}
