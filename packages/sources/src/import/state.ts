/**
 * An import's saved progress ({@link ImportState}): creating it, reading it back from storage,
 * counting where it stands, and applying the user's review decisions.
 *
 * @module
 */

import {
  type AlbumType,
  type AudioCandidate,
  type AutoBlocker,
  type CatalogMode,
  type EntityId,
  isCatalogMode,
  isEntityId,
  isIsrcOrigin,
  isMatchBand,
  isSourceId,
  type Track,
  type TrackKind,
} from '@fxm/core'
import {
  decidesForOwnTrack,
  decisionOf,
  hiddenInMode,
  type ImportMatchDecision,
  trackOfCandidate,
} from './match'
import { catalogTrackOf, storedRow } from './rows'
import {
  IMPORT_BLOCK_REASONS,
  IMPORT_KINDS,
  IMPORT_STATE_VERSION,
  type ImportBlockReason,
  type ImportCollection,
  type ImportKind,
  type ImportState,
  ROW_OUTCOMES,
  type RowLookup,
  type RowResult,
  type StoredRow,
} from './types'

/** A new import's progress: every row waiting. */
export function createImportState(
  kind: ImportKind,
  mode: CatalogMode,
  collection: ImportCollection,
): ImportState {
  return {
    version: IMPORT_STATE_VERSION,
    kind,
    mode,
    rows: collection.rows.map(storedRow),
    results: collection.rows.map(() => null),
    lookups: {},
  }
}

/**
 * Where a row stands now:
 *
 * - `pending`: not processed yet
 * - `ready`, `matched`, `review`, `not-found`, `failed`: what the import decided
 * - `confirmed`: the user chose a candidate in the review list
 * - `skipped`: the user left it out
 */
export type RowStatus =
  | 'pending'
  | 'ready'
  | 'matched'
  | 'review'
  | 'not-found'
  | 'failed'
  | 'confirmed'
  | 'skipped'

/** Where a row stands (see {@link RowStatus}). */
export function rowStatus(result: RowResult | null | undefined): RowStatus {
  if (result === null || result === undefined) return 'pending'
  if (result.review?.action === 'confirmed') return 'confirmed'
  if (result.review?.action === 'skipped') return 'skipped'
  return result.outcome
}

/** Whether a row waits for the user's review: a best guess, or nothing good enough found. */
export function needsReview(result: RowResult | null | undefined): boolean {
  const status = rowStatus(result)
  return status === 'review' || status === 'not-found'
}

/**
 * Whether a row's best guess is "likely right": the engine would play it without asking if the
 * Auto setting were on, and only the setting holds it back.
 */
export function isLikelyMatch(result: RowResult | null | undefined): boolean {
  return rowStatus(result) === 'review' && result?.verdict === 'auto' && result.best !== undefined
}

/** The counts an import-progress record shows. */
export interface ImportCounts {
  /** Rows in the input. */
  total: number
  /** Rows processed. */
  done: number
  /** Rows that play: ready, matched, or confirmed by the user. */
  matched: number
  /** Rows waiting for the user's review. */
  needsReview: number
  /** Rows that failed. */
  failed: number
}

/** Where an import stands, counted from its rows. */
export function importCounts(state: ImportState): ImportCounts {
  const counts: ImportCounts = {
    total: state.rows.length,
    done: 0,
    matched: 0,
    needsReview: 0,
    failed: 0,
  }
  for (const result of state.results) {
    const status = rowStatus(result)
    if (status === 'pending') continue
    counts.done++
    if (status === 'ready' || status === 'matched' || status === 'confirmed') counts.matched++
    else if (status === 'review' || status === 'not-found') counts.needsReview++
    else if (status === 'failed') counts.failed++
  }
  return counts
}

/**
 * Whether a row is worth trying again: it failed, or a search it needed could not be fetched
 * and the user has not decided about it yet.
 */
