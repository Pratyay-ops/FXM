/**
 * Audio quality vocabulary: codecs, containers, quality tiers, download formats and the user's
 * quality preferences.
 *
 * @module
 */

/** An audio codec FXM can play, download or convert to. `pcm` is uncompressed (WAV). */
export type Codec = 'opus' | 'aac' | 'mp3' | 'vorbis' | 'flac' | 'alac' | 'pcm'

/** The codecs that lose information. */
export type LossyCodec = 'opus' | 'aac' | 'mp3' | 'vorbis'

/** The codecs that keep every bit: FLAC, ALAC and uncompressed PCM. */
export type LosslessCodec = 'flac' | 'alac' | 'pcm'

/** A file or stream container. `mp4` and `m4a` are the same format; audio files use `.m4a`. */
export type Container = 'webm' | 'mp4' | 'm4a' | 'mp3' | 'ogg' | 'flac' | 'wav'

/**
 * How good a stream sounds, best first. See {@link tierOf} for the thresholds:
 *
 * - `lossless`: FLAC, ALAC or PCM
 * - `high`: transparent for most listeners (e.g. YouTube's best Opus and AAC streams, MP3 320)
 * - `normal`: good (e.g. Opus 64-119 kbps, MP3 128-255 kbps, or an unknown bitrate)
 * - `low`: data saver
 */
export type QualityTier = 'lossless' | 'high' | 'normal' | 'low'

/** Every tier, best first. */
export const QUALITY_TIERS: readonly QualityTier[] = Object.freeze([
  'lossless',
  'high',
  'normal',
  'low',
])

/** Display name of each codec. */
export const CODEC_LABELS: Readonly<Record<Codec, string>> = Object.freeze({
  opus: 'Opus',
  aac: 'AAC',
  mp3: 'MP3',
  vorbis: 'Vorbis',
  flac: 'FLAC',
  alac: 'ALAC',
  pcm: 'PCM',
})

/** Whether `value` is a {@link Codec}, e.g. to validate stored download metadata. */
export function isCodec(value: unknown): value is Codec {
  return typeof value === 'string' && Object.hasOwn(CODEC_LABELS, value)
}

/** Whether `value` is a {@link QualityTier}, e.g. to validate a stored setting. */
export function isQualityTier(value: unknown): value is QualityTier {
  return typeof value === 'string' && (QUALITY_TIERS as readonly string[]).includes(value)
}

/** Whether a codec is lossless (FLAC, ALAC or PCM). */
export function isLosslessCodec(codec: Codec): codec is LosslessCodec {
  return codec === 'flac' || codec === 'alac' || codec === 'pcm'
}

/**
 * The lowest bitrate, in kbps, at which each lossy codec counts as `high` and as `normal`.
 * Anything below `normal` is `low`. Opus and AAC are efficient enough that YouTube's best free
 * streams (Opus itag 251 at about 130-160 kbps, AAC itag 140 at about 128 kbps) count as high.
 */
export const LOSSY_TIER_THRESHOLDS: Readonly<
  Record<LossyCodec, Readonly<{ high: number; normal: number }>>
> = Object.freeze({
  opus: Object.freeze({ high: 120, normal: 64 }),
  aac: Object.freeze({ high: 120, normal: 96 }),
  mp3: Object.freeze({ high: 256, normal: 128 }),
  vorbis: Object.freeze({ high: 160, normal: 96 }),
})

/** The codec and bitrate of a stream or file, as {@link tierOf} needs them. */
export interface AudioQuality {
  /** The audio codec. */
  codec: Codec
  /** Average bitrate in kbps, when known. */
  bitrateKbps?: number
}

/**
 * The quality tier of a stream:
 *
 * | codec  | `high` | `normal` | `low`     |
 * |--------|--------|----------|-----------|
 * | opus   | >= 120 | >= 64    | below 64  |
 * | aac    | >= 120 | >= 96    | below 96  |
 * | mp3    | >= 256 | >= 128   | below 128 |
 * | vorbis | >= 160 | >= 96    | below 96  |
 *
 * Lossless codecs are always `lossless`. An unknown bitrate (missing, zero, negative or not a
 * finite number) counts as `normal`, and so does an unknown codec, which only bad data can hold.
 */
export function tierOf({ codec, bitrateKbps }: AudioQuality): QualityTier {
  if (isLosslessCodec(codec)) return 'lossless'
  if (!Object.hasOwn(LOSSY_TIER_THRESHOLDS, codec) || bitrateKbps === undefined) return 'normal'
  if (!Number.isFinite(bitrateKbps) || bitrateKbps <= 0) return 'normal'
  const thresholds = LOSSY_TIER_THRESHOLDS[codec]
  if (bitrateKbps >= thresholds.high) return 'high'
  if (bitrateKbps >= thresholds.normal) return 'normal'
  return 'low'
}

