/**
 * Turns a Last.fm station into candidates, following the catalog mode
 * (ARCHITECTURE.md §4, "Other sources in the modes"):
 *
 * - **Music + Video:** a station item's YouTube video plays as it is, as a `video`.
 * - **Music** (and any unknown mode): each video is classified first, with InnerTube calls from
 *   the request budget. A song is recommended as it is. An official video is replaced by its
 *   song: the one it links, else, while the user's Auto setting is on, the one the matching
 *   engine's video-to-song rule maps it to at the `auto` band. Last.fm's links are suggested by
 *   its users, so the song must also be the one the station names (artist, title and version).
 *   When the budget or the time is short, or the classification fails or finds no such song, the
 *   item becomes a song search by its artists and title, which Last.fm knows: its video is
 *   dropped, the song stays.
 *
 * @module
 */

import {
  effectiveMatchBand,
  formatId,
  isFxmError,
  isPlayable,
  type ProviderContext,
  songForVideo,
  type Track,
} from '@fxm/core'
import type { LastfmStationTrack } from '../lastfm/station'
import { comparable, readTitle, sameArtist, sameVersions, similarity } from '../shared/names'
import { wholeNumber } from '../shared/numbers'
import type {
  AutoMatchSetting,
  ClassificationBudget,
  SongForVideo,
  YouTubeLookup,
} from './adapters'
import { beforeDeadline, TIMED_OUT } from './jobs'
import { songKey } from './keys'
import { isMusicMode } from './seeds'
import type {
  CandidateBase,
  RecommendationCandidate,
  SeedRef,
  SongMatch,
  SongSearchCandidate,
  TrackCandidate,
} from './types'

/** By default, classification stops this long after it started, and the rest are searches. */
export const DEFAULT_MAX_CLASSIFICATION_MS = 6_000

/** What classifying station items needs. */
export interface StationOptions {
  /** Looks a YouTube video up; without it nothing is classified. */
  lookup?: YouTubeLookup | undefined
  /** The request budget's room, and the context, for classification calls. */
  budget: ClassificationBudget
  /** The video-to-song rule for official videos without a song link. */
  songForVideo?: SongForVideo | undefined
  /** Whether the user's Auto setting lets matches play unasked. Default: off. */
  autoMatch?: AutoMatchSetting | undefined
  /** Make at most this many classification calls for one station. */
  maxClassifications: number
  /**
   * Stop classifying this many milliseconds after the first call, cancelling the call in
   * flight: the item it was for and the rest become song searches. Default
   * {@link DEFAULT_MAX_CLASSIFICATION_MS}.
   */
  maxClassificationMs?: number | undefined
}

/** The score of the item at `rank` in a list of `total`: 1 for the first, `1/total` for the last. */
export function rankScore(rank: number, total: number): number {
  return total > 0 ? (total - rank) / total : 0
}

/** A station item as a plain YouTube video, which is what Music + Video mode plays. */
function videoTrack(item: LastfmStationTrack, youtubeId: string): Track {
  return {
    id: formatId('yt', 'track', youtubeId),
    source: 'yt',
    title: item.title,
    artists: item.artists.map((name) => ({ name })),
    artwork: [],
    kind: 'video',
  }
}

/** A station item as a song to search for, with its video when it may still be the song. */
function songSearch(
  base: CandidateBase,
  item: LastfmStationTrack,
  keepVideo: boolean,
): SongSearchCandidate {
  const candidate: SongSearchCandidate = {
    ...base,
    type: 'song-search',
    title: item.title,
    artists: item.artists,
  }
  if (keepVideo && item.youtubeId !== undefined) candidate.youtubeId = item.youtubeId
  return candidate
}

/** A song's title proper must be at least this similar to the station item's. */
const MIN_TITLE = 0.8

/** A song as another source names it, e.g. a station item: its title and its artists' names. */
export interface SongName {
  /** The title, as that source shows it. */
  readonly title: string
  /** The artists' names, main artist first. */
  readonly artists: readonly string[]
}

/**
 * Whether a song found for a station item (or any song another source names) is the song the
 * item names: by one of its artists (by name: a tribute or karaoke act named after the artist
 * does not count), with its title proper and the same strong version tags (live, remix,
 * acoustic...).
 */
