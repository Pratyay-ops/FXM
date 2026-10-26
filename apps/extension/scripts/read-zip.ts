/**
 * Reads a zip through its central directory, the way unzip tools do: for the tests of the zip
 * writer and of the release zips. Handles what createZip writes (deflate or store, no ZIP64).
 */
import { crc32, inflateRawSync } from 'node:zlib'

export interface ReadEntry {
  name: string
  /** 8 for deflate, 0 for store. */
  method: number
  data: Buffer
  /** Whether the data matches the CRC-32 the archive records. */
  crcOk: boolean
}

export function readZip(zip: Buffer): ReadEntry[] {
  const end = zip.length - 22
  if (zip.readUInt32LE(end) !== 0x06054b50) throw new Error('no end of central directory record')
  const count = zip.readUInt16LE(end + 10)
  let offset = zip.readUInt32LE(end + 16)
  const entries: ReadEntry[] = []
  for (let i = 0; i < count; i++) {
    if (zip.readUInt32LE(offset) !== 0x02014b50) throw new Error(`no central entry at ${offset}`)
    const method = zip.readUInt16LE(offset + 10)
    const crc = zip.readUInt32LE(offset + 16)
    const compressedSize = zip.readUInt32LE(offset + 20)
    const nameLength = zip.readUInt16LE(offset + 28)
    const localOffset = zip.readUInt32LE(offset + 42)
    const name = zip.toString('utf8', offset + 46, offset + 46 + nameLength)
    const localName = zip.toString('utf8', localOffset + 30, localOffset + 30 + nameLength)
    if (zip.readUInt32LE(localOffset) !== 0x04034b50 || localName !== name) {
      throw new Error(`the local header of ${name} doesn't match its central entry`)
    }
    const start = localOffset + 30 + nameLength
    const body = zip.subarray(start, start + compressedSize)
    const data = method === 8 ? inflateRawSync(body) : Buffer.from(body)
    entries.push({ name, method, data, crcOk: crc32(data) === crc })
    offset += 46 + nameLength
  }
  return entries
}
