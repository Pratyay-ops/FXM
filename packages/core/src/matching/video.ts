/**
 * Official video → song, for Music mode: which song an official music video is the video of.
 *
 * @module
 */

import { entityKey, isEntityId, parseId } from '../ids'
import { songForVideo } from '../mode'
import type { Track } from '../model'
import type { AudioCandidate } from '../providers'
import {
  type Compared,
  closeDurations,
  differentReleases,
  lookAlike,
  releaseIdOf,
} from './candidate'
import { yearOf } from './release'
import {
  prepareCandidateTitle,
  prepareSource,
  scoreCandidate,
  trackSide,
  validDurationMs,
} from './score'
import {
  type AutoBlocker,
  MATCHER_VERSION,
  type MatchBand,
  type MatchVerdict,
  resolveMatchThresholds,
  type VideoMatchOptions,
  type VideoSongMatch,
} from './types'

/** Scores this close are equal. */
const EPSILON = 1e-9

/** Rounds a score for output. */
function round(value: number): number {
  return Math.round(value * 10000) / 10000
}

/** A song that passes the four rules, compared with the video. */
interface VideoCandidate extends Compared {
  /** Its place on the page, for ties. */
  order: number
}

/** A result without a match: Music mode hides the video. */
function noMatch(reason: string, blockers: AutoBlocker[], autoOn: boolean): VideoSongMatch {
  return {
    band: 'none',
    autoEligible: false,
    via: 'none',
    candidates: [],
    autoBlockers: autoOn ? blockers : ['setting-off', ...blockers],
    evidence: [reason],
    matcherVersion: MATCHER_VERSION,
  }
}

/**
 * The song an official music video maps to in Music mode.
 *
 * A song link from the video's source wins over any scoring (`songForVideo`: YouTube Music's
 * album pages link official videos to their songs), and is `auto` whatever the setting: it is
 * not a guess. Pass `ignoreLink` when the linked song turned out not to be playable, which
 * leaves the video `needs-song-match`.
 *
 * Otherwise the engine compares the video with the songs a provider found (the songs search for
 * `videoSongsQuery(video)`), without a duration term, because videos have intros and outros. A
 * song is a candidate only if all of these hold:
 *
 * - its title similarity is at least 0.8 (after "Official Video" and the like and a leading
 *   "Artist - " are gone)
 * - its artist similarity is at least 0.5
 * - no strong version tag differs: a live video never maps to the studio song
 * - it is no longer than the video plus 5 s, so a shortened video never maps to the album
 *   version
 *
 * The bands are those of a track match: `auto` needs the Auto setting, a score of at least 0.80
 * (an uncredited featured artist costs 0.45, so a "feat." version never gets there) and a lead
 * of 0.05 over the best song that is not the same version, and no look-alike song from another
 * release among the candidates, since nothing ties a video to one release (the re-recording
 * guard: "The Twist" comes on six labels' releases). Otherwise `suggest` from 0.60, else `none`,
 * and Music mode hides the video. Only official music videos (`music-video`) are matched; any
 * other video is `none`.
 */
