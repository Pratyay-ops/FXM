/**
 * Readers for tests: what a saved file's tags say, in each format, independently of the writers.
 *
 * @module
 */

import {
  ascii,
  hasAscii,
  oggCrc,
  readSyncsafe,
  readU16BE,
  readU24BE,
  readU32BE,
  readU32LE,
} from '../bytes'
import { childBoxes, findBox } from '../mp4/boxes'

const decoder = new TextDecoder()

/** Decodes ID3v2 text in its encoding (0 Latin-1, 1 UTF-16 with BOM, 3 UTF-8). */
function id3Text(encoding: number, bytes: Uint8Array): string {
  if (encoding === 1) {
    const littleEndian = bytes[0] === 0xff && bytes[1] === 0xfe
    let text = ''
    for (let i = 2; i + 1 < bytes.length; i += 2) {
      const unit = littleEndian
        ? (bytes[i] ?? 0) | ((bytes[i + 1] ?? 0) << 8)
        : ((bytes[i] ?? 0) << 8) | (bytes[i + 1] ?? 0)
      if (unit === 0) break
      text += String.fromCharCode(unit)
    }
    return text
  }
  const end = bytes.indexOf(0)
  const slice = end === -1 ? bytes : bytes.subarray(0, end)
  return encoding === 3 ? decoder.decode(slice) : String.fromCharCode(...slice)
}

/** One ID3v2 frame. */
export interface Id3Frame {
  readonly id: string
  readonly body: Uint8Array
}

/** The version and frames of the ID3v2 tag at the start of `bytes` (2.3 or 2.4). */
export function readId3v2(bytes: Uint8Array): { version: number; frames: Id3Frame[] } | undefined {
  if (!hasAscii(bytes, 0, 'ID3')) return undefined
  const version = bytes[3] ?? 0
  const end = 10 + readSyncsafe(bytes, 6)
  const frames: Id3Frame[] = []
  let at = 10
  while (at + 10 <= end && bytes[at] !== 0) {
    const id = ascii(bytes, at, 4)
    const size = version === 4 ? readSyncsafe(bytes, at + 4) : readU32BE(bytes, at + 4)
    frames.push({ id, body: bytes.subarray(at + 10, at + 10 + size) })
    at += 10 + size
  }
  return { version, frames }
}

/** The text of an ID3v2 text frame (T***). */
export function id3TextFrame(frame: Id3Frame): string {
  return id3Text(frame.body[0] ?? 0, frame.body.subarray(1))
}

/** The text and picture details of the frames FXM writes, by frame ID. */
export function id3Summary(bytes: Uint8Array): Record<string, string> {
  const tag = readId3v2(bytes)
  const summary: Record<string, string> = {}
  for (const frame of tag?.frames ?? []) {
    if (frame.id.startsWith('T')) summary[frame.id] = id3TextFrame(frame)
    else if (frame.id === 'USLT') {
      // encoding, language, descriptor (UTF-16: BOM + 00 00 terminator), text
      const body = frame.body.subarray(4)
      const terminator = findUtf16Terminator(body)
      summary.USLT = id3Text(frame.body[0] ?? 0, body.subarray(terminator + 2))
    } else if (frame.id === 'APIC') {
      const mimeEnd = frame.body.indexOf(0, 1)
      summary.APIC = `${ascii(frame.body, 1, mimeEnd - 1)} type ${frame.body[mimeEnd + 1]}`
    } else if (frame.id === 'SYLT') {
      summary.SYLT = `format ${frame.body[4]} content ${frame.body[5]}`
    }
  }
  return summary
}

function findUtf16Terminator(bytes: Uint8Array): number {
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    if (bytes[i] === 0 && bytes[i + 1] === 0) return i
  }
  return bytes.length
}

/** Name/value pairs of a Vorbis comment list, and its vendor. */
export function readVorbisComments(bytes: Uint8Array): {
  vendor: string
  fields: [string, string][]
} {
  const vendorLength = readU32LE(bytes, 0)
  const vendor = decoder.decode(bytes.subarray(4, 4 + vendorLength))
  let at = 4 + vendorLength
  const count = readU32LE(bytes, at)
  at += 4
  const fields: [string, string][] = []
  for (let i = 0; i < count; i++) {
    const length = readU32LE(bytes, at)
    const text = decoder.decode(bytes.subarray(at + 4, at + 4 + length))
    const equals = text.indexOf('=')
    fields.push([text.slice(0, equals), text.slice(equals + 1)])
    at += 4 + length
  }
  return { vendor, fields }
}