export function isRetryable(result: RowResult | null | undefined): boolean {
  if (result === null || result === undefined) return false
  return result.outcome === 'failed' || (result.incomplete === true && result.review === undefined)
}

/**
 * Puts the rows worth trying again ({@link isRetryable}) back in the queue, in place, so the
 * next run tries them again. Returns how many.
 */
export function retryFailedRows(state: ImportState): number {
  let count = 0
  state.results.forEach((result, index) => {
    if (!isRetryable(result)) return
    state.results[index] = null
    count++
  })
  return count
}

/** The first row still waiting, or the number of rows when none is. */
export function firstPendingRow(state: ImportState): number {
  const index = state.results.indexOf(null)
  return index < 0 ? state.rows.length : index
}

/** What the library must do after a review decision. */
export type ReviewEffect =
  /** Pin the chosen candidate as the audio of the row's own catalog track. */
  | { type: 'pin'; sourceTrackId: EntityId<'track'>; candidate: AudioCandidate }
  /**
   * Put the chosen song into the playlist at the row's place, before `before` (or at the end): a
   * row without a catalog track.
   */
  | { type: 'place'; index: number; track: Track; before: EntityId<'track'> | null }
  /** Nothing. */
  | { type: 'none' }

/** A review decision: confirm a candidate (by `ref`), or skip the row. */
export type ReviewDecision = { action: 'confirm'; ref: string } | { action: 'skip' }

/** A row's result after a decision, and what the library must do for it. */
export interface PlannedReview {
  /** The row's new result. Put it into the state once the library did `effect`. */
  result: RowResult
  /** What the library must do. */
  effect: ReviewEffect
}

/**
 * What a review decision about row `index` makes of it, without changing `state`: the row's new
 * result, and what the library must do. Confirming a row pins the candidate for its own catalog
 * track, or places the song in the playlist for a row without one (or whose own track the mode
 * hides). Commit the result (`state.results[index] = planned.result`) only once the library did
 * the effect, so a failure leaves the row as it was.
 *
 * @throws RangeError for a row that does not exist, has no result yet, was decided already
 * (reopen it first, with {@link planReopen}), or has no candidate with that `ref`.
 */
export function planReview(
  state: ImportState,
  index: number,
  decision: ReviewDecision,
  now: number,
): PlannedReview {
  const row = state.rows[index]
  const result = state.results[index]
  if (row === undefined || result === null || result === undefined) {
    throw new RangeError(`Row ${index} has nothing to review`)
  }
  if (result.review !== undefined) throw new RangeError(`Row ${index} was decided already`)
  if (decision.action === 'skip') {
    return {
      result: { ...result, review: { action: 'skipped', at: now } },
      effect: { type: 'none' },
    }
  }
  const candidate = [result.best, ...(result.alternatives ?? [])].find(
    (option) => option?.ref === decision.ref,
  )
  if (candidate === undefined) throw new RangeError(`Row ${index} has no candidate ${decision.ref}`)
  const next: RowResult = {
    ...result,
    review: { action: 'confirmed', ref: candidate.ref, at: now },
  }
  if (decidesForOwnTrack(row, state.mode)) {
    return {
      result: next,
      effect: { type: 'pin', sourceTrackId: row.trackId as EntityId<'track'>, candidate },
    }
  }
  const track = trackOfCandidate(candidate, result.extras?.[candidate.ref])
  next.playlistTrackId = track.id
  return {
    result: next,
    effect: { type: 'place', index, track, before: nextPlaylistTrack(state, index) },
  }
}

/**
 * Applies a review decision to row `index`, in place, and says what the library must do (see
 * {@link planReview}, which leaves the state alone until the library is done).
 *
 * @throws RangeError as {@link planReview}.
 */
export function applyReview(
  state: ImportState,
  index: number,
  decision: ReviewDecision,
  now: number,
): ReviewEffect {
  const planned = planReview(state, index, decision, now)
  state.results[index] = planned.result
  return planned.effect
}

