/**
 * What saving a download in a format takes: whether the audio of a video (YouTube's itag 18)
 * must be extracted first, whether the ffmpeg core must remux or re-encode it, what writes the
 * tags, and what the file will be. Labels come from core's `describeConversion`, so a converted
 * file always says what it is, and YouTube audio is never called lossless.
 *
 * @module
 */

import {
  CODEC_LABELS,
  type Codec,
  type Container,
  DEFAULT_MP3_KBPS,
  DOWNLOAD_FORMATS,
  type DownloadFormat,
  describeConversion,
  type Mp3Bitrate,
} from '@fxm/core'
import { ConvertError, type SourceAudio } from './types'

/** The muxers FXM's ffmpeg core writes (tools/ffmpeg-wasm). */
export type CoreMuxer = 'flac' | 'ipod' | 'wav' | 'mp3' | 'ogg' | 'webm'

/** One run of the ffmpeg core: the input's best audio stream into one output file. */
export interface CoreJob {
  /** The muxer of the output. */
  readonly format: CoreMuxer
  /**
   * The encoder: an FFmpeg encoder name (`flac`, `alac`, `libmp3lame`, `aac`, `libopus`), `copy`
   * to keep the audio as it is in another container, or `pcm` for WAV at the source's depth.
   */
  readonly codec: string
  /** The bitrate of a lossy encoder, in bits per second. */
  readonly bitRate?: number
  /** FLAC's compression level. */
  readonly compressionLevel?: number
  /** Container tags, only for WebM, whose tags only a muxer can write. */
  readonly metadata?: Readonly<Record<string, string>>
}

/**
 * What writes the saved file's tags: FXM's own writers for ID3v2 (MP3), FLAC, Ogg, MP4 (M4A)
 * and RIFF (WAV) files, or the core's muxer for WebM (`core`, which can't embed a cover).
 */
export type TagWriter = 'id3v2' | 'flac' | 'ogg' | 'mp4' | 'riff' | 'core'

/** What the saved file is. */
export interface ExportOutput {
  readonly codec: Codec
  readonly container: Container
  /** File extension, without the dot. */
  readonly extension: string
  readonly mimeType: string
  /** The bitrate a lossy encode aims at, in kbps; absent when the audio isn't re-encoded. */
  readonly bitrateKbps?: number
}

/** The steps of saving one download in one format. */
export interface ExportPlan {
  readonly format: DownloadFormat
  /** Honest label, e.g. "FLAC (converted from Opus, same quality as the source)". */
  readonly label: string
  /** Whether the file is truly lossless: a lossless source kept lossless. */
  readonly lossless: boolean
  /** Whether the audio is re-encoded. */
  readonly transcoded: boolean
  /** The source is a video (itag 18): its AAC track is extracted with mp4box.js first. */
  readonly extractAudio: boolean
  /** The ffmpeg core's step, when one is needed. */
  readonly core?: CoreJob
  /** What writes the tags at the end. */
  readonly tags: TagWriter
  readonly output: ExportOutput
}

/** The bitrates FXM encodes lossy formats at, in kbps (MP3's comes from the settings). */
export const ENCODE_KBPS = Object.freeze({ aac: 256, opus: 160 })

/** FLAC's compression level: FFmpeg's default, fast enough in WebAssembly. */
export const FLAC_COMPRESSION_LEVEL = 5

/** Options for {@link planExport}. */
export interface ExportOptions {
  /** The MP3 bitrate, from the download settings. Default: {@link DEFAULT_MP3_KBPS}. */
  readonly mp3Kbps?: Mp3Bitrate
}

/** The MIME type of a saved file. */
export function exportMimeType(container: Container): string {
  switch (container) {
    case 'flac':
      return 'audio/flac'
    case 'mp4':
    case 'm4a':
      return 'audio/mp4'
    case 'wav':
      return 'audio/wav'
    case 'mp3':
      return 'audio/mpeg'
    case 'ogg':
      return 'audio/ogg'
    case 'webm':
      return 'audio/webm'
  }
}

