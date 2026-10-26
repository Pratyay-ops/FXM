/**
 * ID3v2.3 tags, for MP3 files and the `id3 ` chunk of WAV files. Version 2.3 with UTF-16 text is
 * what the widest range of players and file managers read (Windows Explorer and older car
 * stereos among them), so FXM writes it rather than 2.4.
 *
 * Frames: TIT2 title, TPE1 artists, TALB album, TRCK track, TPOS disc, TYER year, TSRC ISRC,
 * USLT lyrics, SYLT synced lyrics (milliseconds), APIC front cover, and for a file converted
 * from lossy audio COMM (a note for people) and TXXX frames FXM_SOURCE_CODEC and
 * FXM_SOURCE_BITRATE.
 *
 * @module
 */

import { ByteWriter, concat, hasAscii, latin1, readSyncsafe, utf16WithBom } from '../bytes'
import type { ExportTags } from '../types'
import {
  conversionNote,
  joinedArtists,
  plainLyrics,
  positive,
  releaseYear,
  sourceFields,
} from './fields'

const UTF16 = 1
const TERMINATOR_UTF16 = new Uint8Array([0, 0])
/** ISO 639-2 for "undetermined": FXM doesn't know the language of the lyrics. */
const LANGUAGE = 'und'
/** ISO 639-2 for English, the language of FXM's own notes. */
const ENGLISH = 'eng'

function frame(id: string, body: Uint8Array): Uint8Array {
  // ID3v2.3 frame sizes are plain 32-bit integers (2.4 made them syncsafe).
  return new ByteWriter().ascii(id).u32be(body.length).u16be(0).bytes(body).finish()
}

function textFrame(id: string, text: string | undefined): Uint8Array | undefined {
  if (text === undefined || text.trim() === '') return undefined
  return frame(id, concat([new Uint8Array([UTF16]), utf16WithBom(text)]))
}

function lyricsFrame(text: string): Uint8Array {
  return frame(
    'USLT',
    new ByteWriter()
      .u8(UTF16)
      .ascii(LANGUAGE)
      .bytes(utf16WithBom(''))
      .bytes(TERMINATOR_UTF16)
      .bytes(utf16WithBom(text))
      .finish(),
  )
}

/** A comment (COMM) with no short description: FXM's note on a converted file. */
function commentFrame(text: string): Uint8Array {
  return frame(
    'COMM',
    new ByteWriter()
      .u8(UTF16)
      .ascii(ENGLISH)
      .bytes(utf16WithBom(''))
      .bytes(TERMINATOR_UTF16)
      .bytes(utf16WithBom(text))
      .finish(),
  )
}

/** A user-defined text frame (TXXX): a description that names it, and its value. */
function userTextFrame(description: string, value: string): Uint8Array {
  return frame(
    'TXXX',
    new ByteWriter()
      .u8(UTF16)
      .bytes(utf16WithBom(description))
      .bytes(TERMINATOR_UTF16)
      .bytes(utf16WithBom(value))
      .finish(),
  )
}

function syncedLyricsFrame(lines: NonNullable<ExportTags['syncedLyrics']>): Uint8Array {
  const body = new ByteWriter()
    .u8(UTF16)
    .ascii(LANGUAGE)
    .u8(2) // timestamps in milliseconds
    .u8(1) // content: lyrics
    .bytes(utf16WithBom(''))
    .bytes(TERMINATOR_UTF16)
  for (const line of lines) {
    body
      .bytes(utf16WithBom(line.text))
      .bytes(TERMINATOR_UTF16)
      .u32be(Math.max(0, Math.round(line.timeMs)))
  }
  return frame('SYLT', body.finish())
}

function pictureFrame(cover: NonNullable<ExportTags['cover']>): Uint8Array {
  return frame(
    'APIC',
    new ByteWriter()
      .u8(UTF16)
      .bytes(latin1(cover.mimeType))
      .u8(0)
      .u8(3) // front cover
      .bytes(utf16WithBom(''))
      .bytes(TERMINATOR_UTF16)
      .bytes(cover.data)
      .finish(),
  )
}

/** The frames of `tags`, in a fixed order. */
function frames(tags: ExportTags): Uint8Array[] {
  const track = positive(tags.trackNumber)
  const disc = positive(tags.discNumber)
  const lyrics = plainLyrics(tags)
  const note = conversionNote(tags)
  const list = [
    textFrame('TIT2', tags.title),
    textFrame('TPE1', joinedArtists(tags)),
    textFrame('TALB', tags.album),
    textFrame('TRCK', track === undefined ? undefined : String(track)),
    textFrame('TPOS', disc === undefined ? undefined : String(disc)),
    textFrame('TYER', releaseYear(tags.releaseDate)),
    textFrame('TSRC', tags.isrc),
    lyrics === undefined ? undefined : lyricsFrame(lyrics),
    tags.syncedLyrics !== undefined && tags.syncedLyrics.length > 0
      ? syncedLyricsFrame(tags.syncedLyrics)
      : undefined,
    tags.cover === undefined ? undefined : pictureFrame(tags.cover),
    note === undefined ? undefined : commentFrame(note),
    ...sourceFields(tags).map(([name, value]) => userTextFrame(name, value)),
  ]
  return list.filter((item): item is Uint8Array => item !== undefined)
}

/** The largest tag ID3v2's 28-bit size can describe. */
const MAX_TAG_BYTES = 2 ** 28 - 1

/** A whole ID3v2.3 tag holding `tags`, header included. */
export function buildId3v2(tags: ExportTags): Uint8Array {
  const body = concat(frames(tags))
  if (body.length > MAX_TAG_BYTES) throw new RangeError('The tags are too large for ID3v2')
  return new ByteWriter()
    .ascii('ID3')
    .u8(3) // version 2.3
    .u8(0)
    .u8(0) // no unsynchronisation, extended header or experimental flag
    .syncsafe(body.length)
    .bytes(body)
    .finish()
}

/** The length of the ID3v2 tag at the start of `bytes`, footer included; 0 when there is none. */
export function id3v2Length(bytes: Uint8Array, offset = 0): number {
  if (!hasAscii(bytes, offset, 'ID3') || bytes.length < offset + 10) return 0
  const version = bytes[offset + 3] ?? 0
  const flags = bytes[offset + 5] ?? 0
  if (version < 2 || version > 4) return 0
  const footer = version === 4 && (flags & 0x10) !== 0 ? 10 : 0
  return Math.min(bytes.length - offset, 10 + readSyncsafe(bytes, offset + 6) + footer)
}

/** `bytes` without the ID3v2 tags at its start (files sometimes carry several). */
export function stripId3v2(bytes: Uint8Array): Uint8Array {
  let start = 0
  for (let length = id3v2Length(bytes, start); length > 0; length = id3v2Length(bytes, start)) {
    start += length
  }
  return bytes.subarray(start)
}

/**
 * An MP3 file with `tags` as its only metadata: earlier ID3v2 tags at the start and an ID3v1
 * tag at the end are removed, so no stale title outlives the new one. The audio frames are
 * untouched.
 */
export function writeMp3Tags(bytes: Uint8Array, tags: ExportTags): Uint8Array {
  let audio = stripId3v2(bytes)
  if (audio.length >= 128 && hasAscii(audio, audio.length - 128, 'TAG')) {
    audio = audio.subarray(0, audio.length - 128)
  }
  return concat([buildId3v2(tags), audio])
}
