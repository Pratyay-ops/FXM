/**
 * The SABR rung's stream options. YouTube's web client gets no stream URLs: its `/player` answer
 * names a server ABR streaming URL (`streamingData.serverAbrStreamingUrl`) and a ustreamer
 * config, and the player then posts protobuf requests to that URL and reads the media from UMP
 * answers (googlevideo's `SabrStream`, MIT). The player does this in `@fxm/player`'s MediaSource
 * engine; this module describes one session per audio format as a `StreamOption` whose
 * `protocol` is `sabr` and whose `playback` holds the session, as JSON.
 *
 * A session can't be probed at the end of a file, so its options are `unverified`.
 *
 * @module
 */

import { CODEC_LABELS, type FullLengthCheck, tierOf } from '@fxm/core'
import { arrayAt, asNumber, asRecord, asString, at, type JsonRecord, stringAt } from '../../json'
import type { StreamRungConfig } from '../config'
import { kindOfMimeType, parseStreamUrl, type YouTubeStreamOption } from '../formats'

/** The `format` of every SABR session this module describes: its shape and version. */
export const SABR_PLAYBACK_FORMAT = 'youtube-sabr/1'

/** InnerTube's numeric client IDs, which SABR requests name their client by. */
export const CLIENT_NAME_IDS: Readonly<Record<string, number>> = {
  WEB: 1,
  MWEB: 2,
  TVHTML5: 7,
  WEB_REMIX: 67,
}

/** One format of a SABR session, as googlevideo's `SabrFormat` takes it. */
export type SabrFormatJson = {
  readonly itag: number
  /** The format's `lastModified`, which identifies it with its itag. */
  readonly lastModified: string
  readonly xtags?: string
  readonly mimeType: string
  readonly bitrate: number
  readonly averageBitrate?: number
  readonly contentLength?: number
  readonly approxDurationMs: number
  readonly audioQuality?: string
  readonly audioTrackId?: string
  readonly isDrc?: boolean
  readonly width?: number
  readonly height?: number
  readonly quality?: string
  readonly qualityLabel?: string
}

/**
 * The session a SABR stream option carries in `playback`. The MediaSource engine of
 * `@fxm/player` validates it against the same description.
 */
export type YouTubeSabrPlayback = {
  /** Always {@link SABR_PLAYBACK_FORMAT}. */
  readonly format: typeof SABR_PLAYBACK_FORMAT
  /** The video. */
  readonly videoId: string
  /** The ustreamer config of the `/player` answer, base64. */
  readonly ustreamerConfig: string
  /** A web PO token bound to the video, web-safe base64. */
  readonly poToken: string
  /** The client the session belongs to. */
  readonly client: { readonly nameId: number; readonly version: string }
  /** The video's duration, in milliseconds. */
  readonly durationMs: number
  /** The audio format to play. */
  readonly audio: SabrFormatJson
  /**
   * The smallest video format. SABR sessions name a video format even when only audio plays;
   * the engine tells the server it has all of it, so none is sent.
   */
  readonly video: SabrFormatJson
}

/** A positive whole number from a JSON number or numeric string. */
function count(value: unknown): number | undefined {
  const number = typeof value === 'string' && /^\d{1,15}$/u.test(value) ? Number(value) : value
  return Number.isSafeInteger(number) && (number as number) > 0 ? (number as number) : undefined
}

/** A format of a `/player` answer as a SABR format, or `undefined` when it lacks what SABR needs. */
export function sabrFormatOf(format: JsonRecord): SabrFormatJson | undefined {
  const itag = asNumber(format.itag)
  const lastModified = asString(format.lastModified)
  const mimeType = asString(format.mimeType)
  const bitrate = count(format.bitrate)
  const approxDurationMs = count(format.approxDurationMs)
  if (
    itag === undefined ||
    lastModified === undefined ||
    !/^\d{1,20}$/u.test(lastModified) ||
    mimeType === undefined ||
    bitrate === undefined ||
    approxDurationMs === undefined
  ) {
    return undefined
  }
  const optional = (key: string, value: unknown) => (value === undefined ? {} : { [key]: value })
  return {
    itag,
    lastModified,
    mimeType,
    bitrate,
    approxDurationMs,
    ...optional('xtags', asString(format.xtags)),
    ...optional('averageBitrate', count(format.averageBitrate)),
    ...optional('contentLength', count(format.contentLength)),
    ...optional('audioQuality', asString(format.audioQuality)),
    ...optional('audioTrackId', stringAt(format, 'audioTrack', 'id')),
    ...optional('isDrc', format.isDrc === true ? true : undefined),
    ...optional('width', count(format.width)),
    ...optional('height', count(format.height)),
    ...optional('quality', asString(format.quality)),
    ...optional('qualityLabel', asString(format.qualityLabel)),
  }
}