export function namesSameSong(song: Track, item: SongName): boolean {
  const artists = song.artists.map((artist) => artist.name)
  if (!artists.some((name) => sameArtist(item.artists, name))) return false
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
 * How many classification calls the budget allows now, within `maxClassifications`. A value
 * that is not a number counts as 0, so that bad budget data never turns the cap off.
 */
function allowanceOf(options: StationOptions, ctx: ProviderContext): number {
  const cap = wholeNumber(options.maxClassifications, 0)
  const budget = options.budget.allowance(ctx)
  const room = Number.isNaN(budget) ? 0 : Math.max(0, Math.floor(budget))
  return Math.min(cap, room)
}

/** The context for classification calls: the budget's, with the caller's mode and signal. */
function classificationContext(options: StationOptions, ctx: ProviderContext): ProviderContext {
  const base = options.budget.context?.(ctx) ?? ctx
  const { signal: _theirs, ...rest } = base
  return ctx.signal === undefined
    ? { ...rest, mode: ctx.mode }
    : { ...rest, mode: ctx.mode, signal: ctx.signal }
}

/** A song found for a station item's video, and how. */
interface Found {
  song: Track
  match?: SongMatch
}

/**
 * The candidates of one Last.fm station, in the station's order (see the module documentation).
 * Classification goes one item at a time, within `maxClassifications` and the budget's
 * allowance (each lookup, linked-song lookup and video-to-song call counts), and within
 * `maxClassificationMs`. A failure that is not about the one video (a `RateLimited` refusal from
 * the budget, a bot check, a network error) stops classifying, and the remaining items become
 * song searches. A cancelled `ctx.signal` rejects with its reason.
 */
export async function stationCandidates(
  items: readonly LastfmStationTrack[],
  seed: SeedRef,
  ctx: ProviderContext,
  options: StationOptions,
): Promise<RecommendationCandidate[]> {
  const { lookup } = options
  const music = isMusicMode(ctx.mode)
  const autoOn = options.autoMatch?.(ctx) === true
  let allowance = music && lookup !== undefined ? allowanceOf(options, ctx) : 0
  const classify = classificationContext(options, ctx)
  const limitMs = wholeNumber(options.maxClassificationMs, DEFAULT_MAX_CLASSIFICATION_MS)
  let until: number | undefined
  let stopped = false
  const candidates: RecommendationCandidate[] = []

  /**
   * One classification call, counted against the allowance and timed against the deadline.
   * `TIMED_OUT` (and classification stops) when the time ran out.
   */
  async function call<T>(
    work: (ctx: ProviderContext) => Promise<T>,
  ): Promise<T | typeof TIMED_OUT> {
    allowance--
    until ??= Date.now() + limitMs
    const result = await beforeDeadline(
      (signal) => work({ ...classify, signal }),
      until,
      ctx.signal,
    )
    if (result === TIMED_OUT) stopped = true
    return result
  }

  /** Whether another classification call may start now. */
  function mayCall(): boolean {
    return !stopped && allowance > 0 && (until === undefined || Date.now() < until)
  }

  /** The song a classified video stands for in Music mode, or `null` when there is none. */
  async function songFor(video: Track): Promise<Found | null> {
    if (isPlayable(video, 'music')) return { song: video }
    if (video.kind !== 'music-video' || lookup === undefined) return null
    const linked = songForVideo(video)
    if (linked !== undefined) {
      if (!mayCall()) return null
      const song = await call((context) => lookup.getTrack(linked, context))
      return song !== TIMED_OUT && isPlayable(song, 'music')
        ? { song, match: { via: 'link' } }
        : null
    }
    // A match the user's Auto setting would not let play unasked is no candidate: spare the call.
    const rule = options.songForVideo
    if (rule === undefined || !autoOn || !mayCall()) return null
    const found = await call((context) => rule(video, context))
    if (found === TIMED_OUT || found === null || !isPlayable(found.song, 'music')) return null
    const match: SongMatch = { via: found.via }
    if (found.verdict !== undefined) match.verdict = found.verdict
    if (found.via === 'match' && effectiveMatchBand(found.verdict, autoOn) !== 'auto') return null
    return { song: found.song, match }
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
    if (youtubeId === undefined || lookup === undefined || !mayCall()) {
      candidates.push(songSearch(base, item, true))
      continue
    }
    let video: Track | typeof TIMED_OUT
    try {
      video = await call((context) => lookup.getTrack(formatId('ytm', 'track', youtubeId), context))
    } catch (error) {
      if (ctx.signal?.aborted) throw ctx.signal.reason
      const gone = isVideoError(error)
      if (!gone) stopped = true
      // A video that is gone is dropped; one that could not be looked up may still be a song.
      candidates.push(songSearch(base, item, !gone))
      continue
    }
    if (video === TIMED_OUT) {
      candidates.push(songSearch(base, item, true))
      continue
    }
    let found: Found | null
    try {
      found = await songFor(video)
    } catch (error) {
      if (ctx.signal?.aborted) throw ctx.signal.reason
      if (!isVideoError(error)) stopped = true
      found = null
    }
    if (found === null || !namesSameSong(found.song, item)) {
      candidates.push(songSearch(base, item, false))
      continue
    }
    const [artist] = found.song.artists
    const candidate: TrackCandidate = {
      ...base,
      type: 'track',
      track: found.song,
      key: songKey(artist?.name ?? main, found.song.title),
    }
    if (found.match !== undefined) candidate.match = found.match
    candidates.push(candidate)
  }
  return candidates
}
