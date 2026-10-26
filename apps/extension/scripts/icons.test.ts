import { inflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { ICON_SIZES } from '../src/manifest.ts'
import { iconPng, iconSvg, renderIcon } from './icons.ts'
import { readPngChunks } from './png-chunks.ts'

function pixel(pixels: Uint8Array, size: number, x: number, y: number): number[] {
  const offset = (y * size + x) * 4
  return [...pixels.subarray(offset, offset + 4)]
}

describe('FXM mark icons', () => {
  it('renders a rounded violet tile with transparent corners', () => {
    const size = 128
    const pixels = renderIcon(size)
    expect(pixel(pixels, size, 0, 0)[3]).toBe(0)
    expect(pixel(pixels, size, 127, 127)[3]).toBe(0)
    // Gradient: lighter violet near the top-left, darker near the bottom-right.
    const topLeft = pixel(pixels, size, 12, 12)
    const bottomRight = pixel(pixels, size, 115, 115)
    expect(topLeft[3]).toBe(255)
    expect(bottomRight[3]).toBe(255)
    expect(topLeft[2]).toBeGreaterThan(bottomRight[2] ?? 255)
  })

  it('draws the five white bars', () => {
    const size = 128
    const pixels = renderIcon(size)
    // Centres of the bars (x = bar.x + 1.6, y = middle of the bar), scaled from 32 to 128.
    for (const [x, y] of [
      [6.4, 19.5],
      [11.2, 16],
      [16, 18.5],
      [20.8, 16],
      [25.6, 19.5],
    ] as const) {
      expect(pixel(pixels, size, Math.floor(x * 4), Math.floor(y * 4))).toEqual([
        255, 255, 255, 255,
      ])
    }
  })

  it.each(ICON_SIZES)('encodes a %i px PNG', (size) => {
    const chunks = readPngChunks(iconPng(size))
    const header = chunks[0]?.data ?? Buffer.alloc(0)
    expect([header.readUInt32BE(0), header.readUInt32BE(4)]).toEqual([size, size])
    expect(inflateSync(chunks[1]?.data ?? Buffer.alloc(0))).toHaveLength((size * 4 + 1) * size)
  })

  it('draws the same mark as SVG', () => {
    const svg = iconSvg()
    expect(svg).toMatch(/^<svg xmlns="http:\/\/www.w3.org\/2000\/svg" viewBox="0 0 32 32"/)
    expect(svg).toContain('stop-color="#8b5cf6"')
    expect(svg).toContain('stop-color="#5b21b6"')
    expect(svg.match(/<rect /g)).toHaveLength(6)
  })
})
