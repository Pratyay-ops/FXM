/** Minimal PNG encoding and decoding: 8-bit RGBA, no interlacing, every row unfiltered. */
import { crc32, deflateSync, inflateSync } from 'node:zlib'

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

export interface Image {
  width: number
  height: number
  /** Straight (not premultiplied) RGBA, row by row. */
  rgba: Uint8Array
}

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0)
  return Buffer.concat([head, data, crc])
}

export function encodePng({ width, height, rgba }: Image): Buffer {
  if (rgba.length !== width * height * 4) throw new Error('pixel buffer does not match the size')
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8 // bit depth
  header[9] = 6 // colour type: RGBA; compression, filter and interlace methods stay 0
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height) // each row starts with filter type 0 (none)
  for (let y = 0; y < height; y++) {
    raw.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1)
  }
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** Decodes what encodePng writes, so tests can compare pixels rather than zlib output. */
export function decodePng(png: Buffer): Image {
  if (!png.subarray(0, 8).equals(SIGNATURE)) throw new Error('not a PNG file')
  let width = 0
  let height = 0
  const data: Buffer[] = []
  for (let offset = 8; offset < png.length; ) {
    const length = png.readUInt32BE(offset)
    const type = png.toString('ascii', offset + 4, offset + 8)
    const body = png.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      width = body.readUInt32BE(0)
      height = body.readUInt32BE(4)
      if (body[8] !== 8 || body[9] !== 6 || body[12] !== 0) {
        throw new Error('only 8-bit, non-interlaced RGBA PNG files are supported')
      }
    } else if (type === 'IDAT') {
      data.push(body)
    }
    offset += 12 + length
  }
  const raw = inflateSync(Buffer.concat(data))
  const stride = width * 4
  if (raw.length !== (stride + 1) * height) throw new Error('PNG data does not match its size')
  const rgba = new Uint8Array(stride * height)
  for (let y = 0; y < height; y++) {
    if (raw[y * (stride + 1)] !== 0) throw new Error('only unfiltered PNG rows are supported')
    rgba.set(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)), y * stride)
  }
  return { width, height, rgba }
}
