/**
 * Reads a file's tags, format and cover with music-metadata (MIT): ID3 in MP3 and WAV, MP4
 * atoms in M4A, Vorbis comments in FLAC and Ogg, Matroska tags in WebM.
 *
 * The parser is loaded on first use, in its own chunk, so the app doesn't download it until
 * the user adds music files. It reads only the parts of a file it needs (headers and tags, via
 * `Blob.slice`), never the whole file, and bounds what a damaged or hostile file can make it
 * allocate. Every value it returns is cleaned here: trimmed, length-capped, numbers checked.
 *
 * @module
 */

import {
  loudnessFromR128,
  loudnessFromReplayGain,
  normalizeIsrc,
  parseR128GainDb,
  type StreamLoudness,
} from '@fxm/core'
import type { IAudioMetadata, IOptions } from 'music-metadata'
import {
  AUDIO_EXTENSIONS,
  audioFormatOf,
  extensionOf,
  isWaveExtensible,
  type ParsedFormat,
  waveSubFormat,
} from './format'
import type { LocalAudioFormat, LocalTags, SkipReason } from './types'

/**
 * The version of this reader. Records written by an older one are read again on the next scan,
 * so a reader that learns a new tag fills it in for files already listed. 2: ReplayGain and R128
 * gains (stage 8.1).
 */
export const READER_VERSION = 2

/** The longest tag value kept; longer ones are cut. */
const MAX_TAG_LENGTH = 500

/** The most artists kept for one file. */
const MAX_ARTISTS = 20

/** An embedded cover, as the file holds it. */
export interface PictureData {
  data: Uint8Array
  /** Its MIME type, e.g. `image/jpeg`. */
  format: string
}

/** What reading one file gave. */
export type ReadResult =
  | { ok: true; tags: LocalTags; format: LocalAudioFormat; picture?: PictureData }
  | { ok: false; reason: SkipReason; message: string }

/** Reads a file's tags; `name` is its file name, for the format and the fallback title. */
export type ReadTags = (file: Blob, name: string) => Promise<ReadResult>

const OPTIONS: IOptions = {
  // Estimate an MP3's length from its header instead of reading the whole file.
  duration: false,
  // In WebM, skip the audio clusters by the file's index to reach the tags at the end.
  mkvUseIndex: true,
}

type Parser = typeof import('music-metadata')

let parser: Promise<Parser> | undefined

function loadParser(): Promise<Parser> {
  parser ??= import('music-metadata').catch((error: unknown) => {
    parser = undefined
    throw error
  })
  return parser
}

function messageOf(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error)
}

/** Errors that mean "not an audio format the parser knows", rather than a damaged file. */
const UNSUPPORTED_ERRORS = new Set(['CouldNotDetermineFileTypeError', 'UnsupportedFileTypeError'])

/** What parsing a file gave: the metadata and its format, or why it failed. */
type Parsed =
  | { metadata: IAudioMetadata; format: LocalAudioFormat }
  | { metadata?: IAudioMetadata; failure: { reason: SkipReason; message: string } }

async function parse(parseBlob: Parser['parseBlob'], file: Blob, type: string, extension: string) {
  let metadata: IAudioMetadata
  try {
    metadata = await parseBlob(file.slice(0, file.size, type), OPTIONS)
  } catch (error) {
    const unsupported = error instanceof Error && UNSUPPORTED_ERRORS.has(error.name)
    const reason: SkipReason = unsupported ? 'unsupported' : 'unreadable'
    return { failure: { reason, message: messageOf(error) } } satisfies Parsed
  }
  let parsed: ParsedFormat = metadata.format
  if (isWaveExtensible(parsed)) {
    // The tag reader has no name for this header: the SubFormat in the `fmt ` chunk says what
    // the audio is (PCM in every 24-bit or 96 kHz WAV ffmpeg writes).
    const fmt = await waveFormatChunk(file)
    const sub = fmt === undefined ? undefined : waveSubFormat(fmt)
    if (sub !== undefined) {
      parsed = { ...parsed, codec: sub.codec }
      if (sub.validBits !== undefined) parsed.bitsPerSample = sub.validBits
    }
  }
  const result = audioFormatOf(parsed, extension)
  if ('unsupported' in result) {
    return {
      metadata,
      failure: { reason: 'unsupported', message: result.unsupported },
    } satisfies Parsed
  }
  return { metadata, format: result.format } satisfies Parsed
}

/**
 * Reads `file`. The parser is chosen by the extension first; when that finds nothing playable,
 * by the file's content, for a file whose extension lies (an M4A named `.mp3`).
 */
export const readTags: ReadTags = async (file, name) => {
  const { parseBlob, selectCover } = await loadParser()
  const extension = extensionOf(name)
  let parsed: Parsed = await parse(parseBlob, file, AUDIO_EXTENSIONS[extension] ?? '', extension)
  if ('failure' in parsed) {
    const sniffed = await parse(parseBlob, file, '', extension)
    if (!('failure' in sniffed)) parsed = sniffed
  }
  if ('failure' in parsed) return { ok: false, ...parsed.failure }
  const { metadata, format } = parsed
  const tags = cleanTags(metadata, name)
  if (tags.durationMs === undefined && format.container === 'ogg') {
    const durationMs = await oggDurationMs(file, format)
    if (durationMs !== undefined) tags.durationMs = durationMs
  }
  const cover = selectCover(metadata.common.picture)
  if (cover === null || cover.data.length === 0) return { ok: true, tags, format }
  return { ok: true, tags, format, picture: { data: cover.data, format: cover.format } }
}

