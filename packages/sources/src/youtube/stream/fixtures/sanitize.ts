/**
 * Sanitizing recorded `/player` responses before they become fixtures. Besides what
 * `../../fixtures/sanitize.ts` removes from every InnerTube response (the visitorData, IP
 * addresses, tracking fields, long texts), a `/player` response carries stream URLs signed for
 * the recording machine: its IP address, the googlevideo hosts near it (`rr…---sn-….googlevideo
 * .com`, which name a place and a network), and signatures, session and event IDs.
 *
 * So a fixture keeps only the fields the resolver reads (the playability status, the video's
 * details, the audio formats and two video formats), and each stream URL keeps only the query
 * parameters that describe the format (`itag`, `clen`, `expire`, `c`, …): the IP address
 * becomes a documentation address, the host and every other value a placeholder. Manifest and
 * SABR URLs are replaced whole.
 *
 * @module
 */

import { sanitizeResponse } from '../../fixtures/sanitize'

/** The googlevideo host of every fixture URL. */
export const FIXTURE_HOST = 'rr1---sn-fxmfixture.googlevideo.com'

/** The value of every query parameter that is not kept. */
export const PLACEHOLDER = 'fxm'

/** Query parameters kept as recorded: they describe the format, not the machine. */
const KEPT_PARAMS = new Set([
  'expire',
  'itag',
  'source',
  'requiressl',
  'mime',
  'clen',
  'dur',
  'lmt',
  'c',
  'sparams',
  'lsparams',
  'ratebypass',
  'gir',
])

/** The documentation address every `ip` parameter gets. */
const FAKE_IP = '192.0.2.1'

const PLAYABILITY_KEYS = [
  'status',
  'reason',
  'reasonTitle',
  'desktopLegacyAgeGateReason',
  'playableInEmbed',
] as const

const VIDEO_KEYS = [
  'videoId',
  'title',
  'lengthSeconds',
  'channelId',
  'author',
  'isLive',
  'isLiveContent',
  'isUpcoming',
  'isPostLiveDvr',
  'isLiveDvrEnabled',
  'isLowLatencyLiveStream',
  'isPrivate',
] as const

const FORMAT_KEYS = [
  'itag',
  'url',
  'mimeType',
  'bitrate',
  'averageBitrate',
  'contentLength',
  'quality',
  'qualityLabel',
  'width',
  'height',
  'fps',
  'audioQuality',
  'audioSampleRate',
  'audioChannels',
  'approxDurationMs',
  'loudnessDb',
  'isDrc',
  'audioTrack',
  'xtags',
] as const

type Json = Record<string, unknown>

function asObject(value: unknown): Json | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Json)
    : undefined
}

function pick(value: unknown, keys: readonly string[]): Json | undefined {
  const object = asObject(value)
  if (object === undefined) return undefined
  return Object.fromEntries(keys.flatMap((key) => (key in object ? [[key, object[key]]] : [])))
}

/** A stream URL with the recording machine's details replaced (see the module notes). */
export function sanitizeStreamUrl(value: string): string {
  if (!URL.canParse(value)) return value
  const url = new URL(value)
  url.hostname = FIXTURE_HOST
  for (const name of [...new Set(url.searchParams.keys())]) {
    if (name === 'ip') url.searchParams.set(name, FAKE_IP)
    else if (!KEPT_PARAMS.has(name)) url.searchParams.set(name, PLACEHOLDER)
  }
  return url.href
}

function sanitizeFormat(value: unknown): Json | undefined {
  const format = pick(value, FORMAT_KEYS)
  if (format !== undefined && typeof format.url === 'string') {
    format.url = sanitizeStreamUrl(format.url)
  }
  return format
}

function isAudio(format: unknown): boolean {
  return String(asObject(format)?.mimeType).startsWith('audio/')
}

/**
 * A format's MIME type and codecs (`audio/webm; codecs="opus"`), which name the format, never
 * the recording machine.
 */
const MIME_TYPE = /^(?:audio|video)\/[\w.+-]+(?:; codecs="[\w.+, -]+")?$/u

