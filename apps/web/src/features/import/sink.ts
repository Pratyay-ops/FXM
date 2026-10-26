/**
 * Where an import job's decisions go: the library (stage 2.6). Progress goes into the import's
 * progress record, decisions into the match cache, matched songs into the import's playlist.
 *
 * @module
 */

import { type EntityId, type JsonValue, MATCHER_VERSION } from '@fxm/core'
import {
  type CachedMatch,
  type ImportMatchDecision,
  type ImportSink,
  type ImportState,
  importCounts,
} from '@fxm/sources/import'
import type { LibraryRepo } from '../../db/repo'

/** The progress fields of an import record, from its state. */
export function progressOf(state: ImportState) {
  const { total, done, matched, needsReview, failed } = importCounts(state)
  return { state: state as unknown as JsonValue, total, done, matched, needsReview, failed }
}

/**
 * Stores the engine's decision for a catalog track in the match cache.
 *
 * It stores `decision.band`, the band with the Auto setting applied, because 2.6's
 * `getConfirmedMatch` confirms a `band: 'auto'` record without looking at the setting. Core's
 * `MatchVerdict` asks a cache to store the verdict as it is and apply the setting when it reads;
 * once 2.6's `isConfirmedMatch` reads with `effectiveMatchBand(record.candidate?.verdict, autoOn)`,
 * store `decision.verdictBand` here instead (an integration touch-point, in the README).
 */
export async function recordDecision(
  repo: LibraryRepo,
  decision: ImportMatchDecision,
): Promise<void> {
  await repo.recordMatch({
    sourceTrackId: decision.sourceTrackId,
    mode: decision.mode,
    band: decision.band,
    alternatives: decision.alternatives,
    evidence: decision.evidence,
    ...(decision.isrc === undefined ? {} : { isrc: decision.isrc }),
    ...(decision.candidate === undefined ? {} : { candidate: decision.candidate }),
    ...(decision.candidate?.signals === undefined ? {} : { signals: decision.candidate.signals }),
  })
}

/**
 * Puts `track` into `playlistId` before `before` (or at the end). A track the playlist holds
 * already stays where it is, so placing the same song again changes nothing.
 */
export async function placeTrack(
  repo: LibraryRepo,
  playlistId: EntityId<'playlist'>,
  track: Parameters<ImportSink['placeTrack']>[0],
  before: EntityId<'track'> | null,
): Promise<void> {
  const { added } = await repo.addTracks(playlistId, [track])
  if (added > 0 && before !== null) {
    await repo.moveItems(playlistId, [track.id], { before })
  }
}

/**
 * The library sink of one import: `importId`'s progress record and `playlistId`, the playlist
 * the import fills.
 */
export function createLibrarySink(
  repo: LibraryRepo,
  importId: string,
  playlistId: EntityId<'playlist'>,
): ImportSink {
  return {
    async save(state) {
      await repo.updateImport(importId, progressOf(state))
    },

    async cachedMatch(trackId, mode): Promise<CachedMatch | undefined> {
      const record = await repo.getMatch(trackId, mode)
      if (record === undefined) return undefined
      // A decision of an older matching engine is made again; a user's pin always stands.
      const version = record.candidate?.verdict?.matcherVersion
      if (!record.userPinned && version !== undefined && version !== MATCHER_VERSION) {
        return undefined
      }
      const cached: CachedMatch = {
        band: record.band,
        alternatives: record.alternatives,
        evidence: record.evidence,
        userPinned: record.userPinned,
      }
      if (record.candidate !== undefined) cached.candidate = record.candidate
      return cached
    },

    recordMatch: (decision) => recordDecision(repo, decision),

    placeTrack: (track, before) => placeTrack(repo, playlistId, track, before),

    async saveTrack(track) {
      await repo.saveTracks([track])
    },
  }
}