/** The extension of a saved file: Ogg holding Opus is `.opus`, MP4 audio is `.m4a`. */
export function exportExtension(container: Container, codec: Codec): string {
  if (container === 'mp4' || container === 'm4a') return 'm4a'
  if (container === 'ogg') return codec === 'opus' ? 'opus' : 'ogg'
  return container
}

/** The muxer that writes a container. */
function muxerFor(container: Container): CoreMuxer {
  switch (container) {
    case 'flac':
      return 'flac'
    case 'mp4':
    case 'm4a':
      return 'ipod'
    case 'wav':
      return 'wav'
    case 'mp3':
      return 'mp3'
    case 'ogg':
      return 'ogg'
    case 'webm':
      return 'webm'
  }
}

/** The tag writer for a container. */
function tagWriterFor(container: Container): TagWriter {
  switch (container) {
    case 'flac':
      return 'flac'
    case 'mp4':
    case 'm4a':
      return 'mp4'
    case 'wav':
      return 'riff'
    case 'mp3':
      return 'id3v2'
    case 'ogg':
      return 'ogg'
    case 'webm':
      return 'core'
  }
}

/** The encoder of each conversion format. */
const ENCODERS: Readonly<Record<Exclude<DownloadFormat, 'original'>, string>> = {
  flac: 'flac',
  alac: 'alac',
  wav: 'pcm',
  mp3: 'libmp3lame',
  aac: 'aac',
  opus: 'libopus',
}

/** The same container family: MP4 and M4A are one format. */
function sameContainer(a: Container, b: Container): boolean {
  const family = (container: Container) => (container === 'mp4' ? 'm4a' : container)
  return family(a) === family(b)
}

/**
 * Whether FXM can save `source` at all: any audio file, and a video whose audio is AAC in MP4
 * (YouTube's itag 18, the only video a source delivers). {@link planExport} refuses the rest.
 */
export function isExportable(source: Pick<SourceAudio, 'codec' | 'container' | 'media'>): boolean {
  return (
    source.media !== 'muxed-video' ||
    (source.codec === 'aac' && sameContainer(source.container, 'm4a'))
  )
}

/** How the source reads in labels: "Opus", or "AAC from 360p video" for itag 18. */
export function sourceLabel(source: Pick<SourceAudio, 'codec' | 'media'>): string {
  const codec = CODEC_LABELS[source.codec]
  return source.media === 'muxed-video' ? `${codec} from 360p video` : codec
}

/**
 * The honest label of saving `source` as `format`: core's `describeConversion`, with the audio
 * of a video named as such ("Original (AAC from 360p video)"). YouTube audio, Opus or AAC, is
 * never called lossless, whatever the format.
 */
export function exportLabel(source: SourceAudio, format: DownloadFormat): string {
  const description = describeConversion(source.codec, format)
  if (source.media !== 'muxed-video') return description.label
  const from = sourceLabel(source)
  if (format === 'original') return `Original (${from})`
  if (!description.transcoded)
    return `${DOWNLOAD_FORMATS[format].label} (no conversion, from 360p video)`
  return description.label.replace(
    `converted from ${CODEC_LABELS[source.codec]}`,
    `converted from ${from}`,
  )
}

/**
 * The steps of saving `source` as `format`:
 *
 * - **Original**, or a format with the source's codec ("FLAC (no conversion)"): the audio stays
 *   as it is. FXM writes the tags itself, except into WebM, which the core remuxes with its
 *   tags. A same-codec format in another container (Opus from WebM to `.opus`) is a remux.
 * - **Any other format:** the core decodes and encodes it: FLAC (level 5), ALAC, WAV at the
 *   source's depth, MP3 at the settings' bitrate, AAC at 256 kbps or Opus at 160 kbps.
 * - **A video** (itag 18): its AAC track is extracted with mp4box.js first, never the video.
 *
 * @throws ConvertError `unsupported-input` for a source {@link isExportable} refuses: a video
 * whose audio isn't AAC in MP4, which no source delivers.
 */
