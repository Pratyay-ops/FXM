/** Test helper: splits a PNG file into its chunks and checks each chunk's CRC. */
import { crc32 } from 'node:zlib'

export interface PngChunk {
  type: string
  data: Buffer
  crcOk: boolean
}

export const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

export function readPngChunks(png: Buffer): PngChunk[] {
  if (!png.subarray(0, 8).equals(Buffer.from(PNG_SIGNATURE))) throw new Error('not a PNG file')
  const chunks: PngChunk[] = []
  let offset = 8
  while (offset < png.length) {
    const length = png.readUInt32BE(offset)
    const type = png.toString('ascii', offset + 4, offset + 8)
    const data = png.subarray(offset + 8, offset + 8 + length)
    const crc = png.readUInt32BE(offset + 8 + length)
    chunks.push({ type, data, crcOk: crc32(png.subarray(offset + 4, offset + 8 + length)) === crc })
    offset += 12 + length
  }
  return chunks
}