/** RIFF chunks looked at before the `fmt ` chunk, at most: it normally comes first. */
const MAX_WAVE_CHUNKS = 64

/**
 * The body of a WAV file's `fmt ` chunk (its first 64 bytes, enough for WAVEFORMATEXTENSIBLE),
 * found by walking the RIFF chunks from the start: 8 bytes per chunk are read, never the audio.
 */
export async function waveFormatChunk(file: Blob): Promise<Uint8Array | undefined> {
  // After "RIFF", the file size and "WAVE": chunks of a four-character ID, a 32-bit size and the
  // body, padded to an even length.
  let at = 12
  for (let chunk = 0; chunk < MAX_WAVE_CHUNKS && at + 8 <= file.size; chunk++) {
    const header = new Uint8Array(await file.slice(at, at + 8).arrayBuffer())
    const id = String.fromCharCode(...header.subarray(0, 4))
    const size = new DataView(header.buffer).getUint32(4, true)
    if (id === 'fmt ') {
      return new Uint8Array(await file.slice(at + 8, at + 8 + Math.min(size, 64)).arrayBuffer())
    }
    // The format comes before the audio: past it, there is none.
    if (id === 'data') return undefined
    at += 8 + size + (size % 2)
  }
  return undefined
}

/** Bytes read from the end of an Ogg file to find its last page. */
const OGG_PROBE_BYTES = 64 * 1024

/** "OggS": where an Ogg page starts. */
const OGG_CAPTURE = [0x4f, 0x67, 0x67, 0x53]

/**
 * The length of an Ogg file from the granule position of its last page. The tag reader stops
 * after an Ogg file's first pages unless it reads the whole file, so it leaves the length out;
 * the last page, at the end of the file, has it. Opus counts at 48 kHz after its pre-skip, the
 * others at their sample rate.
 */
export async function oggDurationMs(
  file: Blob,
  format: Pick<LocalAudioFormat, 'codec' | 'sampleRateHz'>,
): Promise<number | undefined> {
  const start = Math.max(0, file.size - OGG_PROBE_BYTES)
  const tail = new Uint8Array(await file.slice(start, file.size).arrayBuffer())
  for (let at = tail.length - 27; at >= 0; at--) {
    if (OGG_CAPTURE.some((byte, index) => tail[at + index] !== byte) || tail[at + 4] !== 0) continue
    const granule = new DataView(tail.buffer, tail.byteOffset + at + 6, 8).getBigUint64(0, true)
    // All ones: no packet ends on this page.
    if (granule === 0xffffffffffffffffn) continue
    const samples = Number(granule)
    if (format.codec === 'opus') {
      const head = new Uint8Array(await file.slice(0, Math.min(file.size, 512)).arrayBuffer())
      const preSkip = opusPreSkip(head)
      return samples > preSkip ? Math.round((samples - preSkip) / 48) : undefined
    }
    const rate = format.sampleRateHz
    return rate !== undefined && samples > 0 ? Math.round((samples / rate) * 1000) : undefined
  }
  return undefined
}

/** The pre-skip of an Opus stream, from the `OpusHead` packet at its start (0 if missing). */
function opusPreSkip(head: Uint8Array): number {
  const signature = [...'OpusHead'].map((char) => char.charCodeAt(0))
  for (let at = 0; at + 12 <= head.length; at++) {
    if (signature.every((byte, index) => head[at + index] === byte)) {
      return (head[at + 10] ?? 0) | ((head[at + 11] ?? 0) << 8)
    }
  }
  return 0
}

/** A tag value as text worth keeping, or `undefined`. */
export function cleanText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  // Some taggers pad with NUL characters; control characters never belong in a name.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: removing them is the point
  const text = value.replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ')
  const trimmed = text.trim().slice(0, MAX_TAG_LENGTH).trim()
  return trimmed === '' ? undefined : trimmed
}

function positiveInteger(value: unknown, max = 9999): number | undefined {
  return Number.isSafeInteger(value) && (value as number) > 0 && (value as number) <= max
    ? (value as number)
    : undefined
}

const DATE = /^(\d{4})(-(0[1-9]|1[0-2])(-(0[1-9]|[12]\d|3[01]))?)?/u

/** A release date as ISO 8601, possibly partial, from a date tag or a year. */
export function cleanDate(date: unknown, year: unknown): string | undefined {
  const match = typeof date === 'string' ? DATE.exec(date.trim()) : null
  if (match?.[0] !== undefined && match[1] !== '0000') return match[0]
  const fallback = positiveInteger(year)
  return fallback !== undefined && fallback >= 1000 ? String(fallback) : undefined
}

