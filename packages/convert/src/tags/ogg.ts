/**
 * Ogg Opus and Ogg Vorbis tags: the stream's comment header packet (RFC 7845 for Opus, the
 * Vorbis I specification for Vorbis). The new packet goes on fresh pages after the
 * identification header, the stream's later pages are renumbered and get new checksums, and
 * the audio packets stay byte for byte.
 *
 * @module
 */

import { ByteWriter, concat, hasAscii, oggCrc, readU32LE, utf8 } from '../bytes'
import type { ExportTags } from '../types'
import { encodeComments, readVendor } from './vorbis'

const HEADER_BYTES = 27
const CONTINUED = 0x01
const BEGINNING = 0x02
/** The most lacing values a page holds. */
const MAX_SEGMENTS = 255

interface Page {
  readonly offset: number
  readonly length: number
  readonly flags: number
  readonly serial: number
  readonly sequence: number
  readonly segments: Uint8Array
  readonly dataOffset: number
}

function readPages(bytes: Uint8Array): Page[] {
  const pages: Page[] = []
  let at = 0
  while (at < bytes.length) {
    if (!hasAscii(bytes, at, 'OggS') || at + HEADER_BYTES > bytes.length) {
      throw new RangeError(`No Ogg page at byte ${at}`)
    }
    const count = bytes[at + 26] ?? 0
    const segments = bytes.subarray(at + HEADER_BYTES, at + HEADER_BYTES + count)
    const dataOffset = at + HEADER_BYTES + count
    const dataLength = segments.reduce((sum, value) => sum + value, 0)
    const length = HEADER_BYTES + count + dataLength
    if (at + length > bytes.length) throw new RangeError('An Ogg page runs past the file')
    pages.push({
      offset: at,
      length,
      flags: bytes[at + 5] ?? 0,
      serial: readU32LE(bytes, at + 14),
      sequence: readU32LE(bytes, at + 18),
      segments,
      dataOffset,
    })
    at += length
  }
  return pages
}

interface Packet {
  readonly data: Uint8Array
  /** The index (in the stream's pages) of the page it ends on. */
  readonly endPage: number
  /** Whether it ends with the last segment of that page. */
  readonly endsPage: boolean
}

/** The first `count` packets of a stream, from its pages. */
function readPackets(bytes: Uint8Array, pages: readonly Page[], count: number): Packet[] {
  const packets: Packet[] = []
  let parts: Uint8Array[] = []
  for (let index = 0; index < pages.length && packets.length < count; index++) {
    const page = pages[index] as Page
    let at = page.dataOffset
    let start = at
    for (let segment = 0; segment < page.segments.length; segment++) {
      const value = page.segments[segment] ?? 0
      at += value
      if (value < 255) {
        parts.push(bytes.subarray(start, at))
        packets.push({
          data: concat(parts),
          endPage: index,
          endsPage: segment === page.segments.length - 1,
        })
        parts = []
        start = at
        if (packets.length === count) break
      }
    }
    if (start < at) parts.push(bytes.subarray(start, at))
  }
  return packets
}

/** Pages for `packets`, numbered from `sequence`, all with granule 0 where a packet ends. */
function paginate(packets: readonly Uint8Array[], serial: number, sequence: number): Uint8Array[] {
  const lacing: { value: number; packetEnds: boolean }[] = []
  const data: Uint8Array[] = []
  for (const packet of packets) {
    let left = packet.length
    while (left >= 255) {
      lacing.push({ value: 255, packetEnds: false })
      left -= 255
    }
    lacing.push({ value: left, packetEnds: true })
    data.push(packet)
  }
  const payload = concat(data)
  const pages: Uint8Array[] = []
  let read = 0
  let continued = false
  for (let first = 0; first < lacing.length; first += MAX_SEGMENTS) {
    const segments = lacing.slice(first, first + MAX_SEGMENTS)
    const size = segments.reduce((sum, item) => sum + item.value, 0)
    const ends = segments.some((item) => item.packetEnds)
    const page = new ByteWriter()
      .ascii('OggS')
      .u8(0)
      .u8(continued ? CONTINUED : 0)
    // Granule 0 on pages where a header packet ends; -1 where none does (RFC 3533).
    if (ends) page.u64le(0)
    else page.u32le(0xffffffff).u32le(0xffffffff)
    page
      .u32le(serial)
      .u32le(sequence + pages.length)
      .u32le(0)
      .u8(segments.length)
    for (const item of segments) page.u8(item.value)
    page.bytes(payload.subarray(read, read + size))
    read += size
    continued = !segments[segments.length - 1]?.packetEnds
    pages.push(withChecksum(page.finish()))
  }
  return pages
}

