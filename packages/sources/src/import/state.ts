/**
 * An import's saved progress ({@link ImportState}): creating it, reading it back from storage,
 * counting where it stands, and applying the user's review decisions.
 *
 * @module
 */

import {
  type AudioCandidate,
  type CatalogMode,
  type EntityId,
  isCatalogMode,
  isEntityId,
  isIsrcOrigin,
  isMatchBand,
  isSourceId,
  type Track,
} from '@fxm/core'
import { trackOfCandidate } from './match'
import { catalogTrackOf, isSpotifyRow, isYouTubeRow, storedRow } from './rows'
import {
  IMPORT_KINDS,
  IMPORT_STATE_VERSION,
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
 * Puts the rows that failed back in the queue, in place, so the next run tries them again.
 * Returns how many.
 */
export function retryFailedRows(state: ImportState): number {
  let count = 0
  state.results.forEach((result, index) => {
    if (result?.outcome !== 'failed') return
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

/**
 * Applies a review decision to row `index`, in place, and says what the library must do.
 * Confirming a row pins the candidate for its own catalog track, or places the song in the
 * playlist for a row without one.
 *
 * @throws RangeError for a row that does not exist, has no result yet, or has no candidate
 * with that `ref`.
 */
export function applyReview(
  state: ImportState,
  index: number,
  decision: ReviewDecision,
  now: number,
): ReviewEffect {
  const row = state.rows[index]
  const result = state.results[index]
  if (row === undefined || result === null || result === undefined) {
    throw new RangeError(`Row ${index} has nothing to review`)
  }
  if (decision.action === 'skip') {
    result.review = { action: 'skipped', at: now }
    return { type: 'none' }
  }
  const candidate = [result.best, ...(result.alternatives ?? [])].find(
    (option) => option?.ref === decision.ref,
  )
  if (candidate === undefined) throw new RangeError(`Row ${index} has no candidate ${decision.ref}`)
  result.review = { action: 'confirmed', ref: candidate.ref, at: now }
  if (row.trackId !== undefined && (isSpotifyRow(row) || isYouTubeRow(row))) {
    return { type: 'pin', sourceTrackId: row.trackId, candidate }
  }
  const track = trackOfCandidate(candidate, result.extras?.[candidate.ref])
  result.playlistTrackId = track.id
  return { type: 'place', index, track, before: nextPlaylistTrack(state, index) }
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

const OPTIONAL_ROW_STRINGS = ['album', 'isrc', 'releaseDate', 'label', 'albumType', 'location']

function isStoredRow(value: unknown): value is StoredRow {
  if (!isFields(value) || typeof value.title !== 'string' || !isStringArray(value.artists)) {
    return false
  }
  if (OPTIONAL_ROW_STRINGS.some((key) => key in value && typeof value[key] !== 'string')) {
    return false
  }
  if ('durationMs' in value && typeof value.durationMs !== 'number') return false
  if ('addedAt' in value && typeof value.addedAt !== 'number') return false
  if ('explicit' in value && typeof value.explicit !== 'boolean') return false
  if ('trackId' in value && !isEntityId(value.trackId, 'track')) return false
  if ('songId' in value && !isEntityId(value.songId, 'track')) return false
  if (
    'kind' in value &&
    !['song', 'music-video', 'video', 'episode'].includes(String(value.kind))
  ) {
    return false
  }
  return true
}

function isCandidate(value: unknown): value is AudioCandidate {
  return (
    isFields(value) &&
    isSourceId(value.source) &&
    typeof value.ref === 'string' &&
    value.ref !== '' &&
    typeof value.title === 'string' &&
    isStringArray(value.artists) &&
    typeof value.confidence === 'number' &&
    isStringArray(value.evidence)
  )
}

function isRowResult(value: unknown): value is RowResult {
  if (!isFields(value) || !(ROW_OUTCOMES as readonly unknown[]).includes(value.outcome)) {
    return false
  }
  if ('verdict' in value && !isMatchBand(value.verdict)) return false
  if ('best' in value && !isCandidate(value.best)) return false
  if ('alternatives' in value) {
    if (!Array.isArray(value.alternatives) || !value.alternatives.every(isCandidate)) return false
  }
  if ('isrcOrigin' in value && !isIsrcOrigin(value.isrcOrigin)) return false
  if ('playlistTrackId' in value && !isEntityId(value.playlistTrackId, 'track')) return false
  if ('review' in value) {
    const review = value.review
    if (!isFields(review) || !['confirmed', 'skipped'].includes(String(review.action))) return false
  }
  return true
}

function isLookup(value: unknown): value is RowLookup | null {
  if (value === null) return true
  return isFields(value) && (value.source === 'spotify' || value.source === 'musicbrainz')
}

/**
 * An import's progress read back from storage, or `null` when it is not one this version can
 * resume (another format, damaged, edited): the import then cannot continue, but nothing it
 * already put into the library is lost.
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
  return {
    version: IMPORT_STATE_VERSION,
    kind: value.kind as ImportKind,
    mode: value.mode,
    rows: rows as StoredRow[],
    results: results as (RowResult | null)[],
    lookups: lookups as Record<string, RowLookup | null>,
  }
}
