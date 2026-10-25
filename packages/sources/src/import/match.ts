/**
 * Matching one import row with the matching engine of `@fxm/core` (stage 1.7), in the import's
 * catalog mode:
 *
 * - a row whose own track already plays in the mode (a YouTube Music song; any YouTube item in
 *   Music + Video mode) needs nothing;
 * - an official video without a song link, in Music mode, goes through the engine's video →
 *   song rule;
 * - everything else (a Spotify track, a CSV or M3U row without a catalog track, another video in
 *   Music mode) goes through `runMatch`: the ISRC gate when the row has an ISRC (its own, or one
 *   found on Spotify or through the MusicBrainz exact path), then the text searches. A row
 *   without a length runs in no-duration mode, which never goes beyond Suggest.
 *
 * The engine decides the band with the user's Auto setting; the verdict it leaves on the best
 * candidate says what the band would be with the setting on.
 *
 * @module
 */

import {
  type AudioCandidate,
  type CatalogMode,
  type EntityId,
  formatId,
  type MatchBand,
  type MatchRequest,
  type MatchResponse,
  type MatchResult,
  type MatchSource,
  matchVideoToSong,
  modePolicy,
  parseId,
  runMatch,
  type Track,
  type VideoSongMatch,
  videoSongsQuery,
} from '@fxm/core'
import { catalogTrackOf, isSpotifyRow, isYouTubeRow } from './rows'
import type { CandidateExtras, RowLookup, RowOutcome, RowResult, StoredRow } from './types'

/** How many alternatives a row keeps for the review list, besides the best candidate. */
export const MAX_ALTERNATIVES = 3

/** How many lines of the engine's evidence a row keeps. */
const MAX_EVIDENCE = 8

/**
 * What the import does with a row in a catalog mode:
 *
 * - `ready`: its own track plays as it is
 * - `load`: its own track must be loaded first, because the input named it by link only
 * - `video-song`: an official video without a song link, in Music mode: the video → song rule
 * - `match`: the matching engine finds its song
 * - `unplayable`: its own track never plays in FXM (a podcast episode)
 */
export type RowPlan = 'ready' | 'load' | 'video-song' | 'match' | 'unplayable'

/** Whether a row names a catalog track it does not describe yet (an M3U line with a link). */
export function needsLoad(row: StoredRow): boolean {
  if (row.trackId === undefined) return false
  if (row.title === '') return true
  return isYouTubeRow(row) && row.kind === undefined
}

/** What the import does with `row` in `mode` (see {@link RowPlan}). */
export function planRow(row: StoredRow, mode: CatalogMode): RowPlan {
  if (row.trackId === undefined) return 'match'
  if (needsLoad(row)) return 'load'
  if (isSpotifyRow(row)) return 'match'
  if (!isYouTubeRow(row) || row.kind === undefined) return 'ready'
  if (row.kind === 'episode') return 'unplayable'
  const verdict = modePolicy({ id: row.trackId, kind: row.kind, ...songIdOf(row) }, mode)
  if (verdict === 'playable' || verdict === 'plays-linked-song') return 'ready'
  if (verdict === 'needs-song-match') return 'video-song'
  return 'match'
}

function songIdOf(row: StoredRow): { songId?: EntityId<'track'> } {
  return row.songId === undefined ? {} : { songId: row.songId }
}