export function planExport(
  source: SourceAudio,
  format: DownloadFormat,
  options: ExportOptions = {},
): ExportPlan {
  if (!isExportable(source)) {
    throw new ConvertError(
      'unsupported-input',
      `Can't extract ${source.codec} audio from a ${source.container} video`,
    )
  }
  const extractAudio = source.media === 'muxed-video'
  // What the audio is once extracted: itag 18's AAC track as an M4A file.
  const audio: { codec: Codec; container: Container } = extractAudio
    ? { codec: 'aac', container: 'm4a' }
    : { codec: source.codec, container: source.container }
  const description = describeConversion(source.codec, format)
  const base = {
    format,
    label: exportLabel(source, format),
    lossless: description.lossless,
    transcoded: description.transcoded,
    extractAudio,
  }

  if (!description.transcoded) {
    // The audio stays as it is, in its own container or the format's.
    const container = format === 'original' ? audio.container : DOWNLOAD_FORMATS[format].container
    const output: ExportOutput = {
      codec: audio.codec,
      container: container === 'mp4' ? 'm4a' : container,
      extension: exportExtension(container, audio.codec),
      mimeType: exportMimeType(container),
    }
    if (container === 'webm') {
      // Only a muxer writes Matroska tags: the core remuxes the audio with them.
      return { ...base, core: { format: 'webm', codec: 'copy' }, tags: 'core', output }
    }
    const tags = tagWriterFor(container)
    if (sameContainer(audio.container, container)) return { ...base, tags, output }
    return { ...base, core: { format: muxerFor(container), codec: 'copy' }, tags, output }
  }

  const target = DOWNLOAD_FORMATS[format as Exclude<DownloadFormat, 'original'>]
  const encoder = ENCODERS[format as Exclude<DownloadFormat, 'original'>]
  const kbps =
    format === 'mp3'
      ? (options.mp3Kbps ?? DEFAULT_MP3_KBPS)
      : format === 'aac'
        ? ENCODE_KBPS.aac
        : format === 'opus'
          ? ENCODE_KBPS.opus
          : undefined
  const core: CoreJob = {
    format: muxerFor(target.container),
    codec: encoder,
    ...(kbps === undefined ? {} : { bitRate: kbps * 1000 }),
    ...(format === 'flac' ? { compressionLevel: FLAC_COMPRESSION_LEVEL } : {}),
  }
  return {
    ...base,
    core,
    tags: tagWriterFor(target.container),
    output: {
      codec: target.codec,
      container: target.container,
      extension: target.extension,
      mimeType: exportMimeType(target.container),
      ...(kbps === undefined ? {} : { bitrateKbps: kbps }),
    },
  }
}

/** One choice of the "Save to device" format menu. */
export interface ExportChoice {
  readonly format: DownloadFormat
  readonly label: string
  readonly extension: string
  /** Whether it takes the ffmpeg core, which isn't available everywhere. */
  readonly needsCore: boolean
  /** Whether the audio is re-encoded; with the core but without this, it is only remuxed. */
  readonly transcoded: boolean
}

/**
 * Every format a source can be saved in, in the menu's order, with their honest labels.
 *
 * @throws ConvertError `unsupported-input` for a source {@link isExportable} refuses.
 */
export function exportChoices(source: SourceAudio, options: ExportOptions = {}): ExportChoice[] {
  return (Object.keys(DOWNLOAD_FORMATS) as DownloadFormat[]).map((format) => {
    const plan = planExport(source, format, options)
    return {
      format,
      label: plan.label,
      extension: plan.output.extension,
      needsCore: plan.core !== undefined,
      transcoded: plan.transcoded,
    }
  })
}
