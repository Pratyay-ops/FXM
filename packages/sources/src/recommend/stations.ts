/**
 * Turns a Last.fm station into candidates, following the catalog mode
 * (ARCHITECTURE.md §4, "Other sources in the modes"):
 *
 * - **Music + Video:** a station item's YouTube video plays as it is, as a `video`.
 * - **Music:** each video is classified first, with one InnerTube call from the request budget.
 *   A song is recommended as it is. An official video is replaced by its song: the one it links,
 *   else the one the matching engine's video-to-song rule finds. Last.fm's links are suggested by
 *   its users, so the song must also be the one the station names (artist, title and version).
 *   When the budget is short, or the classification fails or finds no such song, the item
 *   becomes a song search by its artists and title, which Last.fm knows: its video is dropped,
 *   the song stays.
 *
 * @module
 */

import {
  formatId,
  isFxmError,
  isPlayable,
  type ProviderContext,
  songForVideo,
  type Track,
} from '@fxm/core'
import type { LastfmStationTrack } from '../lastfm/station'
import type { ClassificationBudget, SongForVideo, YouTubeLookup } from './adapters'
import {
  artistSimilarity,
  comparable,
  readTitle,
  sameVersions,
  similarity,
  songKey,
} from './internal/text'
import type {
  CandidateBase,
  RecommendationCandidate,
  SeedRef,
  SongSearchCandidate,
  TrackCandidate,
} from './types'

/** What classifying station items needs. */
export interface StationOptions {
  /** Looks a YouTube video up; without it nothing is classified. */
  lookup?: YouTubeLookup
  /** The request budget's room for classifications. */
  budget: ClassificationBudget
  /** The video-to-song rule for official videos without a song link. */
  songForVideo?: SongForVideo
  /** Classify at most this many items of one station. */
  maxClassifications: number
}

/** The score of the item at `rank` in a list of `total`: 1 for the first, `1/total` for the last. */
export function rankScore(rank: number, total: number): number {
  return total > 0 ? (total - rank) / total : 0
}

/** A station item as a plain YouTube video, which is what Music + Video mode plays. */
function videoTrack(item: LastfmStationTrack, youtubeId: string): Track {
  const track: Track = {
    id: formatId('yt', 'track', youtubeId),
    source: 'yt',
    title: item.title,
    artists: item.artists.map((name) => ({ name })),
    artwork: [],
    kind: 'video',
  }
  if (item.durationMs !== undefined) track.durationMs = item.durationMs
  return track
}

/** A station item as a song to search for. */
function songSearch(base: CandidateBase, item: LastfmStationTrack, keepVideo: boolean) {
  const candidate: SongSearchCandidate = {
    ...base,
    type: 'song-search',
    title: item.title,
    artists: item.artists,
  }
  if (item.durationMs !== undefined) candidate.durationMs = item.durationMs
  if (keepVideo && item.youtubeId !== undefined) candidate.youtubeId = item.youtubeId
  return candidate
}

/** A song must be by an artist at least this similar to the station item's. */
const MIN_ARTIST = 0.6
/** And its title proper at least this similar. */
const MIN_TITLE = 0.8

/**
 * Whether a song found for a station item is the song the item names: by one of its artists,
 * with its title proper and the same strong version tags (live, remix, acoustic...).
 */
export function namesSameSong(song: Track, item: LastfmStationTrack): boolean {
  const artists = song.artists.map((artist) => artist.name)
  if (!artists.some((name) => artistSimilarity(item.artists, name) >= MIN_ARTIST)) return false
  const wanted = readTitle(item.title, item.artists)
  const found = readTitle(song.title, artists)
  return (
    similarity(comparable(wanted.core), comparable(found.core)) >= MIN_TITLE &&
    sameVersions(wanted.versions, found.versions)
  )
}

/** Errors that say something about one video only, after which classifying the next is fine. */
function isVideoError(error: unknown): boolean {
  return (
    isFxmError(error, 'NotFound') ||
    isFxmError(error, 'Unavailable') ||
    isFxmError(error, 'GeoBlocked')
  )
}

/**
 * The candidates of one Last.fm station, in the station's order (see the module documentation).
 * Classification goes one item at a time, at most `maxClassifications` and the budget's
 * allowance. A failure that is not about the one video (a `RateLimited` refusal from the budget,
 * a bot check, a network error) stops classifying, and the remaining items become song searches.
 * A cancelled `ctx.signal` rejects with its reason.
 */
export async function stationCandidates(
  items: readonly LastfmStationTrack[],
  seed: SeedRef,
  ctx: ProviderContext,
  options: StationOptions,
): Promise<RecommendationCandidate[]> {
  const { lookup } = options
  const music = ctx.mode === 'music'
  let allowance =
    music && lookup !== undefined
      ? Math.max(0, Math.min(options.maxClassifications, options.budget.allowance(ctx)))
      : 0
  const candidates: RecommendationCandidate[] = []

  /** The song a classified track stands for in Music mode, or `null` when there is none. */
  async function songFor(track: Track): Promise<Track | null> {
    if (isPlayable(track, 'music')) return track
    if (track.kind !== 'music-video' || lookup === undefined) return null
    const linked = songForVideo(track)
    if (linked !== undefined) {
      if (allowance <= 0) return null
      allowance--
      const song = await lookup.getTrack(linked, ctx)
      return isPlayable(song, 'music') ? song : null
    }
    const song = options.songForVideo === undefined ? null : await options.songForVideo(track, ctx)
    return song !== null && isPlayable(song, 'music') ? song : null
  }

  for (const [rank, item] of items.entries()) {
    const [main = ''] = item.artists
    const base: CandidateBase = {
      source: 'lastfm',
      part: 'station',
      seed,
      rank,
      score: rankScore(rank, items.length),
      key: songKey(main, item.title),
      attributionUrl: item.url,
    }
    const { youtubeId } = item
    if (!music) {
      candidates.push(
        youtubeId === undefined
          ? songSearch(base, item, false)
          : { ...base, type: 'track', track: videoTrack(item, youtubeId) },
      )
      continue
    }
    if (youtubeId === undefined || lookup === undefined || allowance <= 0) {
      candidates.push(songSearch(base, item, true))
      continue
    }
    allowance--
    let video: Track
    try {
      video = await lookup.getTrack(formatId('ytm', 'track', youtubeId), ctx)
    } catch (error) {
      if (ctx.signal?.aborted) throw ctx.signal.reason
      const gone = isVideoError(error)
      if (!gone) allowance = 0
      // A video that is gone is dropped; one that could not be looked up may still be a song.
      candidates.push(songSearch(base, item, !gone))
      continue
    }
    let song: Track | null
    try {
      song = await songFor(video)
    } catch (error) {
      if (ctx.signal?.aborted) throw ctx.signal.reason
      if (!isVideoError(error)) allowance = 0
      song = null
    }
    if (song === null || !namesSameSong(song, item)) {
      candidates.push(songSearch(base, item, false))
      continue
    }
    const [artist] = song.artists
    const candidate: TrackCandidate = {
      ...base,
      type: 'track',
      track: song,
      key: songKey(artist?.name ?? main, song.title),
    }
    candidates.push(candidate)
  }
  return candidates
}