export function matchVideoToSong(
  video: Track,
  songs: readonly Track[],
  options: VideoMatchOptions = {},
): VideoSongMatch {
  const autoOn = options.auto === true
  if (options.ignoreLink !== true) {
    const link = songForVideo(video)
    if (link !== undefined) {
      return {
        band: 'auto',
        autoEligible: true,
        via: 'link',
        songId: link,
        candidates: [],
        autoBlockers: [],
        evidence: ['song link'],
        matcherVersion: MATCHER_VERSION,
      }
    }
  }
  if (video.kind !== 'music-video') {
    return noMatch('not an official music video', ['no-candidates'], autoOn)
  }
  const videoMs = validDurationMs(video.durationMs)
  // No length to compare is no match: the rule needs both.
  if (videoMs === undefined) return noMatch('video duration unknown', ['no-duration'], autoOn)

  const thresholds = resolveMatchThresholds(options.thresholds)
  const source = prepareSource({
    title: video.title,
    artists: video.artists.map((artist) => artist.name),
  })
  const seen = new Set<string>()
  const passed: VideoCandidate[] = []
  for (const song of songs) {
    if (song.kind !== 'song' || !isEntityId(song.id, 'track')) continue
    const key = entityKey(song.id)
    if (seen.has(key)) continue
    seen.add(key)
    const side = trackSide(song)
    const prepared = prepareCandidateTitle(source, side)
    const breakdown = scoreCandidate(source, side, prepared)
    const songMs = side.durationMs
    if (
      songMs === undefined ||
      songMs > videoMs + thresholds.videoSlackMs ||
      !(breakdown.title >= thresholds.videoTitle) ||
      !(breakdown.artist >= thresholds.videoArtist) ||
      breakdown.strongMismatch
    ) {
      continue
    }
    const entry: VideoCandidate = { track: song, key, prepared, breakdown, order: passed.length }
    const year = yearOf(song.releaseDate)
    if (year !== undefined) entry.year = year
    passed.push(entry)
  }
  passed.sort((a, b) => b.breakdown.score - a.breakdown.score || a.order - b.order)
  const best = passed[0]
  if (best === undefined) return noMatch('no song passes', ['no-candidates'], autoOn)

  // The same version of the same song within the window of the best, whatever its release.
  const sameAsBest = (other: VideoCandidate) =>
    lookAlike(best, other) && closeDurations(best, other, undefined, thresholds)
  const rival = passed.find((other) => other !== best && !sameAsBest(other))
  const margin = round(best.breakdown.score - (rival?.breakdown.score ?? 0))
  const rivals = passed.filter(
    (other) => other !== best && sameAsBest(other) && differentReleases(best, other),
  )
  const blockers: AutoBlocker[] = []
  if (!(best.breakdown.score >= thresholds.auto - EPSILON)) blockers.push('low-score')
  if (!(margin >= thresholds.margin - EPSILON)) blockers.push('margin')
  if (rivals.length > 0) blockers.push('rivals')
  const suggestOk = best.breakdown.score >= thresholds.suggest - EPSILON
  const eligibleBand: MatchBand = blockers.length === 0 ? 'auto' : suggestOk ? 'suggest' : 'none'
  const band: MatchBand = eligibleBand === 'auto' && !autoOn ? 'suggest' : eligibleBand
  const autoBlockers: AutoBlocker[] = autoOn ? blockers : ['setting-off', ...blockers]
  const verdict: MatchVerdict = {
    band: eligibleBand,
    blockers: [...blockers],
    matcherVersion: MATCHER_VERSION,
  }

  const candidates = passed.map((entry): AudioCandidate => {
    const { source: songSource, nativeId } = parseId(entry.track.id)
    const source = songSource === 'yt' ? 'ytm' : songSource
    const songMs = validDurationMs(entry.track.durationMs) ?? 0
    const releaseId = releaseIdOf(entry.track, source)
    const candidate: AudioCandidate = {
      source,
      ref: nativeId,
      kind: entry.track.kind,
      title: entry.track.title,
      artists: entry.track.artists.map((artist) => artist.name),
      durationMs: songMs,
      confidence: round(entry.breakdown.score),
      evidence: [
        `title ${entry.breakdown.title.toFixed(2)}`,
        `artist ${entry.breakdown.artist.toFixed(2)}`,
        `song ${((songMs - videoMs) / 1000).toFixed(1)}s vs the video`,
        ...entry.breakdown.uncreditedFeatured.map((name) => `uncredited feat. ${name}`),
        `score ${round(entry.breakdown.score).toFixed(2)}`,
      ],
      signals: {
        isrcVerified: false,
        sourceAlbumMatch: false,
        ...(releaseId !== undefined ? { releaseId } : {}),
      },
    }
    if (entry === best) candidate.verdict = verdict
    return candidate
  })
  const evidence = [
    `best score ${round(best.breakdown.score).toFixed(2)}`,
    `margin ${margin.toFixed(2)}`,
    `band ${band}`,
    ...autoBlockers.map((blocker) => `blocked: ${blocker}`),
  ]
  if (eligibleBand === 'none') {
    return {
      band,
      autoEligible: false,
      via: 'none',
      candidates,
      autoBlockers,
      evidence: ['no song reaches suggest', ...evidence],
      matcherVersion: MATCHER_VERSION,
    }
  }
  const result: VideoSongMatch = {
    band,
    autoEligible: eligibleBand === 'auto',
    via: 'match',
    songId: best.track.id,
    candidates,
    autoBlockers,
    evidence: [`matched ${candidates[0]?.ref ?? ''}`, ...evidence],
    matcherVersion: MATCHER_VERSION,
  }
  if (candidates[0] !== undefined) result.best = candidates[0]
  return result
}