/**
 * A leading track number in a file name: a number before a dash (`1 - `, `01-`), before a dot or
 * parenthesis and a space (`01. `, `1) `), or a zero-padded one before a space (`01 `), after an
 * optional disc number (`1-03 `). "99 Luftballons" and "1979" keep their numbers.
 */
const LEADING_NUMBER = /^(?:\d{1,2}[-.])?(?:(\d{1,3})(?:\s*[.)]\s+|\s*-\s*)|(0\d{1,2})\s+)(?=\S)/u

/**
 * A title from a file name, for files without one: the name without its extension and without
 * a leading track number (`01 - Song.flac` is "Song", track 1).
 */
export function titleFromFileName(name: string): { title: string; trackNumber?: number } {
  const dot = name.lastIndexOf('.')
  const base = (dot > 0 ? name.slice(0, dot) : name).replace(/_/gu, ' ').trim()
  const match = LEADING_NUMBER.exec(base)
  const rest = match === null ? '' : (cleanText(base.slice(match[0].length)) ?? '')
  if (match !== null && rest !== '') {
    const trackNumber = positiveInteger(Number(match[1] ?? match[2]))
    return trackNumber === undefined ? { title: rest } : { title: rest, trackNumber }
  }
  return { title: cleanText(base) ?? name }
}

function uniqueNames(values: readonly unknown[]): string[] {
  const names: string[] = []
  const seen = new Set<string>()
  for (const value of values) {
    const name = cleanText(value)
    if (name === undefined || seen.has(name.toLowerCase())) continue
    seen.add(name.toLowerCase())
    names.push(name)
    if (names.length >= MAX_ARTISTS) break
  }
  return names
}

/** The tags FXM keeps from what the parser read, with the file name as the fallback title. */
export function cleanTags(
  metadata: Pick<IAudioMetadata, 'common' | 'format'> & Partial<Pick<IAudioMetadata, 'native'>>,
  name: string,
): LocalTags {
  const { common, format } = metadata
  const fromName = titleFromFileName(name)
  const artists = uniqueNames(
    common.artists !== undefined && common.artists.length > 0 ? common.artists : [common.artist],
  )
  const tags: LocalTags = { title: cleanText(common.title) ?? fromName.title, artists }
  const albumArtist = cleanText(common.albumartist)
  if (albumArtist !== undefined) tags.albumArtist = albumArtist
  const album = cleanText(common.album)
  if (album !== undefined) tags.album = album
  const trackNumber = positiveInteger(common.track.no) ?? fromName.trackNumber
  if (trackNumber !== undefined) tags.trackNumber = trackNumber
  const discNumber = positiveInteger(common.disk.no, 999)
  if (discNumber !== undefined) tags.discNumber = discNumber
  const releaseDate = cleanDate(common.date ?? common.releasedate, common.year)
  if (releaseDate !== undefined) tags.releaseDate = releaseDate
  const isrc = normalizeIsrc(common.isrc?.[0])
  if (isrc !== null) tags.isrc = isrc
  if (common.compilation === true) tags.compilation = true
  const seconds = format.duration
  if (seconds !== undefined && Number.isFinite(seconds) && seconds > 0) {
    tags.durationMs = Math.round(seconds * 1000)
  }
  const loudness = loudnessOfTags(metadata)
  if (loudness !== undefined) tags.loudness = loudness
  return tags
}

/** An Opus file's R128 gain tags (Vorbis comments), as loudness. */
function r128Loudness(native: IAudioMetadata['native'] | undefined): StreamLoudness | undefined {
  const comments = native?.vorbis ?? []
  const value = (id: string) =>
    comments.find((tag) => typeof tag.id === 'string' && tag.id.toUpperCase() === id)?.value
  return loudnessFromR128({
    trackGainDb: parseR128GainDb(value('R128_TRACK_GAIN')),
    albumGainDb: parseR128GainDb(value('R128_ALBUM_GAIN')),
  })
}

/**
 * How loud a file is (stage 8.1): its ReplayGain tags (`REPLAYGAIN_TRACK_GAIN` and `_PEAK`, and
 * the album pair), which the tag reader finds in ID3, MP4, Vorbis and APE tags; for an Opus file
 * its R128 gains first (RFC 7845: Opus taggers write those, relative to the header's output gain,
 * which the decoder applies). `undefined` without either.
 */
export function loudnessOfTags(
  metadata: Pick<IAudioMetadata, 'common'> & Partial<Pick<IAudioMetadata, 'native' | 'format'>>,
): StreamLoudness | undefined {
  const { common } = metadata
  const r128 = r128Loudness(metadata.native)
  const opus = (metadata.format?.codec ?? '').toLowerCase().includes('opus')
  if (opus && r128 !== undefined) return r128
  const replayGain = loudnessFromReplayGain({
    trackGainDb: common.replaygain_track_gain?.dB,
    trackPeak: common.replaygain_track_peak?.ratio,
    albumGainDb: common.replaygain_album_gain?.dB,
    albumPeak: common.replaygain_album_peak?.ratio,
  })
  return replayGain ?? r128
}