/** The matching engine's view of a row, with what the import looked up about it. */
export function matchSourceOf(row: StoredRow, lookup?: RowLookup | null): MatchSource {
  const source: MatchSource = {
    title: row.title,
    artists: row.artists.map((name) => ({ name })),
  }
  if (row.album !== undefined) source.album = { name: row.album }
  const durationMs = row.durationMs ?? lookup?.durationMs
  if (durationMs !== undefined) source.durationMs = durationMs
  if (row.isrc !== undefined) {
    source.isrc = row.isrc
    source.isrcOrigin = 'catalog'
  } else if (lookup?.isrc !== undefined) {
    source.isrc = lookup.isrc
    source.isrcOrigin = lookup.isrcOrigin ?? 'catalog'
  }
  const explicit = row.explicit ?? lookup?.explicit
  if (explicit !== undefined) source.explicit = explicit
  const releaseDate = row.releaseDate ?? lookup?.releaseDate
  if (releaseDate !== undefined) source.releaseDate = releaseDate
  const label = row.label ?? lookup?.label
  if (label !== undefined) source.label = label
  const albumType = row.albumType ?? lookup?.albumType
  if (albumType !== undefined) source.albumType = albumType
  return source
}

/** The outcome a band gives a row. */
export function outcomeOfBand(band: MatchBand): RowOutcome {
  if (band === 'auto') return 'matched'
  return band === 'suggest' ? 'review' : 'not-found'
}

/** A candidate's track ID. */
export function candidateTrackId(
  candidate: Pick<AudioCandidate, 'source' | 'ref'>,
): EntityId<'track'> {
  return formatId(candidate.source, 'track', candidate.ref)
}

/** The smallest artwork at least 120 pixels wide, else the largest there is. */
function listArtwork(track: Track): CandidateExtras['artwork'] {
  const sized = [...track.artwork].sort((a, b) => (a.width ?? 0) - (b.width ?? 0))
  const pick = sized.find((item) => (item.width ?? 0) >= 120) ?? sized.at(-1)
  if (pick === undefined) return undefined
  return {
    url: pick.url,
    ...(pick.width === undefined ? {} : { width: pick.width }),
    ...(pick.height === undefined ? {} : { height: pick.height }),
  }
}

/** The album and artwork the search pages showed for each candidate, by `ref`. */
function extrasOf(
  candidates: readonly AudioCandidate[],
  seen: ReadonlyMap<string, Track>,
): Record<string, CandidateExtras> | undefined {
  const extras: Record<string, CandidateExtras> = {}
  for (const candidate of candidates) {
    const track = seen.get(candidateTrackId(candidate))
    if (track === undefined) continue
    const entry: CandidateExtras = {}
    if (track.album !== undefined) {
      entry.album = {
        name: track.album.name,
        ...(track.album.id === undefined ? {} : { id: track.album.id }),
      }
    }
    const artwork = listArtwork(track)
    if (artwork !== undefined) entry.artwork = artwork
    if (entry.album !== undefined || entry.artwork !== undefined) extras[candidate.ref] = entry
  }
  return Object.keys(extras).length > 0 ? extras : undefined
}

/** Fills in the fields every matched result shares. */
function withCandidates(
  result: RowResult,
  best: AudioCandidate | undefined,
  candidates: readonly AudioCandidate[],
  seen: ReadonlyMap<string, Track>,
): RowResult {
  if (best === undefined) return result
  result.best = best
  const alternatives = candidates
    .filter((candidate) => candidate !== best)
    .slice(0, MAX_ALTERNATIVES)
  if (alternatives.length > 0) result.alternatives = alternatives
  const extras = extrasOf([best, ...alternatives], seen)
  if (extras !== undefined) result.extras = extras
  return result
}

/** A row's result from the engine's decision on a track. */
export function resultFromMatch(
  match: MatchResult,
  source: MatchSource,
  lookup: RowLookup | null | undefined,
  seen: ReadonlyMap<string, Track> = new Map(),
): RowResult {
  const result: RowResult = {
    outcome: outcomeOfBand(match.band),
    verdict: match.best?.verdict?.band ?? 'none',
  }
  withCandidates(result, match.best, match.candidates, seen)
  if (match.evidence.length > 0) result.evidence = match.evidence.slice(0, MAX_EVIDENCE)
  if (match.autoBlockers.length > 0) result.blockers = [...match.autoBlockers]
  if (match.isrc.isrc !== undefined) {
    result.isrc = match.isrc.isrc
    result.isrcOrigin = source.isrcOrigin ?? 'catalog'
  }
  if (lookup?.source !== undefined) result.lookup = lookup.source
  if (source.durationMs === undefined) result.noDuration = true
  if (match.incomplete) result.incomplete = true
  return result
}

