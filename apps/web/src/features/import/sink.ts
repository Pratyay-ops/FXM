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

    async recordMatch(decision: ImportMatchDecision) {
      await repo.recordMatch({
        sourceTrackId: decision.sourceTrackId,
        mode: decision.mode,
        band: decision.band,
        alternatives: decision.alternatives,
        evidence: decision.evidence,
        ...(decision.isrc === undefined ? {} : { isrc: decision.isrc }),
        ...(decision.candidate === undefined ? {} : { candidate: decision.candidate }),
        ...(decision.candidate?.signals === undefined
          ? {}
          : { signals: decision.candidate.signals }),
      })
    },

    async placeTrack(track, before) {
      const { added } = await repo.addTracks(playlistId, [track])
      if (added > 0 && before !== null) {
        await repo.moveItems(playlistId, [track.id], { before })
      }
    },

    async saveTrack(track) {
      await repo.saveTracks([track])
    },
  }
}