/** What the library must do to take a review decision back. */
export type ReopenEffect =
  /**
   * Remove the user's pin of the row's catalog track, then store the engine's own decision
   * again (absent when the search was incomplete, which is never stored).
   */
  | { type: 'unpin'; sourceTrackId: EntityId<'track'>; decision?: ImportMatchDecision }
  /** Take the song the decision put into the playlist out again. */
  | { type: 'unplace'; trackId: EntityId<'track'> }
  /** Nothing. */
  | { type: 'none' }

/** A reopened row's result, and what the library must do for it. */
export interface PlannedReopen {
  /** The row's result without the decision. Commit it once the library did `effect`. */
  result: RowResult
  /** What the library must do. */
  effect: ReopenEffect
}

/**
 * Takes the user's decision about row `index` back, without changing `state`: the row waits for
 * review again with its candidates, and the effect undoes what the decision did in the library.
 * A song the decision placed stays when another row of the playlist has it too.
 *
 * @throws RangeError for a row without a decision.
 */
export function planReopen(state: ImportState, index: number): PlannedReopen {
  const row = state.rows[index]
  const result = state.results[index]
  if (row === undefined || result === null || result === undefined || !result.review) {
    throw new RangeError(`Row ${index} has no decision to take back`)
  }
  const { review, ...open } = result
  const next: RowResult = open
  if (review.action === 'skipped') return { result: next, effect: { type: 'none' } }
  if (decidesForOwnTrack(row, state.mode)) {
    const sourceTrackId = row.trackId as EntityId<'track'>
    const effect: ReopenEffect = { type: 'unpin', sourceTrackId }
    if (!result.incomplete) effect.decision = decisionOf(sourceTrackId, state.mode, next)
    return { result: next, effect }
  }
  const placed = result.playlistTrackId
  if (hiddenInMode(row, state.mode)) next.playlistTrackId = row.trackId as EntityId<'track'>
  else delete next.playlistTrackId
  if (placed === undefined || placed === next.playlistTrackId) {
    return { result: next, effect: { type: 'none' } }
  }
  const shared = state.rows.some(
    (other, at) => at !== index && playlistTrackIdOf(other, state.results[at]) === placed,
  )
  return { result: next, effect: shared ? { type: 'none' } : { type: 'unplace', trackId: placed } }
}

/**
 * The track a row has in the import's playlist: the song it was placed as, else its own catalog
 * track (which the playlist holds from the start). `undefined` while a row without a catalog
 * track waits.
 */
export function playlistTrackIdOf(
  row: StoredRow,
  result: RowResult | null | undefined,
): EntityId<'track'> | undefined {
  if (result?.playlistTrackId !== undefined) return result.playlistTrackId
  return catalogTrackOf(row) === undefined ? undefined : row.trackId
}

/**
 * Where a song for row `index` goes in the playlist: before the playlist track of the first
 * row after it that has one, or at the end (`null`). Placing songs this way keeps the input's
 * order without undoing moves the user made in the meantime.
 */
export function nextPlaylistTrack(state: ImportState, index: number): EntityId<'track'> | null {
  for (let next = index + 1; next < state.rows.length; next++) {
    const id = playlistTrackIdOf(state.rows[next] as StoredRow, state.results[next])
    if (id !== undefined) return id
  }
  return null
}

/** The library tracks a new import's playlist starts with: the rows' own catalog tracks, in order. */
export function initialPlaylistTracks(collection: ImportCollection): Track[] {
  return collection.rows.flatMap((row) => {
    const track = catalogTrackOf(row)
    return track === undefined ? [] : [track]
  })
}

// --- Reading progress back -----------------------------------------------------------------

type Fields = Readonly<Record<string, unknown>>