/** The metadata blocks of a FLAC stream and where its frames start. */
export function readFlacBlocks(bytes: Uint8Array): {
  blocks: { type: number; last: boolean; body: Uint8Array }[]
  framesAt: number
} {
  const blocks: { type: number; last: boolean; body: Uint8Array }[] = []
  let at = 4
  for (;;) {
    const header = bytes[at] ?? 0
    const length = readU24BE(bytes, at + 1)
    blocks.push({
      type: header & 0x7f,
      last: (header & 0x80) !== 0,
      body: bytes.subarray(at + 4, at + 4 + length),
    })
    at += 4 + length
    if (header & 0x80) return { blocks, framesAt: at }
  }
}

/** One Ogg page, with whether its checksum is right. */
export interface OggPageInfo {
  readonly flags: number
  readonly granule: bigint
  readonly serial: number
  readonly sequence: number
  readonly segments: number[]
  readonly data: Uint8Array
  readonly crcValid: boolean
}

/** Every page of an Ogg file. */
export function readOggPages(bytes: Uint8Array): OggPageInfo[] {
  const pages: OggPageInfo[] = []
  let at = 0
  while (at < bytes.length) {
    if (!hasAscii(bytes, at, 'OggS')) throw new Error(`no page at ${at}`)
    const count = bytes[at + 26] ?? 0
    const segments = Array.from(bytes.subarray(at + 27, at + 27 + count))
    const length = 27 + count + segments.reduce((sum, value) => sum + value, 0)
    const page = bytes.slice(at, at + length)
    const stored = readU32LE(page, 22)
    page.fill(0, 22, 26)
    pages.push({
      flags: bytes[at + 5] ?? 0,
      granule: new DataView(bytes.buffer, bytes.byteOffset + at + 6, 8).getBigInt64(0, true),
      serial: readU32LE(bytes, at + 14),
      sequence: readU32LE(bytes, at + 18),
      segments,
      data: bytes.subarray(at + 27 + count, at + length),
      crcValid: oggCrc(page) === stored,
    })
    at += length
  }
  return pages
}

/** The packets of an Ogg file's pages, in order. */
export function readOggPackets(pages: readonly OggPageInfo[]): Uint8Array[] {
  const packets: Uint8Array[] = []
  let parts: number[] = []
  for (const page of pages) {
    let at = 0
    for (const value of page.segments) {
      parts.push(...page.data.subarray(at, at + value))
      at += value
      if (value < 255) {
        packets.push(new Uint8Array(parts))
        parts = []
      }
    }
  }
  return packets
}

/** The chunks of a RIFF file, by ID, with their data. */
export function readRiffChunks(bytes: Uint8Array): { id: string; data: Uint8Array }[] {
  const chunks: { id: string; data: Uint8Array }[] = []
  let at = 12
  while (at + 8 <= bytes.length) {
    const size = readU32LE(bytes, at + 4)
    chunks.push({ id: ascii(bytes, at, 4), data: bytes.subarray(at + 8, at + 8 + size) })
    at += 8 + size + (size % 2)
  }
  return chunks
}

/** The iTunes items of an M4A file (`moov/udta/meta/ilst`): text values, or a description. */
export function readMp4Tags(bytes: Uint8Array): Record<string, string> {
  const ilst = findBox(bytes, ['moov', 'udta', 'meta', 'ilst'])
  const tags: Record<string, string> = {}
  if (ilst === undefined) return tags
  for (const item of childBoxes(bytes, ilst.offset + 8, ilst.offset + ilst.length)) {
    const children = childBoxes(bytes, item.offset + 8, item.offset + item.length)
    const data = children.find((child) => child.type === 'data')
    if (data === undefined) continue
    const type = readU32BE(bytes, data.offset + 8) & 0xffffff
    const value = bytes.subarray(data.offset + 16, data.offset + data.length)
    let name = item.type
    if (item.type === '----') {
      const nameBox = children.find((child) => child.type === 'name')
      if (nameBox) name = `----:${ascii(bytes, nameBox.offset + 12, nameBox.length - 12)}`
    }
    if (type === 1) tags[name] = decoder.decode(value)
    else if (item.type === 'trkn' || item.type === 'disk') tags[name] = String(readU16BE(value, 2))
    else tags[name] = `type ${type}, ${value.length} bytes`
  }
  return tags
}

/** The types of the top-level boxes of an MP4 file, in order. */
export function topLevelBoxes(bytes: Uint8Array): string[] {
  return childBoxes(bytes).map((item) => item.type)
}