/** Whether a format is the video's own audio, as `formats.ts` checks it for direct URLs. */
function isOriginalAudio(format: JsonRecord): boolean {
  if (format.isDrc === true) return false
  const track = asRecord(format.audioTrack)
  return track?.audioIsDefault !== false
}

/** What {@link sabrStreamOptions} needs besides the answer. */
export interface SabrSession {
  /** The video. */
  readonly videoId: string
  /** The rung. */
  readonly rung: StreamRungConfig
  /** The server ABR streaming URL with its `n` deciphered. */
  readonly url: string
  /** A web PO token bound to the video. */
  readonly poToken: string
  /** The time, in epoch milliseconds. */
  readonly now: number
}

/**
 * One SABR stream option per audio format of the rung's itags that the answer offers, in the
 * rung's order. Empty when the answer lacks the ustreamer config, an audio format or a video
 * format, or the URL is not an HTTPS googlevideo URL.
 */
export function sabrStreamOptions(
  response: JsonRecord,
  session: SabrSession,
): YouTubeStreamOption[] {
  const url = parseStreamUrl(session.url)
  const ustreamerConfig = asString(
    at(
      response,
      'playerConfig',
      'mediaCommonConfig',
      'mediaUstreamerRequestConfig',
      'videoPlaybackUstreamerConfig',
    ),
  )
  const nameId = CLIENT_NAME_IDS[session.rung.client.name]
  if (url === undefined || ustreamerConfig === undefined || nameId === undefined) return []
  const formats = arrayAt(response, 'streamingData', 'adaptiveFormats').flatMap((value) => {
    const format = asRecord(value)
    return format === undefined ? [] : [format]
  })
  const video = formats
    .filter((format) => asString(format.mimeType)?.startsWith('video/'))
    .flatMap((format) => {
      const sabr = sabrFormatOf(format)
      return sabr === undefined ? [] : [sabr]
    })
    .sort((a, b) => a.bitrate - b.bitrate)[0]
  if (video === undefined) return []
  const seconds = count(at(response, 'videoDetails', 'lengthSeconds'))
  const expire = count(url.searchParams.get('expire'))
  const expiresIn = count(at(response, 'streamingData', 'expiresInSeconds'))
  const expiresAt =
    expire !== undefined
      ? expire * 1000
      : expiresIn === undefined
        ? undefined
        : session.now + expiresIn * 1000
  const signed = (url.searchParams.get('sparams') ?? '').split(',')
  const ipBound = url.searchParams.has('ip') || signed.includes('ip')
  const fullLength: FullLengthCheck = 'unverified'
  return session.rung.itags.flatMap((itag) => {
    const format = formats.find((entry) => asNumber(entry.itag) === itag && isOriginalAudio(entry))
    const audio = format === undefined ? undefined : sabrFormatOf(format)
    const kind = audio === undefined ? undefined : kindOfMimeType(audio.mimeType)
    if (format === undefined || audio === undefined || kind === undefined) return []
    if (kind.media !== 'audio') return []
    const average = Math.round((audio.averageBitrate ?? audio.bitrate) / 100) / 10
    const nominal = Math.round(audio.bitrate / 100) / 10
    const sampleRate = count(format.audioSampleRate)
    const playback: YouTubeSabrPlayback = {
      format: SABR_PLAYBACK_FORMAT,
      videoId: session.videoId,
      ustreamerConfig,
      poToken: session.poToken,
      client: { nameId, version: session.rung.client.version },
      durationMs: seconds === undefined ? audio.approxDurationMs : seconds * 1000,
      audio,
      video,
    }
    const option: YouTubeStreamOption = {
      url: url.href,
      codec: kind.codec,
      container: kind.container,
      media: 'audio',
      bitrateKbps: average,
      ...(sampleRate === undefined ? {} : { sampleRateHz: sampleRate }),
      tier: tierOf({ codec: kind.codec, bitrateKbps: nominal }),
      protocol: 'sabr',
      ...(expiresAt === undefined ? {} : { expiresAt }),
      ipBound,
      fullLength,
      playback,
      videoId: session.videoId,
      rung: session.rung.id,
      itag,
      label: CODEC_LABELS[kind.codec],
      ...(audio.contentLength === undefined ? {} : { contentLength: audio.contentLength }),
    }
    return [option]
  })
}
