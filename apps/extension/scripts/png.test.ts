import { inflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { encodePng } from './png.ts'
import { readPngChunks } from './png-chunks.ts'

describe('encodePng', () => {
  it('writes a valid 8-bit RGBA PNG', () => {
    const pixels = new Uint8Array([255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 0, 1, 2, 3, 4])
    const png = encodePng(2, 2, pixels)
    const chunks = readPngChunks(png)
    expect(chunks.map((chunk) => chunk.type)).toEqual(['IHDR', 'IDAT', 'IEND'])
    expect(chunks.every((chunk) => chunk.crcOk)).toBe(true)
    const header = chunks[0]?.data ?? Buffer.alloc(0)
    expect([header.readUInt32BE(0), header.readUInt32BE(4), ...header.subarray(8)]).toEqual([
      2, 2, 8, 6, 0, 0, 0,
    ])
    const raw = inflateSync(chunks[1]?.data ?? Buffer.alloc(0))
    // Each row: filter byte 0, then the row's pixels.
    expect([...raw]).toEqual([0, ...pixels.subarray(0, 8), 0, ...pixels.subarray(8)])
  })

  it('rejects sizes that do not match the pixels', () => {
    expect(() => encodePng(2, 2, new Uint8Array(15))).toThrow()
    expect(() => encodePng(0, 1, new Uint8Array(0))).toThrow()
  })
})
