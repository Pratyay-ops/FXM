// @vitest-environment node
// Build-time config: no DOM.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ICON_FILES, iconSvg, MARK_BAR_WIDTH, MARK_BARS, MASKABLE_BAR_SCALE } from './icons.ts'

/** Width, height and colour type from a PNG's IHDR chunk. */
function pngHeader(file: string) {
  const bytes = readFileSync(new URL(`../public/${file}`, import.meta.url))
  expect(bytes.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  expect(bytes.toString('latin1', 12, 16)).toBe('IHDR')
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), colorType: bytes[25] }
}

describe('app icons', () => {
  it.each(ICON_FILES)('ships $file at $size × $size px', ({ file, size }) => {
    const { width, height } = pngHeader(file)
    expect([width, height]).toEqual([size, size])
  })

  it('keeps the corners of the plain icons transparent', () => {
    for (const icon of ICON_FILES.filter(({ variant }) => variant === 'any')) {
      expect(pngHeader(icon.file).colorType, icon.file).toBe(6) // RGBA
    }
  })

  it('draws the plain icon as the rounded mark, the others to every edge', () => {
    expect(iconSvg('any')).toContain('<rect width="32" height="32" rx="8"')
    expect(iconSvg('maskable')).toContain('<rect width="32" height="32" fill="url(#g)"/>')
    expect(iconSvg('square')).toContain('<rect width="32" height="32" fill="url(#g)"/>')
  })

  it("keeps the maskable icon's bars inside the safe zone", () => {
    expect(iconSvg('maskable')).toContain(`scale(${MASKABLE_BAR_SCALE})`)
    // The safe zone is the centred circle with a radius of 40 % of the icon (12.8 of 32).
    for (const { x, y, height } of MARK_BARS) {
      for (const [cornerX, cornerY] of [
        [x, y],
        [x + MARK_BAR_WIDTH, y],
        [x, y + height],
        [x + MARK_BAR_WIDTH, y + height],
      ] as const) {
        const distance = Math.hypot(cornerX - 16, cornerY - 16) * MASKABLE_BAR_SCALE
        expect(distance).toBeLessThan(12.8)
      }
    }
  })

  it('leaves the bars at full size in the plain and iOS icons', () => {
    expect(iconSvg('any')).not.toContain('scale(')
    expect(iconSvg('square')).not.toContain('scale(')
  })
})
