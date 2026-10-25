/**
 * Restoring a queue saved as JSON, e.g. from IndexedDB or a backup, without trusting it.
 *
 * @module
 */

import { isEntityId, isSourceId } from '../ids'
import { type CatalogMode, isCatalogMode, isPlayable, modePolicy } from '../mode'
import type { AlbumRef, ArtistRef, Artwork, Track, TrackKind } from '../model'
import type { AudioCandidate } from '../providers'
import {
  isRepeatMode,
  QUEUE_CONTEXT_TYPES,
  type QueueContext,
  type QueueItem,
  type QueueState,
} from './queue'

type UnknownRecord = Record<string, unknown>

/** Every track kind; a record so the compiler notices a new one. */
const TRACK_KINDS: Readonly<Record<TrackKind, true>> = {
  song: true,
  'music-video': true,
  video: true,
  episode: true,
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isTrackKind(value: unknown): value is TrackKind {
  return typeof value === 'string' && Object.hasOwn(TRACK_KINDS, value)
}

function isUid(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

function isOptional(value: unknown, guard: (value: unknown) => boolean): boolean {
  return value === undefined || guard(value)
}

function isNonNegativeNumber(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
}

function isArtistRef(value: unknown): value is ArtistRef {
  return (
    isRecord(value) &&
    typeof value.name === 'string' &&
    isOptional(value.id, (id) => isEntityId(id, 'artist'))
  )
}

function isAlbumRef(value: unknown): value is AlbumRef {
  return (
    isRecord(value) &&
    typeof value.name === 'string' &&
    isOptional(value.id, (id) => isEntityId(id, 'album'))
  )
}

function isArtwork(value: unknown): value is Artwork {
  return (
    isRecord(value) &&
    typeof value.url === 'string' &&
    isOptional(value.width, isNonNegativeNumber) &&
    isOptional(value.height, isNonNegativeNumber)
  )
}

/** Whether `value` has the shape of a {@link Track}, for the fields the player relies on. */
function isTrack(value: unknown): value is Track {
  return (
    isRecord(value) &&
    isEntityId(value.id, 'track') &&
    isSourceId(value.source) &&
    typeof value.title === 'string' &&
    Array.isArray(value.artists) &&
    value.artists.every(isArtistRef) &&
    Array.isArray(value.artwork) &&
    value.artwork.every(isArtwork) &&
    isTrackKind(value.kind) &&
    isOptional(value.album, isAlbumRef) &&
    isOptional(value.durationMs, isNonNegativeNumber)
  )
}

/** Whether `value` has the shape of an {@link AudioCandidate}. */
function isCandidate(value: unknown): value is AudioCandidate {
  return (
    isRecord(value) &&
    isSourceId(value.source) &&
    typeof value.ref === 'string' &&
    value.ref !== '' &&
    isTrackKind(value.kind) &&
    typeof value.title === 'string' &&
    isStringArray(value.artists) &&
    typeof value.confidence === 'number' &&
    Number.isFinite(value.confidence) &&
    isStringArray(value.evidence) &&
    isOptional(value.durationMs, isNonNegativeNumber)
  )
}

/** Whether `value` is a valid {@link QueueContext}. */
export function isQueueContext(value: unknown): value is QueueContext {
  return (
    isRecord(value) &&
    typeof value.type === 'string' &&
    (QUEUE_CONTEXT_TYPES as readonly string[]).includes(value.type) &&
    typeof value.id === 'string' &&
    typeof value.title === 'string'
  )
}

/**
 * A clean copy of a stored item, or `undefined` when it is malformed. A malformed candidate only
 * costs the candidate: the item stays and is matched again.
 */
function toQueueItem(value: unknown): QueueItem | undefined {
  if (!isRecord(value) || !isUid(value.uid) || !isTrack(value.track)) return undefined
  return isCandidate(value.candidate)
    ? { uid: value.uid, track: value.track, candidate: value.candidate }
    : { uid: value.uid, track: value.track }
}

/** Unique uids from a stored list that are in `known`, in their stored order. */
function knownUids(value: unknown, known: ReadonlySet<number>): number[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value.filter((uid): uid is number => isUid(uid) && known.has(uid)))]
}

/**
 * Rebuilds a queue from untrusted data, such as a {@link QueueState} saved with
 * `JSON.stringify` and read back from storage or a backup. It fails closed, keeping only what
 * is valid:
 *
 * - malformed items and duplicate uids are dropped, and so are items `mode` hides. A malformed
 *   candidate is dropped on its own, so its item is matched again
 * - when the saved current item is gone, the next surviving item becomes current (or the last
 *   one before it)
 * - the history, the original order of a shuffled queue and the uid counter are repaired to
 *   match the surviving items; an invalid context is dropped, an invalid repeat mode is `off`
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
  const history = knownUids(value.history, uids).filter((uid) => uid !== currentItem?.uid)
  const shuffle = value.shuffle === true
  let unshuffled: number[] | undefined
  if (shuffle) {
    unshuffled = knownUids(value.unshuffled, uids)
    const listed = new Set(unshuffled)
    unshuffled.push(...items.map((item) => item.uid).filter((uid) => !listed.has(uid)))
  }
  const highestUid = items.reduce((highest, item) => Math.max(highest, item.uid), -1)
  const savedNextUid = isUid(value.nextUid) ? value.nextUid : 0

  return {
    items,
    index,
    history,
    ...(isQueueContext(value.context)
      ? { context: { type: value.context.type, id: value.context.id, title: value.context.title } }
      : {}),
    mode: target,
    repeat: isRepeatMode(value.repeat) ? value.repeat : 'off',
    shuffle,
    ...(unshuffled === undefined ? {} : { unshuffled }),
    nextUid: Math.max(savedNextUid, highestUid + 1),
  }
}
