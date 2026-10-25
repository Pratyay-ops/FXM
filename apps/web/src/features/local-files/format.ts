/**
 * Which local files FXM lists, how their formats map to the core codecs and containers, and how
 * their quality is labelled.
 *
 * The rule the labels follow: **FLAC, ALAC and WAV are lossless, nothing else is.** The tier
 * comes from the codec through `tierOf`, so an MP3, AAC, Opus or Vorbis file is never called
 * lossless, whatever its bitrate, and formats a tag reader may call lossless but browsers can't
 * play (Monkey's Audio, WavPack, DSD, AIFF) are not listed at all.
 *
 * @module
 */

import { CODEC_LABELS, type Codec, type Container, isLosslessCodec, tierOf } from '@fxm/core'
import type { LocalAudioFormat } from './types'

/**
 * The extensions FXM reads, with the MIME type that picks the tag reader's parser. Only formats
 * at least one major browser plays: MP3, AAC and ALAC in MP4, FLAC, WAV, and Opus, Vorbis or
 * FLAC in Ogg and WebM.
 */
export const AUDIO_EXTENSIONS: Readonly<Record<string, string>> = {
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  mp4: 'audio/mp4',
  flac: 'audio/flac',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  webm: 'audio/webm',
  weba: 'audio/webm',
}

/** The extension of a file name, lower case and without the dot; empty when it has none. */
export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase()
}

/** Whether FXM reads a file with this name (by its extension; hidden files are skipped). */
export function isAudioFileName(name: string): boolean {
  return !name.startsWith('.') && Object.hasOwn(AUDIO_EXTENSIONS, extensionOf(name))
}

/** The part of the tag reader's format report this module reads (music-metadata's `IFormat`). */
export interface ParsedFormat {
  container?: string | undefined
  codec?: string | undefined
  /** Bits per second. */
  bitrate?: number | undefined
  sampleRate?: number | undefined
  bitsPerSample?: number | undefined
  hasVideo?: boolean | undefined
}

const MP3_CODECS = new Set([
  'mpeg 1 layer 3',
  'mpeg 2 layer 3',
  'mpeg 2.5 layer 3',
  // MP3 inside MP4, Matroska and WAV, as music-metadata names it.
  'mpeg-1 layer 3',
  'mpeg/l3',
  'mpeglayer3',
])

/**
 * The codec name music-metadata 12 gives a WAV whose `fmt ` chunk has the format tag
 * WAVE_FORMAT_EXTENSIBLE (0xFFFE), lower case. ffmpeg and most other tools write that header for
 * anything above 16-bit or 48 kHz and for more than two channels; the real format is the
 * chunk's SubFormat GUID ({@link waveSubFormat}).
 */
export const WAVE_EXTENSIBLE_CODEC = 'non-pcm (65534)'

/** Whether the tag reader found an extensible WAV, whose format is in its SubFormat GUID. */
export function isWaveExtensible(parsed: Pick<ParsedFormat, 'container' | 'codec'>): boolean {
  return (
    parsed.container?.trim().toLowerCase() === 'wave' &&
    parsed.codec?.trim().toLowerCase() === WAVE_EXTENSIBLE_CODEC
  )
}

/**
 * What every SubFormat GUID of a WAVE format tag shares after the tag itself:
 * `xxxxxxxx-0000-0010-8000-00aa00389b71`, from byte 4 of the GUID on.
 */
const SUBFORMAT_TAIL = [0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71]

/** The WAV formats browsers play, by format tag, as the tag reader names them. */
const WAVE_FORMATS: Readonly<Record<number, string>> = { 1: 'PCM', 3: 'IEEE_FLOAT' }

/**
 * The audio of an extensible WAV, from the body of its `fmt ` chunk (WAVEFORMATEXTENSIBLE):
 * `PCM` or `IEEE_FLOAT` when its SubFormat GUID is theirs, with the bits per sample that hold
 * audio (a 24-bit file may store each sample in 32 bits). `undefined` for any other format, such
 * as Ambisonics or compressed audio, and for a chunk that isn't extensible.
 */
export function waveSubFormat(fmt: Uint8Array): { codec: string; validBits?: number } | undefined {
  // The 16-byte WAVEFORMAT, then cbSize (22), the valid bits, the channel mask and the 16-byte
  // GUID at byte 24, whose first field is the format tag as a 32-bit number.
  if (fmt.length < 40) return undefined
  const view = new DataView(fmt.buffer, fmt.byteOffset, fmt.byteLength)
  if (view.getUint16(0, true) !== 0xfffe || view.getUint16(26, true) !== 0) return undefined
  if (SUBFORMAT_TAIL.some((byte, index) => fmt[28 + index] !== byte)) return undefined
  const codec = WAVE_FORMATS[view.getUint16(24, true)]
  if (codec === undefined) return undefined
  const validBits = view.getUint16(18, true)
  return validBits > 0 && validBits <= view.getUint16(14, true) ? { codec, validBits } : { codec }
}