/** Position of a tier in {@link QUALITY_TIERS}; an unknown tier ranks below `low`. */
function tierRank(tier: QualityTier): number {
  const rank = QUALITY_TIERS.indexOf(tier)
  return rank < 0 ? QUALITY_TIERS.length : rank
}

/**
 * Orders two tiers for sorting, best first: negative when `a` is better than `b`, positive when
 * it is worse, 0 when equal. `options.sort((x, y) => compareTiers(x.tier, y.tier))`. An unknown
 * tier from bad data sorts after `low`.
 */
export function compareTiers(a: QualityTier, b: QualityTier): number {
  return tierRank(a) - tierRank(b)
}

/**
 * The file extension (without the dot) for audio in `container`. MP4 audio is `.m4a`, and Ogg
 * holding Opus is `.opus`.
 */
export function containerExtension(container: Container, codec?: Codec): string {
  if (container === 'mp4') return 'm4a'
  if (container === 'ogg' && codec === 'opus') return 'opus'
  return container
}

/** A format the user can download in: the original file, or a conversion with ffmpeg.wasm. */
export type DownloadFormat = 'original' | 'flac' | 'alac' | 'wav' | 'mp3' | 'aac' | 'opus'

/** Every download format except `original`, i.e. the ones that need a conversion. */
export type ConversionFormat = Exclude<DownloadFormat, 'original'>

/** What a conversion format produces. */
export interface ConversionFormatInfo {
  /** Name shown in the UI. */
  label: string
  /** File extension without the dot. */
  extension: string
  /** Container of the output file. */
  container: Container
  /** Codec of the output file. */
  codec: Codec
  /** Whether the format's codec is lossless. The file is only as good as its source, though. */
  lossless: boolean
}

/** The `original` format: everything about it depends on the source. */
export interface OriginalFormatInfo {
  /** Name shown in the UI. */
  label: string
  /** `null`: the source's extension is kept (see {@link containerExtension}). */
  extension: null
  /** `null`: the source's container is kept. */
  container: null
  /** `null`: the source's codec is kept. */
  codec: null
  /** `null`: exactly as lossless as the source. */
  lossless: null
}

/** Details of every download format, in the order the download menu lists them. */
export const DOWNLOAD_FORMATS: Readonly<
  { original: Readonly<OriginalFormatInfo> } & Record<
    ConversionFormat,
    Readonly<ConversionFormatInfo>
  >
> = Object.freeze({
  original: Object.freeze({
    label: 'Original',
    extension: null,
    container: null,
    codec: null,
    lossless: null,
  }),
  flac: conversion('FLAC', 'flac', 'flac', 'flac', true),
  alac: conversion('ALAC', 'm4a', 'm4a', 'alac', true),
  wav: conversion('WAV', 'wav', 'wav', 'pcm', true),
  mp3: conversion('MP3', 'mp3', 'mp3', 'mp3', false),
  aac: conversion('AAC', 'm4a', 'm4a', 'aac', false),
  opus: conversion('Opus', 'opus', 'ogg', 'opus', false),
})

function conversion(
  label: string,
  extension: string,
  container: Container,
  codec: Codec,
  lossless: boolean,
): Readonly<ConversionFormatInfo> {
  return Object.freeze({ label, extension, container, codec, lossless })
}

/** Whether `value` is a {@link DownloadFormat}, e.g. to validate a stored setting. */
export function isDownloadFormat(value: unknown): value is DownloadFormat {
  return typeof value === 'string' && Object.hasOwn(DOWNLOAD_FORMATS, value)
}

/** What a download in some format will really be, as {@link describeConversion} reports it. */
export interface ConversionDescription {
  /** Whether the file is truly lossless: a lossless source kept lossless. */
  lossless: boolean
  /** Whether the audio is re-encoded (`false` for the original and for a same-codec remux). */
  transcoded: boolean
  /**
   * Honest label for the download menu, e.g.
   * `FLAC (converted from Opus, same quality as the source)`.
   */
  label: string
}

/**
 * Describes downloading a `sourceCodec` stream as `target`, with an honest label:
 *
 * - `original`, or a target with the source's codec: no re-encoding, as lossless as the source
 * - lossless source to a lossless format: `lossless`, re-encoded without loss
 * - lossy source to a lossless format: allowed, but not lossless, and labelled
 *   "same quality as the source" so nobody mistakes it for a real lossless file
 * - any source to a lossy format: "some quality loss"
 *
 * @throws RangeError when `sourceCodec` or `target` is unknown. Check values read from storage
 * with {@link isCodec} and {@link isDownloadFormat} (or {@link sanitizeQualityPrefs}) first.
 */
