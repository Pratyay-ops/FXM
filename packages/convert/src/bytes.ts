/**
 * Small helpers for the binary formats the tag writers edit: a growable byte writer, readers for
 * big- and little-endian integers, text encodings and the Ogg CRC.
 *
 * @module
 */

const encoder = new TextEncoder()

/** UTF-8 bytes of `text`. */
export function utf8(text: string): Uint8Array {
  return encoder.encode(text)
}

/** Latin-1 bytes of `text`, for the ASCII fields of the formats (MIME types, box names). */
export function latin1(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length)
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 0xff
  return bytes
}

/** UTF-16 little-endian bytes of `text`, after a byte order mark, as ID3v2.3 writes text. */
export function utf16WithBom(text: string): Uint8Array {
  const bytes = new Uint8Array(2 + text.length * 2)
  bytes[0] = 0xff
  bytes[1] = 0xfe
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i)
    bytes[2 + i * 2] = unit & 0xff
    bytes[3 + i * 2] = unit >> 8
  }
  return bytes
}

/** The ASCII text of `length` bytes at `offset`, e.g. a box type or a chunk ID. */
export function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let text = ''
  for (let i = offset; i < offset + length && i < bytes.length; i++) {
    text += String.fromCharCode(bytes[i] ?? 0)
  }
  return text
}

/** Whether `bytes` holds `text`, as ASCII, at `offset`. */
export function hasAscii(bytes: Uint8Array, offset: number, text: string): boolean {
  if (offset < 0 || offset + text.length > bytes.length) return false
  for (let i = 0; i < text.length; i++) {
    if (bytes[offset + i] !== text.charCodeAt(i)) return false
  }
  return true
}

/** The parts joined into one array. */
export function concat(parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const length = parts.reduce((sum, part) => sum + part.length, 0)
  const out = new Uint8Array(length)
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

export function readU16BE(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0)
}

export function readU24BE(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] ?? 0) << 16) | ((bytes[offset + 1] ?? 0) << 8) | (bytes[offset + 2] ?? 0)
}

export function readU32BE(bytes: Uint8Array, offset: number): number {
  return (
    (((bytes[offset] ?? 0) << 24) >>> 0) +
    (((bytes[offset + 1] ?? 0) << 16) | ((bytes[offset + 2] ?? 0) << 8) | (bytes[offset + 3] ?? 0))
  )
}

export function readU64BE(bytes: Uint8Array, offset: number): number {
  return readU32BE(bytes, offset) * 2 ** 32 + readU32BE(bytes, offset + 4)
}

export function readU32LE(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] ?? 0) |
      ((bytes[offset + 1] ?? 0) << 8) |
      ((bytes[offset + 2] ?? 0) << 16) |
      ((bytes[offset + 3] ?? 0) << 24)) >>>
    0
  )
}

/** A syncsafe integer (7 bits per byte), as ID3v2 stores sizes. */
export function readSyncsafe(bytes: Uint8Array, offset: number): number {
  return (
    (((bytes[offset] ?? 0) & 0x7f) << 21) |
    (((bytes[offset + 1] ?? 0) & 0x7f) << 14) |
    (((bytes[offset + 2] ?? 0) & 0x7f) << 7) |
    ((bytes[offset + 3] ?? 0) & 0x7f)
  )
}

/** A growable buffer that writes integers and bytes in order. */
export class ByteWriter {
  private data = new Uint8Array(256)
  private length = 0

  /** Bytes written so far. */
  get size(): number {
    return this.length
  }

  private reserve(count: number): void {
    if (this.length + count <= this.data.length) return
    let capacity = this.data.length * 2
    while (capacity < this.length + count) capacity *= 2
    const grown = new Uint8Array(capacity)
    grown.set(this.data.subarray(0, this.length))
    this.data = grown
  }

  u8(value: number): this {
    this.reserve(1)
    this.data[this.length++] = value & 0xff
    return this
  }

  u16be(value: number): this {
    return this.u8(value >>> 8).u8(value)
  }

  u24be(value: number): this {
    return this.u8(value >>> 16)
      .u8(value >>> 8)
      .u8(value)
  }

  u32be(value: number): this {
    return this.u8(value >>> 24)
      .u8(value >>> 16)
      .u8(value >>> 8)
      .u8(value)
  }

  u64be(value: number): this {
    return this.u32be(Math.floor(value / 2 ** 32)).u32be(value >>> 0)
  }

  u16le(value: number): this {
    return this.u8(value).u8(value >>> 8)
  }

  u32le(value: number): this {
    return this.u8(value)
      .u8(value >>> 8)
      .u8(value >>> 16)
      .u8(value >>> 24)
  }

  u64le(value: number): this {
    return this.u32le(value >>> 0).u32le(Math.floor(value / 2 ** 32))
  }

  /** A syncsafe integer (7 bits per byte), as ID3v2 stores the tag size. */
  syncsafe(value: number): this {
    return this.u8((value >>> 21) & 0x7f)
      .u8((value >>> 14) & 0x7f)
      .u8((value >>> 7) & 0x7f)
      .u8(value & 0x7f)
  }

  bytes(bytes: Uint8Array): this {
    this.reserve(bytes.length)
    this.data.set(bytes, this.length)
    this.length += bytes.length
    return this
  }

  /** ASCII text, one byte per character. */
  ascii(text: string): this {
    return this.bytes(latin1(text))
  }

  /** The bytes written, as a new array. */
  finish(): Uint8Array<ArrayBuffer> {
    return this.data.slice(0, this.length)
  }
}

const OGG_CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let value = i << 24
    for (let bit = 0; bit < 8; bit++) {
      value = value & 0x80000000 ? (value << 1) ^ 0x04c11db7 : value << 1
    }
    table[i] = value >>> 0
  }
  return table
})()

/** The CRC-32 Ogg pages carry: polynomial 0x04C11DB7, not reflected, starting at 0. */
export function oggCrc(bytes: Uint8Array): number {
  let crc = 0
  for (const byte of bytes) {
    crc = ((crc << 8) ^ (OGG_CRC_TABLE[((crc >>> 24) ^ byte) & 0xff] ?? 0)) >>> 0
  }
  return crc
}

/** Base64 of `bytes`, as Ogg's METADATA_BLOCK_PICTURE comment holds a picture. */
export function base64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}