/**
 * Puts each format's recorded MIME type back after `sanitizeResponse`, whose IPv4 pattern reads
 * a VP9 codec string (`vp09.00.40.08`) as an address. Only a value of the {@link MIME_TYPE} form
 * is put back; anything else stays scrubbed.
 */
function keepMimeTypes(clean: unknown, recorded: unknown): void {
  if (!Array.isArray(clean) || !Array.isArray(recorded)) return
  for (const [index, format] of clean.entries()) {
    const target = asObject(format)
    const mimeType = asObject(recorded[index])?.mimeType
    if (target !== undefined && typeof mimeType === 'string' && MIME_TYPE.test(mimeType)) {
      target.mimeType = mimeType
    }
  }
}

/**
 * The offline slate of an upcoming stream: its start time and main text ("Live in 3 days"),
 * which tells a premiere from a stream. Its images go, and so does its subtitle, which gives the
 * start in the time zone of the recording machine's IP address ("October 29 at 6:45 AM
 * GMT-4"), which names a place.
 */
function sanitizeLiveStreamability(value: unknown): Json | undefined {
  const renderer = asObject(asObject(value)?.liveStreamabilityRenderer)
  if (renderer === undefined) return undefined
  const slate = pick(asObject(asObject(renderer.offlineSlate)?.liveStreamOfflineSlateRenderer), [
    'scheduledStartTime',
    'mainText',
  ])
  return {
    liveStreamabilityRenderer: {
      ...pick(renderer, ['videoId', 'pollDelayMs']),
      ...(slate === undefined ? {} : { offlineSlate: { liveStreamOfflineSlateRenderer: slate } }),
    },
  }
}

/**
 * A sanitized copy of a recorded `/player` response: the fields the resolver reads, with every
 * stream URL scrubbed, then `sanitizeResponse` for the rest, keeping the formats' MIME types.
 */
export function sanitizePlayerResponse(json: unknown): unknown {
  const response = asObject(json) ?? {}
  const status = asObject(response.playabilityStatus)
  const playability = pick(status, PLAYABILITY_KEYS)
  const live = sanitizeLiveStreamability(status?.liveStreamability)
  if (playability !== undefined && live !== undefined) playability.liveStreamability = live
  const streaming = asObject(response.streamingData)
  let streamingData: Json | undefined
  if (streaming !== undefined) {
    const adaptive = Array.isArray(streaming.adaptiveFormats) ? streaming.adaptiveFormats : []
    const kept = [...adaptive.filter(isAudio), ...adaptive.filter((f) => !isAudio(f)).slice(0, 2)]
    streamingData = {
      ...pick(streaming, ['expiresInSeconds', 'aspectRatio']),
      ...(Array.isArray(streaming.formats)
        ? { formats: streaming.formats.map(sanitizeFormat) }
        : {}),
      adaptiveFormats: kept.map(sanitizeFormat),
      ...(typeof streaming.hlsManifestUrl === 'string'
        ? { hlsManifestUrl: 'https://manifest.googlevideo.com/api/manifest/hls_variant/fxm' }
        : {}),
      ...(typeof streaming.serverAbrStreamingUrl === 'string'
        ? { serverAbrStreamingUrl: `https://${FIXTURE_HOST}/videoplayback?fxm=sabr` }
        : {}),
    }
  }
  const videoDetails = pick(response.videoDetails, VIDEO_KEYS)
  const clean = sanitizeResponse({
    ...(response.responseContext === undefined
      ? {}
      : { responseContext: response.responseContext }),
    ...(playability === undefined ? {} : { playabilityStatus: playability }),
    ...(streamingData === undefined ? {} : { streamingData }),
    ...(videoDetails === undefined ? {} : { videoDetails }),
  })
  const cleanStreaming = asObject(asObject(clean)?.streamingData)
  keepMimeTypes(cleanStreaming?.formats, streamingData?.formats)
  keepMimeTypes(cleanStreaming?.adaptiveFormats, streamingData?.adaptiveFormats)
  return clean
}
