/**
 * The SABR session a stream option carries in `playback`, as YouTube's SABR rung of
 * `@fxm/sources` describes it (`youtube/stream/advanced/sabr.ts`, format `youtube-sabr/1`). The
 * player depends on no source, so it checks the JSON against its own copy of that description and
 * refuses anything else.
 *
 * @module
 */

/** The only session format this engine plays. */
export const SABR_PLAYBACK_FORMAT = 'youtube-sabr/1'

/**
 * Whether `url` is one a SABR session may reach: HTTPS on a googlevideo host, on the default
 * port and without credentials. The session's own URL and every redirect it follows must be.
 */
export function isGoogleVideoUrl(url: string | URL): boolean {
  const text = String(url)
  if (!URL.canParse(text)) return false
  const parsed = new URL(text)
  return (
    parsed.protocol === 'https:' &&
    parsed.port === '' &&
    parsed.username === '' &&
    parsed.password === '' &&
    parsed.hostname.toLowerCase().endsWith('.googlevideo.com')
  )
}

/** One format of the session, as googlevideo's `SabrFormat` takes it. */
export type SabrPlaybackFormat = {
  readonly itag: number
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

/** A validated SABR session. */
export type SabrPlayback = {
  readonly format: typeof SABR_PLAYBACK_FORMAT
  readonly videoId: string
  /** The ustreamer config, base64. */
  readonly ustreamerConfig: string
  /** The web PO token, web-safe base64. */
  readonly poToken: string
  /** The client: InnerTube's numeric ID and the version. */
  readonly client: { readonly nameId: number; readonly version: string }
  readonly durationMs: number
  /** The audio format to play. */
  readonly audio: SabrPlaybackFormat
  /** A video format the session names, which the engine never downloads. */
  readonly video: SabrPlaybackFormat
}

type Json = Readonly<Record<string, unknown>>

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const BASE64 = /^[A-Za-z0-9+/_=-]{1,16384}$/u

function positive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function format(value: unknown, kind: 'audio' | 'video'): SabrPlaybackFormat | undefined {
  if (!isObject(value)) return undefined
  const { itag, lastModified, mimeType, bitrate, approxDurationMs } = value
  const ok =
    Number.isSafeInteger(itag) &&
    (itag as number) > 0 &&
    typeof lastModified === 'string' &&
    /^\d{1,20}$/u.test(lastModified) &&
    typeof mimeType === 'string' &&
    mimeType.startsWith(`${kind}/`) &&
    mimeType.length < 200 &&
    positive(bitrate) &&
    positive(approxDurationMs)
  if (!ok) return undefined
  const optional = <K extends keyof SabrPlaybackFormat>(
    key: K,
    check: (entry: unknown) => boolean,
  ): Partial<SabrPlaybackFormat> =>
    value[key] !== undefined && check(value[key]) ? { [key]: value[key] } : {}
  const text = (entry: unknown) => typeof entry === 'string' && entry.length < 200
  return {
    itag: itag as number,
    lastModified,
    mimeType,
    bitrate,
    approxDurationMs,
    ...optional('xtags', text),
    ...optional('averageBitrate', positive),
    ...optional('contentLength', positive),
    ...optional('audioQuality', text),
    ...optional('audioTrackId', text),
    ...optional('isDrc', (entry) => typeof entry === 'boolean'),
    ...optional('width', positive),
    ...optional('height', positive),
    ...optional('quality', text),
    ...optional('qualityLabel', text),
  }
}

/** Reads a stream option's `playback` as a SABR session, or `undefined` when it is not one. */
export function parseSabrPlayback(value: unknown): SabrPlayback | undefined {
  if (!isObject(value) || value.format !== SABR_PLAYBACK_FORMAT) return undefined
  const { videoId, ustreamerConfig, poToken, client, durationMs } = value
  if (typeof videoId !== 'string' || !/^[\w-]{11}$/u.test(videoId)) return undefined
  if (typeof ustreamerConfig !== 'string' || !BASE64.test(ustreamerConfig)) return undefined
  if (typeof poToken !== 'string' || !BASE64.test(poToken)) return undefined
  if (!isObject(client) || !Number.isSafeInteger(client.nameId) || (client.nameId as number) <= 0) {
    return undefined
  }
  if (typeof client.version !== 'string' || !/^[\d.]{1,40}$/u.test(client.version)) {
    return undefined
  }
  if (!positive(durationMs)) return undefined
  const audio = format(value.audio, 'audio')
  const video = format(value.video, 'video')
  if (audio === undefined || video === undefined) return undefined
  return {
    format: SABR_PLAYBACK_FORMAT,
    videoId,
    ustreamerConfig,
    poToken,
    client: { nameId: client.nameId as number, version: client.version },
    durationMs,
    audio,
    video,
  }
}
