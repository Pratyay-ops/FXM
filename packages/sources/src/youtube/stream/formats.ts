/**
 * Turning the formats of a `/player` response into `StreamOption`s: codec, container and media
 * from the MIME type, the bitrate and tier, when the URL expires, whether it is bound to the
 * IP address, and the file's length for the end-of-file probe.
 *
 * @module
 */

import {
  CODEC_LABELS,
  type Codec,
  type Container,
  type FullLengthCheck,
  loudnessFromYouTube,
  type StreamMedia,
  type StreamOption,
  tierOf,
} from '@fxm/core'
import { arrayAt, asNumber, asRecord, asString, at, type JsonRecord } from '../json'
import type { StreamConfig, StreamRungConfig } from './config'

/** A `StreamOption` from the YouTube ladder, with what the ladder knows about it. */
export interface YouTubeStreamOption extends StreamOption {
  /** The video the URL plays. */
  readonly videoId: string
  /** The rung that resolved it, e.g. `visionos` or `android-muxed`. */
  readonly rung: string
  /** YouTube's format number, e.g. 251 for Opus or 18 for the 360p video with AAC. */
  readonly itag: number
  /**
   * What the audio is, for a stream badge: the codec (`Opus`, `AAC`), or for a muxed video
   * where it comes from, e.g. `AAC from 360p video` for itag 18.
   */
  readonly label: string
  /** The file's length in bytes, when YouTube said or the probe found out. */
  readonly contentLength?: number
  /**
   * The format's nominal (peak) bitrate in kbps, YouTube's `bitrate`, for an audio-only format.
   * It sets the tier (see {@link streamOptionsOf}); `bitrateKbps` stays the average.
   */
  readonly peakBitrateKbps?: number
}

/** Whether `option` came from the YouTube ladder. */
export function isYouTubeStreamOption(option: StreamOption): option is YouTubeStreamOption {
  const candidate = option as Partial<YouTubeStreamOption>
  return (
    typeof candidate.videoId === 'string' &&
    typeof candidate.rung === 'string' &&
    typeof candidate.itag === 'number'
  )
}

/** Codec, container and media of a format, from its MIME type. */
interface Kind {
  readonly codec: Codec
  readonly container: Container
  readonly media: StreamMedia
}

/**
 * Reads a format's MIME type, e.g. `audio/webm; codecs="opus"` (Opus in WebM),
 * `audio/mp4; codecs="mp4a.40.2"` (AAC in M4A) or `video/mp4; codecs="avc1.42001E, mp4a.40.2"`
 * (a video with an AAC track). `undefined` for a video without audio, or an audio codec FXM
 * does not play.
 */
export function kindOfMimeType(mimeType: string): Kind | undefined {
  const match = /^(audio|video)\/(webm|mp4)\s*;\s*codecs="([^"]*)"/iu.exec(mimeType.trim())
  if (match === null) return undefined
  const [, type = '', subtype = '', list = ''] = match
  const codecs = list.split(',').map((codec) => codec.trim().toLowerCase())
  const audio = codecs.find(
    (codec) => codec === 'opus' || codec === 'vorbis' || codec.startsWith('mp4a.'),
  )
  if (audio === undefined) return undefined
  const codec: Codec = audio === 'opus' ? 'opus' : audio === 'vorbis' ? 'vorbis' : 'aac'
  const video = type.toLowerCase() === 'video'
  const webm = subtype.toLowerCase() === 'webm'
  return {
    codec,
    container: webm ? 'webm' : video ? 'mp4' : 'm4a',
    media: video ? 'muxed-video' : 'audio',
  }
}

/** A stream URL FXM may use: HTTPS on a googlevideo host. */
export function parseStreamUrl(value: unknown): URL | undefined {
  if (typeof value !== 'string' || !URL.canParse(value)) return undefined
  const url = new URL(value)
  const host = url.hostname.toLowerCase()
  const ok =
    url.protocol === 'https:' &&
    url.username === '' &&
    url.password === '' &&
    host.endsWith('.googlevideo.com')
  return ok ? url : undefined
}

/** A positive whole number from a JSON number or numeric string. */
function count(value: unknown): number | undefined {
  const number = typeof value === 'string' && /^\d{1,15}$/u.test(value) ? Number(value) : value
  return Number.isSafeInteger(number) && (number as number) > 0 ? (number as number) : undefined
}

/** A bitrate in bits per second as kbps, with one decimal. */
function kbps(bitsPerSecond: number | undefined): number | undefined {
  return bitsPerSecond === undefined ? undefined : Math.round(bitsPerSecond / 100) / 10
}

/** A format's `xtags`, as text: YouTube sends them base64-encoded, sometimes plain. */
function xtagsOf(format: JsonRecord): string {
  const xtags = asString(format.xtags) ?? ''
  try {
    return `${xtags} ${atob(xtags.replace(/-/gu, '+').replace(/_/gu, '/'))}`
  } catch {
    return xtags
  }
}

/**
 * Whether a format is the video's own audio: not a dubbed, descriptive or other alternative
 * track, and not the dynamic-range-compressed (`isDrc`) copy some videos also offer.
 */