export function describeConversion(
  sourceCodec: Codec,
  target: DownloadFormat,
): ConversionDescription {
  if (!isCodec(sourceCodec)) throw new RangeError(`Unknown codec: ${String(sourceCodec)}`)
  if (!isDownloadFormat(target)) throw new RangeError(`Unknown download format: ${String(target)}`)
  const source = CODEC_LABELS[sourceCodec]
  const sourceLossless = isLosslessCodec(sourceCodec)
  if (target === 'original') {
    return { lossless: sourceLossless, transcoded: false, label: `Original (${source})` }
  }
  const format = DOWNLOAD_FORMATS[target]
  if (format.codec === sourceCodec) {
    return { lossless: sourceLossless, transcoded: false, label: `${format.label} (no conversion)` }
  }
  let note = 'some quality loss'
  if (format.lossless) note = sourceLossless ? 'lossless' : 'same quality as the source'
  return {
    lossless: format.lossless && sourceLossless,
    transcoded: true,
    label: `${format.label} (converted from ${source}, ${note})`,
  }
}

/** The MP3 bitrates the download settings offer, in kbps. */
export const MP3_BITRATES = Object.freeze([128, 192, 256, 320] as const)

/** One of the {@link MP3_BITRATES}. */
export type Mp3Bitrate = (typeof MP3_BITRATES)[number]

/** The MP3 bitrate, in kbps, used when {@link QualityPrefs} names none. */
export const DEFAULT_MP3_KBPS: Mp3Bitrate = 320

/** Whether `value` is one of the {@link MP3_BITRATES}, e.g. to validate a stored setting. */
export function isMp3Bitrate(value: unknown): value is Mp3Bitrate {
  return (MP3_BITRATES as readonly unknown[]).includes(value)
}

/** The user's quality settings. Validate stored copies with {@link sanitizeQualityPrefs}. */
export interface QualityPrefs {
  /**
   * The best tier to stream at, per network type. A lower tier plays when nothing better
   * exists.
   */
  streaming: {
    /** On Wi-Fi or Ethernet. */
    wifi: QualityTier
    /** On mobile data. */
    cellular: QualityTier
  }
  /** Download settings. */
  download: {
    /** The format downloads are saved in. */
    format: DownloadFormat
    /** Bitrate for MP3 conversions. {@link DEFAULT_MP3_KBPS} (320) when absent. */
    mp3Kbps?: Mp3Bitrate
  }
}

/**
 * {@link QualityPrefs} that cannot be changed at any depth, such as
 * {@link DEFAULT_QUALITY_PREFS}. Still accepted wherever `QualityPrefs` is expected.
 */
export type ReadonlyQualityPrefs = {
  readonly streaming: Readonly<QualityPrefs['streaming']>
  readonly download: Readonly<QualityPrefs['download']>
}

/**
 * The settings of a fresh install: high on Wi-Fi, normal on mobile data, original downloads.
 * Frozen at every depth, so a settings store must not start from a (shallow) copy of it: use
 * {@link sanitizeQualityPrefs}, which returns a fresh, mutable object.
 */
export const DEFAULT_QUALITY_PREFS: ReadonlyQualityPrefs = Object.freeze({
  streaming: Object.freeze({ wifi: 'high', cellular: 'normal' }),
  download: Object.freeze({ format: 'original' }),
})

/** `value` itself when it is a non-null object, else an empty one. */
function asRecord(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

/**
 * Valid {@link QualityPrefs} from an untrusted value, such as settings read from storage or an
 * imported backup. Each field that is missing or invalid gets its default from
 * {@link DEFAULT_QUALITY_PREFS}, an invalid `mp3Kbps` is left out (so the default applies), and
 * unknown fields are dropped. Any JSON-like value is accepted without throwing, and the result
 * is a fresh, mutable object, so `sanitizeQualityPrefs(undefined)` is a copy of the defaults
 * that a store can change.
 */
export function sanitizeQualityPrefs(value: unknown): QualityPrefs {
  const stored = asRecord(value)
  const streaming = asRecord(stored.streaming)
  const download = asRecord(stored.download)
  const defaults = DEFAULT_QUALITY_PREFS
  const prefs: QualityPrefs = {
    streaming: {
      wifi: isQualityTier(streaming.wifi) ? streaming.wifi : defaults.streaming.wifi,
      cellular: isQualityTier(streaming.cellular)
        ? streaming.cellular
        : defaults.streaming.cellular,
    },
    download: {
      format: isDownloadFormat(download.format) ? download.format : defaults.download.format,
    },
  }
  if (isMp3Bitrate(download.mp3Kbps)) prefs.download.mp3Kbps = download.mp3Kbps
  return prefs
}