/** A row's result from the video → song rule. */
export function resultFromVideoMatch(
  match: VideoSongMatch,
  seen: ReadonlyMap<string, Track> = new Map(),
): RowResult {
  const verdict = match.best?.verdict?.band ?? (match.via === 'link' ? 'auto' : 'none')
  const result: RowResult = { outcome: outcomeOfBand(match.band), verdict }
  withCandidates(result, match.best, match.candidates, seen)
  if (match.evidence.length > 0) result.evidence = match.evidence.slice(0, MAX_EVIDENCE)
  if (match.autoBlockers.length > 0) result.blockers = [...match.autoBlockers]
  return result
}

/** What {@link matchRow} needs. */
export interface MatchRowInput {
  /** The row. */
  row: StoredRow
  /** What the import looked up about it. */
  lookup?: RowLookup | null
  /** The import's catalog mode. */
  mode: CatalogMode
  /** The user's Auto setting. */
  autoMatch: boolean
  /** Fetches a page the engine asks for (already paced by the request budget). */
  fetchPage: (request: MatchRequest) => Promise<MatchResponse | null>
  /** Every track the pages returned so far, by ID: where candidates' albums and artwork come from. */
  seen?: ReadonlyMap<string, Track>
}

/**
 * Matches one row (see the module documentation). A row whose plan is `ready` or `unplayable`
 * gets its result without a search; `load` rows must be loaded first (this throws a
 * `RangeError` for them).
 *
 * @throws Whatever `fetchPage` throws, e.g. the abort reason or an `Unsupported` `FxmError`.
 */
export async function matchRow(input: MatchRowInput): Promise<RowResult> {
  const { row, mode, autoMatch, fetchPage } = input
  const seen = input.seen ?? new Map<string, Track>()
  const plan = planRow(row, mode)
  if (plan === 'load') throw new RangeError('Load the row’s track before matching it')
  if (plan === 'ready') {
    return { outcome: 'ready', ...(row.trackId ? { playlistTrackId: row.trackId } : {}) }
  }
  if (plan === 'unplayable') {
    return { outcome: 'not-found', evidence: ['podcast episodes do not play in FXM'] }
  }
  if (plan === 'video-song') {
    const video = catalogTrackOf(row) as Track
    const response = await fetchPage({ kind: 'text-songs', query: videoSongsQuery(video) })
    const songs = response?.kind === 'text-songs' ? response.tracks : []
    const result = resultFromVideoMatch(matchVideoToSong(video, songs, { auto: autoMatch }), seen)
    if (response === null) result.incomplete = true
    return result
  }
  const source = matchSourceOf(row, input.lookup)
  const match = await runMatch(source, fetchPage, { mode, auto: autoMatch })
  return resultFromMatch(match, source, input.lookup, seen)
}

/**
 * The library track for a candidate: the whole track the search page showed, or one made from
 * the candidate.
 */
export function trackOfCandidate(candidate: AudioCandidate, extras?: CandidateExtras): Track {
  const id = candidateTrackId(candidate)
  const track: Track = {
    id,
    source: parseId(id).source,
    title: candidate.title,
    artists: candidate.artists.map((name) => ({ name })),
    artwork: extras?.artwork === undefined ? [] : [extras.artwork],
    kind: candidate.kind,
  }
  if (candidate.durationMs !== undefined) track.durationMs = candidate.durationMs
  if (extras?.album !== undefined) {
    track.album = {
      name: extras.album.name,
      ...(extras.album.id === undefined ? {} : { id: extras.album.id }),
    }
  }
  return track
}
