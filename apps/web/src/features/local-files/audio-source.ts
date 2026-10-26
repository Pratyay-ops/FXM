/**
 * Local files as an `AudioSource` (the provider interface of `@fxm/core`), for the playback
 * policy (stage 2.3), which tries an offline copy first (ARCHITECTURE.md §7.4):
 *
 * - `match` finds a local track's own file, and, for a track from any other source that has an
 *   ISRC, the local files tagged with the same ISRC, so a song the user owns, maybe in FLAC,
 *   can play from their own copy.
 * - `resolve` opens the file and returns one stream: its object URL (see `local-files.ts`).
 *
 * Local files never touch the network, so the provider context's `fetch` goes unused.
 *
 * @module
 */

import {
  type AudioCandidate,
  type AudioSource,
  FxmError,
  type MatchSignals,
  parseId,
  type Track,
} from '@fxm/core'
import { getLocalFiles, type LocalFiles } from './local-files'
import { albumArtistOf } from './tracks'
import type { LocalFileRecord } from './types'

/** A local file as an audio candidate. */
export function candidateOf(
  file: LocalFileRecord,
  confidence: number,
  evidence: string[],
  signals?: MatchSignals,
): AudioCandidate {
  const candidate: AudioCandidate = {
    source: 'local',
    ref: file.id,
    kind: 'song',
    title: file.tags.title,
    artists: file.tags.artists,
    confidence,
    evidence,
  }
  if (file.tags.durationMs !== undefined) candidate.durationMs = file.tags.durationMs
  if (signals !== undefined) candidate.signals = signals
  return candidate
}

function sameText(a: string | undefined, b: string | undefined): boolean {
  return a !== undefined && b !== undefined && a.trim().toLowerCase() === b.trim().toLowerCase()
}

/** The local native ID of a track, when it is a local track. */
export function localNativeIdOf(track: Pick<Track, 'id' | 'source'>): string | undefined {
  return track.source === 'local' ? parseId(track.id).nativeId : undefined
}

/** The local-files audio source; `files` defaults to the app's. */
export function createLocalAudioSource(files: () => LocalFiles = getLocalFiles): AudioSource {
  return {
    id: 'local',

    async match(track) {
      const own = localNativeIdOf(track)
      if (own !== undefined) {
        const file = await files().repo.fileById(own)
        return file === undefined ? [] : [candidateOf(file, 1, ['local file'])]
      }
      if (track.isrc === undefined) return []
      const matches = await files().repo.filesByIsrc(track.isrc)
      return matches.map((file) =>
        candidateOf(file, 0.95, ['isrc', 'local file'], {
          isrcVerified: true,
          sourceAlbumMatch:
            sameText(file.tags.album, track.album?.name) &&
            sameText(albumArtistOf(file.tags), track.artists[0]?.name),
        }),
      )
    },

    async resolve(candidate) {
      if (candidate.source !== 'local') {
        throw new FxmError('Unsupported', `Local files can’t play ${candidate.source} audio`)
      }
      return [await files().streamFor(candidate.ref)]
    },
  }
}
