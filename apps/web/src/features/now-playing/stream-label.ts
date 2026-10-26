/**
 * What the stream badge says: the audio format ("Opus", "AAC from 360p video", "FLAC from Opus"
 * for a file converted from lossy audio), where the audio comes from ("YouTube Music") and, for
 * audio found for another catalog's track, how sure the match is ("Matched from Spotify · 0.93").
 * Plain words only: no logos or brand colours (docs/LEGAL.md).
 *
 * @module
 */

import {
  type AudioCandidate,
  type BuiltInSourceId,
  CODEC_LABELS,
  type Container,
  type EntityId,
  formatId,
  isBuiltInSourceId,
  type QualityTier,
  type SourceId,
  type StreamOption,
  sameEntity,
  songForVideo,
  type Track,
  type TrackKind,
} from '@fxm/core'

/** How the app names each built-in source. */
const SOURCE_NAMES: Readonly<Record<BuiltInSourceId, string>> = {
  ytm: 'YouTube Music',
  yt: 'YouTube',
  spotify: 'Spotify',
  archive: 'Internet Archive',
  jamendo: 'Jamendo',
  local: 'Your files',
}

const TIER_LABELS: Readonly<Record<QualityTier, string>> = {
  lossless: 'Lossless',
  high: 'High',
  normal: 'Normal',
  low: 'Low',
}

const CONTAINER_LABELS: Readonly<Record<Container, string>> = {
  webm: 'WebM',
  mp4: 'MP4',
  m4a: 'M4A',
  mp3: 'MP3',
  ogg: 'Ogg',
  flac: 'FLAC',
  wav: 'WAV',
}

/** How the app labels each kind of track. */
export const KIND_LABELS: Readonly<Record<TrackKind, string>> = {
  song: 'Song',
  'music-video': 'Official video',
  video: 'Video',
  episode: 'Episode',
}

/** The name of a source, e.g. `YouTube Music`, or a plugin's own name. */
export function sourceName(source: SourceId): string {
  return isBuiltInSourceId(source) ? SOURCE_NAMES[source] : source.slice('plugin.'.length)
}

/** The track ID of a candidate's audio, or `undefined` for a malformed candidate. */
function candidateId(candidate: AudioCandidate): EntityId<'track'> | undefined {
  try {
    return formatId(candidate.source, 'track', candidate.ref)
  } catch {
    return undefined
  }
}

/**
 * Whether `candidate` is audio found for `track` rather than the track's own: a song matched
 * to a Spotify track, or the song an official video plays in Music mode. `false` without a
 * candidate, and for the track's own audio (also under the other YouTube prefix).
 */
export function isMatched(track: Track, candidate: AudioCandidate | undefined): boolean {
  if (candidate === undefined) return false
  const id = candidateId(candidate)
  return id === undefined || !sameEntity(id, track.id)
}

/** The source the audio comes from, or `undefined` while a track without audio has no match. */
function audioSource(track: Track, candidate: AudioCandidate | undefined): SourceId | undefined {
  if (candidate !== undefined) return isMatched(track, candidate) ? candidate.source : track.source
  // Spotify supplies metadata only: its tracks play through a match.
  return track.source === 'spotify' ? undefined : track.source
}

function isYouTube(source: SourceId | undefined): boolean {
  return source === 'ytm' || source === 'yt'
}

/**
 * The format of a stream, e.g. `Opus`, `FLAC` or `AAC from 360p video`, and `FLAC from Opus` for a
 * file whose tags say it was converted from lossy audio (FXM's Save to device marks those): such
 * a file is no better than its source, so its format never reads as plain FLAC.
 */
export function formatLabel(stream: StreamOption, source?: SourceId): string {
  const codec = CODEC_LABELS[stream.codec] ?? stream.codec
  const from = stream.convertedFrom
  if (from !== undefined) return `${codec} from ${CODEC_LABELS[from.codec] ?? from.codec}`
  if (stream.media !== 'muxed-video') return codec
  // YouTube's only muxed rung is itag 18, a 360p MP4 (ARCHITECTURE.md §7.3).
  return isYouTube(source) ? `${codec} from 360p video` : `${codec} from video`
}

/** A confidence from 0 to 1, as the badge shows it: `0.93`. */
export function formatConfidence(confidence: number): string {
  return Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)).toFixed(2) : '0.00'
}

/** How the match came about, e.g. `Matched from Spotify · 0.93`, for matched audio only. */
function matchLabel(track: Track, candidate: AudioCandidate): string {
  const confidence = formatConfidence(candidate.confidence)
  if (track.kind === 'music-video' && candidate.kind === 'song') {
    // The song the video links to is certain; one the matching engine found has a score.
    const linked = songForVideo(track)
    const id = candidateId(candidate)
    const isLink = linked !== undefined && id !== undefined && sameEntity(linked, id)
    return isLink ? 'Song version' : `Song version · ${confidence}`
  }
  return `Matched from ${sourceName(track.source)} · ${confidence}`
}

/** One row of the stream details. */
export interface StreamDetail {
  label: string
  value: string
}

/** What the stream badge shows for the current item. */
export interface StreamDescription {
  /**
   * The badge: the format and the source, e.g. `Opus · YouTube Music`. Only the source until a
   * stream is known, and absent while there is neither (a Spotify track before its match).
   */
  badge?: string
  /** For matched audio: `Matched from Spotify · 0.93`, or `Song version` for a video's song. */
  match?: string
  /** Details for the stream info panel, in display order. */
  details: StreamDetail[]
}

/**
 * Describes what plays for `track`: the `candidate` the player recorded for it (if any) and the
 * `stream` it plays (once resolved).
 */
export function describeStream(
  track: Track,
  candidate: AudioCandidate | undefined,
  stream: StreamOption | undefined,
): StreamDescription {
  const source = audioSource(track, candidate)
  const format = stream === undefined ? undefined : formatLabel(stream, source)
  const parts = [format, source === undefined ? undefined : sourceName(source)]
  const badge = parts.filter((part) => part !== undefined).join(' · ')
  const matched = candidate !== undefined && isMatched(track, candidate)

  const details: StreamDetail[] = []
  if (stream !== undefined) {
    // A converted file's own bitrate says nothing of its quality: its source's does.
    const kbps =
      stream.convertedFrom === undefined ? stream.bitrateKbps : stream.convertedFrom.bitrateKbps
    const bitrate = kbps !== undefined && Number.isFinite(kbps) ? `, ${Math.round(kbps)} kbps` : ''
    details.push({ label: 'Format', value: `${format}${bitrate}` })
    details.push({ label: 'Quality', value: TIER_LABELS[stream.tier] ?? stream.tier })
    details.push({ label: 'File', value: CONTAINER_LABELS[stream.container] ?? stream.container })
  }
  if (source !== undefined) details.push({ label: 'Source', value: sourceName(source) })
  if (matched) {
    details.push({
      label: 'Matched to',
      value: `${candidate.title} · ${candidate.artists.join(', ')}`,
    })
    details.push({ label: 'Confidence', value: formatConfidence(candidate.confidence) })
    if (candidate.evidence.length > 0) {
      details.push({ label: 'Evidence', value: candidate.evidence.join(' · ') })
    }
  }

  return {
    ...(badge === '' ? {} : { badge }),
    ...(matched ? { match: matchLabel(track, candidate) } : {}),
    details,
  }
}