/** `page` with its CRC field computed (over the page with the field zeroed). */
function withChecksum(page: Uint8Array): Uint8Array {
  page.fill(0, 22, 26)
  const crc = oggCrc(page)
  page[22] = crc & 0xff
  page[23] = (crc >>> 8) & 0xff
  page[24] = (crc >>> 16) & 0xff
  page[25] = (crc >>> 24) & 0xff
  return page
}

/** A copy of the page at `page` with sequence number `sequence`, checksum updated. */
function renumbered(bytes: Uint8Array, page: Page, sequence: number): Uint8Array {
  const copy = bytes.slice(page.offset, page.offset + page.length)
  copy[18] = sequence & 0xff
  copy[19] = (sequence >>> 8) & 0xff
  copy[20] = (sequence >>> 16) & 0xff
  copy[21] = (sequence >>> 24) & 0xff
  return withChecksum(copy)
}

/** The codecs whose comments FXM writes, by their identification header. */
function codecOf(header: Uint8Array): 'opus' | 'vorbis' | undefined {
  if (hasAscii(header, 0, 'OpusHead')) return 'opus'
  if (header[0] === 1 && hasAscii(header, 1, 'vorbis')) return 'vorbis'
  return undefined
}

/** What {@link writeOggTags} did. */
export interface OggTagResult {
  readonly bytes: Uint8Array
  /** False when the stream's codec has no comment header FXM writes (FLAC or Speex in Ogg). */
  readonly tagged: boolean
}

/**
 * An Ogg Opus or Ogg Vorbis file with `tags` as its comments, the cover as a
 * METADATA_BLOCK_PICTURE. Other codecs in Ogg come back unchanged (`tagged: false`). Only the
 * first logical stream is tagged; the pages of other streams stay as they are.
 *
 * @throws RangeError when `bytes` is not an Ogg file, or its headers break the specification
 * (header and audio packets sharing a page).
 */
export function writeOggTags(bytes: Uint8Array, tags: ExportTags): OggTagResult {
  const all = readPages(bytes)
  const first = all[0]
  if (first === undefined || !(first.flags & BEGINNING)) throw new RangeError('Not an Ogg stream')
  const serial = first.serial
  const pages = all.filter((page) => page.serial === serial)
  const idHeader = readPackets(bytes, pages, 1)[0]
  const codec = idHeader === undefined ? undefined : codecOf(idHeader.data)
  if (codec === undefined) return { bytes, tagged: false }
  const headerCount = codec === 'opus' ? 2 : 3
  const headers = readPackets(bytes, pages, headerCount)
  const last = headers[headerCount - 1]
  if (headers.length < headerCount || last === undefined || !last.endsPage) {
    throw new RangeError('The Ogg headers are incomplete or share a page with audio')
  }
  if (headers[0]?.endPage !== 0 || !headers[0]?.endsPage) {
    throw new RangeError('The Ogg identification header must fill the first page')
  }
  const oldComments = headers[1]?.data ?? new Uint8Array()
  const prefixLength = codec === 'opus' ? 8 : 7
  const vendor = readVendor(oldComments.subarray(prefixLength)) || 'FXM'
  const comments =
    codec === 'opus'
      ? concat([utf8('OpusTags'), encodeComments(vendor, tags, { pictureInComments: true })])
      : concat([
          new Uint8Array([3]),
          utf8('vorbis'),
          encodeComments(vendor, tags, { pictureInComments: true }),
          new Uint8Array([1]), // framing bit
        ])
  const newHeaders =
    codec === 'opus' ? [comments] : [comments, headers[2]?.data ?? new Uint8Array()]
  const headerPages = paginate(newHeaders, serial, 1)
  // Pages 1 to last.endPage of the stream held the old headers.
  const replaced = new Set(pages.slice(1, last.endPage + 1))
  const shift = headerPages.length - replaced.size
  const out: Uint8Array[] = []
  for (const page of all) {
    if (page === first) {
      out.push(bytes.subarray(page.offset, page.offset + page.length), ...headerPages)
    } else if (replaced.has(page)) {
      // Written above.
    } else if (page.serial === serial && shift !== 0) {
      out.push(renumbered(bytes, page, (page.sequence + shift) >>> 0))
    } else {
      out.push(bytes.subarray(page.offset, page.offset + page.length))
    }
  }
  return { bytes: concat(out), tagged: true }
}
