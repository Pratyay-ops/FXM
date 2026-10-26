/**
 * The rules of the match cache, as pure functions: how decisions are keyed, which count as
 * confirmed, when they expire, and how a new engine decision meets a user's pin.
 *
 * - Keyed by the **source** track (its `entityKey`) and the catalog mode, because Music and
 *   Music + Video may pick different audio for the same track.
 * - A `suggest` decision is a guess: it is stored, so the version switcher can show it, but it
 *   never counts as confirmed. Only an `auto` decision or a user pin does.
 * - Engine decisions are kept {@link MATCH_TTL_MS} (about 30 days). Pins always win: the engine
 *   never overwrites one, and nothing deletes one automatically.
 *
 * @module
 */

import { type AudioCandidate, type CatalogMode, type EntityId, entityKey } from '@fxm/core'
import { MATCH_TTL_MS, type MatchCacheRecord } from './types'

/** The cache key of a source track's decision in one mode: `<entityKey>|<mode>`. */
export function matchKey(sourceTrackId: EntityId<'track'>, mode: CatalogMode): string {
  return `${entityKey(sourceTrackId)}|${mode}`
}

/**
 * Whether playback may use the decision's candidate without asking: the user pinned it, or the
 * engine was sure (`auto`). A `suggest` guess never is, and a decision without a candidate
 * can't be.
 */
export function isConfirmedMatch(record: MatchCacheRecord): boolean {
  return record.candidate !== undefined && (record.userPinned || record.band === 'auto')
}

/** Whether an engine decision is older than {@link MATCH_TTL_MS}. Pins never expire. */
export function isExpiredMatch(record: MatchCacheRecord, now: number): boolean {
  return !record.userPinned && now - record.decidedAt > MATCH_TTL_MS
}

/** What the matching engine decided about one source track, as the cache stores it. */
export interface MatchDecision {
  /** The track that needed audio. */
  sourceTrackId: EntityId<'track'>
  /** The catalog mode of the search. */
  mode: CatalogMode
  /** The source track's ISRC, when known. */
  isrc?: string
  /** How sure the engine is. */
  band: MatchCacheRecord['band']
  /** The best candidate, when there is one. */
  candidate?: AudioCandidate
  /** The other candidates, best first. */
  alternatives?: AudioCandidate[]
  /** The facts the decision rested on. */
  signals?: MatchCacheRecord['signals']
  /** Why, for people. */
  evidence?: string[]
}

/**
 * The record that stores `decision`, made at `now`. When `existing` is a pin, the pin stays and
 * the decision is dropped (`null`): a pin always wins.
 */
export function recordFromDecision(
  decision: MatchDecision,
  now: number,
  existing?: MatchCacheRecord,
): MatchCacheRecord | null {
  if (existing?.userPinned) return null
  const record: MatchCacheRecord = {
    key: matchKey(decision.sourceTrackId, decision.mode),
    sourceKey: entityKey(decision.sourceTrackId),
    sourceTrackId: decision.sourceTrackId,
    mode: decision.mode,
    band: decision.band,
    alternatives: decision.alternatives ?? [],
    evidence: decision.evidence ?? decision.candidate?.evidence ?? [],
    // Only the user pins: an engine decision, whatever its band, never is one.
    userPinned: false,
    decidedAt: now,
  }
  if (decision.isrc !== undefined) record.isrc = decision.isrc
  if (decision.candidate !== undefined) record.candidate = decision.candidate
  const signals = decision.signals ?? decision.candidate?.signals
  if (signals !== undefined) record.signals = signals
  return record
}

/**
 * The record after the user chose `candidate` ("Not the right version?"): a pin, which keeps
 * the engine's other candidates as alternatives.
 */
export function pinnedRecord(
  sourceTrackId: EntityId<'track'>,
  mode: CatalogMode,
  candidate: AudioCandidate,
  now: number,
  existing?: MatchCacheRecord,
): MatchCacheRecord {
  const sameAudio = (other: AudioCandidate) =>
    other.source === candidate.source && other.ref === candidate.ref
  const previous = [
    ...(existing?.candidate === undefined ? [] : [existing.candidate]),
    ...(existing?.alternatives ?? []),
  ]
  const record: MatchCacheRecord = {
    key: matchKey(sourceTrackId, mode),
    sourceKey: entityKey(sourceTrackId),
    sourceTrackId,
    mode,
    band: existing?.band ?? 'none',
    candidate,
    alternatives: previous.filter((other) => !sameAudio(other)),
    evidence: ['pinned by the user'],
    userPinned: true,
    decidedAt: now,
  }
  if (existing?.isrc !== undefined) record.isrc = existing.isrc
  if (candidate.signals !== undefined) record.signals = candidate.signals
  return record
}