function isOriginalAudio(format: JsonRecord): boolean {
  if (format.isDrc === true) return false
  const track = asRecord(format.audioTrack)
  if (track !== undefined && track.audioIsDefault === false) return false
  return !/dubbed|descriptive|secondary/iu.test(xtagsOf(format))
}

/** When the URL stops working, in epoch milliseconds. */
function expiry(url: URL, response: JsonRecord, now: number): number | undefined {
  const expire = count(url.searchParams.get('expire'))
  if (expire !== undefined) return expire * 1000
  const seconds = count(at(response, 'streamingData', 'expiresInSeconds'))
  return seconds === undefined ? undefined : now + seconds * 1000
}

/** Whether YouTube signed the requesting IP address into the URL. */
function isIpBound(url: URL): boolean {
  const signed = (url.searchParams.get('sparams') ?? '').split(',')
  return url.searchParams.has('ip') || signed.includes('ip')
}

/** One format as a stream option, or `undefined` when FXM cannot use it. */
function toOption(
  format: JsonRecord,
  itag: number,
  context: { videoId: string; rung: StreamRungConfig; config: StreamConfig; response: JsonRecord },
  now: number,
): YouTubeStreamOption | undefined {
  const url = parseStreamUrl(format.url)
  const kind = kindOfMimeType(asString(format.mimeType) ?? '')
  if (url === undefined || kind === undefined) return undefined
  // A muxed video's bitrate covers the picture too: its audio track's comes from the config.
  const muxed = kind.media === 'muxed-video'
  const peak = muxed ? undefined : kbps(count(format.bitrate))
  const average = muxed
    ? context.config.muxedAudioKbps[String(itag)]
    : (kbps(count(format.averageBitrate)) ?? peak)
  // The tier follows the format's nominal (peak) bitrate (see `streamOptionsOf`).
  const nominal = peak ?? average
  const sampleRate = count(format.audioSampleRate)
  const contentLength = count(format.contentLength) ?? count(url.searchParams.get('clen'))
  const expiresAt = expiry(url, context.response, now)
  const fullLength: FullLengthCheck = 'unverified'
  const codecLabel = CODEC_LABELS[kind.codec]
  const video = asString(format.qualityLabel)
  const label = !muxed
    ? codecLabel
    : `${codecLabel} from ${video === undefined ? '' : `${video} `}video`
  // How far above YouTube's -14 LUFS reference the format is (see CLEAN-ROOM.md).
  const loudness = loudnessFromYouTube(format.loudnessDb)
  return {
    url: url.href,
    codec: kind.codec,
    container: kind.container,
    media: kind.media,
    ...(average === undefined ? {} : { bitrateKbps: average }),
    ...(sampleRate === undefined ? {} : { sampleRateHz: sampleRate }),
    tier: tierOf({ codec: kind.codec, ...(nominal === undefined ? {} : { bitrateKbps: nominal }) }),
    protocol: 'progressive',
    ...(expiresAt === undefined ? {} : { expiresAt }),
    ipBound: isIpBound(url),
    fullLength,
    videoId: context.videoId,
    rung: context.rung.id,
    itag,
    label,
    ...(contentLength === undefined ? {} : { contentLength }),
    ...(peak === undefined ? {} : { peakBitrateKbps: peak }),
    ...(loudness === undefined ? {} : { loudness }),
  }
}

/**
 * The stream options a rung offers in a playable `/player` response: one per format in the
 * rung's `itags` that the response carries with a direct googlevideo URL, in the rung's order
 * of preference. Every option starts `unverified`; the end-of-file probe may change that.
 *
 * **Bitrate and tier.** `bitrateKbps` is the file's average (`averageBitrate`), and for a muxed
 * video its audio track's bitrate from the config (`muxedAudioKbps`). The `tier` of an audio
 * format is `tierOf` its nominal (peak) bitrate, YouTube's `bitrate`, kept as
 * `peakBitrateKbps`: the format is encoded to that bitrate, and a quiet passage of variable-
 * bitrate Opus averages less without sounding worse. So Opus 251 is `high`, as
 * ARCHITECTURE.md §7.3 has it, even for a quiet song whose average dips below 120 kbps, where
 * `tierOf(option)` of the average would say `normal`: read the tier from the option.
 */
export function streamOptionsOf(
  response: JsonRecord,
  videoId: string,
  rung: StreamRungConfig,
  config: StreamConfig,
  now: number,
): YouTubeStreamOption[] {
  const formats = [
    ...arrayAt(response, 'streamingData', 'formats'),
    ...arrayAt(response, 'streamingData', 'adaptiveFormats'),
  ].flatMap((value) => {
    const format = asRecord(value)
    return format === undefined ? [] : [format]
  })
  const context = { videoId, rung, config, response }
  return rung.itags.flatMap((itag) => {
    for (const format of formats) {
      if (asNumber(format.itag) !== itag || !isOriginalAudio(format)) continue
      const option = toOption(format, itag, context, now)
      if (option !== undefined) return [option]
    }
    return []
  })
}