function isFields(value: unknown): value is Fields {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

/** Whether `value` is absent, or passes `check`. */
function optional(fields: Fields, key: string, check: (value: unknown) => boolean): boolean {
  return !(key in fields) || check(fields[key])
}

function oneOf<T extends string>(values: readonly T[]): (value: unknown) => value is T {
  return (value): value is T =>
    typeof value === 'string' && (values as readonly string[]).includes(value)
}

/** Every value of a string union, from a record that TypeScript checks is complete. */
function keysOf<T extends string>(record: Readonly<Record<T, true>>): T[] {
  return Object.keys(record) as T[]
}

const isTrackKind = oneOf(
  keysOf<TrackKind>({ song: true, 'music-video': true, video: true, episode: true }),
)
const isAlbumType = oneOf(
  keysOf<AlbumType>({ album: true, single: true, ep: true, compilation: true }),
)
const isAutoBlocker = oneOf(
  keysOf<AutoBlocker>({
    'setting-off': true,
    'no-duration': true,
    'low-score': true,
    'low-title': true,
    'duration-window': true,
    margin: true,
    'not-song': true,
    'explicit-mismatch': true,
    classical: true,
    rivals: true,
    'isrc-miss': true,
    'release-conflict': true,
    'release-agreement-required': true,
    'no-candidates': true,
  }),
)
const isLookupSource = oneOf<'spotify' | 'musicbrainz'>(['spotify', 'musicbrainz'])
const isBlockReason = oneOf<ImportBlockReason>(IMPORT_BLOCK_REASONS)
const isTrue = (value: unknown) => value === true
const isString = (value: unknown) => typeof value === 'string'
const isBoolean = (value: unknown) => typeof value === 'boolean'

/** An artwork URL a library track may carry: `https:` only. */
function isArtworkUrl(value: unknown): boolean {
  if (typeof value !== 'string' || value.length > 2048) return false
  try {
    return new URL(value).protocol === 'https:'
  } catch {
    return false
  }
}

const OPTIONAL_ROW_STRINGS = ['album', 'isrc', 'releaseDate', 'label', 'location']

function isStoredRow(value: unknown): value is StoredRow {
  if (!isFields(value) || typeof value.title !== 'string' || !isStringArray(value.artists)) {
    return false
  }
  if (!OPTIONAL_ROW_STRINGS.every((key) => optional(value, key, isString))) return false
  return (
    optional(value, 'albumType', isAlbumType) &&
    optional(value, 'durationMs', isCount) &&
    optional(value, 'addedAt', isCount) &&
    optional(value, 'explicit', isBoolean) &&
    optional(value, 'trackId', (id) => isEntityId(id, 'track')) &&
    optional(value, 'songId', (id) => isEntityId(id, 'track')) &&
    optional(value, 'kind', isTrackKind)
  )
}

function isVerdict(value: unknown): boolean {
  return (
    isFields(value) &&
    isMatchBand(value.band) &&
    Array.isArray(value.blockers) &&
    value.blockers.every(isAutoBlocker) &&
    typeof value.matcherVersion === 'number'
  )
}

function isSignals(value: unknown): boolean {
  return (
    isFields(value) &&
    typeof value.isrcVerified === 'boolean' &&
    typeof value.sourceAlbumMatch === 'boolean' &&
    optional(value, 'releaseId', isString) &&
    optional(value, 'releaseYear', isCount) &&
    optional(value, 'label', isString)
  )
}

function isCandidate(value: unknown): value is AudioCandidate {
  return (
    isFields(value) &&
    isSourceId(value.source) &&
    typeof value.ref === 'string' &&
    value.ref !== '' &&
    isTrackKind(value.kind) &&
    typeof value.title === 'string' &&
    isStringArray(value.artists) &&
    typeof value.confidence === 'number' &&
    isStringArray(value.evidence) &&
    optional(value, 'durationMs', isCount) &&
    optional(value, 'signals', isSignals) &&
    optional(value, 'verdict', isVerdict)
  )
}

function isExtras(value: unknown): boolean {
  if (!isFields(value)) return false
  const { album, artwork } = value
  if (album !== undefined) {
    if (!isFields(album) || typeof album.name !== 'string') return false
    if (!optional(album, 'id', (id) => isEntityId(id, 'album'))) return false
  }
  if (artwork !== undefined) {
    if (!isFields(artwork) || !isArtworkUrl(artwork.url)) return false
    if (!optional(artwork, 'width', isCount) || !optional(artwork, 'height', isCount)) return false
  }
  return true
}

function isReview(value: unknown): boolean {
  if (!isFields(value) || !isCount(value.at)) return false
  if (value.action === 'skipped') return !('ref' in value)
  return value.action === 'confirmed' && typeof value.ref === 'string' && value.ref !== ''
}

function isRowResult(value: unknown): value is RowResult {
  if (!isFields(value) || !(ROW_OUTCOMES as readonly unknown[]).includes(value.outcome)) {
    return false
  }
  return (
    optional(value, 'verdict', isMatchBand) &&
    optional(value, 'best', isCandidate) &&
    optional(value, 'alternatives', (list) => Array.isArray(list) && list.every(isCandidate)) &&
    optional(
      value,
      'extras',
      (extras) => isFields(extras) && Object.values(extras).every(isExtras),
    ) &&
    optional(value, 'evidence', isStringArray) &&
    optional(value, 'blockers', (list) => Array.isArray(list) && list.every(isAutoBlocker)) &&
    optional(value, 'isrc', isString) &&
    optional(value, 'isrcOrigin', isIsrcOrigin) &&
    optional(value, 'lookup', isLookupSource) &&
    optional(value, 'noDuration', isTrue) &&
    optional(value, 'incomplete', isTrue) &&
    optional(value, 'cached', isTrue) &&
    optional(value, 'error', isString) &&
    optional(value, 'review', isReview) &&
    optional(value, 'playlistTrackId', (id) => isEntityId(id, 'track'))
  )
}

function isLookup(value: unknown): value is RowLookup | null {
  if (value === null) return true
  return (
    isFields(value) &&
    isLookupSource(value.source) &&
    optional(value, 'isrc', isString) &&
    optional(value, 'isrcOrigin', isIsrcOrigin) &&
    optional(value, 'durationMs', isCount) &&
    optional(value, 'label', isString) &&
    optional(value, 'releaseDate', isString) &&
    optional(value, 'albumType', isAlbumType) &&
    optional(value, 'explicit', isBoolean)
  )
}

/**
 * An import's progress read back from storage, or `null` when it is not one this version can
 * resume (another format, damaged, edited): the import then cannot continue, but nothing it
 * already put into the library is lost. Every field is checked, since the progress also comes
 * back from library backups, and what it holds reaches the review list and library tracks.
 */
export function sanitizeImportState(value: unknown): ImportState | null {
  if (!isFields(value) || value.version !== IMPORT_STATE_VERSION) return null
  if (!(IMPORT_KINDS as readonly unknown[]).includes(value.kind) || !isCatalogMode(value.mode)) {
    return null
  }
  const { rows, results, lookups } = value
  if (!Array.isArray(rows) || !Array.isArray(results) || rows.length !== results.length) return null
  if (!rows.every(isStoredRow)) return null
  if (!results.every((result) => result === null || isRowResult(result))) return null
  if (!isFields(lookups) || !Object.values(lookups).every(isLookup)) return null
  if (!optional(value, 'blocked', isBlockReason)) return null
  const state: ImportState = {
    version: IMPORT_STATE_VERSION,
    kind: value.kind as ImportKind,
    mode: value.mode,
    rows: rows as StoredRow[],
    results: results as (RowResult | null)[],
    lookups: lookups as Record<string, RowLookup | null>,
  }
  if (isBlockReason(value.blocked)) state.blocked = value.blocked
  return state
}

/**
 * Why an import's last run stopped with rows waiting, read cheaply from its saved progress
 * (without checking the rest, as {@link sanitizeImportState} does), for a status line.
 */
export function importBlockOf(value: unknown): ImportBlockReason | undefined {
  return isFields(value) && isBlockReason(value.blocked) ? value.blocked : undefined
}
