import { crc32, inflateRawSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { createZip } from './zip.ts'

interface ReadEntry {
  name: string
  method: number
  data: Buffer
  crcOk: boolean
}

/** Reads a zip through its central directory, the way unzip tools do. */
function readZip(zip: Buffer): ReadEntry[] {
  const end = zip.length - 22
  expect(zip.readUInt32LE(end)).toBe(0x06054b50)
  const count = zip.readUInt16LE(end + 10)
  let offset = zip.readUInt32LE(end + 16)
  const entries: ReadEntry[] = []
  for (let i = 0; i < count; i++) {
    expect(zip.readUInt32LE(offset)).toBe(0x02014b50)
    const method = zip.readUInt16LE(offset + 10)
    const crc = zip.readUInt32LE(offset + 16)
    const compressedSize = zip.readUInt32LE(offset + 20)
    const nameLength = zip.readUInt16LE(offset + 28)
    const localOffset = zip.readUInt32LE(offset + 42)
    const name = zip.toString('utf8', offset + 46, offset + 46 + nameLength)
    expect(zip.readUInt32LE(localOffset)).toBe(0x04034b50)
    expect(zip.toString('utf8', localOffset + 30, localOffset + 30 + nameLength)).toBe(name)
    const start = localOffset + 30 + nameLength
    const body = zip.subarray(start, start + compressedSize)
    const data = method === 8 ? inflateRawSync(body) : Buffer.from(body)
    entries.push({ name, method, data, crcOk: crc32(data) === crc })
    offset += 46 + nameLength
  }
  return entries
}

const ENTRIES = [
  { name: 'manifest.json', data: Buffer.from(JSON.stringify({ a: 'x'.repeat(200) })) },
  { name: 'icons/icon-16.png', data: new Uint8Array([0x89, 0x50, 0x4e, 0x47]) },
  { name: 'empty.txt', data: new Uint8Array(0) },
]

describe('createZip', () => {
  it('writes entries in order that unzip back to the same bytes', () => {
    const entries = readZip(createZip(ENTRIES))
    expect(entries.map((entry) => entry.name)).toEqual(ENTRIES.map((entry) => entry.name))
    for (const [index, entry] of entries.entries()) {
      expect(entry.crcOk).toBe(true)
      expect([...entry.data]).toEqual([...(ENTRIES[index]?.data ?? [])])
    }
    // Compressible data is deflated; tiny data is stored.
    expect(entries.map((entry) => entry.method)).toEqual([8, 0, 0])
  })

  it('is deterministic', () => {
    expect(createZip(ENTRIES).equals(createZip(ENTRIES))).toBe(true)
  })

  it('rejects duplicate and unsafe names', () => {
    const data = new Uint8Array(1)
    expect(() =>
      createZip([
        { name: 'a', data },
        { name: 'a', data },
      ]),
    ).toThrow(/duplicate/)
    expect(() => createZip([{ name: '/etc/passwd', data }])).toThrow()
    expect(() => createZip([{ name: 'a\\b', data }])).toThrow()
    expect(() => createZip([{ name: '', data }])).toThrow()
  })
})
