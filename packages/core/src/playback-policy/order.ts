/**
 * The order in which the playback policy looks for a track's audio (ARCHITECTURE.md §7.4), and
 * the audio candidates it builds from a track itself.
 *
 * @module
 */

import { entityKey, formatId, isSourceId, parseId, type SourceId } from '../ids'
import { type CatalogMode, isPlayable, modePolicy, songForVideo } from '../mode'
import type { Track } from '../model'
import type { AudioCandidate, NetworkCapabilities } from '../providers'
import type { MatchTarget, PlaybackSettings } from './settings'

/**
 * Where a candidate the policy tries comes from:
 *
 * - `pinned`: the user's pinned match for the track, which always wins
 * - `recorded`: the audio recorded on the queue item: a match the policy confirmed earlier, or
 *   the version the user picked
 * - `own`: the track's own audio: a YouTube Music song or video, an Internet Archive or Jamendo
 *   item, a local file
 * - `linked-song`: for an official music video in Music mode, the song its source links it to
 */
export type CandidateOrigin = 'pinned' | 'recorded' | 'own' | 'linked-song'

/**
 * One thing the playback policy tries, in the order {@link planPlayback} lists them:
 *
 * - `offline`: an offline copy of the track (a download)
 * - `candidate`: resolve this candidate through its audio source
 * - `match`: find the track's match (from the match cache, else the matching engine) and, if
 *   it may play, resolve it
 * - `invidious`: resolve the YouTube audio found so far through the Invidious instance the user
 *   entered
 *
 * When every step fails, the item is "Unavailable", with alternatives and a manual search.
 */
export type PlaybackStep =
  | { readonly type: 'offline' }
  | {
      readonly type: 'candidate'
      readonly origin: CandidateOrigin
      readonly candidate: AudioCandidate
    }
  | { readonly type: 'match'; readonly target: MatchTarget }
  | { readonly type: 'invidious' }

/** What {@link planPlayback} needs to know about one queue item. */
export interface PlaybackPlanInput {
  /** The track to play. */
  readonly track: Track
  /** The catalog mode. */
  readonly mode: CatalogMode
  /**
   * The audio recorded on the queue item (`QueueItem.candidate`): a match the policy confirmed
   * earlier, or the version the user picked.
   */
  readonly recorded?: AudioCandidate
  /** The user's pinned match for the track, from the match cache. */
  readonly pinned?: AudioCandidate
  /** The user's playback settings. */
  readonly settings: Readonly<PlaybackSettings>
  /** Leave out the offline copy, e.g. right after the user picked another version. */
  readonly skipOffline?: boolean
}

/** The sources whose tracks are lossless-capable free audio, never matched to a lossless copy. */
const FREE_SOURCES: ReadonlySet<SourceId> = new Set(['archive', 'jamendo', 'local'])

/**
 * The steps that find audio for a track, in the order the playback policy tries them
 * (ARCHITECTURE.md §7.4):
 *
 * 1. An offline copy, unless `skipOffline`.
 * 2. With a pin, only the pinned candidate and then Invidious: the user's choice always wins,
 *    and a pin is never swapped for another version behind the user's back.
 * 3. The candidate recorded on the queue item.
 * 4. With "prefer lossless" on, a lossless match on Internet Archive or Jamendo, for a track
 *    that is not itself from a free source.
 * 5. The track's own audio (a YouTube Music song through the resolution ladder, an Internet
 *    Archive or Jamendo item, a local file), or for a music video in Music mode the song it
 *    links, and failing that its matched song. A track from a catalog without audio, such as
 *    Spotify, gets its matched song.
 * 6. With Invidious on, the YouTube audio found by then, through the user's instance.
 *
 * Candidates that are not playable in `mode` are left out (see `isPlayable`), and so is a
 * candidate that an earlier step already tries. A track the mode hides gets no steps after the
 * offline copy.
 */