/** The core codec for the tag reader's codec name, or `undefined` for one FXM doesn't play. */
export function codecOf(name: string | undefined): Codec | undefined {
  const codec = name?.trim().toLowerCase()
  if (codec === undefined || codec === '') return undefined
  if (codec === 'flac') return 'flac'
  if (codec === 'alac') return 'alac'
  // Uncompressed WAV audio, as integers or floats. An extensible WAV is named after its
  // SubFormat by `readTags` first (see `waveSubFormat`); unread, it stays unknown here.
  if (codec === 'pcm' || codec === 'ieee_float') return 'pcm'
  if (codec === 'opus') return 'opus'
  if (codec === 'vorbis i' || codec === 'vorbis') return 'vorbis'
  if (MP3_CODECS.has(codec)) return 'mp3'
  // `MPEG-4/AAC` in MP4, `AAC` and `AAC/MPEG4/LC` in Matroska.
  if (codec === 'mpeg-4/aac' || codec === 'aac' || codec.startsWith('aac/')) return 'aac'
  return undefined
}

/** MP4 brands from the file type box, which music-metadata reports as the container. */
const MP4_BRANDS = /^(m4a|m4b|m4p|mp4\d|iso\d|isom|dash|avc1|qt|f4a|mp71|3gp\d|3g2\w?)$/

/**
 * The core container for the tag reader's container name, or `undefined` for one FXM doesn't
 * play. `extension` tells MP4 audio (`.m4a`) from MP4 (`.mp4`).
 */
export function containerOf(name: string | undefined, extension: string): Container | undefined {
  const container = name?.trim().toLowerCase() ?? ''
  if (container === 'mpeg') return 'mp3'
  if (container === 'flac') return 'flac'
  if (container === 'wave') return 'wav'
  if (container === 'ogg') return 'ogg'
  if (container === 'ebml/webm') return 'webm'
  // e.g. `M4A/isom/mp42`: the brands of an MP4 file.
  if (container.split('/').some((brand) => MP4_BRANDS.test(brand))) {
    return extension === 'mp4' ? 'mp4' : 'm4a'
  }
  return undefined
}

/** The containers each codec may come in, so a mislabelled pair is refused. */
const CONTAINERS: Readonly<Record<Codec, readonly Container[]>> = {
  mp3: ['mp3'],
  aac: ['m4a', 'mp4'],
  alac: ['m4a', 'mp4'],
  flac: ['flac', 'ogg'],
  pcm: ['wav'],
  opus: ['ogg', 'webm'],
  vorbis: ['ogg', 'webm'],
}

function positiveInteger(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) && value > 0 ? Math.round(value) : undefined
}

/**
 * The format of a file from the tag reader's report, or why FXM doesn't list it: a video, or a
 * codec or container browsers don't play.
 */
export function audioFormatOf(
  parsed: ParsedFormat,
  extension: string,
): { format: LocalAudioFormat } | { unsupported: string } {
  if (parsed.hasVideo === true) return { unsupported: 'A video file' }
  const codec = codecOf(parsed.codec)
  const container = containerOf(parsed.container, extension)
  if (codec === undefined || container === undefined || !CONTAINERS[codec].includes(container)) {
    const what = [parsed.codec, parsed.container].filter(Boolean).join(' in ')
    return { unsupported: what ? `Not a format browsers play: ${what}` : 'An unknown format' }
  }
  const bitrateKbps = positiveInteger(
    parsed.bitrate === undefined ? undefined : parsed.bitrate / 1000,
  )
  const format: LocalAudioFormat = {
    codec,
    container,
    tier: tierOf(bitrateKbps === undefined ? { codec } : { codec, bitrateKbps }),
  }
  if (bitrateKbps !== undefined) format.bitrateKbps = bitrateKbps
  const sampleRateHz = positiveInteger(parsed.sampleRate)
  if (sampleRateHz !== undefined) format.sampleRateHz = sampleRateHz
  const bitDepth = positiveInteger(parsed.bitsPerSample)
  if (bitDepth !== undefined && isLosslessCodec(codec)) format.bitDepth = bitDepth
  return { format }
}

/** Whether a file's audio is lossless: FLAC, ALAC or WAV, nothing else. */
export function isLossless(format: Pick<LocalAudioFormat, 'tier'>): boolean {
  return format.tier === 'lossless'
}

/** The name of a format for people: the codec, except WAV's PCM, which people know as WAV. */
export function formatName(format: Pick<LocalAudioFormat, 'codec' | 'container'>): string {
  return format.codec === 'pcm' ? 'WAV' : CODEC_LABELS[format.codec]
}

/** A sample rate for people: `44.1 kHz`, `96 kHz`. */
function kilohertz(hz: number): string {
  return `${Number((hz / 1000).toFixed(1)).toLocaleString('en')} kHz`
}

/**
 * The quality of a file for people, e.g. `FLAC · 24-bit · 96 kHz` or `MP3 · 320 kbps`. Lossless
 * files show their resolution, lossy ones their bitrate, when known.
 */
export function qualityLabel(format: LocalAudioFormat): string {
  const parts = [formatName(format)]
  if (isLossless(format)) {
    if (format.bitDepth !== undefined) parts.push(`${format.bitDepth}-bit`)
    if (format.sampleRateHz !== undefined) parts.push(kilohertz(format.sampleRateHz))
  } else if (format.bitrateKbps !== undefined) {
    parts.push(`${format.bitrateKbps} kbps`)
  }
  return parts.join(' · ')
}
