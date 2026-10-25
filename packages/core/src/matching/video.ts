/**
 * Official video → song, for Music mode: which song an official music video is the video of.
 *
 * @module
 */

import { entityKey, isEntityId, parseId } from '../ids'
import { songForVideo } from '../mode'
import type { Track } from '../model'
import type { AudioCandidate } from '../providers'
import { prepareCandidateTitle, prepareSource, scoreCandidate, trackSide } from './score'
import { type MatchOptions, resolveThresholds, type VideoSongMatch } from './types'

/** Rounds a score for output. */
function round(value: number): number {
  return Math.round(value * 10000) / 10000
}

/**
 * The song an official music video maps to in Music mode.
 *
 * A song link from the video's source wins over any scoring (`songForVideo`: YouTube Music's
 * album pages link official videos to their songs). Otherwise the engine compares the video
 * with the songs a provider found, without a duration check, because videos have intros and
 * outros. A song matches only if all of these hold:
 *
 * - its title similarity is at least 0.8 (after "Official Video" and the like and a leading
 *   "Artist - " are gone)
 * - its artist similarity is at least 0.5
 * - no strong version family differs: a live video never maps to the studio song
 * - it is no longer than the video plus 5 s, so a shortened video never maps to the album
 *   version
 *
 * The best match by score is `auto` when the Auto setting is on and `suggest` otherwise; with
 * no match the band is `none`, and Music mode hides the video. A link is always `auto`: it is
 * not a guess.
 */
export function matchVideoToSong(
  video: Track,
  songs: readonly Track[],
  options: MatchOptions = {},
): VideoSongMatch {
  const link = songForVideo(video)
  if (link !== undefined) {
    return { band: 'auto', via: 'link', songId: link, candidates: [], evidence: ['song link'] }
  }
  const thresholds = resolveThresholds(options)
  const source = prepareSource({
    title: video.title,
    artists: video.artists.map((artist) => artist.name),
  })
  const seen = new Set<string>()
  const passed: Array<{ song: Track; candidate: AudioCandidate; score: number; order: number }> = []
  for (const song of songs) {
    if (song.kind !== 'song' || !isEntityId(song.id, 'track')) continue
    const key = entityKey(song.id)
    if (seen.has(key)) continue
    seen.add(key)
    const songMs = song.durationMs
    const videoMs = video.durationMs
    // No length to compare is no match: the rule needs both.
    if (songMs === undefined || videoMs === undefined) continue
    if (songMs > videoMs + thresholds.videoSlackMs) continue
    const side = trackSide(song)
    const breakdown = scoreCandidate(source, side, prepareCandidateTitle(source, side))
    if (
      breakdown.title < thresholds.videoTitle ||
      breakdown.artist < thresholds.videoArtist ||
      breakdown.strongMismatch
    ) {
      continue
    }
    const { source: songSource, nativeId } = parseId(song.id)
    const candidate: AudioCandidate = {
      source: songSource === 'yt' ? 'ytm' : songSource,
      ref: nativeId,
      kind: song.kind,
      title: song.title,
      artists: song.artists.map((artist) => artist.name),
      durationMs: songMs,
      confidence: round(breakdown.score),
      evidence: [
        `title ${breakdown.title.toFixed(2)}`,
        `artist ${breakdown.artist.toFixed(2)}`,
        `song ${((songMs - videoMs) / 1000).toFixed(1)}s vs the video`,
        `score ${round(breakdown.score).toFixed(2)}`,
      ],
      signals: { isrcVerified: false, sourceAlbumMatch: false },
    }
    passed.push({ song, candidate, score: breakdown.score, order: passed.length })
  }
  passed.sort((a, b) => b.score - a.score || a.order - b.order)
  const best = passed[0]
  if (best === undefined) {
    return { band: 'none', via: 'none', candidates: [], evidence: ['no song passes'] }
  }
  return {
    band: options.auto ? 'auto' : 'suggest',
    via: 'match',
    songId: best.song.id,
    best: best.candidate,
    candidates: passed.map((entry) => entry.candidate),
    evidence: [`matched ${best.candidate.ref}`, ...best.candidate.evidence],
  }
}