export function planPlayback(input: PlaybackPlanInput): PlaybackStep[] {
  const { track, mode, settings } = input
  const steps: PlaybackStep[] = []
  const seen = new Set<string>()
  const addCandidate = (origin: CandidateOrigin, candidate: AudioCandidate | undefined) => {
    if (candidate === undefined || !isPlayable(candidate, mode)) return
    const key = candidateKey(candidate)
    if (seen.has(key)) return
    seen.add(key)
    steps.push({ type: 'candidate', origin, candidate })
  }
  if (input.skipOffline !== true) steps.push({ type: 'offline' })
  if (input.pinned !== undefined && isPlayable(input.pinned, mode)) {
    addCandidate('pinned', input.pinned)
    if (settings.useInvidious && isYouTubeCandidate(input.pinned)) steps.push({ type: 'invidious' })
    return steps
  }
  addCandidate('recorded', input.recorded)
  const verdict = modePolicy(track, mode)
  if (verdict === 'hidden') return steps
  if (settings.preferLossless && !FREE_SOURCES.has(track.source)) {
    steps.push({ type: 'match', target: 'lossless' })
  }
  const own = verdict === 'playable' ? ownCandidate(track) : undefined
  if (own !== undefined) {
    addCandidate('own', own)
  } else {
    if (verdict === 'plays-linked-song') addCandidate('linked-song', linkedSongCandidate(track))
    steps.push({ type: 'match', target: 'song' })
  }
  const youtube = steps.some(
    (step) =>
      (step.type === 'match' && step.target === 'song') ||
      (step.type === 'candidate' && isYouTubeCandidate(step.candidate)),
  )
  if (settings.useInvidious && youtube) steps.push({ type: 'invidious' })
  return steps
}

/** Whether a source has audio of its own: every source but Spotify, which supplies metadata only. */
export function hasOwnAudio(source: SourceId): boolean {
  return source !== 'spotify'
}

/**
 * The audio source that resolves a track's own audio: `ytm` for every YouTube video, including
 * plain YouTube's (`yt`), else the track's own source.
 */
function audioSourceOf(source: SourceId): SourceId {
  return source === 'yt' ? 'ytm' : source
}

/**
 * The track's own audio as a candidate, e.g. a YouTube Music song's video or an Internet Archive
 * file, with `confidence` 1. `undefined` for a track from a source without audio of its own
 * (Spotify) and for a track whose ID does not parse, which only bad data has.
 */
export function ownCandidate(track: Track): AudioCandidate | undefined {
  const parts = parseId(track.id)
  if (parts === null || !hasOwnAudio(parts.source)) return undefined
  return {
    source: audioSourceOf(parts.source),
    ref: parts.nativeId,
    kind: track.kind,
    title: track.title,
    artists: track.artists.map((artist) => artist.name),
    ...(track.durationMs === undefined ? {} : { durationMs: track.durationMs }),
    confidence: 1,
    evidence: ['own audio'],
  }
}

/**
 * For an official music video whose source links its song (`songForVideo`), that song as a
 * candidate: what Music mode plays in the video's place. Only a song on YouTube can be built
 * this way; `undefined` otherwise, and the video then needs the matching engine.
 *
 * The link comes from YouTube Music's own album pages, so it beats any score. The candidate's
 * title and artists are the video's, since the song itself is not loaded.
 */
export function linkedSongCandidate(track: Track): AudioCandidate | undefined {
  const songId = songForVideo(track)
  const parts = songId === undefined ? null : parseId(songId)
  if (parts === null || (parts.source !== 'ytm' && parts.source !== 'yt')) return undefined
  return {
    source: 'ytm',
    ref: parts.nativeId,
    kind: 'song',
    title: track.title,
    artists: track.artists.map((artist) => artist.name),
    confidence: 1,
    evidence: ['song-for-video link'],
  }
}

/** Whether a candidate is a YouTube video (audio source `ytm` or `yt`). */
export function isYouTubeCandidate(candidate: Pick<AudioCandidate, 'source'>): boolean {
  return candidate.source === 'ytm' || candidate.source === 'yt'
}

/**
 * The key that identifies a candidate's audio, for caches and comparisons: the `entityKey` of
 * its track ID, so a YouTube video has one key whichever YouTube prefix names it. A candidate
 * with an unknown source or an empty `ref`, which only bad data has, gets a key of its own that
 * never equals a valid candidate's.
 */
export function candidateKey(candidate: Pick<AudioCandidate, 'source' | 'ref'>): string {
  const { source, ref } = candidate
  if (!isSourceId(source) || typeof ref !== 'string' || ref === '') {
    return `invalid:${String(source)}:${String(ref)}`
  }
  return entityKey(formatId(source, 'track', ref))
}

/** Whether two candidates are the same audio (see {@link candidateKey}). */
export function sameCandidate(
  a: Pick<AudioCandidate, 'source' | 'ref'>,
  b: Pick<AudioCandidate, 'source' | 'ref'>,
): boolean {
  return candidateKey(a) === candidateKey(b)
}

/**
 * Whether the platform can reach a source's audio at all: YouTube needs `youtube` access other
 * than `none` (the Lite tier, FXM Connect or a native app), and Spotify has no audio. Every
 * other source is reachable from any platform. The source itself still decides what it can
 * resolve.
 */
export function canReachAudio(source: SourceId, capabilities: NetworkCapabilities): boolean {
  if (source === 'ytm' || source === 'yt') return capabilities.youtube !== 'none'
  return hasOwnAudio(source)
}
