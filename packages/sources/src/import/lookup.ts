/**
 * What an import looks up about a Spotify row before matching it, so the matching engine gets
 * an ISRC and a length:
 *
 * - **Spotify** (stage 1.5), when it is on and reachable: the track's ISRC, label, release date
 *   and album type (`metadata/4`), and its length when the row lacks one. The ISRC is the
 *   catalog's own (`catalog`).
 * - **MusicBrainz's exact path** (stage 1.6) otherwise: the recording MusicBrainz links to the
 *   Spotify track's URL, with its ISRCs and length, in batches of up to 100 rows. A hit counts as
 *   an ISRC-verified input. Spotify's data export, which has neither lengths nor ISRCs, needs no
 *   Spotify provider this way; rows MusicBrainz cannot fill run in no-duration mode.
 *
 * @module
 */

import type { EntityId, ProviderContext, Track } from '@fxm/core'
import { findExactIsrcs, type MusicBrainzLookups } from '../musicbrainz'
import type { ImportSpotify } from './load'
import { isSpotifyRow } from './rows'
import type { RowLookup, StoredRow } from './types'

/** What the MusicBrainz exact path uses. */
export type ImportMusicBrainz = Pick<MusicBrainzLookups, 'lookupUrls' | 'getRecordings'>

/** How many rows one MusicBrainz batch looks up: one URL request takes up to 100 URLs. */
export const MUSICBRAINZ_BATCH = 100

/** Whether a row is worth looking up: a Spotify row without an ISRC or a length. */
export function wantsLookup(row: StoredRow): boolean {
  return isSpotifyRow(row) && (row.isrc === undefined || row.durationMs === undefined)
}

/**
 * Looks a Spotify row up on Spotify: its details, and the track itself when the row lacks a
 * length or a title, calling `pace` before each request. Returns the lookup and, when it was
 * loaded, the whole track (for the library's artwork).
 *
 * @throws The provider's errors.
 */
export async function lookupOnSpotify(
  spotify: ImportSpotify,
  row: StoredRow,
  ctx: ProviderContext,
  pace: () => Promise<void> = async () => {},
): Promise<{ lookup: RowLookup; track?: Track }> {
  const id = row.trackId as EntityId<'track'>
  await pace()
  const details = await spotify.getTrackDetails(id, ctx)
  let track: Track | undefined
  if (row.durationMs === undefined || row.title === '') {
    await pace()
    track = await spotify.getTrack(id, ctx)
  }
  const lookup: RowLookup = { source: 'spotify' }
  if (details.isrc !== undefined) {
    lookup.isrc = details.isrc
    lookup.isrcOrigin = 'catalog'
  }
  if (details.label !== undefined) lookup.label = details.label
  if (details.releaseDate !== undefined) lookup.releaseDate = details.releaseDate
  if (details.albumType !== undefined) lookup.albumType = details.albumType
  if (track?.durationMs !== undefined) lookup.durationMs = track.durationMs
  if (track?.explicit !== undefined) lookup.explicit = track.explicit
  return track === undefined ? { lookup } : { lookup, track }
}

/**
 * The MusicBrainz exact path for a batch of Spotify rows: a lookup for each row MusicBrainz
 * links to exactly one recording, `null` for the others. A recording with one ISRC gives it as
 * `musicbrainz-exact`; with several, the first as `musicbrainz-exact-several`; with none, only
 * its length.
 *
 * @throws The client's errors (`RateLimited`, `Network`, …) and the abort reason.
 */
export async function lookupOnMusicBrainz(
  musicBrainz: ImportMusicBrainz,
  rows: readonly { index: number; trackId: EntityId<'track'> }[],
  ctx: ProviderContext,
): Promise<Map<number, RowLookup | null>> {
  const findings = await findExactIsrcs(
    musicBrainz,
    rows.map((row) => row.trackId),
    ctx,
    { priority: 'bulk' },
  )
  const lookups = new Map<number, RowLookup | null>()
  for (const { index, trackId } of rows) {
    const finding = findings.get(trackId)
    if (finding === undefined) {
      lookups.set(index, null)
      continue
    }
    const lookup: RowLookup = { source: 'musicbrainz' }
    const isrc = finding.isrc ?? finding.isrcs[0]
    if (isrc !== undefined) {
      lookup.isrc = isrc
      lookup.isrcOrigin =
        finding.isrc === undefined ? 'musicbrainz-exact-several' : 'musicbrainz-exact'
    }
    if (finding.recording.lengthMs !== undefined) lookup.durationMs = finding.recording.lengthMs
    lookups.set(index, lookup.isrc === undefined && lookup.durationMs === undefined ? null : lookup)
  }
  return lookups
}
